/**
 * Local JSON datastore — replaces the dead Supabase project so the whole app
 * runs on localhost with zero external infrastructure (spec v2.1 Phase 0:
 * single write path; here the Node server is the single writer).
 *
 * Tables (arrays of rows keyed by id):
 *   users, sessions (chat/exam/solve sessions), news, learn_chapters,
 *   concept_state (knowledge-graph layer A+B lite), llm_log (cost ledger §8)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'evolve-db.json');

const EMPTY = {
  users: [],
  sessions: [],
  news: [],
  learn_chapters: [],
  concept_state: [],
  llm_log: [],
  plans: [],
};

let db = null;
let saveTimer = null;

export function uuid() {
  return crypto.randomUUID();
}

export function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } else {
      db = structuredClone(EMPTY);
    }
  } catch (err) {
    console.error('[DB] Failed to load db file, starting fresh:', err.message);
    db = structuredClone(EMPTY);
  }
  return db;
}

export function save() {
  // Debounced write so bursts of updates cost one disk write
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[DB] Save failed:', err.message);
    }
  }, 150);
}

export function saveNow() {
  clearTimeout(saveTimer);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
}

export const table = (name) => {
  load();
  if (!db[name]) db[name] = [];
  return {
    all: () => db[name],
    find: (pred) => db[name].find(pred) || null,
    filter: (pred) => db[name].filter(pred),
    insert: (row) => {
      const withId = { id: row.id || uuid(), created_at: row.created_at || new Date().toISOString(), ...row };
      withId.id = withId.id; // keep provided id if any
      db[name].push(withId);
      save();
      return withId;
    },
    update: (pred, patch) => {
      const rows = db[name].filter(pred);
      rows.forEach(r => Object.assign(r, typeof patch === 'function' ? patch(r) : patch));
      if (rows.length) save();
      return rows;
    },
    remove: (pred) => {
      const before = db[name].length;
      db[name] = db[name].filter(r => !pred(r));
      if (db[name].length !== before) save();
      return before - db[name].length;
    },
    count: () => db[name].length,
  };
};

export default { load, save, saveNow, table, uuid };
