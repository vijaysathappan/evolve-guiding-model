/**
 * LLMGateway (spec §8) — the ONLY place that talks to an LLM provider.
 * - OpenRouter chat completions (works with the key in .env)
 * - retry with exponential backoff, request timeout
 * - strips <think>/reasoning artifacts from reasoning models
 * - appends every call to the llm_log cost ledger
 */
import { table } from '../db.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Exported so other agents (e.g. the News agent pipeline) can report which
// model actually powered them, and so a single env var controls all of them.
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

function stripReasoning(text) {
  if (!text) return '';
  return text
    .replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .trim();
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

/**
 * chat({ messages, imageBase64, maxTokens, temperature, promptName, userId, sourceMode })
 * -> { text, usage: { prompt_tokens, completion_tokens, total_token } }
 */
export async function chat({
  messages,
  imageBase64 = null,
  maxTokens = 4096,
  temperature = 0.6,
  promptName = 'generic',
  userId = null,
  sourceMode = 'chat',
  timeoutMs = 90000,
  retries = 2,
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing in .env');

  // Attach image to the last user message when provided (data-URI or raw b64)
  const finalMessages = messages.map(m => ({ ...m }));
  if (imageBase64) {
    const last = finalMessages[finalMessages.length - 1];
    const url = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    last.content = [
      { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
      { type: 'image_url', image_url: { url } },
    ];
  }

  const body = {
    model: DEFAULT_MODEL,
    messages: finalMessages,
    max_tokens: maxTokens,
    temperature,
  };

  const started = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'Evolve GM',
        },
        body: JSON.stringify(body),
      }, timeoutMs);

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || `Provider HTTP ${res.status}`);
      }

      const raw = data.choices?.[0]?.message?.content || '';
      const text = stripReasoning(raw);
      const u = data.usage || {};
      const usage = {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_token: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      };

      table('llm_log').insert({
        user_id: userId,
        prompt_name: promptName,
        source_mode: sourceMode,
        model: DEFAULT_MODEL,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        latency_ms: Date.now() - started,
        error: null,
      });

      return { text, usage };
    } catch (err) {
      lastErr = err;
      console.warn(`[LLM] attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  table('llm_log').insert({
    user_id: userId,
    prompt_name: promptName,
    source_mode: sourceMode,
    model: DEFAULT_MODEL,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: Date.now() - started,
    error: lastErr?.message || 'unknown',
  });
  throw lastErr;
}

/** Extract the first JSON object from an LLM reply (registry-style tolerant parse). */
export function extractJson(text) {
  if (!text) return null;
  let raw = stripReasoning(text).replace(/```json|```/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  raw = raw.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    // Common LLM slip: trailing commas
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

export default { chat, extractJson };
