/**
 * Offline unit tests for the News agent pipeline (server/services/newsAgent.js).
 *
 * These deliberately never hit the real network or the real LLM — every
 * agent call is injected via `chatFn`/`fetchImpl` so the suite is fast,
 * deterministic, and runnable in environments without outbound internet
 * access (the scraper and the OpenRouter call still work exactly the same
 * way against the real network when `chatFn`/`fetchImpl` are left at their
 * defaults, which is how server.js actually calls this module).
 *
 * Run with: node --test server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuckDuckGoHtml,
  resolveDdgHref,
  extractDateHint,
  dedupeItems,
  planQueries,
  curateAndSummarize,
  getLiveNews,
  __internal,
} from './newsAgent.js';

// ── fixtures ─────────────────────────────────────────────────────────────────
const DDG_FIXTURE = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fjee-main-2026-admit-card&amp;rut=abc">JEE Main 2026 admit card <b>released</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">3 days ago — NTA has released the admit card for JEE Main 2026 session 1 candidates.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanother.example.com%2Fneet-counseling&amp;rut=def">NEET counseling round 2 seat allotment</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=y">MCC has published the round-2 seat allotment for NEET UG counseling.</a>
  </div>
</div>
</body></html>
`;

test('parseDuckDuckGoHtml extracts title, resolved url, snippet, domain', () => {
  const results = parseDuckDuckGoHtml(DDG_FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'JEE Main 2026 admit card released');
  assert.equal(results[0].url, 'https://news.example.com/jee-main-2026-admit-card');
  assert.equal(results[0].domain, 'news.example.com');
  assert.match(results[0].snippet, /admit card for JEE Main 2026/);
  assert.equal(results[1].domain, 'another.example.com');
});

test('parseDuckDuckGoHtml returns [] for empty/garbage input', () => {
  assert.deepEqual(parseDuckDuckGoHtml(''), []);
  assert.deepEqual(parseDuckDuckGoHtml('<html><body>no results here</body></html>'), []);
});

test('resolveDdgHref decodes the uddg redirect param', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1&rut=xyz';
  assert.equal(resolveDdgHref(href), 'https://example.com/path?a=1');
});

test('resolveDdgHref passes through a plain absolute url unchanged', () => {
  assert.equal(resolveDdgHref('https://example.com/foo'), 'https://example.com/foo');
});

test('resolveDdgHref handles null/empty gracefully', () => {
  assert.equal(resolveDdgHref(null), null);
  assert.equal(resolveDdgHref(''), null);
});

test('extractDateHint parses "N days ago" relative to a fixed now', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const iso = extractDateHint('3 days ago — something happened', now);
  assert.equal(iso, new Date('2026-09-25T12:00:00.000Z').toISOString());
});

test('extractDateHint parses an absolute "Mon DD, YYYY" date', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const iso = extractDateHint('Sep 20, 2026 — something happened', now);
  assert.equal(new Date(iso).toISOString().slice(0, 10), '2026-09-20');
});

test('extractDateHint falls back to now when no date hint is present', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  assert.equal(extractDateHint('no date here at all', now), now.toISOString());
  assert.equal(extractDateHint('', now), now.toISOString());
});

test('dedupeItems drops exact-url duplicates and near-identical titles', () => {
  const items = [
    { title: 'JEE Main 2026 admit card released today', url: 'https://a.com/1' },
    { title: 'JEE Main 2026 admit card released today!!', url: 'https://a.com/1-mirror' }, // same normalized title
    { title: 'JEE Main 2026 admit card released today', url: 'https://a.com/1' }, // exact dupe url
    { title: 'Completely different NEET counseling story', url: 'https://b.com/2' },
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://a.com/1');
  assert.equal(out[1].url, 'https://b.com/2');
});

test('normalizeTrack defaults unknown tracks to JEE', () => {
  assert.equal(__internal.normalizeTrack('neet'), 'NEET');
  assert.equal(__internal.normalizeTrack('jee'), 'JEE');
  assert.equal(__internal.normalizeTrack('bogus'), 'JEE');
  assert.equal(__internal.normalizeTrack(undefined), 'JEE');
});

test('planQueries (QueryPlannerAgent) uses the LLM query for every boundary when it returns valid JSON', async () => {
  const boundaryCount = __internal.BOUNDARIES.JEE.length + 1; // + shared CBSE boundary
  const fakeChat = async () => ({
    text: JSON.stringify({ queries: Array.from({ length: boundaryCount }, (_, i) => `custom query ${i + 1}`) }),
    usage: {},
  });
  const jobs = await planQueries('JEE', { chatFn: fakeChat, now: new Date('2026-09-28') });
  assert.equal(jobs.length, boundaryCount);
  assert.equal(jobs[0].query, 'custom query 1');
  assert.ok(jobs.every(j => j.category && j.label));
});

test('planQueries falls back to static templates when the agent call throws', async () => {
  const failingChat = async () => { throw new Error('provider down'); };
  const jobs = await planQueries('NEET', { chatFn: failingChat, now: new Date('2026-09-28') });
  assert.equal(jobs.length, __internal.BOUNDARIES.NEET.length + 1);
  // fallback queries are built from the boundary's static template + year
  assert.ok(jobs[0].query.includes('2026'));
});

test('planQueries falls back when the agent returns malformed/short JSON', async () => {
  const badChat = async () => ({ text: '{"queries": ["only one"]}', usage: {} });
  const jobs = await planQueries('JEE', { chatFn: badChat, now: new Date('2026-09-28') });
  assert.equal(jobs.length, __internal.BOUNDARIES.JEE.length + 1);
});

test('curateAndSummarize (NewsCuratorAgent) resolves ref back to the real scraped url, never trusts an LLM-provided link', async () => {
  const raw = [
    { title: 'Raw title one', snippet: 'raw snippet one', url: 'https://real-source.com/one', domain: 'real-source.com', category: 'JEE', boundary: 'exam dates' },
    { title: 'Raw title two', snippet: 'raw snippet two', url: 'https://real-source.com/two', domain: 'real-source.com', category: 'JEE', boundary: 'results' },
  ];
  const fakeChat = async () => ({
    text: JSON.stringify({
      items: [
        { ref: 1, headline: 'Punchy headline', summary: 'Why it matters.', category: 'JEE', importance: 9, sensational: true },
        // ref 2 intentionally omitted -> should be filtered out by the curator, not force-included
        { ref: 99, headline: 'Should be dropped', summary: 'out of range ref', category: 'JEE', importance: 10, sensational: true },
      ],
    }),
    usage: {},
  });
  const out = await curateAndSummarize('JEE', raw, { chatFn: fakeChat, now: new Date('2026-09-28') });
  assert.equal(out.length, 1);
  assert.equal(out[0].source_url, 'https://real-source.com/one'); // native-scraped, not LLM text
  assert.equal(out[0].title, 'Punchy headline');
  assert.equal(out[0].importance, 9);
  assert.ok(out[0].id); // stable id derived from the url
});

test('curateAndSummarize returns [] when there is nothing scraped', async () => {
  const out = await curateAndSummarize('JEE', [], { chatFn: async () => ({ text: '{}' }) });
  assert.deepEqual(out, []);
});

test('curateAndSummarize falls back to the raw title/snippet when the agent omits them', async () => {
  const raw = [{ title: 'Fallback title', snippet: 'Fallback snippet', url: 'https://x.com/1', domain: 'x.com', category: 'NEET', boundary: 'results' }];
  const fakeChat = async () => ({ text: JSON.stringify({ items: [{ ref: 1, importance: 6 }] }), usage: {} });
  const out = await curateAndSummarize('NEET', raw, { chatFn: fakeChat });
  assert.equal(out[0].title, 'Fallback title');
  assert.equal(out[0].summary, 'Fallback snippet');
});

test('getLiveNews end-to-end with fully injected agents/scraper produces a ranked, capped, JSON-safe feed', async () => {
  // force:true bypasses any cache another test in this file may have left behind for JEE.
  let scrapeCalls = 0;
  const fakeFetch = async (url) => {
    scrapeCalls++;
    return {
      ok: true,
      text: async () => DDG_FIXTURE,
    };
  };
  const fakeChat = async ({ promptName }) => {
    if (promptName === 'news_query_planner') {
      const n = __internal.BOUNDARIES.JEE.length + 1;
      return { text: JSON.stringify({ queries: Array.from({ length: n }, (_, i) => `q${i}`) }) };
    }
    return {
      text: JSON.stringify({
        items: [
          { ref: 1, headline: 'A', summary: 's', category: 'JEE', importance: 5, sensational: false },
          { ref: 2, headline: 'B', summary: 's', category: 'NEET', importance: 8, sensational: true },
        ],
      }),
    };
  };

  const result = await getLiveNews('JEE', { force: true, chatFn: fakeChat, fetchImpl: fakeFetch });
  assert.equal(result.track, 'JEE');
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length <= 12);
  // sorted by importance desc
  if (result.items.length > 1) {
    assert.ok(result.items[0].importance >= result.items[1].importance);
  }
  assert.ok(result.agent_model); // the LLM is named in the response
  assert.ok(result.generated_at);
  assert.ok(scrapeCalls > 0);
  // JSON-serializable (no internal fields leak to the API response)
  assert.equal(JSON.stringify(result).includes('_expiresAtMs'), false);
});

test('getLiveNews serves cache on the second call within the TTL without re-invoking the agents', async () => {
  const track = 'NEET'; // untouched by the other getLiveNews test in this file, so its cache starts empty
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: true, text: async () => DDG_FIXTURE }; };
  const fakeChat = async ({ promptName }) => {
    calls++;
    if (promptName === 'news_query_planner') {
      const n = __internal.BOUNDARIES.JEE.length + 1;
      return { text: JSON.stringify({ queries: Array.from({ length: n }, (_, i) => `q${i}`) }) };
    }
    return { text: JSON.stringify({ items: [{ ref: 1, headline: 'A', summary: 's', category: 'JEE', importance: 5 }] }) };
  };

  await getLiveNews(track, { chatFn: fakeChat, fetchImpl: fakeFetch });
  const callsAfterFirst = calls;
  await getLiveNews(track, { chatFn: fakeChat, fetchImpl: fakeFetch });
  assert.equal(calls, callsAfterFirst, 'second call within TTL must not re-scrape or re-call the LLM');
});
