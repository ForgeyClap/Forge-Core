#!/usr/bin/env node
'use strict';
/**
 * forge-gate-writescope.cjs — the optional per-task WRITE-SCOPE freeze of forge-gate-hook.cjs (package 3.3c,
 * 2026-10-24). OFF unless a scope directory is configured (the env var FORGE_WRITE_SCOPE only: the config schema has no
 * string/path type, so there is no `write-scope` key; the mode can also come from the config key `write-scope-mode`);
 * then every Bash/PowerShell call is read for the files it WRITES and each target is judged against that directory:
 *   inside   -> silent;
 *   outside  -> a visible warning (mode `warn`, the default) or a block (mode `deny`, only when the owner set it);
 *   unknown  -> a visible "could not check" notice in either mode, NEVER a block (a variable, a glob, a `cd` earlier
 *               in the command, an MSYS mount such as /tmp, a UNC share, a symlink whose `..` reads two ways, ...).
 * Only a target that is PROVABLY outside can ever be blocked; anything this file cannot prove stays visible instead.
 *
 * WHAT COUNTS AS A WRITE (from the command text only — this hook's matcher is Bash|PowerShell): an output redirect
 * (`>`, `>>`, `>|`, `&>`, `n>`, `<>`; PowerShell `>`, `>>`, `n>`, `*>`), `tee`/`Tee-Object`, `sed -i`/`--in-place`
 * (GNU), and `Set-Content`/`Add-Content`/`Out-File`. NOT read (documented, not caught): cp/mv/Copy-Item, New-Item,
 * perl -i, an interpreter writing from inline code (node -e, python -c), npm/git writing on their own, the aliases
 * `sc`/`ac` (sc.exe in PowerShell 7), and a redirect inside a `$(...)` that sits inside double quotes. Edit/Write tool
 * calls never reach this hook at all (that would need an Edit|Write matcher: an owner-gated settings change).
 *
 * PATHS. A target is resolved against the payload cwd (relative targets become `unknown` once the command itself
 * changes directory: cd, pushd, Set-Location, ...). Windows: `C:\x`, `C:/x`, Git Bash `/c/x`, `\\?\C:\x`; comparison
 * is case-insensitive there. `..` is resolved both lexically and physically (component by component through the real
 * filesystem); when the two disagree about inside/outside the target is `unknown`. Symlinks and junctions are
 * resolved through the longest existing ancestor (fs.realpathSync.native), so a junction inside the scope that points
 * elsewhere is outside. A UNC path (`\\server\share`) can never be PROVED outside a local scope (it may be this very
 * machine), so it is `unknown` unless the scope is the same share.
 *
 * COST. One linear pass over the text, at most MAX_TARGETS filesystem checks; never throws (every failure becomes an
 * `unsure` reason, which the hook shows). Seams for tests: ctx.platform, ctx.homedir, ctx.fsImpl {existsSync,
 * realpathSync}. Pure apart from those fs reads; never writes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TARGETS = 32;
const MAX_SCAN_CHARS = 200000;
const MODES = new Set(['warn', 'deny']);
const CD_VERBS = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'push-location', 'pop-location']);
const BASH_WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'nice']);
const WRAPPER_VALUE_OPTS = { sudo: 'ugpCDRTUrth', env: 'uCS', nice: 'n', time: 'fo', exec: 'a' };
const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', '$null', '-']);
const WIN_DEVICES = /^(?:con|prn|aux|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// ---- tokenizer -------------------------------------------------------------------------------------------------
// A PowerShell variable reference, sticky and bounded (a `${` that never closes may not rescan the rest per `$`).
const PS_VAR_RE = /\$(?:\{[^}\n]{0,256}\}|[A-Za-z0-9_?^$]+(?::[A-Za-z0-9_]+)?)/y;
// tokens: {k:'w', v, dyn, glob, tilde, param, commas:[...]} | {k:'r', op, fd} | {k:'s'}
function newWord() { return { k: 'w', v: '', dyn: false, glob: false, tilde: false, quoted: false, param: false, commas: null }; }

function tokenizeBash(s, out) {
  const n = s.length;
  let w = null, test = false, bt = false, gluePos = -1, i = 0;
  const push = (t) => out.tokens.push(t);
  const flush = () => {
    if (!w) return;
    if (!w.quoted && w.v === '[[') test = true;
    else if (!w.quoted && w.v === ']]') test = false;
    push(w); w = null;
  };
  const sep = () => { flush(); push({ k: 's' }); };
  // start() -> the current word; a word that begins RIGHT after a closing `)` or backtick is glued to computed text
  const start = () => { if (!w) { w = newWord(); if (i === gluePos) w.dyn = true; } return w; };
  const ch = (c) => { start().v += c; };
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n' || c === ';') { sep(); i++; continue; }
    if (c === '#' && !w) { const nl = s.indexOf('\n', i); i = nl === -1 ? n : nl; continue; }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) ch(s[i + 1]);
      i += 2; continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) { out.unsure.push('an unclosed quote'); return; }
      const x = start(); x.v += s.slice(i + 1, end); x.quoted = true;
      i = end + 1; continue;
    }
    if (c === '"') {
      const x = start(); x.quoted = true;
      let j = i + 1, closed = false;
      while (j < n) {
        const d = s[j];
        if (d === '\\' && j + 1 < n) { const e = s[j + 1]; x.v += '"\\$`\n'.includes(e) ? e : d + e; j += 2; continue; }
        if (d === '"') { closed = true; break; }
        if (d === '$' || d === '`') x.dyn = true;
        x.v += d; j++;
      }
      if (!closed) { out.unsure.push('an unclosed quote'); return; }
      i = j + 1; continue;
    }
    if (c === '$') {
      const e = s[i + 1];
      if (e === '(') { // $( : a substitution (its inside is its own command); $(( : arithmetic, a computed word
        if (s[i + 2] === '(') { const end = s.indexOf('))', i + 3); if (end === -1) { out.unsure.push('an unclosed $(('); return; } start().dyn = true; i = end + 2; continue; }
        if (w) w.dyn = true;
        sep(); i += 2; continue;
      }
      if (e === "'" || e === '"' || e === '{' || /[A-Za-z0-9_@*#?$!-]/.test(e || '')) {
        const x = start(); x.dyn = true;
        if (e === '{') { const end = s.indexOf('}', i + 2); if (end === -1) { out.unsure.push('an unclosed ${'); return; } x.v += s.slice(i, end + 1); i = end + 1; continue; }
        x.v += '$'; i++; continue;
      }
      ch('$'); i++; continue;
    }
    if (c === '`') { // opens or closes a substitution: a word glued to the OUTSIDE of it is computed
      if (!bt && w) w.dyn = true;
      sep(); bt = !bt; if (!bt) gluePos = i + 1; i++; continue;
    }
    if (c === '(') { if (w) w.dyn = true; sep(); i++; continue; }
    if (c === ')') { sep(); gluePos = i + 1; i++; continue; }
    if (c === '{' || c === '}') {
      // a lone { or } is a command group; anywhere else it is brace expansion (it can add `..`): a wildcard
      if (!w && (c === '}' || i + 1 >= n || /\s/.test(s[i + 1]))) { sep(); i++; continue; }
      ch(c); w.glob = true; i++; continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { sep(); i += 2; continue; }
      if (s[i + 1] === '>') { flush(); const op = s[i + 2] === '>' ? '&>>' : '&>'; push({ k: 'r', op, fd: null }); i += op.length; continue; }
      sep(); i++; continue;
    }
    if (c === '|') { sep(); i += (s[i + 1] === '|' || s[i + 1] === '&') ? 2 : 1; continue; }
    if (c === '>' || c === '<') {
      if (test) { ch(c); i++; continue; } // [[ a > b ]] compares, it does not redirect
      let fd = null;
      if (w && !w.quoted && !w.dyn && /^\d$/.test(w.v)) { fd = w.v; w = null; } else flush();
      if (c === '>') {
        if (s[i + 1] === '(') { sep(); i += 2; continue; } // >(cmd): process substitution, not a file
        let op = '>';
        if (s[i + 1] === '>') op = '>>'; else if (s[i + 1] === '|') op = '>|'; else if (s[i + 1] === '&') op = '>&';
        push({ k: 'r', op, fd }); i += op.length; continue;
      }
      if (s[i + 1] === '(') { sep(); i += 2; continue; } // <(cmd)
      if (s[i + 1] === '>') { push({ k: 'r', op: '<>', fd }); i += 2; continue; }
      if (s.startsWith('<<<', i)) { push({ k: 'r', op: 'in', fd }); i += 3; continue; }
      if (s[i + 1] === '<') { push({ k: 'r', op: 'in', fd }); i += (s[i + 2] === '-') ? 3 : 2; continue; } // heredoc marker; body blanked
      push({ k: 'r', op: s[i + 1] === '&' ? 'dup-in' : 'in', fd }); i += s[i + 1] === '&' ? 2 : 1; continue;
    }
    if (c === '*' || c === '?' || c === '[') { ch(c); w.glob = true; i++; continue; }
    if (c === '~' && !w) { ch(c); w.tilde = true; i++; continue; }
    ch(c); i++;
  }
  flush();
}

function tokenizePowerShell(s, out) {
  const n = s.length;
  let w = null, gluePos = -1, i = 0;
  const push = (t) => out.tokens.push(t);
  const flush = () => { if (w) { push(w); w = null; } };
  const sep = () => { flush(); push({ k: 's' }); };
  const start = () => { if (!w) { w = newWord(); if (i === gluePos) w.dyn = true; } return w; };
  const comma = () => { const x = start(); (x.commas = x.commas || []).push(x.v); x.v = ''; };
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n' || c === ';') { sep(); i++; continue; }
    if (c === '<' && s[i + 1] === '#') { const end = s.indexOf('#>', i + 2); if (end === -1) { out.unsure.push('an unclosed <# comment'); return; } i = end + 2; continue; }
    if (c === '#' && !w) { const nl = s.indexOf('\n', i); i = nl === -1 ? n : nl; continue; }
    if (c === '`') { if (s[i + 1] === '\n') { i += 2; continue; } if (i + 1 < n) start().v += s[i + 1]; i += 2; continue; }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && (s[i + 2] === '\n' || (s[i + 2] === '\r' && s[i + 3] === '\n'))) {
      const q = s[i + 1];
      const end = s.indexOf('\n' + q + '@', i + 2);
      if (end === -1) { out.unsure.push('an unclosed here-string'); return; }
      const x = start(); x.quoted = true; if (q === '"' && /[$`]/.test(s.slice(i + 2, end))) x.dyn = true;
      x.v += s.slice(i + 3, end); i = end + 3; continue;
    }
    if (c === "'") {
      const x = start(); x.quoted = true;
      let j = i + 1, closed = false;
      while (j < n) { if (s[j] === "'") { if (s[j + 1] === "'") { x.v += "'"; j += 2; continue; } closed = true; break; } x.v += s[j]; j++; }
      if (!closed) { out.unsure.push('an unclosed quote'); return; }
      i = j + 1; continue;
    }
    if (c === '"') {
      const x = start(); x.quoted = true;
      let j = i + 1, closed = false;
      while (j < n) {
        const d = s[j];
        if (d === '`' && j + 1 < n) { x.v += s[j + 1]; j += 2; continue; }
        if (d === '"') { if (s[j + 1] === '"') { x.v += '"'; j += 2; continue; } closed = true; break; }
        if (d === '$') x.dyn = true;
        x.v += d; j++;
      }
      if (!closed) { out.unsure.push('an unclosed quote'); return; }
      i = j + 1; continue;
    }
    if (c === '$') {
      if (s[i + 1] === '(') { if (w) w.dyn = true; sep(); i += 2; continue; }
      PS_VAR_RE.lastIndex = i;
      const m = PS_VAR_RE.exec(s);
      const x = start();
      if (m && m[0].toLowerCase() === '$null' && x.v === '' && !/[A-Za-z0-9_:]/.test(s[i + 5] || '')) { x.v = '$null'; x.nullSink = true; i += 5; continue; }
      x.dyn = true; x.v += m ? m[0] : '$'; i += m ? m[0].length : 1; continue;
    }
    if (c === '@' && s[i + 1] === '(') { if (w) w.dyn = true; sep(); i += 2; continue; }
    if (c === '(' || c === '{') { if (w) w.dyn = true; sep(); i++; continue; }
    if (c === ')' || c === '}') { sep(); gluePos = i + 1; i++; continue; }
    if (c === '|') { sep(); i += s[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&') { if (s[i + 1] === '&') { sep(); i += 2; continue; } flush(); i++; continue; } // a bare & is the call operator
    if (c === '>') {
      let fd = null;
      if (w && !w.quoted && !w.dyn && /^[1-6*]$/.test(w.v)) { fd = w.v; w = null; } else flush();
      if (s[i + 1] === '&') { push({ k: 'r', op: 'dup', fd }); i += 3; continue; } // n>&1
      const op = s[i + 1] === '>' ? '>>' : '>';
      push({ k: 'r', op, fd }); i += op.length; continue;
    }
    if (c === ',' && w && !w.param) { comma(); i++; continue; }
    if (c === '-' && !w) { const x = start(); x.param = true; x.v = '-'; i++; continue; }
    if (c === '*' || c === '?' || c === '[') { start().v += c; w.glob = true; i++; continue; }
    if (c === '~' && !w) { start().v += c; w.tilde = true; i++; continue; }
    start().v += c; i++;
  }
  flush();
}

// ---- write targets per simple command ---------------------------------------------------------------------------
const lowerBase = (v) => String(v).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
const values = (wd) => (wd.commas ? wd.commas.concat([wd.v]) : [wd.v]).filter((x) => x !== '');
// unknownWhy: the target was found, but where it sits in the argument list could not be read with certainty (an
// unknown option before it): it is reported as `unknown`, never judged — a misread word must never cause a block.
const asTarget = (wd, via, v, unknownWhy) => ({ v: v === undefined ? wd.v : v, dyn: wd.dyn, glob: wd.glob, tilde: wd.tilde, nullSink: !!wd.nullSink, via, unknownWhy: unknownWhy || null });

// PowerShell parameter tables: name -> 'v' (takes a value) | 's' (switch) | 'path' (a write target) | 'novar' (Tee -Variable)
const COMMON_PS = { erroraction: 'v', ea: 'v', errorvariable: 'v', ev: 'v', warningaction: 'v', wa: 'v', warningvariable: 'v', wv: 'v',
  informationaction: 'v', infa: 'v', informationvariable: 'v', iv: 'v', outvariable: 'v', ov: 'v', outbuffer: 'v', ob: 'v',
  pipelinevariable: 'v', pv: 'v', progressaction: 'v', proga: 'v', verbose: 's', vb: 's', debug: 's', db: 's', whatif: 's', wi: 's', confirm: 's', cf: 's' };
const PS_CMDLETS = {
  'set-content': { params: { path: 'path', literalpath: 'path', pspath: 'path', lp: 'path', value: 'v', filter: 'v', include: 'v', exclude: 'v', credential: 'v', encoding: 'v', stream: 'v', force: 's', nonewline: 's', passthru: 's', asbytestream: 's', usetransaction: 's' }, positional: ['path', 'value'] },
  'add-content': null, // same table as set-content (filled below)
  'out-file': { params: { filepath: 'path', path: 'path', literalpath: 'path', pspath: 'path', lp: 'path', encoding: 'v', append: 's', force: 's', noclobber: 's', width: 'v', nonewline: 's', inputobject: 'v' }, positional: ['path', 'encoding'] },
  'tee-object': { params: { filepath: 'path', path: 'path', literalpath: 'path', pspath: 'path', lp: 'path', variable: 'novar', inputobject: 'v', append: 's', encoding: 'v' }, positional: ['path'] },
};
PS_CMDLETS['add-content'] = PS_CMDLETS['set-content'];

function psCmdletTargets(words, spec, out) {
  const table = Object.assign({}, COMMON_PS, spec.params);
  const names = Object.keys(table);
  const targets = [];
  const filled = new Set(); // positional slots already bound BY NAME (PowerShell binds named parameters first)
  const positional = [];
  let i = 0, unsure = null, unreliable = null;
  while (i < words.length) {
    const wd = words[i];
    if (wd.param && wd.v.length > 1) {
      let name = wd.v.slice(1), attached = null;
      const colon = name.indexOf(':');
      if (colon !== -1) { attached = name.slice(colon + 1); name = name.slice(0, colon); }
      const lc = name.toLowerCase();
      const hits = table[lc] ? [lc] : names.filter((k) => k.startsWith(lc));
      if (hits.length !== 1) { unsure = 'an unknown or ambiguous parameter -' + name; unreliable = unsure; i++; continue; }
      const kind = table[hits[0]];
      if (kind === 's') { i++; continue; }
      if (kind === 'novar') return { targets: [], unsure: null };
      const valWord = attached !== null
        ? Object.assign(newWord(), { v: attached, dyn: wd.dyn, glob: wd.glob, quoted: wd.quoted, commas: attached.includes(',') ? attached.split(',').slice(0, -1) : null })
        : words[i + 1];
      if (valWord && attached !== null && valWord.commas) valWord.v = attached.split(',').pop();
      i += attached !== null ? 1 : 2;
      if (!valWord) { unsure = 'a -' + name + ' without a value'; continue; }
      const slot = kind === 'path' ? 'path' : hits[0];
      filled.add(slot);
      if (kind === 'path') for (const v of values(valWord)) targets.push(asTarget(valWord, 'parameter -' + name, v));
      continue;
    }
    positional.push(wd);
    i++;
  }
  const slots = spec.positional.filter((s) => !filled.has(s));
  positional.forEach((wd, k) => {
    if (slots[k] === 'path') for (const v of values(wd)) targets.push(asTarget(wd, 'positional path', v, unreliable));
  });
  if (!targets.length && !unsure) unsure = 'no -Path given (the path may come from the pipeline)';
  return { targets, unsure };
}

function teeTargets(words) {
  const targets = [];
  let opts = true;
  for (const wd of words) {
    if (opts && !wd.quoted && wd.v === '--') { opts = false; continue; }
    if (opts && !wd.quoted && /^-/.test(wd.v) && wd.v !== '-') {
      if (/^(?:-[aip]+|--append|--ignore-interrupts|--output-error(?:=\w+)?)$/.test(wd.v)) continue;
      return { targets, unsure: 'an unknown tee option ' + wd.v };
    }
    targets.push(asTarget(wd, 'tee'));
  }
  return { targets, unsure: null };
}

function sedTargets(words) {
  let inPlace = false, scriptGiven = false, unsure = null;
  const operands = [];
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    const v = wd.v;
    if (!wd.quoted && /^--/.test(v)) {
      if (/^--in-place(?:=.*)?$/.test(v)) inPlace = true;
      else if (/^--(?:expression|file)=/.test(v)) scriptGiven = true;
      else if (v === '--expression' || v === '--file') { scriptGiven = true; i++; }
      else if (v === '--line-length') i++;
      else if (!/^--(?:quiet|silent|debug|posix|sandbox|separate|unbuffered|null-data|regexp-extended|follow-symlinks|line-length=\d+)$/.test(v)) unsure = 'an unknown sed option ' + v;
      continue;
    }
    if (!wd.quoted && /^-[^-]/.test(v)) {
      for (let k = 1; k < v.length; k++) {
        const f = v[k];
        if (f === 'i') { inPlace = true; break; } // the rest of the cluster is the backup suffix
        if (f === 'e' || f === 'f') { scriptGiven = true; if (k === v.length - 1) i++; break; }
        if (f === 'l') { if (k === v.length - 1) i++; break; }
        if (!'nrEsuz'.includes(f)) { unsure = 'an unknown sed option -' + f; break; }
      }
      continue;
    }
    operands.push(wd);
  }
  if (!inPlace) return { targets: [], unsure: null };
  const files = scriptGiven ? operands : operands.slice(1);
  if (operands.some((o) => o.v === '')) return { targets: [], unsure: 'an empty sed argument (BSD-style -i \'\'?)' };
  return { targets: files.map((wd) => asTarget(wd, 'sed -i', undefined, unsure)), unsure };
}

/** writeTargets(command, shell) -> { targets:[{v, dyn, glob, tilde, nullSink, via, afterCd}], unsure:[reason] }. */
function writeTargets(command, shell) {
  const text = String(command);
  const out = { tokens: [], unsure: [] };
  if (text.length > MAX_SCAN_CHARS) return { targets: [], unsure: ['the command is too large to read for writes'] };
  let body = text;
  if (shell !== 'PowerShell' && text.includes('<<')) {
    try { body = require('./forge-gate-quotes.cjs').blankHeredocBodies(text); } catch { return { targets: [], unsure: ['the heredoc reader is unavailable'] }; }
  }
  if (shell === 'PowerShell') tokenizePowerShell(body, out); else tokenizeBash(body, out);
  const targets = [];
  let cmd = [], cdSeen = false;
  const finish = () => {
    const words = cmd.filter((t) => t.k === 'w');
    let at = 0;
    if (shell !== 'PowerShell') {
      for (let guard = 0; guard < words.length; guard++) {
        while (at < words.length && !words[at].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at].v)) at++;
        if (!(at < words.length && BASH_WRAPPERS.has(lowerBase(words[at].v)))) break;
        const valueOpts = WRAPPER_VALUE_OPTS[lowerBase(words[at].v)] || '';
        at++;
        while (at < words.length && /^-/.test(words[at].v)) {
          const o = words[at].v;
          at++;
          // `sudo -u root`: a short option that takes a value, given as its own word, consumes the next word too
          if (/^-[A-Za-z]$/.test(o) && valueOpts.includes(o[1]) && at < words.length) at++;
        }
      }
    } else if (words.length > 1 && /^\$/.test(words[0].v) && (words[1].v === '=' || /^[+\-*/]?=$/.test(words[1].v))) at = 2;
    const verbWord = words[at];
    const verb = verbWord ? lowerBase(verbWord.v.replace(/^\\/, '')).replace(/^microsoft\.powershell\.(?:utility|management)\\/, '') : '';
    const rest = words.slice(at + 1);
    let res = null;
    if (verbWord && !verbWord.dyn) {
      if (verb === 'tee' && shell !== 'PowerShell') res = teeTargets(rest);
      else if ((verb === 'tee' || verb === 'tee-object') && shell === 'PowerShell') res = psCmdletTargets(rest, PS_CMDLETS['tee-object'], out);
      else if (verb === 'sed' || verb === 'gsed') res = sedTargets(rest);
      else if (shell === 'PowerShell' && PS_CMDLETS[verb]) res = psCmdletTargets(rest, PS_CMDLETS[verb], out);
    }
    if (res) {
      for (const tg of res.targets) targets.push(Object.assign(tg, { afterCd: cdSeen }));
      if (res.unsure) out.unsure.push(verb + ': ' + res.unsure);
    }
    if (verbWord && CD_VERBS.has(verb)) cdSeen = true;
    cmd = [];
  };
  const toks = out.tokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 's') { finish(); continue; }
    if (t.k === 'r') {
      const next = toks[i + 1];
      const isWrite = t.op === '>' || t.op === '>>' || t.op === '>|' || t.op === '&>' || t.op === '&>>' || t.op === '<>' || t.op === '>&';
      if (!isWrite) { if (t.op === 'in' && next && next.k === 'w') i++; continue; }
      if (!next || next.k !== 'w') { out.unsure.push('a redirect into something computed'); continue; }
      i++;
      if (t.op === '>&' && /^(?:\d+|-)$/.test(next.v) && !next.quoted) continue; // fd duplication, not a file
      targets.push(Object.assign(asTarget(next, 'redirect ' + (t.fd || '') + t.op), { afterCd: cdSeen }));
      continue;
    }
    cmd.push(t);
  }
  finish();
  return { targets, unsure: out.unsure };
}

// ---- path judgement ---------------------------------------------------------------------------------------------
function fsOf(ctx) {
  const f = (ctx && ctx.fsImpl) || {};
  return {
    existsSync: f.existsSync || ((p) => fs.existsSync(p)),
    realpathSync: f.realpathSync || ((p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p))),
  };
}
const isWin = (ctx) => (ctx.platform || process.platform) === 'win32';
const P = (ctx) => (isWin(ctx) ? path.win32 : path.posix);

/** toNative(v, ctx) -> {abs} | {sink} | {unknown: reason}. Shell syntax -> an absolute path of the platform. */
function toNative(t, ctx) {
  let v = t.v;
  const lc = v.toLowerCase();
  if (t.nullSink || NULL_SINKS.has(lc)) return { sink: true };
  if (t.unknownWhy) return { unknown: t.unknownWhy };
  if (t.dyn) return { unknown: 'a variable or computed name' };
  const win = isWin(ctx);
  const p = P(ctx);
  // the `?` of a Windows long-path prefix (\\?\C:\x) is not a wildcard; any other * ? [ { is
  const longPrefix = win && /^\\\\\?\\/.test(v);
  if (t.glob && (!longPrefix || /[*?[{]/.test(v.slice(4)))) return { unknown: 'a wildcard' };
  if (t.tilde) {
    if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = (ctx.homedir || os.homedir()) + v.slice(1);
    else return { unknown: 'a ~user path' };
  }
  if (win) {
    if (/^\\\\\?\\UNC\\/i.test(v)) v = '\\\\' + v.slice(8);
    else if (/^\\\\\?\\[A-Za-z]:/.test(v)) v = v.slice(4);
    if (/^\\\\\.\\/.test(v)) return { unknown: 'a device path' };
    if (WIN_DEVICES.test(p.basename(v))) return { unknown: 'a Windows device name' };
    if (ctx.shell !== 'PowerShell' && /^\/[A-Za-z](?:\/|$)/.test(v)) v = v[1] + ':\\' + v.slice(3);
    else if (ctx.shell !== 'PowerShell' && /^\/(?!\/)/.test(v)) return { unknown: 'a Git Bash mount (' + v.split('/').slice(0, 2).join('/') + ')' };
    if (/^[A-Za-z]{2,}:/.test(v)) return { unknown: 'a PowerShell provider path' };
    if (/^[A-Za-z]:(?![\\/])/.test(v)) return { unknown: 'a drive-relative path' };
  }
  const unc = win && /^(?:\\\\|\/\/)[^\\/]/.test(v);
  if (win && !unc && /^[\\/]/.test(v)) { // `\x` (PowerShell): the root of the working directory's drive
    if (!ctx.cwd || !/^[A-Za-z]:/.test(ctx.cwd)) return { unknown: 'a drive-less root path' };
    v = ctx.cwd.slice(0, 2) + v;
  }
  if (!p.isAbsolute(v) && !unc) {
    if (t.afterCd) return { unknown: 'a relative path after the command changed directory' };
    if (!ctx.cwd || !p.isAbsolute(ctx.cwd)) return { unknown: 'no absolute working directory' };
    v = ctx.cwd.replace(/[\\/]+$/, '') + (win ? '\\' : '/') + v; // NOT p.join: that would already collapse `..`
  }
  return { abs: v, unc };
}

function normCase(s, ctx) { return isWin(ctx) ? s.toLowerCase() : s; }
function within(child, parent, ctx) {
  const p = P(ctx);
  const c = normCase(p.normalize(child), ctx).replace(/[\\/]+$/, '');
  const r = normCase(p.normalize(parent), ctx).replace(/[\\/]+$/, '');
  if (c === r) return true;
  const sepc = isWin(ctx) ? '\\' : '/';
  return c.startsWith(r + sepc) || (r.endsWith(':') && c.startsWith(r + sepc));
}

/** realOf(abs, ctx) -> the path with its longest existing ancestor resolved through the filesystem (symlinks, junctions,
 *  8.3 names), the not-yet-existing tail appended as written. Lexical `..` handling is the caller's choice. */
function realOf(abs, ctx) {
  const F = fsOf(ctx);
  const p = P(ctx);
  let head = abs;
  const tail = [];
  for (let guard = 0; guard < 4096; guard++) {
    let exists = false;
    try { exists = F.existsSync(head); } catch { exists = false; }
    if (exists) break;
    const parent = p.dirname(head);
    if (parent === head) break;
    tail.unshift(p.basename(head));
    head = parent;
  }
  let real = head;
  try { real = F.realpathSync(head); } catch { real = head; }
  return tail.length ? p.join(real, ...tail) : real;
}

/** physicalOf(abs, ctx) -> the path walked component by component, each existing prefix resolved through the
 *  filesystem BEFORE the next `..` is applied (how a POSIX kernel resolves `link/..`). */
function physicalOf(abs, ctx) {
  const F = fsOf(ctx);
  const p = P(ctx);
  const root = p.parse(abs).root;
  const parts = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  let existing = true;
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { cur = p.dirname(cur); continue; }
    const next = p.join(cur, part);
    if (existing) {
      let ex = false;
      try { ex = F.existsSync(next); } catch { ex = false; }
      if (ex) { try { cur = F.realpathSync(next); } catch { cur = next; } continue; }
      existing = false;
    }
    cur = next;
  }
  return cur;
}

/** judgeTarget(target, ctx) -> {verdict:'inside'|'outside'|'unknown'|'sink', path?, why?}. ctx.scope must already be
 *  the RESOLVED scope (resolveScope). */
function judgeTarget(t, ctx) {
  const nat = toNative(t, ctx);
  if (nat.sink) return { verdict: 'sink' };
  if (nat.unknown) return { verdict: 'unknown', why: nat.unknown };
  const p = P(ctx);
  if (nat.unc || ctx.scopeUnc) {
    if (nat.unc && ctx.scopeUnc && within(p.normalize(nat.abs), ctx.scope, ctx)) return { verdict: 'inside', path: p.normalize(nat.abs) };
    return { verdict: 'unknown', why: 'a network (UNC) path that may be this machine' };
  }
  const lexical = realOf(p.normalize(nat.abs), ctx);
  const physical = realOf(physicalOf(nat.abs, ctx), ctx);
  const a = within(lexical, ctx.scope, ctx);
  const b = within(physical, ctx.scope, ctx);
  if (a !== b) return { verdict: 'unknown', why: 'a `..` after a symlink reads two ways', path: lexical };
  if (isWin(ctx) === false && (ctx.platform || process.platform) === 'darwin' && within(lexical.toLowerCase(), ctx.scope.toLowerCase(), { platform: 'linux' }) !== a) {
    return { verdict: 'unknown', why: 'a case difference on a case-insensitive disk', path: lexical };
  }
  return { verdict: a ? 'inside' : 'outside', path: lexical };
}

/** resolveScope(raw, ctx) -> {ok:true, scope, unc} | {ok:false, why}. The scope must be an absolute, existing directory. */
function resolveScope(raw, ctx) {
  const p = P(ctx);
  const F = fsOf(ctx);
  let v = String(raw || '').trim();
  if (!v) return { ok: false, why: 'empty' };
  if (isWin(ctx) && /^\/[A-Za-z](?:\/|$)/.test(v)) v = v[1] + ':\\' + v.slice(3);
  if (isWin(ctx) && /^\\\\\?\\[A-Za-z]:/.test(v)) v = v.slice(4);
  const unc = isWin(ctx) && /^(?:\\\\|\/\/)[^\\/]/.test(v);
  if (!unc && !p.isAbsolute(v)) return { ok: false, why: 'not an absolute path: ' + v };
  if (!unc && isWin(ctx) && !/^[A-Za-z]:[\\/]/.test(v)) return { ok: false, why: 'no drive letter: ' + v };
  let exists = false;
  try { exists = F.existsSync(v); } catch { exists = false; }
  if (!exists) return { ok: false, why: 'the folder does not exist: ' + v };
  let real = v;
  if (!unc) { try { real = F.realpathSync(v); } catch { real = v; } }
  return { ok: true, scope: p.normalize(real), unc };
}

/** checkWriteScope(command, ctx) -> {scope, mode, outside:[{v,path,via}], unknown:[{v,why,via}], inside:n, unsure:[...]}.
 *  ctx = {scopeRaw, mode, shell, cwd, platform?, homedir?, fsImpl?}. Never throws. */
function checkWriteScope(command, ctx) {
  try {
    const mode = MODES.has(ctx.mode) ? ctx.mode : 'warn';
    const sc = resolveScope(ctx.scopeRaw, ctx);
    if (!sc.ok) return { invalid: sc.why, mode };
    const jctx = Object.assign({}, ctx, { scope: sc.scope, scopeUnc: sc.unc });
    const w = writeTargets(command, ctx.shell);
    const res = { scope: sc.scope, mode, outside: [], unknown: [], inside: 0, unsure: w.unsure.slice() };
    if (w.targets.length > MAX_TARGETS) res.unsure.push(w.targets.length + ' write targets, only the first ' + MAX_TARGETS + ' were checked');
    for (const t of w.targets.slice(0, MAX_TARGETS)) {
      const j = judgeTarget(t, jctx);
      if (j.verdict === 'inside') res.inside++;
      else if (j.verdict === 'outside') res.outside.push({ v: t.v, path: j.path, via: t.via });
      else if (j.verdict === 'unknown') res.unknown.push({ v: t.v, why: j.why, via: t.via });
    }
    return res;
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0], mode: MODES.has(ctx.mode) ? ctx.mode : 'warn' };
  }
}

const list = (arr, f) => arr.slice(0, 4).map(f).join(', ') + (arr.length > 4 ? ' (+' + (arr.length - 4) + ')' : '');

/** describe(res, cap) -> {block?, reason?, notice?} — the hook's wording. `cap` is the hook's notice cap. */
function describe(res, cap) {
  cap = cap || ((s) => s);
  if (res.invalid) return { notice: cap('FORGE WRITE SCOPE: genegeerd, de map klopt niet (' + res.invalid + ') / ignored, the folder is not valid (' + res.invalid + ')') };
  if (res.error) return { notice: cap('FORGE WRITE SCOPE: de schrijfcontrole liep vast (' + res.error + '), dit commando is NIET gecontroleerd / the write check failed (' + res.error + '), this call was NOT checked') };
  const out = res.outside.length ? list(res.outside, (o) => o.path) : '';
  if (res.outside.length && res.mode === 'deny') {
    return { block: true, reason: 'FORGE GATE (write-scope):\n- dit commando schrijft buiten de afgesproken map ' + res.scope + ': ' + out + ' — Forge vraagt eerst. / this command writes outside the agreed folder ' + res.scope + ': ' + out + ' — Forge asks first.\n'
      + '  Veilige variant: schrijf binnen ' + res.scope + ', of vraag de eigenaar om de map of de modus (write-scope-mode) aan te passen. / Safe variant: write inside ' + res.scope + ', or ask the owner to change the folder or the mode (write-scope-mode).' };
  }
  const parts = [];
  if (res.outside.length) parts.push('schrijft buiten ' + res.scope + ' / writes outside ' + res.scope + ': ' + out);
  const unk = res.unknown.length ? list(res.unknown, (u) => u.v + ' (' + u.why + ')') : '';
  if (res.unknown.length) parts.push('niet na te gaan / could not check: ' + unk);
  if (res.unsure.length) parts.push('niet na te gaan / could not check: ' + res.unsure.slice(0, 2).join('; '));
  if (!parts.length) return {};
  return { notice: cap('FORGE WRITE SCOPE (' + res.mode + '): ' + parts.join(' · ') + ' — niet geblokkeerd / not blocked') };
}

module.exports = { checkWriteScope, writeTargets, judgeTarget, resolveScope, describe, toNative, realOf, physicalOf, within, MAX_TARGETS, MODES };
