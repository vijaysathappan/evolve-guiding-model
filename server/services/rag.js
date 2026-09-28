/**
 * RetrievalService — spec §5 "2026-standard retrieval pipeline", local edition.
 *
 *   student question
 *     -> query rewrite (multi-turn follow-ups become standalone questions)
 *     -> sparse lexical search (BM25)                 ┐ run over the same
 *     -> dense-ish search (TF-IDF cosine similarity)  ┤ chunk index
 *     -> Reciprocal Rank Fusion (k=60)                ┘
 *     -> top-N fused candidates
 *     -> similarity floor check (refuse when nothing is grounded)
 *     -> structured answer + [n] citations
 *
 * Chunks carry contextual headers ("Physics > Class 11 > Units and
 * Measurement > §1.2 ..."), exactly the cheap contextual-retrieval trick the
 * spec calls for. Embedding-model dense retrieval can be swapped in later by
 * replacing `denseRank` — the fusion and the API stay identical.
 */
import { table } from '../db.js';
import { chat } from './llm.js';

const RRF_K = 60;
// RRF scores are bounded: a chunk ranked #1 in BOTH lists scores 2/(k+1) ≈ 0.033.
// 0.02 ≈ "top-5 in at least one ranker and present in the other" — grounded enough.
const SIM_FLOOR = 0.02;

// ── tokenization ────────────────────────────────────────────────────────────
const STOP = new Set('a an the is are was were be been of in on at to for with by from as and or not no this that these those it its if then than so such do does did can could may might will would shall should has have had you your i we they he she'.split(' '));

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+\-*/=^²³%. ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

// ── index build ─────────────────────────────────────────────────────────────
let index = null;

function chunkSection(chapter, section, secIdx) {
  // ~180-word chunks with 30-word overlap keeps formulas near their prose
  const words = (section.raw_text || '').split(/\s+/);
  const chunks = [];
  const SIZE = 180, OVERLAP = 30;
  for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
    const slice = words.slice(i, i + SIZE).join(' ');
    if (slice.trim().length < 40) continue;
    const header = `${chapter.subject} > ${chapter.class_level || 'Class 11'} > ${chapter.chapter_name} > ${section.title}`;
    chunks.push({
      id: `${chapter.id}_${secIdx}_${i}`,
      subject: chapter.subject,
      chapter_id: chapter.id,
      chapter_name: chapter.chapter_name,
      section_title: section.title,
      header,
      text: slice,
      embed_input: `${header}: ${slice}`,
    });
    if (i + SIZE >= words.length) break;
  }
  return chunks;
}

export function buildIndex() {
  const chapters = table('learn_chapters').all();
  const chunks = [];
  for (const ch of chapters) {
    (ch.sections || []).forEach((sec, i) => chunks.push(...chunkSection(ch, sec, i)));
  }

  // document frequencies for BM25 + TF-IDF
  const df = new Map();
  const docs = chunks.map(c => {
    const toks = tokenize(c.embed_input);
    const tf = new Map();
    toks.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);

  index = { chunks, docs, df, avgLen, n: chunks.length };
  console.log(`[RAG] Index built: ${chunks.length} chunks from ${chapters.length} chapters`);
  return index;
}

function ensureIndex() {
  if (!index) buildIndex();
  return index;
}

// ── rankers ─────────────────────────────────────────────────────────────────
function bm25Rank(queryToks, subject) {
  const { chunks, docs, df, avgLen, n } = ensureIndex();
  const k1 = 1.4, b = 0.75;
  const scores = [];
  for (let i = 0; i < chunks.length; i++) {
    if (subject && chunks[i].subject !== subject) continue;
    let s = 0;
    for (const q of queryToks) {
      const f = docs[i].tf.get(q) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docs[i].len / avgLen));
    }
    if (s > 0) scores.push([i, s]);
  }
  return scores.sort((a, b2) => b2[1] - a[1]);
}

function tfidfCosineRank(queryToks, subject) {
  const { chunks, docs, df, n } = ensureIndex();
  const qtf = new Map();
  queryToks.forEach(t => qtf.set(t, (qtf.get(t) || 0) + 1));
  const qvec = new Map();
  let qnorm = 0;
  for (const [t, f] of qtf) {
    const idf = Math.log(1 + n / ((df.get(t) || 0) + 1));
    const w = f * idf;
    qvec.set(t, w);
    qnorm += w * w;
  }
  qnorm = Math.sqrt(qnorm) || 1;

  const scores = [];
  for (let i = 0; i < chunks.length; i++) {
    if (subject && chunks[i].subject !== subject) continue;
    let dot = 0, dnorm = 0;
    for (const [t, f] of docs[i].tf) {
      const idf = Math.log(1 + n / ((df.get(t) || 0) + 1));
      const w = f * idf;
      dnorm += w * w;
      const qw = qvec.get(t);
      if (qw) dot += qw * w;
    }
    if (dot > 0) scores.push([i, dot / (qnorm * (Math.sqrt(dnorm) || 1))]);
  }
  return scores.sort((a, b) => b[1] - a[1]);
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────
export function retrieve(query, { subject = null, topK = 5 } = {}) {
  const { chunks } = ensureIndex();
  const toks = tokenize(query);
  if (!toks.length || !chunks.length) return [];

  const sparse = bm25Rank(toks, subject).slice(0, 40);
  const dense = tfidfCosineRank(toks, subject).slice(0, 40);

  const fused = new Map();
  sparse.forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + 1 / (RRF_K + r + 1)));
  dense.forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + 1 / (RRF_K + r + 1)));

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([i, score]) => ({ ...chunks[i], rrf_score: score }));
}

// ── query rewrite for multi-turn grounding (spec §5.4) ─────────────────────
export async function rewriteQuery(query, history = []) {
  if (!history.length || query.split(/\s+/).length > 12) return query;
  try {
    const { text } = await chat({
      promptName: 'chat.query_rewrite',
      sourceMode: 'chat',
      maxTokens: 120,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: `Rewrite the student's follow-up as ONE standalone question, keeping all subject-specific terms. Reply with the rewritten question only, no preamble.\n\nConversation:\n${history.slice(-6).join('\n')}\n\nFollow-up: "${query}"`,
      }],
    });
    const rewritten = text.replace(/^["']|["']$/g, '').trim();
    return rewritten.length > 3 ? rewritten : query;
  } catch {
    return query;
  }
}

// ── grounded answer with citations + refusal floor ─────────────────────────
export async function groundedAnswer({ query, history = [], subject = null, userId = null }) {
  const standalone = await rewriteQuery(query, history);
  const hits = retrieve(standalone, { subject, topK: 5 });
  const grounded = hits.length > 0 && hits[0].rrf_score >= SIM_FLOOR;

  const contextBlock = hits
    .map((h, i) => `[${i + 1}] (${h.header})\n${h.text}`)
    .join('\n\n');

  const system = grounded
    ? `You are Evolve GM, a CBSE/JEE/NEET tutor. Answer using the CONTEXT below and cite passages inline as [1], [2] etc. If the context only partially covers the question, answer what is covered from context (with citations) and clearly mark anything beyond it as "beyond the provided material". Be concise, exam-focused, and show formulas properly.\n\nCONTEXT:\n${contextBlock}`
    : `You are Evolve GM, a CBSE/JEE/NEET tutor. No curriculum passage matched this question, so answer from general knowledge but begin with: "*(Not found in your loaded chapters — answering from general knowledge.)*" Keep it exam-focused and concise.`;

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-6).map(h => {
      const isTutor = h.startsWith('Tutor:');
      return { role: isTutor ? 'assistant' : 'user', content: h.replace(/^(Tutor|Student):\s*/, '') };
    }),
    { role: 'user', content: standalone },
  ];

  const { text, usage } = await chat({
    promptName: 'chat.grounded_answer',
    sourceMode: 'chat',
    userId,
    messages,
  });

  return {
    text,
    usage,
    grounded,
    rewritten_query: standalone !== query ? standalone : null,
    citations: hits.map((h, i) => ({
      n: i + 1,
      source: h.header,
      section: h.section_title,
      chapter: h.chapter_name,
      score: Number(h.rrf_score.toFixed(4)),
    })),
  };
}

export default { buildIndex, retrieve, rewriteQuery, groundedAnswer };
