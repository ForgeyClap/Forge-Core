#!/usr/bin/env node
'use strict';
/**
 * forge-prompt-moments.cjs — main-session moments (SD-T7, default skills Task 7;
 * design: .claude/docs/default-skills.md). forge-scribe-hook.cjs calls it on
 * every owner prompt and appends at most ONE directive line to its additionalContext:
 *   - vague_prompt: at least one vague hit (forge-promptcheck countVagueHits, Dutch forms included), no path or file
 *     token, prompt shorter than 400 characters -> the forge-prompt-coach directive;
 *   - new_work: a build verb ("bouw", "maak een", "build", "create", "nieuwe") and no path or file token -> the
 *     forge-brainstorm directive (autonomous form). A prompt that ends in a question mark is a question, not a build
 *     order, and gets no new_work line.
 * Slash commands, machine text (forge-scribe-classify machineSkip) and empty or non-string input get null.
 *
 * The directive text and skill come ONLY from the loader (forge-default-skills.cjs loadDefaults(root).data.moments),
 * never from a copy here. The research measured gentle hook hints at no better than no hook, so the loader's lines are
 * directives with a commitment step ("call X, state the result, then work"); a line over 300 characters is dropped.
 *
 * COST: pure and bounded. Only the first SCAN_MAX characters are read; the loader is read once per project root per
 * process (cached, also when it fails). Never throws.
 *
 * API: momentFor(text, opts?) -> {moment, skill, directive} | null. opts.root (the project root; falls back to this
 * copy's own project when that root has no usable moments), opts.data (a loaded defaults object, test seam),
 * opts.machineSkip (function, test seam).
 */
const path = require('path');

const VAGUE_MAX_CHARS = 400;
const SCAN_MAX = 4000;
const DIRECTIVE_MAX = 300;
const NEW_WORK_RE = /(?:^|[^\p{L}\p{N}_])(?:bouw|maak\s+een|build|create|nieuwe)(?![\p{L}\p{N}_])/iu;
const OWN_ROOT = path.resolve(__dirname, '..', '..');

const PC = (() => { try { return require('./forge-promptcheck.cjs'); } catch { return null; } })();
const CLASSIFY = (() => { try { return require('./forge-scribe-classify.cjs'); } catch { return null; } })();
const cache = new Map();

/** momentsOf(root) -> moments object or null; cached per root for the life of the process. */
function momentsOf(root) {
  const key = String(root || '');
  if (cache.has(key)) return cache.get(key);
  let moments = null;
  try {
    const D = require('./forge-default-skills.cjs').loadDefaults(key);
    const m = D && D.data && D.data.moments;
    if (m && typeof m === 'object' && !Array.isArray(m)) moments = m;
  } catch { moments = null; }
  cache.set(key, moments);
  return moments;
}

function pick(moments, name) {
  const def = moments && moments[name];
  if (!def || typeof def.skill !== 'string' || !def.skill || typeof def.directive !== 'string') return null;
  const directive = def.directive.replace(/\s+/g, ' ').trim();
  if (!directive || directive.length > DIRECTIVE_MAX) return null;
  return { moment: name, skill: def.skill, directive };
}

function isMachine(text, opts) {
  const fn = opts && typeof opts.machineSkip === 'function' ? opts.machineSkip : (CLASSIFY && typeof CLASSIFY.machineSkip === 'function' ? CLASSIFY.machineSkip : null);
  if (!fn) return false;
  try { return !!fn(text); } catch { return false; }
}

// Lead follow-up 2026-11-08: the owner types new work AFTER /forge and chains routing commands ("/forge /goal
// /superpowers:brainstorming ik wil ..."), so the text after the leading slash words is judged. A bare subcommand
// ("/forge status", "/forge remember ...", "/forge config ...") and a short harness command ("/model opus") stay null.
const FORGE_SUBCOMMANDS = new Set(['status', 'runs', 'dashboard', 'start', 'use', 'open-report', 'config', 'resume', 'learn',
  'remember', 'snapshot', 'approve-skill', 'stop', 'pause', 'init', 'doctor', 'help', 'install', 'sync', 'update', 'report']);
const MIN_FREE_WORDS = 3;
/** freeTextOf(trimmed) -> the prompt text with its leading slash commands removed, or null when nothing judgeable is
 *  left (a subcommand, or fewer than MIN_FREE_WORDS words). Text without a leading slash is returned as it is. */
function freeTextOf(trimmed) {
  if (!trimmed.startsWith('/')) return trimmed;
  const rest = trimmed.replace(/^(?:\/[^\s/]+\s*)+/, '').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length < MIN_FREE_WORDS || FORGE_SUBCOMMANDS.has(words[0].toLowerCase())) return null;
  return rest;
}

/** momentFor(text, opts?) — see the header. Never throws. */
function momentFor(text, opts) {
  try {
    if (typeof text !== 'string') return null;
    const trimmed = freeTextOf(text.trim());
    if (!trimmed) return null;
    if (!PC || typeof PC.countVagueHits !== 'function' || typeof PC.hasPathOrFileToken !== 'function') return null;
    const scan = trimmed.slice(0, SCAN_MAX);
    if (PC.hasPathOrFileToken(scan)) return null;
    if (isMachine(trimmed.slice(0, SCAN_MAX * 2), opts)) return null;
    let name = null;
    if (trimmed.length < VAGUE_MAX_CHARS && PC.countVagueHits(scan) >= 1) name = 'vague_prompt';
    else if (NEW_WORK_RE.test(scan) && !/\?\s*$/.test(trimmed)) name = 'new_work';
    if (!name) return null;
    const o = opts || {};
    let moments = o.data && o.data.moments ? o.data.moments : null;
    if (!moments && o.root) moments = momentsOf(path.resolve(o.root));
    if (!moments || !pick(moments, name)) moments = momentsOf(OWN_ROOT);
    return pick(moments, name);
  } catch { return null; }
}

module.exports = { momentFor, VAGUE_MAX_CHARS, DIRECTIVE_MAX, SCAN_MAX };
