/**
 * NewsAgent — "Live News Updates" feed on the Home page (MainPad).
 *
 * Two small agents, both powered by DEFAULT_MODEL (OpenRouter, NVIDIA free
 * tier — see server/services/llm.js — no OpenAI/Gemini involved):
 *
 *   1. QueryPlannerAgent — turns a fixed set of "boundary" topics (exam
 *      dates, results, syllabus/policy changes, counseling, trending/
 *      sensational stories, ...) into fresh, dated DuckDuckGo search
 *      queries for the student's track (JEE/NEET), so the feed isn't just
 *      one query repeated — it's swept across every boundary every cycle.
 *   2. NewsCuratorAgent — reads everything scraped across all boundary
 *      queries in one pass, drops anything irrelevant/duplicate/low-value,
 *      scores what's left for importance/how "breaking" it is, and writes
 *      a short, engaging summary for each surviving item.
 *
 * Scraping itself is native (built-in `fetch` + a hand-rolled HTML parser
 * for DuckDuckGo's no-JS HTML results page) — no third-party search API,
 * no scraping-as-a-service. The curator agent never invents source URLs:
 * every item is resolved back to the exact link the scraper found, so
 * links can't be LLM-hallucinated.
 *
 * State is intentionally NOT persisted to the JSON datastore — it's an
 * in-memory cache per track with a 6h TTL. A background scheduler
 * refreshes both tracks every 6h; the frontend refresh button forces an
 * immediate (rate-limited) refresh using the same pipeline.
 */
import crypto from 'crypto';
import { chat, extractJson, DEFAULT_MODEL } from './llm.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FORCE_REFRESH_COOLDOWN_MS = 20 * 1000; // guard the refresh button against spamming the free LLM tier
const MAX_ITEMS = 12;
const SCRAPE_CONCURRENCY = 3;
const SCRAPE_TIMEOUT_MS = 12000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── boundary topics ─────────────────────────────────────────────────────────
// Every cycle sweeps ALL boundaries for the track (plus the shared board-exam
// boundary), never just one query, so the feed covers the whole "world" of
// the exam, not a single angle of it.
const BOUNDARIES = {
  JEE: [
    { category: 'JEE', label: 'exam dates & admit card', fallback: 'JEE Main admit card exam date news' },
    { category: 'JEE', label: 'results & counseling', fallback: 'JEE Main JoSAA counseling seat allotment news' },
    { category: 'JEE', label: 'syllabus & pattern changes', fallback: 'JEE Main JEE Advanced syllabus pattern change news' },
    { category: 'JEE', label: 'paper analysis & cutoff', fallback: 'JEE Main paper analysis cutoff news' },
    { category: 'JEE', label: 'high-impact / trending', fallback: 'JEE Advanced IIT admission breaking news' },
  ],
  NEET: [
    { category: 'NEET', label: 'exam dates & admit card', fallback: 'NEET UG admit card exam date news' },
    { category: 'NEET', label: 'results & counseling', fallback: 'NEET UG MCC counseling seat allotment news' },
    { category: 'NEET', label: 'syllabus & policy changes', fallback: 'NEET UG NMC syllabus policy change news' },
    { category: 'NEET', label: 'paper analysis & cutoff', fallback: 'NEET UG paper analysis cutoff news' },
    { category: 'NEET', label: 'high-impact / trending', fallback: 'NEET UG medical admission breaking news' },
  ],
};
const SHARED_BOUNDARY = { category: 'CBSE', label: 'board exam updates', fallback: 'CBSE board exam date sheet syllabus news' };

function normalizeTrack(track) {
  const t = String(track || 'JEE').toUpperCase();
  return BOUNDARIES[t] ? t : 'JEE';
}

// ── HTML parsing helpers (native, no cheerio/jsdom) ─────────────────────────
function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DuckDuckGo's HTML results wrap the real URL in a `/l/?uddg=<encoded>` redirect. */
export function resolveDdgHref(href) {
  if (!href) return null;
  let h = decodeEntities(href);
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return h;
  } catch {
    return h;
  }
}

/**
 * Parses DuckDuckGo's no-JS HTML results page into { title, url, snippet }[].
 * Pure/offline-testable — takes raw HTML text, returns structured results.
 */
export function parseDuckDuckGoHtml(html) {
  if (!html) return [];
  const results = [];
  const blocks = String(html).split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const url = resolveDdgHref(titleMatch[1]);
    const title = stripTags(titleMatch[2]);
    if (!url || !title) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* leave blank */ }
    results.push({ title, url, snippet, domain });
  }
  return results;
}

/** Best-effort "X days ago" / "Mon DD, YYYY" hint at the start of a DDG snippet. */
export function extractDateHint(snippet, now = new Date()) {
  if (!snippet) return now.toISOString();
  const rel = snippet.match(/^(\d+)\s+(hour|day|week|month)s?\s+ago/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unitMs = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[rel[2].toLowerCase()];
    return new Date(now.getTime() - n * unitMs).toISOString();
  }
  const abs = snippet.match(/^([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/);
  if (abs) {
    const d = new Date(abs[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function scrapeQuery(query, { fetchImpl = fetchWithTimeout } = {}) {
  const url = `${DDG_HTML_URL}?q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml',
        },
      }, SCRAPE_TIMEOUT_MS);
      if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
      const html = await res.text();
      return parseDuckDuckGoHtml(html);
    } catch (err) {
      if (attempt === 1) {
        console.warn(`[NewsAgent] scrape failed for "${query}": ${err.message}`);
        return [];
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return [];
}

/** Runs a batch of scrape jobs with a small concurrency cap — polite to DDG. */
async function scrapeAll(jobs, opts) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      const job = jobs[idx];
      const results = await scrapeQuery(job.query, opts);
      out.push(...results.map(r => ({ ...r, boundary: job.label, category: job.category })));
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCRAPE_CONCURRENCY, jobs.length) }, worker));
  return out;
}

// ── QueryPlannerAgent ────────────────────────────────────────────────────────
/**
 * Turns each boundary into a sharp, dated DuckDuckGo query via the LLM.
 * Falls back to the boundary's static template query if the agent call
 * fails or returns something unusable — the feed must never go empty just
 * because the free-tier model hiccupped.
 */
export async function planQueries(track, { chatFn = chat, now = new Date() } = {}) {
  const t = normalizeTrack(track);
  const boundaries = [...BOUNDARIES[t], SHARED_BOUNDARY];
  const dateCtx = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const fallbackQueries = boundaries.map(b => `${b.fallback} ${now.getFullYear()}`);

  try {
    const prompt = [
      { role: 'system', content: 'You write short, high-signal DuckDuckGo search queries for a student news feed. Reply with ONLY a JSON object, no prose.' },
      {
        role: 'user',
        content: `Today is ${dateCtx}. The student is preparing for ${t} (Indian competitive exam). ` +
          `For each of these ${boundaries.length} topic boundaries, write ONE concise, current search query ` +
          `(include the year, and "today"/"this week" style freshness words where it helps) that will surface ` +
          `recent real news, not generic study material:\n` +
          boundaries.map((b, i) => `${i + 1}. ${b.label}`).join('\n') +
          `\n\nReturn JSON exactly like: {"queries": ["query for boundary 1", "query for boundary 2", ...]} ` +
          `with exactly ${boundaries.length} strings, same order as listed.`,
      },
    ];
    const { text } = await chatFn({
      messages: prompt,
      maxTokens: 400,
      temperature: 0.4,
      promptName: 'news_query_planner',
      sourceMode: 'news_agent',
    });
    const parsed = extractJson(text);
    const queries = Array.isArray(parsed?.queries) ? parsed.queries.filter(q => typeof q === 'string' && q.trim()) : null;
    if (queries && queries.length === boundaries.length) {
      return boundaries.map((b, i) => ({ ...b, query: queries[i].trim() }));
    }
  } catch (err) {
    console.warn(`[NewsAgent] QueryPlannerAgent failed, using fallback templates: ${err.message}`);
  }
  return boundaries.map((b, i) => ({ ...b, query: fallbackQueries[i] }));
}

// ── dedupe ───────────────────────────────────────────────────────────────────
function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
}

/** Drops exact-URL and near-identical-title duplicates, first-seen wins. */
export function dedupeItems(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const out = [];
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (seenUrls.has(item.url) || seenTitles.has(key)) continue;
    seenUrls.add(item.url);
    seenTitles.add(key);
    out.push(item);
  }
  return out;
}

// ── NewsCuratorAgent ─────────────────────────────────────────────────────────
/**
 * Filters + ranks + summarizes the raw scraped items in ONE LLM call (cheap
 * on the free tier). The LLM only ever returns a `ref` index into `rawItems`
 * plus judgement fields — it never gets to invent the `source_url`, so links
 * shown to the user are always exactly what the scraper found.
 */
export async function curateAndSummarize(track, rawItems, { chatFn = chat, now = new Date() } = {}) {
  if (!rawItems.length) return [];
  const t = normalizeTrack(track);
  const listing = rawItems
    .map((r, i) => `[${i + 1}] (${r.category}/${r.boundary}, ${r.domain}) ${r.title} — ${r.snippet}`.slice(0, 400))
    .join('\n');

  const prompt = [
    {
      role: 'system',
      content: 'You are a news curator for competitive-exam students in India. Reply with ONLY a JSON object, no prose, no markdown fences.',
    },
    {
      role: 'user',
      content: `Track: ${t} (also accept CBSE board-exam news — same student base). Today: ${now.toDateString()}.\n\n` +
        `Below are raw web search snippets, numbered. For EACH item that is genuinely relevant, real news ` +
        `(not a generic guide, ad, or unrelated result), and not a duplicate of another item in this list:\n` +
        ` - write a short, engaging 1-2 sentence "headline" (<=90 chars) rewrite of the title\n` +
        ` - write a punchy 1-2 sentence "summary" that makes clear WHY it matters to the student\n` +
        ` - assign "category" as exactly one of: JEE, NEET, CBSE, General\n` +
        ` - assign "importance" 1-10 (10 = urgent/deadline/result/policy-change, 1 = minor/evergreen)\n` +
        ` - set "sensational" true if it's a breaking/high-attention story\n\n` +
        `Skip items that are irrelevant, spammy, or low-value — do not force every item into the output.\n\n` +
        listing +
        `\n\nReturn JSON exactly like: {"items": [{"ref": 1, "headline": "...", "summary": "...", "category": "JEE", "importance": 8, "sensational": true}, ...]}`,
    },
  ];

  const { text } = await chatFn({
    messages: prompt,
    maxTokens: 1800,
    temperature: 0.5,
    promptName: 'news_curator',
    sourceMode: 'news_agent',
  });
  const parsed = extractJson(text);
  const judged = Array.isArray(parsed?.items) ? parsed.items : [];

  const out = [];
  for (const j of judged) {
    const idx = Number(j.ref) - 1;
    const raw = rawItems[idx];
    if (!raw) continue; // never trust an out-of-range ref
    const category = ['JEE', 'NEET', 'CBSE', 'General'].includes(j.category) ? j.category : raw.category;
    const importance = Math.min(10, Math.max(1, Number(j.importance) || 5));
    const headline = (typeof j.headline === 'string' && j.headline.trim()) ? j.headline.trim().slice(0, 120) : raw.title;
    const summary = (typeof j.summary === 'string' && j.summary.trim()) ? j.summary.trim().slice(0, 400) : raw.snippet.slice(0, 300);
    out.push({
      id: crypto.createHash('md5').update(raw.url).digest('hex').slice(0, 16),
      title: headline,
      summary,
      category,
      importance,
      sensational: !!j.sensational,
      source_url: raw.url, // always native-scraped, never LLM-generated
      source_domain: raw.domain,
      published_at: extractDateHint(raw.snippet, now),
    });
  }
  return out;
}

function sortAndCap(items) {
  return dedupeItems(
    items.sort((a, b) => (b.importance - a.importance) || (Number(b.sensational) - Number(a.sensational)))
  ).slice(0, MAX_ITEMS);
}

// ── pipeline orchestration + cache ──────────────────────────────────────────
async function runPipeline(track, { chatFn, fetchImpl, now = new Date() } = {}) {
  const jobs = await planQueries(track, { chatFn, now });
  const raw = dedupeItems(await scrapeAll(jobs, { fetchImpl }));
  const curated = raw.length ? await curateAndSummarize(track, raw, { chatFn, now }) : [];
  const items = sortAndCap(curated);
  return {
    track: normalizeTrack(track),
    items,
    agent_model: DEFAULT_MODEL,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
    _expiresAtMs: now.getTime() + TTL_MS,
  };
}

const cache = new Map(); // track -> pipeline result
const inFlight = new Map(); // track -> Promise<result>
const lastForceAt = new Map(); // track -> ms timestamp

function stripInternal(entry) {
  const rest = { ...entry };
  delete rest._expiresAtMs;
  return rest;
}

/**
 * Returns the cached feed for a track, transparently regenerating it when
 * stale (or on `force`). Concurrent callers for the same track share one
 * in-flight regeneration. If regeneration fails, stale cache is served
 * rather than erroring out — the feed degrades gracefully.
 */
export async function getLiveNews(track = 'JEE', { force = false, chatFn, fetchImpl } = {}) {
  const key = normalizeTrack(track);
  const now = Date.now();
  const entry = cache.get(key);

  if (force) {
    const last = lastForceAt.get(key) || 0;
    if (now - last < FORCE_REFRESH_COOLDOWN_MS && entry) {
      return { ...stripInternal(entry), rate_limited: true };
    }
    lastForceAt.set(key, now);
  } else if (entry && entry._expiresAtMs > now) {
    return stripInternal(entry);
  }

  if (inFlight.has(key)) return stripInternal(await inFlight.get(key));

  const p = runPipeline(key, { chatFn, fetchImpl })
    .then(result => { cache.set(key, result); inFlight.delete(key); return result; })
    .catch(err => {
      inFlight.delete(key);
      console.error(`[NewsAgent] pipeline failed for ${key}: ${err.message}`);
      if (entry) return entry; // serve stale rather than fail the request
      throw err;
    });
  inFlight.set(key, p);
  return stripInternal(await p);
}

let schedulerStarted = false;
/** Proactively refreshes both tracks every 6h so users rarely hit a cold cache. */
export function startNewsScheduler({ delayMs = 5000, intervalMs = TTL_MS } = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = () => {
    for (const t of Object.keys(BOUNDARIES)) {
      getLiveNews(t, { force: true }).catch(err => console.error(`[NewsAgent] scheduled refresh failed for ${t}: ${err.message}`));
    }
  };
  setTimeout(run, delayMs);
  setInterval(run, intervalMs);
}

export const __internal = { normalizeTrack, BOUNDARIES, TTL_MS };
