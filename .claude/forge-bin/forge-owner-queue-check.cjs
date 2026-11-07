#!/usr/bin/env node
'use strict';
/**
 * forge-owner-queue-check.cjs — a report may hand the owner hard gates only, never a choice.
 *
 * Owner standing rules owner-remember-mw2ld5jc-caudls (P-000126) and owner-remember-mw3qo53m-7nruha (repeat R-0149 of
 * R-0062): the Lead makes every product, design, scope and priority choice itself and never ENDS a report with a choice
 * for the owner. Only hard gates go to the owner: push, deploy, spend, outbound/publish, credentials or sign-in,
 * production, destructive deletes or --force, settings/plugin writes the gate keeps from agents, edits outside the
 * project, owner acks, and values only the owner has. The skills-audit report at 87bc0c2 still ended with "You choose
 * whether…", "say so if you still want…" and "Commit or keep it as you prefer", and the owner had to say "maak de beste
 * keuzes" again.
 *
 * What is judged (review M3 of a2459ed widened the first version, which read only a "## Owner queue" list):
 *   QUEUE sections (owner queue / owner actions / owner-gated / owner decisions / what I need from you / for you, NL
 *   forms too, any heading level, deeper subheadings included): every list item, table row and plain paragraph is an
 *   item (round-5 N3). An item fails when it
 *     (a) holds choice wording ("you choose", "say so if", "do you want", "shall I", "wil je", "laat me weten", ...),
 *         an ack item included, or
 *     (b) names no hard gate, unless it is an ack of named R-ids;
 *   W2-H1B-SCOUT L2: an indented sub-bullet is its own item (numbered 3.1, 3.1.2), judged like any other;
 *   it inherits its parent's gate only when the parent is a gated lead-in ending in ":" (it lists that item's objects).
 *   A plain lead-in line ending in ":" with no item after it in the queue is a finding;
 *   NEXT sections ("Next", "Next step(s)", "Volgende stap(pen)", "Wat nu") and the report's LAST section (unless that is
 *   a Self-review or a queue): every line is checked for (a) only.
 * forge-endreview `record` refuses while a finding stands, and `check` re-judges the report as it is now. Pure text.
 *
 * CLI: node forge-owner-queue-check.cjs --file <report.md> [--json]   exit 0 clean (or nothing to judge) · 1 findings · 2 usage
 * API: checkText(md) -> {section, items, findings[{item, line, text, reason, where}]} · checkFile(file)
 */
const fs = require('fs');

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const NUM = '(?:\\d+[a-z]?\\.?[ \\t]+)?';
const QUEUE_TITLE_RE = new RegExp('^' + NUM + '(?:owner[ -]?(?:queue|action|actions|actie|acties|wachtrij|gated|decisions?|to-?do)|'
  + 'what i need from you|for you|for the owner|voor (?:jou|u|de eigenaar)|wat ik (?:nog )?van (?:je|jou|u) nodig heb|'
  + 'eigenaar[ -]?(?:wachtrij|acties?|beslissingen)|jouw acties|wat jij (?:nog )?moet doen|what you need to do)\\b', 'i');
const NEXT_TITLE_RE = new RegExp('^' + NUM + '(?:next(?: steps?)?|volgende stap(?:pen)?|wat nu)\\b', 'i');
const SELF_REVIEW_RE = new RegExp('^' + NUM + 'self-review\\b', 'i');
const ITEM_RE = /^(?:\d+[.)]|[-*])[ \t]+/;
const TABLE_RE = /^\s*\|/;
const TABLE_SEP_RE = /^[\s|:]*-{2,}[\s|:-]*$/;
// wording that hands the owner a decision the Lead should take itself
const CHOICE_RE = new RegExp('\\b(?:' + [
  'you choose', 'you decide', 'your (?:call|choice|pick)', 'say so if', 'decide whether', 'choose whether', 'as you prefer',
  'if you (?:still )?want', 'whichever you', 'up to you', 'do you want', 'would you like', 'shall i', 'should i', 'let me know',
  'yes or no', 'or accept', 'jouw keuze', 'jij kiest', 'kies (?:zelf|jij)', 'zeg het als', 'zeg maar als', 'als je (?:dat )?(?:nog )?wilt',
  'naar keuze', 'wat jij wilt', 'wil je', 'wilt u', 'laat (?:me |het )?(?:even )?weten', 'of niet', 'ja of nee',
].join('|') + ')\\b', 'i');
// an owner ack of NAMED items is a hard gate by design (the scribe only accepts the owner's own words)
const ACK_RE = /\b(?:acknowledge|acknowledgement|ack|acks|bevestig|bevestigen|akkoord)\b/i;
const RID_RE = /\bR-\d{2,}\b/;
// the hard gates (EN + NL); one hit is enough
const GATE_RE = new RegExp('(?:--force|\\b(?:' + [
  'push(?:es|ed)?', 'deploy(?:s|ment)?', 'publish(?:es|ing)?', 'release tag', 'outbound', 'spend(?:s|ing)?', 'costs? (?:money|usage)',
  'paid (?:action|service|plan|api|tier)', 'betaal\\w*', 'kosten',
  'credentials?', 'api keys?', '(?:api|access|auth|oauth) tokens?',
  // round-5 N4: a bare "secret" also matched "the secret to a good intake"; only a secret VALUE counts
  'secrets? (?:values?|keys?|tokens?|files?|store|manager|vault)', 'client secrets?', '(?:api|webhook|signing) secrets?', 'wachtwoord\\w*', 'sign(?:s|ed)? in', 'log(?:s|ged)? in', 'inlogg\\w*',
  '(?:second|another|new|extra) (?:claude )?account', 'usage polic(?:y|ies)', 'terms of (?:service|use)', 'licen[cs]e terms', 'dns',
  // round-5 N4: bare "production"/"productie" matched "the production numbers"; only a production TARGET counts
  '(?:to|into|on|in|onto) production', 'production (?:deploy\\w*|release|database|db|server|data|traffic|env\\w*|change\\w*|access|site|url|domain|workflows?|webhooks?|secrets?|keys?)',
  '(?:naar|in|op) productie', 'productie[- ]?(?:omgeving|database|server|data|deploy\\w*|release)',
  'discard(?:s|ing)?', 'delet(?:e|es|ing|ion)', 'verwijder\\w*', 'destructive', 'weggooien',
  'settings (?:file|files|change|write|writes)', 'settings\\.json', 'plugin (?:install|installs|enable|settings|allowlist)', 'allowlist',
  'the gate (?:blocks|keeps|leaves|refuses)', 'owner-gated', 'hard-gated', 'hard gates?', 'outside (?:this|the) project', 'buiten (?:dit|het) project',
  'git remote', 'remote url',
  // round-5 N4: bare "only you" matched "only you will see it"; only something the owner alone CAN do or HAS counts
  'only you (?:can|may|have|hold|own|know the)', 'only the owner (?:can|may|has|holds|owns)', 'alleen (?:jij|u) (?:kunt|kan|mag|hebt|heeft|weet)',
].join('|') + '))(?![\\w-])', 'i');

function sectionsOf(lines) {
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i]);
    if (h) { cur = { title: h[2].trim(), level: h[1].length, start: i + 1, body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push({ n: i + 1, text: lines[i] });
  }
  return out;
}
/** itemsOf(body) -> [{line, text, leadIn}]. Round-5 N3: a plain (non-list) line is an item too. A paragraph
 *  that starts at column 0 after a blank line (or with no item open) is its own item, so prose can never ride on the
 *  gated item above it; an indented line, or a line straight under an item, continues that item. A plain item that
 *  ends in ":" is a lead-in ("These need you:") and is judged for choice wording only. */
// W2-H1B-SCOUT L2: an indented list line under an item is a nested item of its own (it was glued onto
// its parent, so "1. Push …\n   - Rebuild the installer." passed on the parent's gate)
const NESTED_ITEM_RE = /^([ \t]+)(?:\d+[.)]|[-*])[ \t]+/;
function itemsOf(body) {
  const items = [];
  let cur = null, tableHeader = true, afterBlank = false, stack = [];
  for (const { n, text } of body) {
    if (!text.trim()) { afterBlank = true; continue; }
    const blank = afterBlank; afterBlank = false;
    if (TABLE_RE.test(text)) {
      if (TABLE_SEP_RE.test(text)) { tableHeader = false; continue; }
      if (tableHeader) continue; // the header row names columns, it asks nothing
      cur = null; stack = []; items.push({ line: n, parts: [text.replace(/\|/g, ' ').trim()], parent: -1 }); continue;
    }
    tableHeader = true;
    const nested = NESTED_ITEM_RE.exec(text);
    if (nested && stack.length) {
      const indent = nested[1].replace(/\t/g, '    ').length;
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      cur = { line: n, parts: [text.replace(NESTED_ITEM_RE, '')], parent: stack[stack.length - 1].idx };
      items.push(cur); stack.push({ indent, idx: items.length - 1 }); continue;
    }
    if (ITEM_RE.test(text.trimStart())) {
      cur = { line: n, parts: [text.trimStart().replace(ITEM_RE, '')], parent: -1 };
      items.push(cur); stack = [{ indent: 0, idx: items.length - 1 }]; continue;
    }
    if (cur && (/^\s/.test(text) || (!blank && !cur.plain))) { cur.parts.push(text.trim()); continue; }
    if (cur && cur.plain && !blank) { cur.parts.push(text.trim()); continue; }
    cur = { line: n, parts: [text.trim()], plain: true, parent: -1 }; stack = []; items.push(cur);
  }
  return items.map((it) => {
    const t = it.parts.join(' ');
    return { line: it.line, text: t, parent: it.parent, plain: !!it.plain, leadIn: /:\s*$/.test(t) };
  });
}
const choiceReason = (m) => 'hands the owner an open choice ("' + m + '"): take it yourself with a one-line reason (standing rule owner-remember-mw2ld5jc-caudls), or name the hard gate and drop the choice wording';
/** checkText(md) -> {section, items, findings[]} */
function checkText(md) {
  const lines = String(md || '').split(/\r?\n/);
  const secs = sectionsOf(lines);
  const findings = [];
  let n = 0, total = 0, section = false, queueLevel = 0, pending = [];
  // L2: a plain lead-in waits for an item under it, also one under a deeper subheading; the queue's end settles it
  const flush = () => { for (const p of pending) findings.push(p); pending = []; };
  secs.forEach((s, idx) => {
    // round-5 N3: a deeper subheading inside a queue section ("### Group A") stays part of that queue
    const inQueue = queueLevel && s.level > queueLevel;
    if (!inQueue) { flush(); queueLevel = QUEUE_TITLE_RE.test(s.title) ? s.level : 0; }
    if (inQueue || queueLevel) {
      section = true;
      const items = itemsOf(s.body);
      total += items.length;
      const ids = [], gated = [], kids = [];
      items.forEach((it, k) => {
        // top-level items keep their plain number (1, 2, 3); a nested item is numbered under its parent (3.1, 3.1.2)
        if (it.parent < 0) { n++; ids[k] = n; } else { kids[it.parent] = (kids[it.parent] || 0) + 1; ids[k] = ids[it.parent] + '.' + kids[it.parent]; }
        const choice = CHOICE_RE.exec(it.text);
        const namedAck = ACK_RE.test(it.text) && RID_RE.test(it.text);
        // L2: a sub-bullet under a gated lead-in item ("Retire these (outside this project):") names that item's objects
        const inherits = it.parent >= 0 && items[it.parent].leadIn && gated[it.parent];
        gated[k] = namedAck || GATE_RE.test(it.text) || inherits;
        const base = { item: ids[k], line: it.line, where: s.title, text: it.text.slice(0, 200) };
        const leadIn = it.plain && it.leadIn;
        if (!leadIn) pending = []; // an item: the open lead-in did lead in to something
        else flush(); // a second lead-in: the one before it had nothing under it
        if (choice) findings.push(Object.assign(base, { reason: choiceReason(choice[0]) }));
        else if (leadIn) {
          // L2: a plain lead-in is judged for choice wording only, but it must lead in to at least one item
          pending.push(Object.assign(base, { reason: 'is a lead-in ("…:") with no queue item under it: drop it or put the hard-gated items under it' }));
        } else if (!gated[k]) findings.push(Object.assign(base, { reason: 'names no hard gate (push, deploy, spend, outbound, credentials or sign-in, production, destructive or --force, settings or plugin write, outside the project, an ack of named items, a value only the owner has): decide it yourself instead of queueing it' }));
      });
      return;
    }
    const last = idx === secs.length - 1 && !SELF_REVIEW_RE.test(s.title);
    if (!NEXT_TITLE_RE.test(s.title) && !last) return;
    for (const { n: ln, text } of s.body) {
      const choice = CHOICE_RE.exec(text);
      if (choice) findings.push({ item: 'next', line: ln, where: s.title, text: text.trim().slice(0, 200), reason: choiceReason(choice[0]) + ' (in the closing "' + s.title + '" section)' });
    }
  });
  flush();
  findings.sort((a, b) => a.line - b.line);
  return { section, items: total, findings };
}
function checkFile(file) { return checkText(fs.readFileSync(file, 'utf8')); }

function main(argv) {
  const i = argv.indexOf('--file');
  const file = i >= 0 ? argv[i + 1] : null;
  if (!file) { process.stderr.write('usage: forge-owner-queue-check.cjs --file <report.md> [--json]\n'); return 2; }
  let r;
  try { r = checkFile(file); } catch (e) { process.stderr.write('forge-owner-queue-check: cannot read ' + file + ': ' + e.message + '\n'); return 2; }
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (!r.findings.length) process.stdout.write(r.section ? 'owner queue clean: ' + r.items + ' item(s), each a hard gate; no choice in the closing sections\n' : 'no owner queue section in ' + file + '; no choice in the closing sections\n');
  else for (const f of r.findings) process.stdout.write((f.item === 'next' ? 'closing section' : 'item ' + f.item) + ' (line ' + f.line + '): ' + f.reason + '\n  "' + f.text + '"\n');
  return r.findings.length ? 1 : 0;
}

module.exports = { checkText, checkFile, CHOICE_RE, GATE_RE, QUEUE_TITLE_RE, NEXT_TITLE_RE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
