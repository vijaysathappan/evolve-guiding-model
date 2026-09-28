/**
 * Evolve GM — local API server (single write path, spec v2.1 §1).
 * Replaces the dead Supabase project with a local JSON datastore and
 * implements the previously-missing LLM endpoints (/api/query, learn mode,
 * RAG-grounded doubts) natively.
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

import { table, uuid } from './db.js';
import { seed } from './seed.js';
import { chat as llmChat, extractJson } from './services/llm.js';
import { buildIndex, retrieve, groundedAnswer } from './services/rag.js';
import { getLiveNews, startNewsScheduler } from './services/newsAgent.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // handwritten-solution images arrive as base64

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// SERVER_PORT (not PORT) — dev-preview tooling injects PORT for the Vite
// process and the API server must never collide with it.
const PORT = process.env.SERVER_PORT || 5000;

seed();
buildIndex();
startNewsScheduler(); // proactively refreshes the Live News agent feed every 6h

const publicUser = (u) => ({
  id: u.id,
  username: u.name,
  userId: u.user_id,
  email: u.email_id,
  chat_id: u.id, // legacy field some clients read; sessions are per-user now
});

/* ══════════════════════ AUTH ══════════════════════ */

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, userId, email, password } = req.body;
    if (!username?.trim() || !userId?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const users = table('users');
    const clash = users.find(u => u.user_id === userId || u.email_id.toLowerCase() === email.toLowerCase());
    if (clash) return res.status(400).json({ message: 'User ID or Email already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const user = users.insert({
      name: username.trim(),
      user_id: userId.trim(),
      email_id: email.trim(),
      password: hashed,
      course: 'default',
      is_active: true,
      last_login: new Date().toISOString(),
    });
    res.status(201).json({ message: 'User created successfully', user: publicUser(user) });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const user = table('users').find(u => u.user_id === userId);
    if (!user) return res.status(400).json({ message: 'Invalid User ID' });

    let ok = false;
    try { ok = await bcrypt.compare(password, user.password); } catch { ok = false; }
    // Legacy plaintext upgrade path
    if (!ok && user.password === password) {
      ok = true;
      const hashed = await bcrypt.hash(password, 10);
      table('users').update(u => u.id === user.id, { password: hashed });
    }
    if (!ok) return res.status(400).json({ message: 'Invalid Password' });
    if (user.is_active === false) return res.status(403).json({ message: 'Account is deactivated' });

    table('users').update(u => u.id === user.id, { last_login: new Date().toISOString() });
    res.json({ message: 'Login successful', user: publicUser(user) });
  } catch (err) {
    console.error('Signin error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/auth/check-userid/:userId', (req, res) => {
  const taken = !!table('users').find(u => u.user_id === req.params.userId);
  res.json({ available: !taken });
});

app.get('/api/auth/check-email/:email', (req, res) => {
  const taken = !!table('users').find(u => u.email_id.toLowerCase() === req.params.email.toLowerCase());
  res.json({ available: !taken });
});

/* ══════════════════════ CHAT SESSIONS ══════════════════════ */
// One row per session; content = array of {query, response, citations?, at}

app.post('/api/chat/new', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const session = table('sessions').insert({
    user_id: userId,
    chat_type: 'doubt',
    chat_title: 'New Chat',
    content: [],
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });
  res.status(201).json({ chat: { ...session, chat_id: session.id } });
});

app.get('/api/chat/list/:userId', (req, res) => {
  const chats = table('sessions')
    .filter(s => s.user_id === req.params.userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(s => ({
      id: s.id,
      session_id: s.id,
      title: s.chat_title || 'Chat',
      created_at: s.created_at,
      chat_type: s.chat_type,
    }));
  res.json({ chats });
});

app.get('/api/chat/history/:sessionId', (req, res) => {
  const s = table('sessions').find(x => x.id === req.params.sessionId);
  if (!s) return res.json({ history: [], chat_type: 'doubt' });
  res.json({ history: s.content || [], chat_type: s.chat_type || 'doubt' });
});

app.post('/api/chat/rename', (req, res) => {
  const { sessionId, title } = req.body;
  const rows = table('sessions').update(s => s.id === sessionId, { chat_title: String(title || '').slice(0, 120) });
  if (!rows.length) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true, updated: { id: sessionId, chat_title: rows[0].chat_title } });
});

app.delete('/api/chat/:sessionId', (req, res) => {
  const n = table('sessions').remove(s => s.id === req.params.sessionId);
  if (!n) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true });
});

/* ══════════════════════ THE LLM QUERY PATH (was missing entirely) ══════════ */

app.post('/api/query', async (req, res) => {
  try {
    const { query, chat_data_id, user_id, image_base64, chat_type } = req.body;
    if (!query?.trim() && !image_base64) return res.status(400).json({ error: 'Empty query' });

    const session = chat_data_id ? table('sessions').find(s => s.id === chat_data_id) : null;

    // Tool-style calls (quiz/exam generators) embed their own JSON contract —
    // route those straight to the model, skipping retrieval.
    const isStructured = /reply (only )?with (only )?this (exact )?json/i.test(query || '');

    let out;
    if (isStructured || image_base64) {
      const { text, usage } = await llmChat({
        promptName: isStructured ? 'practice.generate' : 'chat.vision',
        sourceMode: chat_type || 'chat',
        userId: user_id,
        imageBase64: image_base64 || null,
        messages: [
          { role: 'system', content: 'You are Evolve GM, an expert CBSE/JEE/NEET tutor. Follow the user instructions exactly.' },
          { role: 'user', content: query || 'Analyze the attached image.' },
        ],
      });
      out = { text, usage, grounded: false, citations: [] };
    } else {
      const history = (session?.content || []).slice(-4).flatMap(m => [
        `Student: ${m.query}`,
        `Tutor: ${String(m.response || '').slice(0, 600)}`,
      ]);
      out = await groundedAnswer({ query, history, userId: user_id });
    }

    // Persist into the session + roll up token usage
    if (session) {
      table('sessions').update(s => s.id === session.id, (s) => {
        const content = Array.isArray(s.content) ? s.content : [];
        content.push({
          query,
          response: out.text,
          citations: out.citations?.length ? out.citations : undefined,
          at: new Date().toISOString(),
        });
        const patch = {
          content,
          input_tokens: (s.input_tokens || 0) + out.usage.prompt_tokens,
          output_tokens: (s.output_tokens || 0) + out.usage.completion_tokens,
          total_tokens: (s.total_tokens || 0) + out.usage.total_token,
        };
        if (chat_type && s.chat_type === 'doubt') patch.chat_type = chat_type;
        // Auto-title new chats from the first message
        if ((s.chat_title === 'New Chat' || !s.chat_title) && content.length === 1) {
          patch.chat_title = query.replace(/\s+/g, ' ').slice(0, 48) + (query.length > 48 ? '…' : '');
        }
        return patch;
      });
    }

    res.json({
      text: out.text,
      usage: out.usage,
      grounded: out.grounded,
      citations: out.citations,
      rewritten_query: out.rewritten_query || null,
    });
  } catch (err) {
    console.error('[QUERY ERROR]', err.message);
    res.status(500).json({ error: 'LLM request failed', detail: err.message });
  }
});

/* ══════════════════════ USAGE / ACTIVITY ══════════════════════ */

const MONTHLY_LIMIT = 200000;

app.get('/api/user/usage/:userId', (req, res) => {
  const total = table('sessions')
    .filter(s => s.user_id === req.params.userId)
    .reduce((a, s) => a + (s.total_tokens || 0), 0);
  res.json({ total_token: total, limit: MONTHLY_LIMIT });
});

app.get('/api/user/activity/:userId', (req, res) => {
  const activity = table('sessions')
    .filter(s => s.user_id === req.params.userId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(s => ({
      created_at: s.created_at,
      total_token: s.total_tokens || 0,
      total_tokens: s.total_tokens || 0,
      input_tokens: s.input_tokens || 0,
      output_tokens: s.output_tokens || 0,
      chat_type: s.chat_type,
    }));
  res.json({ activity });
});

/* ══════════════════════ EXAM SAVE + KG EVIDENCE ══════════════════════ */

// Canonicalize free-text chapter/topic names ("units and measurement basics",
// "Quiz: Physics · SI Units") onto curriculum chapters so the knowledge graph
// keys stay consistent and Plan Mode can join against them.
function canonicalizeChapter(subject, chapterName) {
  const chapters = table('learn_chapters').filter(c => !subject || c.subject === subject);
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(chapterName);
  if (!q) return chapterName;
  let best = null, bestScore = 0;
  for (const c of chapters) {
    const name = norm(c.chapter_name);
    if (q.includes(name) || name.includes(q)) return c.chapter_name;
    const qWords = new Set(q.split(' '));
    const overlap = name.split(' ').filter(w => w.length > 3 && qWords.has(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = c; }
  }
  return bestScore >= 2 ? best.chapter_name : chapterName;
}

// Knowledge-graph layer A (spec §7): EWMA mastery per (user, subject, chapter)
function recordEvidence(userId, subject, rawChapterName, evidence, weight = 0.35) {
  if (!userId) return;
  const chapterName = canonicalizeChapter(subject, rawChapterName);
  const cs = table('concept_state');
  const key = r => r.user_id === userId && r.subject === subject && r.chapter_name === chapterName;
  const row = cs.find(key);
  if (row) {
    cs.update(key, r => ({
      mastery: Math.min(1, Math.max(0, r.mastery + weight * (evidence - r.mastery))),
      evidence_count: (r.evidence_count || 0) + 1,
      last_evidence_at: new Date().toISOString(),
    }));
  } else {
    cs.insert({
      user_id: userId,
      subject,
      chapter_name: chapterName,
      mastery: Math.min(1, Math.max(0, 0.4 + weight * (evidence - 0.4))),
      evidence_count: 1,
      last_evidence_at: new Date().toISOString(),
    });
  }
}

app.post('/api/exam/save', (req, res) => {
  try {
    const { user_id, subject, chapter, data, input_token, output_token, total_token, evolve_comment, chat_type, chat_title } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const session = table('sessions').insert({
      user_id,
      chat_type: chat_type || 'exam',
      chat_title: chat_title || `${subject} - ${chapter} Exam`,
      content: { ...data, performance: evolve_comment?.performance },
      input_tokens: input_token || 0,
      output_tokens: output_token || 0,
      total_tokens: total_token || 0,
    });
    // Feed the knowledge graph: exam score is strong evidence
    if (data?.total_questions > 0) {
      recordEvidence(user_id, subject, chapter, (data.marks || 0) / data.total_questions, 0.5);
    }
    res.status(201).json({ success: true, exam: session });
  } catch (err) {
    console.error('[EXAM ERROR]', err.message);
    res.status(500).json({ error: 'Failed to save exam data.' });
  }
});

app.get('/api/kg/:userId', (req, res) => {
  res.json({ states: table('concept_state').filter(r => r.user_id === req.params.userId) });
});

/* ══════════════════════ NEWS (Home mode) ══════════════════════ */

app.get('/api/news', (req, res) => {
  const items = table('news').all()
    .slice()
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  res.json({ news: items });
});

// Agent-curated live feed (see server/services/newsAgent.js). Not DB-backed —
// in-memory, 6h TTL, scraped fresh from DuckDuckGo and ranked/summarized by
// an OpenRouter/NVIDIA-free model. `track` is JEE or NEET.
app.get('/api/news/live', async (req, res) => {
  try {
    const result = await getLiveNews(req.query.track || 'JEE');
    res.json(result);
  } catch (err) {
    console.error('News live error:', err);
    res.status(502).json({ error: 'Failed to fetch live news', detail: err.message });
  }
});

app.post('/api/news/refresh', async (req, res) => {
  try {
    const result = await getLiveNews(req.body?.track || 'JEE', { force: true });
    res.json(result);
  } catch (err) {
    console.error('News refresh error:', err);
    res.status(502).json({ error: 'Failed to refresh live news', detail: err.message });
  }
});

/* ══════════════════════ LEARN MODE ══════════════════════ */

app.get('/api/learn/chapters', (req, res) => {
  const chapters = table('learn_chapters').all().map(c => ({
    id: c.id,
    subject: c.subject,
    class_level: c.class_level,
    chapter_name: c.chapter_name,
    order_index: c.order_index,
    pyq_weightage: c.pyq_weightage,
    section_count: (c.sections || []).length,
  }));
  res.json({ chapters });
});

function findChapter(subject, chapterName) {
  const chapters = table('learn_chapters').filter(c => c.subject === subject);
  const q = (chapterName || '').toLowerCase();
  return chapters.find(c =>
    c.chapter_name.toLowerCase().includes(q) || q.includes(c.chapter_name.toLowerCase())
  ) || null;
}

app.post('/api/learn/raw_content', (req, res) => {
  const { subject, chapter_name } = req.body;
  const ch = findChapter(subject, chapter_name);
  if (!ch) return res.status(404).json({ detail: `Chapter '${chapter_name}' not found for ${subject}` });
  const sections = (ch.sections || []).map(s => ({ title: s.title, raw_text: s.raw_text }));
  if (!sections.length) return res.status(404).json({ detail: 'No sections in chapter' });
  res.json({ concept: sections[0], all_sections: sections });
});

async function personalizeSection(section, { subject, chapterName, personalization, simplify = false }) {
  const { text } = await llmChat({
    promptName: simplify ? 'learn.reteach' : 'learn.teach',
    sourceMode: 'learn',
    maxTokens: 3000,
    messages: [{
      role: 'user',
      content: `You are an expert ${subject} teacher covering "${chapterName}" for a CBSE Class 11 student preparing for JEE/NEET.

Rewrite the SECTION below as a ${simplify ? 'SIMPLER re-explanation (the student answered the last check incorrectly — use a different angle, more everyday analogies, smaller steps)' : 'personalized teaching explanation'}.
Student preference: "${personalization || 'Make it easy to understand'}".

Keep it faithful to the source. Use 3-6 short paragraphs separated by blank lines. End-of-section MCQ must test the core idea.

SECTION TITLE: ${section.title}
SECTION TEXT:
${section.raw_text}

Reply ONLY with this exact JSON (no markdown fences):
{
  "title": "${section.title.replace(/"/g, "'")}",
  "raw_text": "the personalized explanation, paragraphs separated by \\n\\n",
  "question": {
    "text": "one MCQ testing the core concept",
    "options": ["A", "B", "C", "D"],
    "correct_index": 0,
    "explanation": "why the correct option is right"
  }
}`,
    }],
  });
  const parsed = extractJson(text);
  if (parsed?.raw_text && parsed?.question?.options?.length >= 2) return parsed;
  // Fallback: serve source text with no question rather than failing the lesson
  return { title: section.title, raw_text: section.raw_text, question: null };
}

app.post('/api/learn/personalize_start', async (req, res) => {
  try {
    const { user_id, subject, chapter_name, personalization } = req.body;
    const ch = findChapter(subject, chapter_name);
    if (!ch) return res.status(404).json({ detail: `Chapter '${chapter_name}' not found for ${subject}` });
    const sections = (ch.sections || []).map(s => ({ title: s.title, raw_text: s.raw_text }));
    if (!sections.length) return res.status(404).json({ detail: 'No sections in chapter' });

    const concept = await personalizeSection(sections[0], { subject, chapterName: ch.chapter_name, personalization });
    const sessionId = `learn_${user_id}_${ch.id}`;
    res.json({ session_id: sessionId, concept, all_sections: sections });
  } catch (err) {
    console.error('[LEARN START ERROR]', err.message);
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/learn/evaluate_concept', async (req, res) => {
  try {
    const {
      user_id, subject, chapter_name, current_concept_index,
      user_answer_index, all_sections, personalization, question_data,
    } = req.body;

    const isCorrect = question_data && Number(user_answer_index) === Number(question_data.correct_index ?? question_data.correct ?? -1);

    // Knowledge-graph evidence: discussion answers are medium-weight (spec §4.3)
    recordEvidence(user_id, subject, chapter_name, isCorrect ? 0.85 : 0.2, 0.3);

    const sections = all_sections || [];
    let concept = null;
    let complete = false;

    if (isCorrect) {
      const nextIdx = current_concept_index + 1;
      if (nextIdx < sections.length) {
        concept = await personalizeSection(sections[nextIdx], { subject, chapterName: chapter_name, personalization });
      } else {
        complete = true;
      }
    } else {
      // Re-teach the same concept from a different angle
      const current = sections[current_concept_index] || sections[0];
      if (current) {
        concept = await personalizeSection(current, { subject, chapterName: chapter_name, personalization, simplify: true });
      }
    }

    res.json({ complete, concept, is_correct: isCorrect, explanation: question_data?.explanation || null });
  } catch (err) {
    console.error('[LEARN EVAL ERROR]', err.message);
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/learn/doubt_eval', async (req, res) => {
  try {
    const { query, context, history } = req.body;
    // RAG-grounded doubt answering: current section text + retrieved chunks
    const hits = retrieve(query, { topK: 3 });
    const extra = hits.map((h, i) => `[${i + 1}] (${h.header}) ${h.text}`).join('\n\n');

    const { text } = await llmChat({
      promptName: 'learn.doubt',
      sourceMode: 'learn',
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content: `You are a friendly tutor answering a doubt DURING a lesson. Be brief (2-5 sentences), conversational (this is read aloud), and grounded in the lesson material below. No markdown formatting, no bullet lists.

CURRENT LESSON PASSAGE:
${context || '(none)'}

RELATED CURRICULUM PASSAGES:
${extra || '(none)'}`,
        },
        ...(history || []).slice(-6).map(h => ({
          role: h.startsWith('Tutor:') ? 'assistant' : 'user',
          content: h.replace(/^(Tutor|Student):\s*/, ''),
        })),
        { role: 'user', content: query },
      ],
    });

    const intensity = /don'?t worry|great question|excellent/i.test(text) ? 'high' : 'low';
    res.json({ answer: text, intensity, citations: hits.map(h => h.header) });
  } catch (err) {
    console.error('[DOUBT ERROR]', err.message);
    res.status(500).json({ answer: 'I hit a snag reaching the AI service. Please try again.', intensity: 'low' });
  }
});

/* ══════════════════════ STUDY PLAN (spec §7, lite) ══════════════════════ */

app.get('/api/plan/:userId', (req, res) => {
  const userId = req.params.userId;
  const states = table('concept_state').filter(r => r.user_id === userId);
  const chapters = table('learn_chapters').all();

  const masteryOf = (subject, name) =>
    states.find(s => s.subject === subject && s.chapter_name === name)?.mastery ?? null;

  // Goal-backward lite: weak chapters first (FSRS-style urgency ∝ 1 - mastery),
  // then untouched chapters by PYQ weightage, then revision of strong ones.
  const tasks = chapters.map(ch => {
    const m = masteryOf(ch.subject, ch.chapter_name);
    const weight = ch.pyq_weightage === 'high' ? 1.0 : ch.pyq_weightage === 'medium' ? 0.7 : 0.4;
    let kind, urgency;
    if (m === null) { kind = 'learn'; urgency = 0.6 * weight; }
    else if (m < 0.45) { kind = 'reteach'; urgency = (1 - m) * weight + 0.3; }
    else if (m < 0.75) { kind = 'practice'; urgency = (1 - m) * weight + 0.1; }
    else { kind = 'revise'; urgency = (1 - m) * weight; }
    return {
      id: ch.id,
      subject: ch.subject,
      chapter_name: ch.chapter_name,
      mastery: m,
      kind,
      urgency: Number(urgency.toFixed(3)),
      pyq_weightage: ch.pyq_weightage,
      reason: m === null
        ? 'Not started yet — high exam weightage'
        : m < 0.45 ? 'Recent evidence shows weak understanding'
        : m < 0.75 ? 'Understanding is forming — practice will consolidate it'
        : 'Strong — light revision keeps retention above 90%',
    };
  }).sort((a, b) => b.urgency - a.urgency);

  res.json({ tasks, generated_at: new Date().toISOString() });
});

/* ══════════════════════ STATIC / BOOT ══════════════════════ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/api/books', express.static(path.join(__dirname, '..', 'utils', 'books')));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Evolve GM local server running on http://localhost:${PORT}`);
  });
}

export default app;
