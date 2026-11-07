// Forge Command Center — shared Claude session store (WP A4, mission forge-systeem 2026-11-01).
//
// One durable map `conversationId -> { sessionId, model, cwd, createdAt, lastUsedAt, title,
// pendingFork }` in a single JSON file, shared by every surface that drives `claude -p`: the
// gateway chat (gateway-sessions.mjs binds it to the gateway data dir) and the Discord bot
// (discord/src/session-store.js is a thin adapter over this class). Before A4 the gateway had no
// session memory at all (every spawn was a fresh session) and Discord kept its own private copy.
//
// Pure module: only node:fs and node:path, no gateway imports, so the Discord package can load it.
//
// File format: `{ "version": 1, "sessions": { "<conversationId>": <record> } }`. The Discord bot's
// earlier format stored a bare session-id string per conversation (`{ "sessions": { "id": "sid" } }`);
// such legacy values are still read (normalised to a record), so an existing Discord state file
// keeps working without a migration step.
//
// Every operation re-reads the file: it is small, and a fresh read keeps two store instances (or two
// processes reading the same file) coherent. Writes are atomic (temp file + rename), so a crash never
// leaves a half-written state file.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SESSION_ENTRIES = 5000;
const MAX_KEY_LEN = 200;
const MAX_SESSION_ID_LEN = 200;
const MAX_FIELD_LEN = 1024;
const MAX_TITLE_LEN = 200;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function cleanString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > MAX_TITLE_LEN ? flat.slice(0, MAX_TITLE_LEN) : flat;
}

/** A conversation key the store accepts: a non-empty, bounded string with no control characters
 *  that cannot collide with an Object prototype property. */
export function isValidConversationKey(conversationId) {
  const key = cleanString(conversationId, MAX_KEY_LEN);
  return key !== null && key === conversationId && !FORBIDDEN_KEYS.has(key);
}

function isoOrNull(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Normalises one stored value (a record or a legacy bare session-id string) to a fresh record,
 *  or null when it carries no usable session id. */
export function normalizeSessionRecord(raw) {
  if (typeof raw === 'string') {
    const sessionId = cleanString(raw, MAX_SESSION_ID_LEN);
    return sessionId ? { sessionId, model: null, cwd: null, createdAt: null, lastUsedAt: null, title: null, pendingFork: false } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = cleanString(raw.sessionId, MAX_SESSION_ID_LEN);
  if (!sessionId) return null;
  return {
    sessionId,
    model: cleanString(raw.model, MAX_FIELD_LEN),
    cwd: cleanString(raw.cwd, MAX_FIELD_LEN),
    createdAt: isoOrNull(raw.createdAt),
    lastUsedAt: isoOrNull(raw.lastUsedAt),
    title: cleanTitle(raw.title),
    pendingFork: raw.pendingFork === true,
  };
}

export class SessionStore {
  constructor(filePath, { maxEntries = MAX_SESSION_ENTRIES } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('SessionStore needs a file path');
    this.filePath = filePath;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_SESSION_ENTRIES;
  }

  // Missing file = empty store. A corrupt file is an explicit error, never silently treated as
  // empty: the next write would otherwise wipe every stored session.
  loadMap() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return new Map();
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (err) {
      throw new Error('session store file is not valid JSON: ' + this.filePath + ' (' + err.message + ')');
    }
    const map = new Map();
    const sessions = data && typeof data === 'object' ? data.sessions : null;
    if (!sessions || typeof sessions !== 'object') return map;
    for (const [key, value] of Object.entries(sessions)) {
      if (!isValidConversationKey(key)) continue;
      const record = normalizeSessionRecord(value);
      if (record) map.set(key, record);
    }
    return map;
  }

  saveMap(map) {
    const sessions = {};
    for (const [key, record] of map) sessions[key] = record;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /** The full record for a conversation (a fresh copy), or null. */
  get(conversationId) {
    if (!isValidConversationKey(conversationId)) return null;
    const record = this.loadMap().get(conversationId);
    return record ? { ...record } : null;
  }

  /** Just the Claude session id for a conversation, or null. */
  getSessionId(conversationId) {
    const record = this.get(conversationId);
    return record ? record.sessionId : null;
  }

  /** Stores (or updates) the session for a conversation. `createdAt` is kept from an existing
   *  record, `lastUsedAt` is set to now, and a field left out keeps its stored value. Returns the
   *  stored record, or null when the key or session id is not acceptable. */
  set(conversationId, fields = {}) {
    if (!isValidConversationKey(conversationId)) return null;
    const sessionId = cleanString(fields.sessionId, MAX_SESSION_ID_LEN);
    if (!sessionId) return null;
    const map = this.loadMap();
    const prev = map.get(conversationId) || null;
    const now = new Date().toISOString();
    const pick = (name, cleaned) => (name in fields ? cleaned : prev ? prev[name] : null);
    const record = {
      sessionId,
      model: pick('model', cleanString(fields.model, MAX_FIELD_LEN)),
      cwd: pick('cwd', cleanString(fields.cwd, MAX_FIELD_LEN)),
      createdAt: prev && prev.createdAt ? prev.createdAt : now,
      lastUsedAt: now,
      title: pick('title', cleanTitle(fields.title)),
      pendingFork: fields.pendingFork === true,
    };
    map.delete(conversationId);
    map.set(conversationId, record);
    this.evictOverflow(map);
    this.saveMap(map);
    return { ...record };
  }

  /** Removes a conversation's session. Returns true when something was removed. */
  clear(conversationId) {
    if (!isValidConversationKey(conversationId)) return false;
    const map = this.loadMap();
    if (!map.delete(conversationId)) return false;
    this.saveMap(map);
    return true;
  }

  /** All sessions, newest `lastUsedAt` first, optionally filtered by a case-insensitive title
   *  substring (`query`) and bounded by `limit`. Each row is `{ conversationId, ...record }`. */
  list({ query = null, limit = null } = {}) {
    const needle = typeof query === 'string' && query.trim().length > 0 ? query.trim().toLowerCase() : null;
    const rows = [];
    for (const [conversationId, record] of this.loadMap()) {
      if (needle && !(record.title || '').toLowerCase().includes(needle)) continue;
      rows.push({ conversationId, ...record });
    }
    rows.sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
    return Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows;
  }

  /** Title search: `list({ query })` under its own name for callers that only search. */
  search(query, { limit = null } = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) return [];
    return this.list({ query, limit });
  }

  evictOverflow(map) {
    if (map.size <= this.maxEntries) return;
    const byAge = [...map.entries()].sort((a, b) => String(a[1].lastUsedAt || '').localeCompare(String(b[1].lastUsedAt || '')));
    for (const [key] of byAge.slice(0, map.size - this.maxEntries)) map.delete(key);
  }
}
