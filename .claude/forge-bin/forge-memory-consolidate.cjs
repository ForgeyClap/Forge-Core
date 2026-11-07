#!/usr/bin/env node
'use strict';
/**
 * forge-memory-consolidate.cjs — zero-loss memory consolidation (modernization plan item 1.4).
 * Zero-dependency (fs/path/crypto). DRY-RUN BY DEFAULT: nothing is written without `--apply`.
 *
 * What it does (memory model: FORGE_MEMORY.md current state · per-Boss lessons <=200 lines · dated verbatim
 * archives with sha256 · LESSONS.md <=200 lines distilled with evidence pointers):
 *   1. ROTATE `.claude/FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`, `FORGE_DECISIONS.md` when larger than
 *      50 KB. The preamble (title, and for decisions the founding table) and the NEWEST `## ` sections (by the
 *      latest date in the heading, ties by file position) stay in place, in their original order, until the
 *      live file is about 30 KB. All other sections move VERBATIM (byte-exact) to `<NAME>_ARCHIVE_<YYYY-MM>.md`
 *      beside it. A small pointer block (HTML-comment fenced, no `## ` heading so newest-first readers such as
 *      forge-snapshot never mistake it for an entry) names every archive.
 *   2. DISTILL each `.claude/agent-memory/<boss>/MEMORY.md` above 20 KB (or above 200 lines): the whole file
 *      moves verbatim to `lessons-archive-<YYYY-MM-DD>.md` beside it, and the live file becomes <=200 lines of
 *      literal lesson openings (a prefix of the source text, never rewritten), each with its archive line.
 *   3. BUILD `.claude/LESSONS.md` (<=200 lines): lesson | evidence pointer | date, taken only from source text
 *      (agent-memory lessons.jsonl records, dated MEMORY.md lines, decision lines that say they supersede an
 *      earlier one). Identical lessons are merged and counted; 3+ repeats are marked as preference candidates.
 *
 * DATA-LOSS RULES (enforced in code, not prose): every archive starts with a header recording the source file,
 * UTC time, line count and sha256 of the exact moved bytes; before any write the plan is verified by
 * RECONSTRUCTING the original bytes from (archive body + live file minus pointer block) and comparing sha256 and
 * line count; files are written to temp, read back, renamed, then verified again from disk (on failure the live
 * file is restored and the new archive removed). A live file that changed after planning is refused. Every live
 * file is copied to `_scratch/memory-preconsolidate/` (never overwriting an earlier copy) before it is touched.
 * Idempotent: a second run finds nothing over the limits and an identical LESSONS.md, and writes nothing.
 *
 * CLI: node forge-memory-consolidate.cjs [--apply] [--only <file>] [--root <dir>] [--json] [--now <iso>]
 *      node forge-memory-consolidate.cjs verify <archive-file>      (recompute an archive's sha256 + line count)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROTATE_FILES = ['FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md'];
const ROTATE_THRESHOLD = 50 * 1024;
const KEEP_TARGET = 30 * 1024;
const MEMORY_THRESHOLD = 20 * 1024;
const MEMORY_MAX_LINES = 200;
const MEMORY_TARGET_BYTES = 18 * 1024;
const LESSONS_MAX_LINES = 200;
const LESSON_TEXT_CAP = 220;
const MARKER = '<!-- forge-archive-verbatim-begin -->';
const PTR_BEGIN = '<!-- forge-archive-pointer-begin -->';
const PTR_END = '<!-- forge-archive-pointer-end -->';
const SUPERSEDE_RE = /\bsupersede[sd]?\b|\bsupersedeert\b|\bvervangt\b|\bKEERT OM\b/i;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

// WP 2.1 (opt-in .forge layout): memory files come from forge-paths.cjs memoryFile — .forge/memory only in a project
// with a .forge folder (or FORGE_STATE_DIR), otherwise exactly .claude/<name>. A history/ledger/decisions file is
// rotated WHERE IT IS (its read path; the archive goes beside it), so this tool never moves a file between layouts.
// LESSONS.md is written to its active path. agent-memory/ is Claude Code's own folder and stays in .claude. Guarded:
// an older or missing forge-paths.cjs keeps the legacy literals.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.memoryFile === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function viaForgePaths(fn, legacy) { if (forgePaths) { try { return fn(forgePaths); } catch { /* unresolvable root or canon: legacy */ } } return legacy(); }
const relPosix = (root, p) => path.relative(root, p).split(path.sep).join('/');
function memFile(root, name, read) { return viaForgePaths((P) => P.memoryFile(root, name, { read: !!read }), () => path.join(root, '.claude', name)); }
/** memoryDirsOf(root) -> the folders that hold memory files, active first (legacy layout: just .claude). */
function memoryDirsOf(root) { return viaForgePaths((P) => { const d = P.existingStateDirs(root, 'memory'); return d.length ? d : [P.stateDir(root, 'memory')]; }, () => [path.join(root, '.claude')]); }

/** splitLines — byte-exact: each element keeps its own '\n' (and '\r'); concat(result) === input. */
function splitLines(buf) {
  const out = []; let s = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { out.push(buf.subarray(s, i + 1)); s = i + 1; }
  if (s < buf.length) out.push(buf.subarray(s));
  return out;
}
const str = (l) => l.toString('utf8').replace(/\r?\n$/, '');
function eolOf(lines) { return lines.length && /\r\n$/.test(lines[0].toString('utf8')) ? '\r\n' : '\n'; }
function maxDate(s) { const m = s.match(DATE_RE); return m ? m.sort().pop() : null; }

/** stripPointer — removes the tool's own pointer block; returns { lines, at, entries } (at = index or -1). */
function stripPointer(lines) {
  const b = lines.findIndex((l) => str(l) === PTR_BEGIN);
  if (b === -1) return { lines, at: -1, entries: [] };
  let e = b + 1; while (e < lines.length && str(lines[e]) !== PTR_END) e++;
  if (e >= lines.length) throw new Error('pointer block has no end marker');
  const entries = lines.slice(b + 1, e).map(str).filter((s) => /^> - \[/.test(s));
  return { lines: lines.slice(0, b).concat(lines.slice(e + 1)), at: b, entries };
}

function parseSections(lines) {
  const heads = []; lines.forEach((l, i) => { if (/^## /.test(str(l))) heads.push(i); });
  const pre = heads.length ? heads[0] : lines.length;
  const sections = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const bytes = lines.slice(h, end).reduce((n, l) => n + l.length, 0);
    return { index: k, start: h, end, heading: str(lines[h]), date: maxDate(str(lines[h])), bytes };
  });
  return { preambleEnd: pre, sections };
}

function archiveHeader(o) {
  const L = [
    '# ' + o.title + ' (verbatim, read-only)', '',
    '> Source file: `' + o.source + '`',
    '> Moved on (UTC): ' + o.when + ' by forge-memory-consolidate.cjs',
    '> Moved bytes: ' + o.bytes + ' · lines: ' + o.lines + ' · sha256: `' + o.sha + '`',
    '> Source before this step: ' + o.srcBytes + ' bytes, ' + o.srcLines + ' lines, sha256 `' + o.srcSha + '`',
    '> Original line ranges moved (1-based, inclusive): ' + o.ranges,
    '> Verify: the sha256 of the bytes after the marker line must equal the sha256 above. Do not edit below the marker.',
    '', MARKER];
  return Buffer.from(L.join(o.eol) + o.eol, 'utf8');
}

/** readArchive — parses + verifies an archive buffer. Returns { ok, body, sha, lines, ranges, headerLines, reason }. */
function readArchive(buf) {
  const lines = splitLines(buf);
  const mi = lines.findIndex((l) => str(l) === MARKER);
  if (mi === -1) return { ok: false, reason: 'no marker line' };
  const head = lines.slice(0, mi).map(str).join('\n');
  const m = head.match(/Moved bytes: (\d+) · lines: (\d+) · sha256: `([0-9a-f]{64})`/);
  if (!m) return { ok: false, reason: 'header has no bytes/lines/sha256' };
  const body = Buffer.concat(lines.slice(mi + 1));
  const rm = head.match(/line ranges moved \(1-based, inclusive\): (.*)/);
  const ranges = rm ? rm[1].split(',').map((r) => r.trim().split('-').map(Number)) : [];
  const got = { sha: sha256(body), lines: lines.length - mi - 1, bytes: body.length };
  const ok = got.sha === m[3] && got.lines === Number(m[2]) && got.bytes === Number(m[1]);
  return { ok, body, sha: got.sha, lines: got.lines, bytes: got.bytes, ranges, headerLines: mi + 1,
    reason: ok ? null : 'recomputed ' + JSON.stringify(got) + ' != header ' + JSON.stringify({ sha: m[3], lines: +m[2], bytes: +m[1] }) };
}

/** reconstruct — original bytes from (live minus pointer, archive body + its ranges). Pure; used before AND after writing. */
function verifyRotation(liveBuf, archiveBuf, origBuf) {
  const a = readArchive(archiveBuf);
  if (!a.ok) return { ok: false, reason: 'archive: ' + a.reason };
  const live = stripPointer(splitLines(liveBuf)).lines;
  const orig = stripPointer(splitLines(origBuf)).lines;
  const arch = splitLines(a.body);
  if (arch.length + live.length !== orig.length) {
    return { ok: false, reason: 'line count ' + arch.length + ' + ' + live.length + ' != ' + orig.length };
  }
  const moved = new Set(); a.ranges.forEach(([s, e]) => { for (let i = s; i <= e; i++) moved.add(i - 1); });
  if (moved.size !== arch.length) return { ok: false, reason: 'ranges cover ' + moved.size + ' lines, archive body has ' + arch.length };
  const out = []; let ai = 0, li = 0;
  for (let i = 0; i < orig.length; i++) out.push(moved.has(i) ? arch[ai++] : live[li++]);
  const rebuilt = Buffer.concat(out), want = Buffer.concat(orig);
  if (sha256(rebuilt) !== sha256(want)) return { ok: false, reason: 'reconstructed sha256 differs from the original' };
  return { ok: true, archiveLines: arch.length, liveBodyLines: live.length, originalLines: orig.length };
}

function freeName(dir, base, suffixes) {
  for (const s of suffixes) { if (!fs.existsSync(path.join(dir, base(s)))) return base(s); }
  throw new Error('no free archive name in ' + dir);
}
const SUFFIXES = ['', '-b', '-c', '-d', '-e', '-f', '-g', '-h'];

/** planRotation — returns null (no action) or a plan { kind, livePath, origBuf, newLiveBuf, archivePath, archiveBuf, report }.
 *  claudeDir = the folder that holds the live file (the archive goes beside it); relPrefix = its project-relative
 *  pointer prefix for the header and report (default '.claude/', the legacy layout — WP 2.1). */
function planRotation(claudeDir, name, nowIso, relPrefix) {
  const pre = typeof relPrefix === 'string' ? relPrefix : '.claude/';
  const livePath = path.join(claudeDir, name);
  if (!fs.existsSync(livePath)) return { skip: 'missing', livePath };
  const origBuf = fs.readFileSync(livePath);
  if (origBuf.length <= ROTATE_THRESHOLD) return { skip: 'under ' + ROTATE_THRESHOLD + ' bytes', livePath, size: origBuf.length };
  const all = splitLines(origBuf); const eol = eolOf(all);
  const { lines, at, entries } = stripPointer(all);
  const { preambleEnd, sections } = parseSections(lines);
  const order = sections.slice().sort((x, y) => ((y.date || '9999') > (x.date || '9999') ? 1 : (y.date || '9999') < (x.date || '9999') ? -1 : y.index - x.index));
  const keep = new Set(); let total = lines.slice(0, preambleEnd).reduce((n, l) => n + l.length, 0) + 600;
  for (const s of order) { if (keep.size && total + s.bytes > KEEP_TARGET) break; keep.add(s.index); total += s.bytes; }
  const moved = sections.filter((s) => !keep.has(s.index));
  if (!moved.length) return { skip: 'nothing older to move', livePath, size: origBuf.length };
  const ranges = []; moved.forEach((s) => {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === s.start) last[1] = s.end; else ranges.push([s.start, s.end]);
  });
  const body = Buffer.concat(moved.flatMap((s) => lines.slice(s.start, s.end)));
  const base = name.replace(/\.md$/, '');
  const archiveName = freeName(claudeDir, (sfx) => base + '_ARCHIVE_' + nowIso.slice(0, 7) + sfx + '.md', SUFFIXES);
  const header = archiveHeader({ title: base + ' archive ' + nowIso.slice(0, 7), source: pre + name, when: nowIso,
    bytes: body.length, lines: splitLines(body).length, sha: sha256(body), srcBytes: origBuf.length, srcLines: lines.length,
    srcSha: sha256(Buffer.concat(lines)), ranges: ranges.map(([s, e]) => (s + 1) + '-' + e).join(', '), eol });
  const archiveBuf = Buffer.concat([header, body]);
  const ptr = [PTR_BEGIN, '> Older entries were moved verbatim (nothing deleted) by forge-memory-consolidate.cjs. Search these archives for anything not below:']
    .concat(entries, ['> - [' + archiveName + '](' + archiveName + ') — ' + nowIso.slice(0, 10) + ', ' + moved.length + ' sections, ' + splitLines(body).length + ' lines, sha256 `' + sha256(body).slice(0, 16) + '…`', PTR_END])
    .map((s) => Buffer.from(s + eol, 'utf8'));
  const keptLines = lines.slice(0, preambleEnd).concat(sections.filter((s) => keep.has(s.index)).flatMap((s) => lines.slice(s.start, s.end)));
  const insertAt = at !== -1 && at <= preambleEnd ? at : preambleEnd;
  const newLiveBuf = Buffer.concat(keptLines.slice(0, insertAt).concat(ptr, keptLines.slice(insertAt)));
  return { kind: 'rotate', name, livePath, origBuf, newLiveBuf, archivePath: path.join(claudeDir, archiveName), archiveBuf,
    verify: (live, arch) => verifyRotation(live, arch, origBuf),
    report: { file: pre + name, beforeBytes: origBuf.length, beforeLines: all.length, sections: sections.length,
      keptSections: keep.size, movedSections: moved.length, archive: pre + archiveName, archiveBodyLines: splitLines(body).length,
      afterBytes: newLiveBuf.length, afterLines: splitLines(newLiveBuf).length, pointerLines: ptr.length } };
}

/** excerpt — a literal prefix of the source text (first sentence when it fits), never rewritten. */
function excerpt(text, cap) {
  const chars = Array.from(text.trim());
  if (chars.length <= cap) return chars.join('');
  const head = chars.slice(0, cap).join('');
  const re = /[.!?](?=\s)/g; let m;
  while ((m = re.exec(head)) !== null) {
    const upto = head.slice(0, m.index + 1);
    if (upto.length >= 40 && !/\b(e\.g|i\.e|etc|vs|cf|bijv|o\.a|nl|resp)\.$/i.test(upto)) return upto;
  }
  const cut = head.lastIndexOf(' ');
  return (cut > cap / 2 ? head.slice(0, cut) : head) + ' …';
}

function distillLines(srcLines, archiveName, headerLines, cap, nowIso, meta) {
  const title = srcLines.map(str).find((s) => /^# /.test(s)) || '# ' + meta.boss + ' — Memory Index';
  const out = [title, '', '> Distilled ' + nowIso.slice(0, 10) + ' by forge-memory-consolidate.cjs: the full previous file (' + meta.lines +
    ' lines, ' + meta.bytes + ' bytes, sha256 `' + meta.sha.slice(0, 16) + '…`) is verbatim in [' + archiveName + '](' + archiveName +
    '). Each line below is the literal opening of one lesson; follow its archive line for the full text. Add new lessons below.', ''];
  srcLines.forEach((l, i) => {
    const s = str(l);
    if (/^#{2,3} /.test(s)) out.push(s);
    else if (/^- /.test(s)) out.push('- ' + excerpt(s.slice(2), cap) + ' — [' + archiveName + ' L' + (headerLines + i + 1) + '](' + archiveName + ')');
    else if (/^\d{4}-\d{2}-\d{2} /.test(s)) out.push(s.slice(0, 11) + excerpt(s.slice(11), cap) + ' — [' + archiveName + ' L' + (headerLines + i + 1) + '](' + archiveName + ')');
  });
  return out;
}

function planMemory(memPath, nowIso) {
  if (!fs.existsSync(memPath)) return { skip: 'missing', livePath: memPath };
  const origBuf = fs.readFileSync(memPath); const src = splitLines(origBuf); const eol = eolOf(src);
  if (origBuf.length <= MEMORY_THRESHOLD && src.length <= MEMORY_MAX_LINES) return { skip: 'under limits', livePath: memPath, size: origBuf.length };
  const dir = path.dirname(memPath); const day = nowIso.slice(0, 10);
  const archiveName = freeName(dir, (sfx) => 'lessons-archive-' + day + sfx + '.md', SUFFIXES);
  const rel = '.claude/agent-memory/' + path.basename(dir) + '/MEMORY.md';
  const header = archiveHeader({ title: path.basename(dir) + ' MEMORY archive ' + day, source: rel, when: nowIso, bytes: origBuf.length,
    lines: src.length, sha: sha256(origBuf), srcBytes: origBuf.length, srcLines: src.length, srcSha: sha256(origBuf), ranges: '1-' + src.length, eol });
  const archiveBuf = Buffer.concat([header, origBuf]);
  const headerLines = splitLines(header).length;
  let cap = 200, lines;
  for (;;) {
    lines = distillLines(src, archiveName, headerLines, cap, nowIso, { lines: src.length, bytes: origBuf.length, sha: sha256(origBuf), boss: path.basename(dir) });
    if (Buffer.byteLength(lines.join(eol)) <= MEMORY_TARGET_BYTES || cap <= 80) break;
    cap -= 20;
  }
  if (lines.length > MEMORY_MAX_LINES) {
    const extra = lines.length - (MEMORY_MAX_LINES - 1);
    lines = lines.slice(0, MEMORY_MAX_LINES - 1).concat(['- (' + extra + ' more lines are only in ' + archiveName + ')']);
  }
  const newLiveBuf = Buffer.from(lines.join(eol) + eol, 'utf8');
  return { kind: 'distill', name: rel, livePath: memPath, origBuf, newLiveBuf, archivePath: path.join(dir, archiveName), archiveBuf,
    verify: (live, arch) => {
      const a = readArchive(arch);
      if (!a.ok) return { ok: false, reason: 'archive: ' + a.reason };
      if (sha256(a.body) !== sha256(origBuf) || a.lines !== src.length) return { ok: false, reason: 'archive body is not the original file' };
      const n = splitLines(live).length;
      return n <= MEMORY_MAX_LINES ? { ok: true, archiveLines: a.lines, originalLines: src.length, liveLines: n } : { ok: false, reason: 'live has ' + n + ' lines' };
    },
    report: { file: rel, beforeBytes: origBuf.length, beforeLines: src.length, archive: rel.replace('MEMORY.md', archiveName),
      archiveBodyLines: src.length, afterBytes: newLiveBuf.length, afterLines: lines.length, excerptCap: cap } };
}

// ---- LESSONS.md ----
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
function lessonRows(claudeDir, post) {
  const rows = []; const memRoot = path.join(claudeDir, 'agent-memory');
  const bosses = fs.existsSync(memRoot) ? fs.readdirSync(memRoot).filter((d) => fs.statSync(path.join(memRoot, d)).isDirectory()).sort() : [];
  for (const b of bosses) {
    const jl = path.join(memRoot, b, 'lessons.jsonl');
    if (fs.existsSync(jl)) {
      fs.readFileSync(jl, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; }
        if (!r || typeof r.text !== 'string' || !r.text.trim()) return;
        let run = ''; try { const ev = typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence; run = ev && ev.run_id ? ', run ' + ev.run_id : ''; } catch { /* plain text evidence */ }
        rows.push({ text: r.text, ptr: 'agent-memory/' + b + '/lessons.jsonl L' + (i + 1) + ' (id ' + r.id + run + ')', date: String(r.ts || '').slice(0, 10) || '?' });
      });
    }
    const memRel = 'agent-memory/' + b + '/MEMORY.md';
    const mem = post[memRel] || (fs.existsSync(path.join(claudeDir, memRel)) ? fs.readFileSync(path.join(claudeDir, memRel)) : null);
    if (mem) splitLines(mem).map(str).forEach((s, i) => {
      const m = s.match(/^(\d{4}-\d{2}-\d{2}) (.{10,})$/);
      if (m) rows.push({ text: m[2].replace(/ — \[[^\]]+ L\d+\]\([^)]+\)$/, ''), ptr: memRel + ' L' + (i + 1), date: m[1] });
    });
  }
  return rows;
}
/** supersededRows(claudeDir, post, decisionDirs?) — decisionDirs (WP 2.1, default [claudeDir]) are the memory folders
 *  that may hold FORGE_DECISIONS*.md, active first; a name found in an earlier folder wins. */
function supersededRows(claudeDir, post, decisionDirs) {
  const dirs = Array.isArray(decisionDirs) && decisionDirs.length ? decisionDirs : [claudeDir];
  const files = Object.keys(post).filter((k) => /^FORGE_DECISIONS/.test(k));
  const dirOf = new Map();
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { if (d === claudeDir) throw e; }
    for (const f of names) if (/^FORGE_DECISIONS(_ARCHIVE_.*)?\.md$/.test(f) && !dirOf.has(f)) { dirOf.set(f, d); if (!files.includes(f)) files.push(f); }
  }
  const rows = [];
  for (const f of files.sort()) {
    const buf = post[f] || fs.readFileSync(path.join(dirOf.get(f) || claudeDir, f)); let secDate = null;
    splitLines(buf).map(str).forEach((s, i) => {
      if (/^## /.test(s)) secDate = maxDate(s);
      if (/^(- |\| \d{4})/.test(s) && SUPERSEDE_RE.test(s)) rows.push({ text: s.replace(/^- /, ''), ptr: f + ' L' + (i + 1), date: (s.match(DATE_RE) || [secDate || '?'])[0] });
    });
  }
  return rows;
}
function buildLessons(claudeDir, post, decisionDirs) {
  const merged = new Map();
  for (const r of lessonRows(claudeDir, post)) {
    const k = r.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const m = merged.get(k);
    if (m) { m.n++; m.ptrs.push(r.ptr); if (r.date > m.date) m.date = r.date; } else merged.set(k, { text: r.text, ptrs: [r.ptr], date: r.date, n: 1 });
  }
  const lessons = [...merged.values()].sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : a.ptrs[0] < b.ptrs[0] ? -1 : 1));
  const sup = supersededRows(claudeDir, post, decisionDirs);
  const head = ['# Forge Lessons (distilled)', '',
    '> Generated by `forge-bin/forge-memory-consolidate.cjs` from source text only: `agent-memory/*/lessons.jsonl`, dated lines in',
    '> `agent-memory/*/MEMORY.md`, and decision lines that state they supersede an earlier one. Each lesson is a literal opening of its',
    '> source; follow the evidence pointer for the full text. Regenerate instead of editing by hand.', '',
    '## Lessons (newest first)', '', '| Lesson | Evidence | Date |', '|---|---|---|'];
  const supHead = ['', '## Superseded decisions (marked here, never deleted from the decisions log)', '',
    '> Keyword match (supersede / supersedeert / vervangt / KEERT OM) on decision lines: each row names what replaced an earlier decision;', '> read the evidence line before treating the older decision as void.', '',
    '| Decision line that supersedes something | Evidence | Date |', '|---|---|---|'];
  const room = LESSONS_MAX_LINES - head.length - (sup.length ? supHead.length + sup.length : 0) - 2;
  const shown = lessons.slice(0, Math.max(0, room));
  const body = shown.map((l) => '| ' + cell(excerpt(l.text, LESSON_TEXT_CAP)) + (l.n >= 3 ? ' (repeated ' + l.n + '×: preference candidate)' : l.n > 1 ? ' (seen ' + l.n + '×)' : '') +
    ' | ' + cell(l.ptrs.slice(0, 3).join('; ') + (l.ptrs.length > 3 ? '; +' + (l.ptrs.length - 3) + ' more' : '')) + ' | ' + l.date + ' |');
  const tail = lessons.length > shown.length ? ['', '> ' + (lessons.length - shown.length) + ' older lessons are not listed here (line cap); they remain in their source files.'] : [];
  const supBody = sup.map((r) => '| ' + cell(excerpt(r.text, LESSON_TEXT_CAP)) + ' | ' + cell(r.ptr) + ' | ' + r.date + ' |');
  const lines = head.concat(body, tail, sup.length ? supHead.concat(supBody) : []);
  return { buf: Buffer.from(lines.join('\n') + '\n', 'utf8'), lessons: lessons.length, shown: shown.length, superseded: sup.length, lines: lines.length };
}

// ---- apply (atomic, verified, backed up) ----
function backup(root, livePath, buf, backupDir) {
  // WP 2.1: a file outside .claude (the .forge layout) is copied under its project-relative path with the leading dot
  // of the first segment dropped (.forge/memory/X -> forge/memory/X): never a '..' escape out of backupDir, and never
  // a folder named .forge inside the backups (that name marks a project root for discovery).
  const claudeDir = path.join(root, '.claude');
  const inClaude = !path.relative(claudeDir, livePath).startsWith('..') && !path.isAbsolute(path.relative(claudeDir, livePath));
  const rel = inClaude ? path.relative(claudeDir, livePath) : path.relative(root, livePath).replace(/^\.(?=[^.\\/])/, '');
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('REFUSED backup: ' + livePath + ' is outside the project');
  let dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) { if (sha256(fs.readFileSync(dst)) === sha256(buf)) return dst; dst += '.' + Date.now(); }
  fs.writeFileSync(dst, buf, { flag: 'wx' });
  return dst;
}
function writeVerified(target, buf) {
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, buf, { flag: 'wx' });
  if (sha256(fs.readFileSync(tmp)) !== sha256(buf)) { fs.unlinkSync(tmp); throw new Error('read-back mismatch for ' + tmp); }
  return tmp;
}
/** commitPlan — verify in memory, back up, write temps, rename, verify again from disk. Refuses (throws, nothing written) on any mismatch. */
function commitPlan(plan, root, backupDir) {
  const pre = plan.verify(plan.newLiveBuf, plan.archiveBuf);
  if (!pre.ok) throw new Error('REFUSED ' + plan.livePath + ': ' + pre.reason);
  if (sha256(fs.readFileSync(plan.livePath)) !== sha256(plan.origBuf)) throw new Error('REFUSED ' + plan.livePath + ': changed since planning');
  if (fs.existsSync(plan.archivePath)) throw new Error('REFUSED: archive already exists ' + plan.archivePath);
  const bak = backup(root, plan.livePath, plan.origBuf, backupDir);
  const ta = writeVerified(plan.archivePath, plan.archiveBuf);
  let tl;
  try { tl = writeVerified(plan.livePath, plan.newLiveBuf); } catch (e) { fs.unlinkSync(ta); throw e; }
  fs.renameSync(ta, plan.archivePath);
  fs.renameSync(tl, plan.livePath);
  const post = plan.verify(fs.readFileSync(plan.livePath), fs.readFileSync(plan.archivePath));
  if (!post.ok) {
    fs.writeFileSync(plan.livePath, plan.origBuf); fs.unlinkSync(plan.archivePath);
    throw new Error('ROLLED BACK ' + plan.livePath + ': post-write verify failed: ' + post.reason);
  }
  return Object.assign({ backup: bak }, post);
}

function run(opts) {
  const defRoot = opts.root ? null : viaForgePaths((P) => P.scriptRoot(__dirname), () => path.join(__dirname, '..', '..'));
  if (!opts.root && !defRoot) throw new Error('no project root found (this copy is not inside a project and neither CLAUDE_PROJECT_DIR nor the current folder names one) — pass --root');
  const root = path.resolve(opts.root || defRoot);
  const claudeDir = path.join(root, '.claude');
  const nowIso = opts.now || new Date().toISOString();
  const backupDir = opts.backupDir || path.join(root, '_scratch', 'memory-preconsolidate');
  const want = (rel) => !opts.only || rel === opts.only || path.basename(rel) === opts.only || rel.endsWith('/' + opts.only);
  const plans = [], skipped = [];
  for (const f of ROTATE_FILES) {
    if (!want(f)) continue;
    // WP 2.1: rotate the file where it is (legacy layout: .claude/<f>, exactly as before)
    const dir = path.dirname(memFile(root, f, true));
    const p = planRotation(dir, f, nowIso, relPosix(root, dir) + '/');
    (p.skip ? skipped : plans).push(p.skip ? { file: f, reason: p.skip, size: p.size } : p);
  }
  const memRoot = path.join(claudeDir, 'agent-memory');
  if (fs.existsSync(memRoot)) for (const b of fs.readdirSync(memRoot).sort()) {
    const rel = 'agent-memory/' + b + '/MEMORY.md'; const mp = path.join(memRoot, b, 'MEMORY.md');
    if (!want(rel) || !fs.existsSync(mp)) continue;
    const p = planMemory(mp, nowIso); (p.skip ? skipped : plans).push(p.skip ? { file: rel, reason: p.skip, size: p.size } : p);
  }
  const post = {};
  for (const p of plans) {
    const v = p.verify(p.newLiveBuf, p.archiveBuf);
    if (!v.ok) throw new Error('REFUSED (plan) ' + p.livePath + ': ' + v.reason);
    p.report.verify = v;
    const key = p.kind === 'rotate' ? p.name : p.name.replace(/^\.claude\//, '');
    post[key] = p.newLiveBuf; post[p.kind === 'rotate' ? path.basename(p.archivePath) : key.replace('MEMORY.md', path.basename(p.archivePath))] = p.archiveBuf;
  }
  let lessons = null;
  if (want('LESSONS.md')) {
    // WP 2.1: decisions from every memory folder; LESSONS.md written to its active path, compared with its read path
    const L = buildLessons(claudeDir, post, memoryDirsOf(root));
    const lp = memFile(root, 'LESSONS.md'); const lpRead = memFile(root, 'LESSONS.md', true);
    const cur = fs.existsSync(lpRead) ? fs.readFileSync(lpRead) : null;
    lessons = { file: relPosix(root, lp), lines: L.lines, bytes: L.buf.length, lessons: L.lessons, shown: L.shown, superseded: L.superseded,
      changed: !cur || sha256(cur) !== sha256(L.buf), buf: L.buf, path: lp, cur, curPath: lpRead };
    if (L.lines > LESSONS_MAX_LINES) throw new Error('REFUSED LESSONS.md: ' + L.lines + ' lines');
  }
  const result = { mode: opts.apply ? 'apply' : 'dry-run', root, plans: plans.map((p) => p.report), skipped, lessons: null, written: [] };
  if (opts.apply) {
    for (const p of plans) { const r = commitPlan(p, root, backupDir); result.written.push({ file: p.report.file, archive: p.report.archive, backup: r.backup }); }
    if (lessons && lessons.changed) {
      if (lessons.cur) backup(root, lessons.curPath, lessons.cur, backupDir);
      fs.mkdirSync(path.dirname(lessons.path), { recursive: true });
      const tmp = writeVerified(lessons.path, lessons.buf); fs.renameSync(tmp, lessons.path);
      result.written.push({ file: lessons.file });
    }
  }
  if (lessons) { delete lessons.buf; delete lessons.cur; delete lessons.path; delete lessons.curPath; result.lessons = lessons; }
  return result;
}

function main(argv) {
  const opts = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true; else if (a === '--json') opts.json = true;
    else if (a === '--only' || a === '--root' || a === '--now' || a === '--backup-dir') { const v = argv[++i]; if (!v) { console.error('missing value for ' + a); return 2; } opts[{ '--only': 'only', '--root': 'root', '--now': 'now', '--backup-dir': 'backupDir' }[a]] = v; }
    else rest.push(a);
  }
  if (rest[0] === 'verify') {
    if (!rest[1]) { console.error('usage: verify <archive-file>'); return 2; }
    const r = readArchive(fs.readFileSync(rest[1]));
    console.log((r.ok ? 'OK ' : 'MISMATCH ') + rest[1] + ' — body ' + r.bytes + ' bytes, ' + r.lines + ' lines, sha256 ' + r.sha + (r.ok ? '' : ' — ' + r.reason));
    return r.ok ? 0 : 1;
  }
  if (rest.length) { console.error('unknown argument: ' + rest[0]); return 2; }
  if (opts.now && Number.isNaN(Date.parse(opts.now))) { console.error('--now must be an ISO date'); return 2; }
  const res = run(opts);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
  console.log('forge-memory-consolidate (' + res.mode + ')');
  for (const p of res.plans) console.log('  ' + p.file + ': ' + p.beforeBytes + ' B / ' + p.beforeLines + ' lines -> ' + p.afterBytes + ' B / ' + p.afterLines + ' lines; archive ' + p.archive + ' (' + p.archiveBodyLines + ' lines); verify ' + (p.verify.ok ? 'OK' : 'FAIL'));
  for (const s of res.skipped) console.log('  skip ' + s.file + ' (' + s.reason + ')');
  if (res.lessons) console.log('  ' + res.lessons.file + ': ' + res.lessons.lines + ' lines, ' + res.lessons.shown + '/' + res.lessons.lessons + ' lessons, ' + res.lessons.superseded + ' superseded decisions' + (res.lessons.changed ? '' : ' (unchanged)'));
  console.log(opts.apply ? '  written: ' + res.written.length : '  dry-run: nothing written (use --apply)');
  return 0;
}

module.exports = { splitLines, readArchive, verifyRotation, planRotation, planMemory, buildLessons, commitPlan, run, excerpt,
  ROTATE_THRESHOLD, MEMORY_THRESHOLD, MARKER, PTR_BEGIN, PTR_END };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
