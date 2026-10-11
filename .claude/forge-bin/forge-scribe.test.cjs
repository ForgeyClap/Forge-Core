#!/usr/bin/env node
'use strict';
/**
 * forge-scribe.test.cjs — hermetic tests for forge-scribe.cjs (+ -store, -classify, -owner, -integrity). Every fixture
 * lives under os.tmpdir() (fs.mkdtempSync) and is passed via opts.root / FORGE_PROJECT_ROOT; this file never touches
 * the real project's .claude/forge-scribe/ nor the real ~/.claude. Covers audit SCRIBE-F11 items 1-9, 12 and 16, and
 * the Codex R3 findings SC-01, SC-02, SC-03, SC-06, SC-07, SC-09, SC-10 and SC-11 (sections 20-27; SC-04/05/08/12 and
 * the hook side of SC-06/SC-11 live in forge-scribe-hook.test.cjs, log-event-completion-gate.test.cjs and
 * forge-finalize.test.cjs).
 *
 * Owner prompts are simulated the way the UserPromptSubmit hook delivers them: a Claude-style transcript entry
 * (promptId, sessionId, timestamp) under a TEMP "~/.claude/projects/<slug of the fixture root>/" folder, captured with
 * source 'hook'. The library seam claudeProjectsRoot points the owner check at that temp folder (the pre-R3 seam
 * transcriptRoots is passed too, so each regression test can be run unchanged against the pre-R3 code and fail there).
 * Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const SC = require('./forge-scribe.cjs');
const S = require('./forge-scribe-store.cjs');
const C = require('./forge-scribe-classify.cjs');

const CLI = path.join(__dirname, 'forge-scribe.cjs');
const cfg = C.loadConfig();
let pass = 0, fail = 0;
const t = (name, cond, info) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (info ? ' :: ' + String(info).slice(0, 600) : '')); } };
const throwsRefused = (fn) => { try { fn(); return false; } catch (e) { return e && e.code === 'SCRIBE_REFUSED'; } };
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e && e.code === 'SCRIBE_REFUSED' ? e.message : 'NOT-A-REFUSAL: ' + (e && e.message); } };
/** section(name, fn) — a section that throws (e.g. an API the code under test lacks) is ONE failure, never a crash. */
const section = (name, fn) => { try { fn(); } catch (e) { fail++; console.error('  FAIL ' + name + ' threw: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } };
const slugOf = (d) => path.resolve(d).replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's project folder rule
const rnd = () => crypto.randomBytes(5).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const linesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()) : []);

const TMP = [];
function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-' + prefix + '-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-home-'));
  TMP.push(root, home);
  const projects = path.join(home, '.claude', 'projects');
  const tr = path.join(projects, slugOf(root));
  fs.mkdirSync(tr, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  let clock = Date.parse('2026-10-01T09:00:00Z');
  const opts = (extra) => Object.assign({ root, config: cfg, claudeProjectsRoot: projects, transcriptRoots: [tr], now: () => new Date(clock), standingRulesPath: path.join(root, 'standing.user.json') }, extra || {});
  /** a transcript entry exactly as Claude Code writes a typed prompt (fields used by the owner check) */
  const entry = (text, sess, o) => Object.assign({ type: 'user', uuid: 'u-' + rnd(), promptId: 'p-' + rnd(), sessionId: sess, timestamp: new Date(clock).toISOString(), message: { role: 'user', content: text } }, o || {});
  /** hookCapture(text, {session, tp, entry}) — capture as the hook does, with the given transcript entry/path */
  const hookCapture = (text, o) => {
    o = o || {};
    const sess = o.session || 's1';
    const tp = o.tp || path.join(tr, sess + '.jsonl');
    const e = o.entry === undefined ? entry(text, sess) : o.entry;
    if (e) { fs.mkdirSync(path.dirname(tp), { recursive: true }); fs.appendFileSync(tp, JSON.stringify(e) + '\n'); }
    const meta = { source: o.source || 'hook', session_id: sess, transcript_path: tp, uuid: e ? e.uuid : undefined, prompt_id: o.noPromptId ? undefined : (e ? e.promptId : 'p-' + rnd()) };
    return SC.capture(text, opts(Object.assign(meta, o.extra || {})));
  };
  return {
    root, home, projects, tr, opts, entry, hookCapture,
    tick: (sec) => { clock += sec * 1000; },
    p: S.paths(root),
    /** Simulate a real owner prompt: a Claude transcript entry under ~/.claude/projects/<slug>/ + the hook capture. */
    owner: (text, session, extra) => hookCapture(text, { session, extra }),
    events: (runId, evs) => {
      const d = path.join(root, '.claude', 'forge-runs', runId);
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, 'events.jsonl'), evs.map((e) => JSON.stringify(Object.assign({ run_id: runId }, e))).join('\n') + '\n');
    },
    finish: (rid, wp, runId) => { // plan, start and finish an item with real wp_completed evidence
      SC.transition(rid, 'link', { wp_ids: [wp], run_id: runId }, opts());
      SC.transition(rid, 'start', {}, opts());
      return SC.transition(rid, 'done', { evidence: { type: 'wp_completed', ref: wp }, run_id: runId }, opts());
    },
  };
}
const envFor = (f, extra) => Object.assign({}, process.env, { FORGE_PROJECT_ROOT: f.root }, extra || {});

console.log('forge-scribe hermetic tests (os.tmpdir() fixtures only)');

// ---------------------------------------------------------------- 1. classifier corpus
{
  const corpus = [
    // change (NL/EN)
    ['Verander de kleur van de knoppen naar groen', 'change'],
    ['Pas de header aan zodat het logo links staat', 'change'],
    ['Kun je de titel wijzigen naar Welkom thuis', 'change'],
    ['De footer moet donkerder worden', 'change'],
    ['Gebruik Inter in plaats van Roboto voor de body', 'change'],
    ['Hernoem de pagina diensten naar aanbod', 'change'],
    ['Vervang de hero-foto door een foto van het team', 'change'],
    ['Ik heb liever een witte achtergrond', 'change'],
    ['Change the button color to green', 'change'],
    ['Rename the settings page to preferences', 'change'],
    ['Use Postgres instead of SQLite', 'change'],
    ['Make the logo bigger on mobile', 'change'],
    ['Replace the placeholder images with the real photos', 'change'],
    ['The submit button should be on the right', 'change'],
    ['Switch the chart library to Recharts', 'change'],
    ['Modify the export so it writes CSV', 'change'],
    // new
    ['Voeg een contactformulier toe aan de homepage', 'new'],
    ['Ook wil ik een nieuwsbrief-aanmelding onderaan', 'new'],
    ['Maak ook een donkere modus', 'new'],
    ['Bouw een dashboard voor de omzetcijfers', 'new'],
    ['Zet er een FAQ-sectie erbij', 'new'],
    ['Kun je een zoekfunctie toevoegen?', 'new'],
    ['Add a login page with email and password fields', 'new'],
    ['I also want a pricing table', 'new'],
    ['Create an export to PDF', 'new'],
    ['Please implement rate limiting on the API', 'new'],
    ['Build a small admin panel for the bookings', 'new'],
    ['Include a sitemap.xml in the build', 'new'],
    ['I need a cron job that sends the weekly report', 'new'],
    // cancel
    ['Laat de blog maar zitten', 'cancel'],
    ['Schrap de animatie op de homepage', 'cancel'],
    ['Die nieuwsbrief hoeft niet meer', 'cancel'],
    ['Vergeet die PDF-export', 'cancel'],
    ['Annuleer R-0007', 'cancel'],
    ['Never mind the dark mode', 'cancel'],
    ['Cancel the PDF export', 'cancel'],
    ['Scrap the onboarding tour', 'cancel'],
    ["We don't need the admin panel anymore", 'cancel'],
    ['Drop the analytics integration', 'cancel'],
    // preference
    ['Voortaan wil ik alle teksten in het Nederlands', 'preference'],
    ['Gebruik nooit lorem ipsum', 'preference'],
    ['In het vervolg eerst een plan sturen', 'preference'],
    ['Altijd mobiel eerst testen', 'preference'],
    ['From now on write commit messages in English', 'preference'],
    ['Always run the tests before you report done', 'preference'],
    ['Never use default Tailwind colors', 'preference'],
    ['Going forward keep the replies short', 'preference'],
    // question
    ['Hoe werkt de betaalkoppeling precies?', 'question'],
    ['Waarom is de build zo traag?', 'question'],
    ['Wat is de status van het dashboard?', 'question'],
    ['Klopt het dat de API nog geen auth heeft?', 'question'],
    ['How does the caching layer work?', 'question'],
    ['Why did the deploy fail?', 'question'],
    ['What is left on the backlog?', 'question'],
    ['Is it possible to run this offline?', 'question'],
    // ack
    ['Akkoord met R-0012', 'ack'],
    ['Ziet er goed uit, goed zo', 'ack'],
    ['Prima, R-0003 is goedgekeurd', 'ack'],
    ['Looks good to me', 'ack'],
    ['LGTM', 'ack'],
    ['Approved, R-0020 can be closed', 'ack'],
    ['Perfect, dat klopt', 'ack'],
    // ambiguous -> unclassified (never guess)
    ['de knoppen', 'unclassified'],
    ['hmm', 'unclassified'],
    ['zie mijn vorige bericht', 'unclassified'],
    ['the thing from yesterday', 'unclassified'],
    ['ok maar verander de kleur', 'unclassified'],
    ['Logo', 'unclassified'],
    ['ga door', 'unclassified'],
    ['continue', 'unclassified'],
    // polite requests phrased as a question must not become 'question'
    ['Kan de tekst op de homepage korter?', 'unclassified'],
    ['Kun je de API ook voor mobiel maken?', 'unclassified'],
    ['Can you add a search bar?', 'new'],
    ['Could you rename the export button?', 'change'],
    ['Can you explain the deploy flow?', 'question'],
    ['Remove the sidebar on mobile', 'change'],
    ['Fix the broken link in the footer', 'change'],
    ['Graag ook een Engelse versie', 'new'],
    ['Thanks, that works', 'ack'],
    ['De knop werkt niet', 'unclassified'],
  ];
  let ok = 0;
  const misses = [];
  for (const [txt, want] of corpus) {
    const got = C.classify(txt, cfg).class;
    if (got === want) ok++; else misses.push(JSON.stringify(txt) + ' want ' + want + ' got ' + got);
  }
  const acc = ok / corpus.length;
  t('1a: classifier corpus has >= 60 labelled NL/EN prompts (' + corpus.length + ')', corpus.length >= 60);
  t('1b: classifier exact accuracy >= 95% (' + (acc * 100).toFixed(1) + '%)', acc >= 0.95, misses.join(' | '));
  const amb = corpus.filter((x) => x[1] === 'unclassified');
  t('1c: every ambiguous prompt goes to unclassified, never a wrong class', amb.every(([txt]) => C.classify(txt, cfg).class === 'unclassified'),
    amb.filter(([txt]) => C.classify(txt, cfg).class !== 'unclassified').map((x) => x[0]).join(' | '));
  const multi = C.classify('Verander de kleur naar groen. Voeg een contactformulier toe. Schrap de blog. Voortaan alles in het Nederlands.', cfg);
  t('1d: a prompt with 3+ asks is flagged multi_ask (Scribe-agent dispatch trigger)', multi.multi_ask === true && multi.asks >= 3);
  t('1e: a single ask is not multi_ask', C.classify('Voeg een contactformulier toe', cfg).multi_ask === false);
  if (misses.length) console.log('     classifier misses: ' + misses.join(' | '));
}

// ---------------------------------------------------------------- 2. hash chains
section('2', () => {
  const f = fixture('chain');
  for (let i = 0; i < 5; i++) { f.owner('Voeg feature nummer ' + i + ' toe'); f.tick(200); }
  t('2a: fresh inbox + ledger chains verify OK', SC.verifyChains(f.opts()).ok);
  const lines = fs.readFileSync(f.p.inbox, 'utf8').split('\n').filter(Boolean);
  const mid = JSON.parse(lines[2]); mid.text = 'Voeg feature nummer 99 toe'; lines[2] = JSON.stringify(mid);
  fs.writeFileSync(f.p.inbox, lines.join('\n') + '\n');
  const r = SC.verifyChains(f.opts());
  t('2b: an edited middle inbox line is detected', !r.ok && !r.inbox.ok && r.inbox.breaks.some((b) => b.line === 4));
  const f2 = fixture('chain2');
  for (let i = 0; i < 4; i++) { f2.owner('Verander tekst ' + i); f2.tick(200); }
  const ll = fs.readFileSync(f2.p.ledger, 'utf8').split('\n').filter(Boolean);
  const m2 = JSON.parse(ll[1]); m2.class = 'cancel'; ll[1] = JSON.stringify(m2);
  fs.writeFileSync(f2.p.ledger, ll.join('\n') + '\n');
  t('2c: an edited middle ledger line is detected', !SC.verifyChains(f2.opts()).ledger.ok);
  const f3 = fixture('chain3');
  for (let i = 0; i < 3; i++) { f3.owner('Verander tekst ' + i); f3.tick(200); }
  const l3 = fs.readFileSync(f3.p.ledger, 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(l3[l3.length - 1]); last.class = 'cancel'; l3[l3.length - 1] = JSON.stringify(last);
  fs.writeFileSync(f3.p.ledger, l3.join('\n') + '\n');
  t('2d: an edited LAST ledger line is caught via the cached ledger_head', !SC.verifyChains(f3.opts()).ledger.ok);
  const cli = spawnSync(process.execPath, [CLI, 'verify-chain'], { encoding: 'utf8', env: envFor(f) });
  t('2e: CLI verify-chain exits 3 on a broken chain', cli.status === 3, cli.stdout + cli.stderr);
});

// ---------------------------------------------------------------- 3. idempotent + incremental folding
section('3', () => {
  const f = fixture('fold');
  for (let i = 0; i < 12; i++) { f.owner((i % 2 ? 'Verander pagina ' : 'Voeg sectie toe nummer ') + i); f.tick(150); }
  SC.transition('R-0001', 'link', { wp_ids: ['wp-1'], run_id: 'run-a' }, f.opts());
  SC.transition('R-0001', 'start', {}, f.opts());
  SC.transition('R-0002', 'defer', { reason: 'next sprint' }, f.opts());
  const incremental = JSON.parse(fs.readFileSync(f.p.state, 'utf8'));
  const full = S.rebuildState(f.p);
  const strip = (s) => JSON.stringify({ items: s.items, last_seq: s.last_seq, head: s.ledger_head, off: s.ledger_offset, counts: s.counts, next: s.next_rid });
  t('3a: incremental state equals a from-scratch rebuild', strip(incremental) === strip(full));
  const again = S.loadState(f.p);
  t('3b: loading again with no new ledger bytes changes nothing (idempotent)', strip(again) === strip(incremental));
  const r1 = SC.rebuild(f.opts()), r2 = SC.rebuild(f.opts());
  t('3c: rebuild twice gives the same state', strip(r1) === strip(r2));
  const st = S.rebuildState(f.p);
  st.ledger_offset = 0;
  S.saveState(f.p, st);
  t('3d: re-reading already-folded ledger bytes does not double-apply', strip(S.loadState(f.p)) === strip(full));
  fs.writeFileSync(f.p.state, '{ corrupt');
  t('3e: a corrupt state.json is rebuilt from the ledger', strip(S.loadState(f.p)) === strip(full));
});

// ---------------------------------------------------------------- 4. illegal transitions refused
section('4', () => {
  const f = fixture('trans');
  f.events('run-x', [
    { event_type: 'agent_work_package_created', wp_id: 'wp-1', task: 'header' },
    { event_type: 'wp_completed', wp_id: 'wp-1', command: 'node t', output: 'ok', evidence: 'x', event_id: 'e1' },
  ]);
  f.owner('Verander de header naar blauw'); f.tick(5);
  t('4a: start from open is refused (must be planned first)', throwsRefused(() => SC.transition('R-0001', 'start', {}, f.opts())));
  t('4b: link without --wp/--ticket is refused', throwsRefused(() => SC.transition('R-0001', 'link', {}, f.opts())));
  SC.transition('R-0001', 'link', { wp_ids: ['wp-1'], run_id: 'run-x' }, f.opts());
  t('4c: done from planned (not started) is refused', throwsRefused(() => SC.transition('R-0001', 'done', { evidence: { type: 'wp_completed', ref: 'wp-1' } }, f.opts())));
  SC.transition('R-0001', 'start', {}, f.opts());
  t('4d: done without evidence is refused', throwsRefused(() => SC.transition('R-0001', 'done', {}, f.opts())));
  t('4e: done with an evidence ref not in events.jsonl is refused', throwsRefused(() => SC.transition('R-0001', 'done', { evidence: { type: 'check_passed', ref: 'nope' }, run_id: 'run-x' }, f.opts())));
  t('4f: done with a wp not linked to the item is refused', throwsRefused(() => SC.transition('R-0001', 'done', { evidence: { type: 'wp_completed', ref: 'wp-9' }, run_id: 'run-x' }, f.opts())));
  t('4g: ack before done is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: 'P-000001' }, f.opts())));
  const d = SC.transition('R-0001', 'done', { evidence: { type: 'wp_completed', ref: 'wp-1' }, run_id: 'run-x' }, f.opts());
  t('4h: done with a real wp_completed event is accepted', d.status === 'done' && d.evidence.event_id === 'e1');
  f.tick(5);
  t('4i: ack without an owner pid is refused', throwsRefused(() => SC.transition('R-0001', 'ack', {}, f.opts())));
  // agent-forged inbox record: captured by the CLI path, without a transcript
  const cliRec = SC.capture('R-0001 akkoord', f.opts({ source: 'cli' })); f.tick(5);
  t('4j: ack whose prompt was not captured by the hook (no transcript) is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: cliRec.pid }, f.opts())));
  // a hook-shaped record whose transcript does not contain the message
  const fakeTp = path.join(f.tr, 'fake.jsonl');
  fs.writeFileSync(fakeTp, JSON.stringify(f.entry('iets anders', 'fake')) + '\n');
  const k = f.hookCapture('Akkoord R-0001 hoor', { session: 'fake', tp: fakeTp, entry: null }); f.tick(5);
  t('4k: ack whose prompt is missing from its transcript is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: k.pid }, f.opts())));
  // transcript outside the project's transcript folder
  const outside = path.join(f.root, 'elsewhere.jsonl');
  const l = f.hookCapture('R-0001 is akkoord', { session: 'q', tp: outside }); f.tick(5);
  t('4l: ack whose transcript is outside the project transcript folder is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: l.pid }, f.opts())));
  // a tool_result (not the owner) carrying the text
  const toolTp = path.join(f.tr, 'tool.jsonl');
  const m = f.hookCapture('R-0001 goed zo', { session: 'tool', tp: toolTp, entry: f.entry('', 'tool', { message: { role: 'user', content: [{ type: 'tool_result', content: 'R-0001 goed zo' }] } }) }); f.tick(5);
  t('4m: a tool_result in the transcript does not count as the owner', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: m.pid }, f.opts())));
  const n = f.owner('R-0042 akkoord'); f.tick(5);
  t('4n: ack whose owner prompt names a different R-id is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: n.pid }, f.opts())));
  const o = f.owner('Prima, R-0001 is goedgekeurd'); f.tick(5);
  const acked = SC.transition('R-0001', 'ack', { pid: o.pid }, f.opts());
  t('4o: ack with a real owner prompt naming the R-id is accepted', acked.status === 'acked' && acked.acked_by_pid === o.pid, JSON.stringify(acked));
  t('4p: cancel without an owner pid is refused', throwsRefused(() => SC.transition('R-0002', 'cancel', {}, f.opts())));
  t('4q: unknown op is refused', throwsRefused(() => SC.transition('R-0002', 'teleport', {}, f.opts())));
  t('4r: defer without a reason is refused', throwsRefused(() => SC.transition('R-0002', 'defer', {}, f.opts())));
  t('4s: answer on a non-question item is refused', throwsRefused(() => SC.transition('R-0001', 'answer', {}, f.opts())));
  const cli = spawnSync(process.execPath, [CLI, 'transition', 'R-0001', 'start'], { encoding: 'utf8', env: envFor(f) });
  t('4t: CLI exits 2 on an illegal transition', cli.status === 2 && /illegal transition/.test(cli.stderr), cli.stderr);
});

// ---------------------------------------------------------------- 5. secrets never stored
section('5', () => {
  const f = fixture('secret');
  const fakeKey = 'sk-' + 'Zq9'.repeat(12);
  const fakeGh = 'ghp_' + 'a1B2'.repeat(9);
  const fakePw = 'hunter2' + 'Xy7z' + 'Q9';
  const r = f.owner('Gebruik deze key ' + fakeKey + ' en token ' + fakeGh + ' en password=' + fakePw + ' voor de API, verander de config');
  const all = ['inbox', 'ledger', 'state', 'digest'].map((k) => (fs.existsSync(f.p[k]) ? fs.readFileSync(f.p[k], 'utf8') : '')).join('\n');
  t('5a: a planted fake API key never reaches any scribe file', !all.includes(fakeKey) && !all.includes(fakeKey.slice(3)));
  t('5b: a planted GitHub token never reaches any scribe file', !all.includes(fakeGh));
  t('5c: a labelled password value never reaches any scribe file', !all.includes(fakePw));
  t('5d: the record is marked redacted and the rest of the prompt is kept word-for-word', r.redacted === true && /verander de config/.test(fs.readFileSync(f.p.inbox, 'utf8')));
});

// ---------------------------------------------------------------- 6. capture fails open (library + CLI)
section('6', () => {
  const f = fixture('failopen');
  f.owner('Voeg een footer toe'); f.tick(5);
  fs.writeFileSync(f.p.state, 'not json at all');
  const cli = spawnSync(process.execPath, [CLI, 'capture', '--text', 'Verander de footer naar grijs', '--source', 'cli'], { encoding: 'utf8', env: envFor(f) });
  const inboxLines = linesOf(f.p.inbox).length;
  t('6a: corrupt state.json -> CLI capture still exits 0', cli.status === 0, cli.stderr);
  t('6b: ... and the inbox is still appended', inboxLines === 2);
  fs.appendFileSync(f.p.ledger, '{ broken line\n');
  const r = SC.capture('Voeg een banner toe', f.opts({ now: () => new Date(Date.parse('2026-10-02T00:00:00Z')) }));
  t('6c: corrupt ledger -> capture still stores the prompt and reports ledger_error', !!r.pid && !!r.ledger_error && fs.readFileSync(f.p.inbox, 'utf8').includes('Voeg een banner toe'));
  const g = fixture('latency');
  const times = [];
  for (let i = 0; i < 200; i++) { const t0 = process.hrtime.bigint(); SC.capture('Verander item ' + i, g.opts()); times.push(Number(process.hrtime.bigint() - t0) / 1e6); g.tick(1); }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  const median = times[Math.floor(times.length / 2)];
  t('6d: in-process capture median < 150 ms and p95 < 1500 ms over 200 captures (median ' + median.toFixed(1) + ' ms, p95 ' + p95.toFixed(1) + ' ms)', median < 150 && p95 < 1500);
});

// ---------------------------------------------------------------- 8. digest cap
section('8', () => {
  const f = fixture('digest');
  for (let i = 0; i < 200; i++) { SC.capture('Verander onderdeel nummer ' + i + ' met een redelijk lange omschrijving erbij', f.opts()); f.tick(130); }
  const d = SC.digest(f.opts({ write: true }));
  const lines = d.split('\n');
  t('8a: digest <= 1200 chars with 200 items (' + d.length + ')', d.length <= 1200);
  t('8b: DIGEST.md on disk respects the cap too', fs.readFileSync(f.p.digest, 'utf8').trimEnd().length <= 1200);
  t('8c: newest open item is listed first', /^R-0200 /.test(lines[1]), lines[1]);
  t('8d: overflow is summarised, not silently dropped', /more \(forge-scribe list\)$/.test(lines[lines.length - 1]));
});

// ---------------------------------------------------------------- 9. impact
section('9', () => {
  const f = fixture('impact');
  f.events('run-i', [
    { event_type: 'agent_work_package_created', wp_id: 'wp-1', task: 'Header + navigation', output_artifact: 'src/components/Header.tsx' },
    { event_type: 'agent_work_package_created', wp_id: 'wp-2', task: 'Pricing page', inputs: ['src/pages/pricing.tsx'] },
    { event_type: 'agent_work_package_created', wp_id: 'wp-3', task: 'Contact form backend', allowed_actions: ['edit api/contact.js'] },
  ]);
  f.owner('Verander in src/pages/pricing.tsx de prijzen naar maandbedragen', 's1', { run_id: 'run-i', run_active: true });
  const im = SC.impact('R-0001', 'run-i', f.opts());
  t('9a: a change touching one path proposes exactly that package', JSON.stringify(im.proposed) === '["wp-2"]', JSON.stringify(im.proposed));
  t('9b: the captured item is marked impact:pending while a run is active', SC.list(f.opts())[0].impact === 'pending');
  f.tick(10);
  f.owner('Verander de contact form backend validatie', 's1', { run_id: 'run-i' });
  const im2 = SC.impact('R-0002', 'run-i', f.opts());
  t('9c: without a path, word overlap proposes the matching package', JSON.stringify(im2.proposed) === '["wp-3"]', JSON.stringify(im2.scored.slice(0, 2)));
  SC.transition('R-0001', 'link', { wp_ids: im.proposed, run_id: 'run-i' }, f.opts());
  t('9d: link clears impact:pending and plans the item', SC.list(f.opts())[0].status === 'planned' && SC.list(f.opts())[0].impact === null);
});

// ---------------------------------------------------------------- 12. ledger change after "finalize" is visible
section('12', () => {
  const f = fixture('receipt');
  f.owner('Voeg een logo toe'); f.tick(5);
  const atFinalize = SC.gate(f.opts()).ledger_head;
  SC.transition('R-0001', 'defer', { reason: 'later' }, f.opts());
  t('12a: any ledger change after finalize changes ledger_head (the value WP-7b binds into the receipt)', SC.gate(f.opts()).ledger_head !== atFinalize);
  const l = fs.readFileSync(f.p.ledger, 'utf8').split('\n').filter(Boolean);
  const r = JSON.parse(l[l.length - 1]); r.reason = 'edited'; l[l.length - 1] = JSON.stringify(r);
  fs.writeFileSync(f.p.ledger, l.join('\n') + '\n');
  t('12b: a hand-edit of the ledger after finalize turns verify-chain red', !SC.verifyChains(f.opts()).ok);
});

// ---------------------------------------------------------------- 16. 7-day / 30-prompt simulation
section('16', () => {
  const f = fixture('sim');
  fs.writeFileSync(f.opts().standingRulesPath, JSON.stringify({ version: 1, rules: [{ id: 'owner-remember-sim-1' }, { id: 'owner-remember-sim-2' }] }));
  const run = 'run-sim';
  const prompts = [
    ['d1', 'Bouw een landingspagina voor de bakkerij'], ['d1', 'Voeg een contactformulier toe'], ['d1', 'Verander de kleur van de knoppen naar groen'],
    ['d1', 'Hoe werkt de deploy straks?'], ['d1', 'Voortaan alle teksten in het Nederlands'], ['d1', 'Voeg een openingstijden-blok toe'],
    ['d2', 'Pas de header aan zodat het logo links staat'], ['d2', 'Add a newsletter signup in the footer'], ['d2', 'Schrap de animatie op de homepage'],
    ['d2', 'Waarom is de pagina zo traag?'], ['d2', 'Voeg een fotogalerij toe'], ['d2', 'Change the font to Inter'],
    ['d3', 'Maak ook een donkere modus'], ['d3', 'Voeg een kaart met de locatie toe'], ['d3', 'Never use stock photos'],
    ['d3', 'Vervang de hero-foto door een foto van het team'], ['d3', 'Add a cookie banner'], ['d3', 'What is left on the backlog?'],
    ['d4', 'Voeg reviews van klanten toe'], ['d4', 'Hernoem de pagina diensten naar aanbod'], ['d4', 'Add an online ordering page'],
    ['d4', 'Verander de footer naar donkergrijs'], ['d4', 'Voeg een FAQ toe'], ['d4', 'Create a sitemap'],
    ['d5', 'Voeg een vacaturepagina toe'], ['d5', 'Change the button text to Bestel nu'], ['d5', 'Add structured data for the bakery'],
    ['d5', 'Voeg een Instagram-feed toe'], ['d5', 'Pas de prijzen aan op de bestelpagina'], ['d5', 'Verander de favicon naar het nieuwe logo'],
  ];
  t('16a: simulation has 30 prompts over 5 sessions', prompts.length === 30 && new Set(prompts.map((x) => x[0])).size === 5);
  const DAY = 86400;
  let sessionIdx = -1, lastSession = null;
  for (const [sess, text] of prompts) {
    if (sess !== lastSession) { sessionIdx++; lastSession = sess; if (sessionIdx > 0) f.tick(DAY + 3600); }
    f.owner(text, sess, { run_id: run, run_active: true });
    f.tick(600);
    if (sess === 'd3' && text.startsWith('Never use')) {
      const before = JSON.stringify(S.loadState(f.p).items);
      fs.unlinkSync(f.p.state); fs.unlinkSync(f.p.digest);
      const after = JSON.stringify(SC.rebuild(f.opts()).items);
      t('16b: compaction mid-run: rebuilt state equals the state before', before === after);
    }
  }
  const resumed = SC.list(f.opts());
  t('16c: resume sees every one of the 30 captured items', resumed.length === 30);
  for (const it of resumed.filter((i) => i.status === 'unclassified')) SC.transition(it.rid, 'classify', { class: 'new' }, f.opts());
  const items = SC.list(f.opts());
  const actionable = items.filter((i) => i.class === 'new' || i.class === 'change');
  const leaveOpen = actionable[actionable.length - 1].rid;
  const leavePlanned = actionable[actionable.length - 2].rid;
  const leaveInProgress = actionable[actionable.length - 3].rid;
  const evs = [];
  let wpN = 0;
  const finish = [];
  for (const it of actionable) {
    if (it.rid === leaveOpen) continue;
    const wp = 'wp-' + (++wpN);
    evs.push({ event_type: 'agent_work_package_created', wp_id: wp, task: it.title });
    SC.transition(it.rid, 'link', { wp_ids: [wp], run_id: run }, f.opts());
    if (it.rid === leavePlanned) continue;
    SC.transition(it.rid, 'start', {}, f.opts());
    if (it.rid === leaveInProgress) continue;
    evs.push({ event_type: 'wp_completed', wp_id: wp, command: 'node test', output: 'ok', evidence: 'test', event_id: 'ev-' + wp });
    finish.push([it.rid, wp]);
  }
  f.events(run, evs);
  for (const [rid, wp] of finish) SC.transition(rid, 'done', { evidence: { type: 'wp_completed', ref: wp }, run_id: run }, f.opts());
  for (const it of items.filter((i) => i.class === 'question')) SC.transition(it.rid, 'answer', { reason: 'answered in chat' }, f.opts());
  let ruleN = 0;
  for (const it of items.filter((i) => i.class === 'preference')) SC.transition(it.rid, 'done', { evidence: { type: 'standing_rule', ref: 'owner-remember-sim-' + (++ruleN) } }, f.opts());
  const cancelItem = items.find((i) => i.class === 'cancel');
  f.tick(600);
  const cp = f.owner('Laat ' + cancelItem.rid + ' maar zitten', 'd5');
  SC.transition(cancelItem.rid, 'cancel', { pid: cp.pid }, f.opts());
  t('16d0: applying the owner cancel also answers the owner\'s own cancel prompt item (it carried nothing else)', S.loadState(f.p).items[cp.rid].status === 'answered', JSON.stringify(S.loadState(f.p).items[cp.rid]));
  f.tick(600);
  const ackP = f.owner('Alles akkoord, top werk', 'd5');
  for (const it of SC.list(f.opts({ status: 'done' }))) SC.transition(it.rid, 'ack', { pid: ackP.pid }, f.opts());
  const g = SC.gate(f.opts({ final: true }));
  const got = g.blocking.map((b) => b.rid).sort();
  t('16d: final gate reports exactly the 3 deliberately unfinished items', JSON.stringify(got) === JSON.stringify([leaveOpen, leavePlanned, leaveInProgress].sort()), JSON.stringify(g.blocking));
  t('16e: the 3 are open / planned / in-progress', JSON.stringify(g.blocking.map((b) => b.status).sort()) === JSON.stringify(['in-progress', 'open', 'planned']));
  t('16f: chains verify after the whole week', SC.verifyChains(f.opts()).ok);
  t('16g: digest lists the unfinished items and stays within the cap', (() => { const d = SC.digest(f.opts()); return d.length <= 1200 && [leaveOpen, leavePlanned, leaveInProgress].every((r) => d.includes(r)); })());
  const cli = spawnSync(process.execPath, [CLI, 'gate', '--final'], { encoding: 'utf8', env: envFor(f) });
  t('16h: CLI gate --final exits 3 while items are unfinished', cli.status === 3 && /BLOCKED \(3 item/.test(cli.stdout), cli.stdout + cli.stderr);
  // the agent PROPOSES to carry the last three over; the owner's batched ack confirms the proposals
  SC.transition(leaveOpen, 'defer', { reason: 'carry over to next phase' }, f.opts());
  SC.transition(leavePlanned, 'defer', { reason: 'carry over' }, f.opts());
  SC.transition(leaveInProgress, 'defer', { reason: 'carry over' }, f.opts());
  const still = spawnSync(process.execPath, [CLI, 'gate', '--final'], { encoding: 'utf8', env: envFor(f) });
  t('16i: agent-proposed deferrals keep the FINAL gate red until the owner confirms them (SC-03)', still.status === 3 && /defer-proposed/.test(still.stdout), still.stdout);
  f.tick(600);
  const ok2 = f.owner('Alles akkoord', 'd5');
  for (const rid of [leaveOpen, leavePlanned, leaveInProgress]) SC.transition(rid, 'ack', { pid: ok2.pid }, f.opts());
  const cli2 = spawnSync(process.execPath, [CLI, 'gate', '--final'], { encoding: 'utf8', env: envFor(f) });
  t('16j: CLI gate --final exits 0 once every item is acked, answered, cancelled or owner-deferred', cli2.status === 0, cli2.stdout + cli2.stderr);
  t('16k: the owner-confirmed carry-overs read "deferred" (not defer-proposed)', [leaveOpen, leavePlanned, leaveInProgress].every((r) => S.loadState(f.p).items[r].status === 'deferred'));
});

// ---------------------------------------------------------------- 17. import-lines (post-sync adoption)
section('17', () => {
  const f = fixture('import');
  const items = [
    { text: 'Registry-tweak voor Defender-uitzondering nog testen op 26H2', source: 'tasks/RESUME-2026-10-09.md:12' },
    { text: 'TODO: rollback-script voor de taakplanner schrijven', source: '.claude/FORGE_TASK_HISTORY.md:40' },
    { text: 'api key sk-' + 'ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA nog roteren', source: 'tasks/RESUME-2026-10-09.md:13' },
    { text: '   ', source: 'tasks/RESUME-2026-10-09.md:14' },
    { text: 'zonder bron' },
  ];
  const r = SC.importLines(items, f.opts());
  t('17a: import-lines imports the 3 valid items as open R-items', r.imported.length === 3 && r.imported.every((x) => /^R-\d{4}$/.test(x.rid)), JSON.stringify(r));
  t('17b: empty text and a missing source are skipped with a reason', r.skipped.length === 2 && r.skipped.every((s) => s.reason), JSON.stringify(r.skipped));
  const st = S.loadState(f.p);
  const its = r.imported.map((x) => st.items[x.rid]);
  t('17c: imported items are open, class new, no pid, imported_from set', its.every((i) => i.status === 'open' && i.class === 'new' && i.pid === null && /:\d+$/.test(i.imported_from)), JSON.stringify(its));
  t('17d: nothing is written to the inbox (an import is not an owner prompt)', !fs.existsSync(f.p.inbox) || S.readJsonl(f.p.inbox, false).length === 0);
  const ledger = S.readJsonl(f.p.ledger, true);
  t('17e: ledger ops are by:import with import_source + import_key', ledger.filter((l) => l.op === 'open').every((l) => l.by === 'import' && l.import_source && /^[0-9a-f]{64}$/.test(l.import_key)));
  t('17f: a secret in an imported line is scrubbed', !JSON.stringify(ledger).includes('sk-ant-api03-AAAA') && its.some((i) => i.quote.includes('REDACTED') || i.quote.includes('***')), JSON.stringify(its.map((i) => i.quote)));
  const again = SC.importLines(items, f.opts());
  t('17g: re-running the same import is idempotent (0 imported, 3 already imported)', again.imported.length === 0 && again.skipped.filter((s) => s.reason === 'already imported').length === 3, JSON.stringify(again));
  const moved = SC.importLines([{ text: items[0].text, source: 'tasks/RESUME-2026-10-09.md:99' }], f.opts());
  t('17h: the same text on another line of the same file is still a duplicate', moved.imported.length === 0);
  t('17i: chains verify after imports', SC.verifyChains(f.opts()).ok);
  const d = SC.digest(f.opts());
  t('17j: the digest marks imported items "import" instead of a prompt id', r.imported.every((x) => d.includes(x.rid)) && /— import /.test(d), d);
  t('17k: a non-work class is refused', throwsRefused(() => SC.importLines([{ text: 'x y z', source: 'a.md:1' }], f.opts({ class: 'preference' }))));
  t('17l: a non-array input is refused', throwsRefused(() => SC.importLines({ text: 'x' }, f.opts())));
  const f2 = fixture('import-cli');
  const cli = spawnSync(process.execPath, [CLI, 'import-lines', '--stdin', '--json'], { encoding: 'utf8', env: envFor(f2), input: JSON.stringify(items.slice(0, 2)) });
  let cj = null; try { cj = JSON.parse(cli.stdout); } catch { cj = null; }
  t('17m: CLI import-lines --stdin --json exits 0 and imports 2', cli.status === 0 && cj && cj.imported.length === 2, cli.stdout + cli.stderr);
  const gate = spawnSync(process.execPath, [CLI, 'gate'], { encoding: 'utf8', env: envFor(f2) });
  t('17n: imported open items keep the gate red (they are real open work)', gate.status === 3, gate.stdout);
  const bad = spawnSync(process.execPath, [CLI, 'import-lines', '--stdin'], { encoding: 'utf8', env: envFor(f2), input: 'not json' });
  t('17o: CLI refuses invalid JSON with exit 2', bad.status === 2 && /not valid JSON/.test(bad.stderr), bad.stderr);
});

// ================================================================ Codex R3 regression tests
console.log('\nCodex R3 regression tests');

// ---------------------------------------------------------------- 20. SC-01 affirmative owner act
section('20 SC-01', () => {
  const f = fixture('sc01');
  f.events('run-1', [
    { event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' },
    { event_type: 'agent_work_package_created', wp_id: 'wp-2' }, { event_type: 'wp_completed', wp_id: 'wp-2', event_id: 'e2' },
  ]);
  f.owner('Voeg een contactformulier toe'); f.tick(5);
  f.owner('Voeg een nieuwsbrief toe'); f.tick(5);
  f.finish('R-0001', 'wp-1', 'run-1'); f.tick(5);
  const neg = f.owner('Do not approve or cancel R-0001'); f.tick(5);
  t('SC-01a: "Do not approve or cancel R-0001" does NOT authorise an ack', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: neg.pid }, f.opts())));
  t('SC-01b: ... nor a cancel', throwsRefused(() => SC.transition('R-0001', 'cancel', { pid: neg.pid }, f.opts())));
  const nl = f.owner('Niet akkoord met R-0001'); f.tick(5);
  t('SC-01c: "Niet akkoord met R-0001" does not authorise an ack', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: nl.pid }, f.opts())));
  const cn = f.owner('cancel niet R-0002'); f.tick(5);
  t('SC-01d: "cancel niet R-0002" does not authorise a cancel', throwsRefused(() => SC.transition('R-0002', 'cancel', { pid: cn.pid }, f.opts())));
  const mention = f.owner('R-0001 staat nog open in de lijst'); f.tick(5);
  t('SC-01e: a bare mention of the R-id is not an act', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: mention.pid }, f.opts())));
  const mixed = f.owner('R-0001 akkoord. Nee wacht, R-0001 niet akkoord.'); f.tick(5);
  t('SC-01f: an ack and a negated ack of the same R-id in one prompt is ambiguous -> no authorisation', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: mixed.pid }, f.opts())));
  // freshness: a batch ack captured BEFORE R-0002 was done never approves it
  const early = f.owner('Alles akkoord'); f.tick(5);
  f.finish('R-0002', 'wp-2', 'run-1'); f.tick(5);
  t('SC-01g: an old batch ack ("Alles akkoord" before R-0002 was done) does not approve later work', throwsRefused(() => SC.transition('R-0002', 'ack', { pid: early.pid }, f.opts())));
  const yes = f.owner('R-0001 akkoord'); f.tick(5);
  const acked = SC.transition('R-0001', 'ack', { pid: yes.pid }, f.opts());
  t('SC-01h: an affirmative "R-0001 akkoord" made after done is accepted', acked.status === 'acked' && acked.acked_by_pid === yes.pid, JSON.stringify(acked));
  t('SC-01i: the owner\'s own ack prompt item is answered once applied (it carried nothing else)', S.loadState(f.p).items[yes.rid].status === 'answered');
  const withWish = f.owner('R-0002 akkoord, en voeg ook een kaart toe'); f.tick(5);
  SC.transition('R-0002', 'ack', { pid: withWish.pid }, f.opts());
  t('SC-01j: an ack prompt that also carries a new wish keeps its own item open (the wish never disappears)', S.loadState(f.p).items[withWish.rid].status !== 'answered', JSON.stringify(S.loadState(f.p).items[withWish.rid]));
});

// ---------------------------------------------------------------- 21. SC-02 hook-captured provenance
section('21 SC-02', () => {
  const f = fixture('sc02');
  f.events('run-1', [{ event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' }]);
  f.owner('Voeg een contactformulier toe'); f.tick(5);
  f.finish('R-0001', 'wp-1', 'run-1'); f.tick(5);
  const viaCli = f.hookCapture('R-0001 akkoord', { session: 'cli1', source: 'cli' }); f.tick(5);
  t('SC-02a: a record captured outside the hook (source cli) never carries owner authority, even with a matching transcript', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: viaCli.pid }, f.opts())));
  const noPid = f.hookCapture('R-0001 is akkoord', { session: 'np', noPromptId: true }); f.tick(5);
  t('SC-02b: a missing prompt id never passes', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: noPid.pid }, f.opts())));
  const otherProject = path.join(f.projects, slugOf(path.join(os.tmpdir(), 'some-other-project')));
  const foreign = f.hookCapture('R-0001 goed zo', { session: 'fp', tp: path.join(otherProject, 'fp.jsonl') }); f.tick(5);
  t('SC-02c: a transcript in ANOTHER project\'s folder (same projects root) is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: foreign.pid }, f.opts())));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-junction-target-')); TMP.push(target);
  const link = path.join(f.tr, 'linked');
  let linked = false;
  try { fs.symlinkSync(target, link, 'junction'); linked = true; } catch { linked = false; }
  if (linked) {
    const viaLink = f.hookCapture('Prima, R-0001 akkoord', { session: 'jl', tp: path.join(link, 'jl.jsonl') }); f.tick(5);
    t('SC-02d: a junction inside the project folder pointing outside is refused (realpath containment)', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: viaLink.pid }, f.opts())));
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* left for the tmp cleanup */ } }
  } else t('SC-02d: (junction could not be created here — containment covered by SC-02c)', true);
  const sessMismatch = f.hookCapture('R-0001 akkoord hoor', { session: 'sm', entry: f.entry('R-0001 akkoord hoor', 'some-other-session') }); f.tick(5);
  t('SC-02e: a transcript entry from another session is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: sessMismatch.pid }, f.opts())));
  // the CLI: no environment override of the transcript roots, and --prompt looks the prompt up in the inbox
  const good = f.owner('Akkoord met R-0001'); f.tick(5);
  const envOverride = spawnSync(process.execPath, [CLI, 'transition', 'R-0001', 'ack', '--pid', good.pid], { encoding: 'utf8', env: envFor(f, { FORGE_SCRIBE_TRANSCRIPT_ROOTS: f.tr }) });
  t('SC-02f: CLI ignores FORGE_SCRIBE_TRANSCRIPT_ROOTS: a fake transcript root is never trusted (exit 2)', envOverride.status === 2 && S.loadState(f.p).items['R-0001'].status === 'done', envOverride.stdout + envOverride.stderr);
  const viaPrompt = spawnSync(process.execPath, [CLI, 'transition', 'R-0001', 'ack', '--prompt', viaCli.pid], { encoding: 'utf8', env: envFor(f) });
  t('SC-02g: CLI --prompt P-n looks the prompt up in the inbox and names why it cannot authorise', viaPrompt.status === 2 && /not captured by the UserPromptSubmit hook/.test(viaPrompt.stderr), viaPrompt.stderr);
  const forgedSource = spawnSync(process.execPath, [CLI, 'capture', '--text', 'R-0001 akkoord', '--source', 'hook'], { encoding: 'utf8', env: envFor(f) });
  t('SC-02h: CLI capture --source hook is refused (only the hook sets that provenance)', forgedSource.status === 2, forgedSource.stdout + forgedSource.stderr);
  const okay = SC.transition('R-0001', 'ack', { pid: good.pid }, f.opts());
  t('SC-02i: the genuine hook-captured owner prompt still authorises (library, test projects root)', okay.status === 'acked');
});

// ---------------------------------------------------------------- 22. SC-03 owner-gated defer / supersede / reclassify
section('22 SC-03', () => {
  const f = fixture('sc03');
  f.owner('Voeg een fotogalerij toe'); f.tick(5);            // R-0001
  f.owner('Verander de footer naar grijs'); f.tick(5);       // R-0002
  f.owner('Bouw een kaart met de route'); f.tick(5);         // R-0003
  f.owner('Voeg een vacaturepagina toe'); f.tick(5);         // R-0004
  const d1 = SC.transition('R-0001', 'defer', { reason: 'later' }, f.opts());
  t('SC-03a: an agent defer becomes defer-proposed, not deferred', d1.status === 'defer-proposed', JSON.stringify(d1));
  const gp = SC.gate(f.opts({ until: '2026-10-01T09:00:06Z' }));
  t('SC-03b: the progress gate treats a proposal as handled', !gp.blocking.some((b) => b.rid === 'R-0001'), JSON.stringify(gp.blocking));
  t('SC-03c: the FINAL gate keeps R-0001 open until the owner acks the proposal', SC.gate(f.opts({ final: true })).blocking.some((b) => b.rid === 'R-0001' && b.status === 'defer-proposed'));
  t('SC-03d: self-supersede is refused without the owner', throwsRefused(() => SC.transition('R-0002', 'supersede', { supersedes: 'R-0002' }, f.opts())));
  t('SC-03e: a supersede with only a reason (no replacement) is refused without the owner', throwsRefused(() => SC.transition('R-0002', 'supersede', { reason: 'not needed' }, f.opts())));
  const sup = SC.transition('R-0002', 'supersede', { supersedes: 'R-0003' }, f.opts());
  t('SC-03f: a supersede by a live replacement is allowed (the scope carries forward)', sup.status === 'superseded' && sup.superseded_by === 'R-0003', JSON.stringify(sup));
  t('SC-03g: reclassifying to question needs the owner', throwsRefused(() => SC.transition('R-0004', 'classify', { class: 'question' }, f.opts())));
  t('SC-03h: reclassifying to ack needs the owner', throwsRefused(() => SC.transition('R-0004', 'classify', { class: 'ack' }, f.opts())));
  t('SC-03i: reclassifying to preference needs the owner', throwsRefused(() => SC.transition('R-0004', 'classify', { class: 'preference' }, f.opts())));
  t('SC-03j: a caller can never claim --by owner', throwsRefused(() => SC.transition('R-0004', 'defer', { reason: 'x', by: 'owner' }, f.opts())));
  const okQ = f.owner('R-0004 akkoord, dat was alleen een vraag'); f.tick(5);
  const q = SC.transition('R-0004', 'classify', { class: 'question', pid: okQ.pid }, f.opts());
  t('SC-03k: with an owner ack for R-0004 the reclassification is accepted (by owner)', q.class === 'question');
  const okD = f.owner('Prima, R-0001 akkoord'); f.tick(5);
  const conf = SC.transition('R-0001', 'ack', { pid: okD.pid }, f.opts());
  t('SC-03l: the owner\'s ack of the proposal makes it a confirmed carry-over (deferred)', conf.status === 'deferred' && conf.deferred_by_pid === okD.pid, JSON.stringify(conf));
  f.owner('Voeg een webshop toe'); f.tick(5);                // next rid
  const shop = SC.list(f.opts()).find((i) => /webshop/.test(i.title)).rid;
  const okDirect = f.owner(shop + ' akkoord, volgende fase'); f.tick(5);
  const direct = SC.transition(shop, 'defer', { reason: 'next phase', pid: okDirect.pid }, f.opts());
  t('SC-03m: an owner-authorised defer (--prompt) is deferred at once', direct.status === 'deferred');
  // split keeps every part of the owner's prompt visible
  const multi = f.owner('Voeg een blog toe. Verander het logo naar blauw. Schrap de banner.'); f.tick(5);
  SC.transition(multi.rid, 'classify', { class: 'new', split: ['Voeg een blog toe.'] }, f.opts());
  const kids = SC.list(f.opts()).filter((i) => i.parent === multi.rid);
  t('SC-03n: a split with one quote still keeps the two uncovered sentences as children', kids.length === 3 && kids.some((k) => /logo/.test(k.quote)) && kids.some((k) => /banner/.test(k.quote)), JSON.stringify(kids.map((k) => k.quote)));
  const q2 = f.owner('ok de knoppen. de kleuren'); f.tick(5);
  SC.transition(q2.rid, 'classify', { class: 'question', split: ['de kleuren'] }, f.opts());
  const qk = SC.list(f.opts()).filter((i) => i.parent === q2.rid);
  t('SC-03o: a split never labels an unsure child question (only the classifier or the owner may)', qk.length > 0 && qk.every((k) => k.class !== 'question'), JSON.stringify(qk.map((k) => [k.quote, k.class])));
  // a hand-written owner op whose prompt is not a hook capture is reported by the gate
  const cliRec = SC.capture('R-0003 akkoord', f.opts({ source: 'cli' })); f.tick(5);
  const st = S.loadState(f.p);
  S.appendChained(f.p.ledger, { v: 1, seq: st.last_seq + 1, ts: new Date().toISOString(), op: 'cancel', rid: 'R-0003', by: 'owner', pid: cliRec.pid });
  const g = SC.gate(f.opts());
  t('SC-03p: the gate flags a by:owner op that no hook-captured prompt authorises', !g.ok && g.blocking.some((b) => b.status === 'unauthorized-owner-op' && b.rid === 'R-0003'), JSON.stringify(g.blocking));
});

// ---------------------------------------------------------------- 23. SC-06 gate/verify-chain never trust the cache
section('23 SC-06', () => {
  const f = fixture('sc06');
  f.owner('Voeg een zoekbalk toe'); f.tick(5);
  const st = JSON.parse(fs.readFileSync(f.p.state, 'utf8'));
  st.items = {}; st.counts = {};
  fs.writeFileSync(f.p.state, JSON.stringify(st));
  t('SC-06a: emptying the cached items in state.json does not open the gate (recomputed from the ledger)', SC.gate(f.opts()).ok === false && SC.gate(f.opts()).blocking.some((b) => b.rid === 'R-0001'));
  // truncate-then-rebuild against a run-log anchor
  const g = fixture('sc06b');
  for (let i = 0; i < 3; i++) { g.owner('Voeg onderdeel ' + i + ' toe'); g.tick(5); }
  const ll = linesOf(g.p.ledger);
  g.events('run-a', [{ event_type: 'scribe_head', seq: 1, _forge_verify: { scribe_head: { ledger_lines: ll.length, ledger_head: sha(ll[ll.length - 1]), inbox_lines: linesOf(g.p.inbox).length, inbox_head: sha(linesOf(g.p.inbox).slice(-1)[0]) } } }]);
  t('SC-06b: an intact ledger agrees with its run-log anchor', SC.verifyChains(g.opts()).ok, JSON.stringify(SC.verifyChains(g.opts())));
  fs.writeFileSync(g.p.ledger, ll[0] + '\n');
  SC.rebuild(g.opts());
  g.tick(5);
  g.owner('Iets anders toevoegen'); g.tick(5);
  const v = SC.verifyChains(g.opts());
  t('SC-06c: a ledger truncated to an earlier prefix and rebuilt no longer verifies against the anchor', !v.ok && (v.ledger.breaks || []).some((b) => /anchor|recorded/.test(b.reason)), JSON.stringify(v.ledger.breaks));
  t('SC-06d: the gate reports the anchor disagreement too', SC.gate(g.opts()).ok === false && (SC.gate(g.opts()).problems || []).length > 0);
  const h = fixture('sc06c');
  h.owner('Voeg een pagina toe'); h.tick(5);
  fs.unlinkSync(h.p.ledger);
  t('SC-06e: a missing ledger while the cache recorded a head is broken, not "nothing to verify"', SC.verifyChains(h.opts()).ok === false);
});

// ---------------------------------------------------------------- 24. SC-07 crash between inbox and ledger
section('24 SC-07', () => {
  const f = fixture('sc07');
  f.owner('Voeg een prijspagina toe'); f.tick(5);
  SC.transition('R-0001', 'defer', { reason: 'x' }, f.opts());
  // simulate the crash: the prompt reached the inbox, the ledger append never happened
  const text = 'Verander de kleur van de header'; // no secret: the stored text is the text itself
  S.appendChained(f.p.inbox, { v: 1, pid: 'P-000002', ts: new Date(Date.parse('2026-10-01T09:00:10Z')).toISOString(), session_id: 's1', source: 'hook', text, redacted: false, text_sha256: S.sha256(text) });
  const g = SC.gate(f.opts());
  t('SC-07a: an inbox prompt without an item counts as OPEN in the gate', g.ok === false && g.blocking.some((b) => b.status === 'orphan' && b.pid === 'P-000002'), JSON.stringify(g.blocking));
  const cli = spawnSync(process.execPath, [CLI, 'list', '--json'], { encoding: 'utf8', env: envFor(f) });
  let items = null; try { items = JSON.parse(cli.stdout); } catch { items = null; }
  t('SC-07b: the next command re-folds it as an open item (crash recovery)', cli.status === 0 && Array.isArray(items) && items.some((i) => i.pid === 'P-000002' && i.status === 'open' && i.recovered === true), cli.stdout + cli.stderr);
  t('SC-07c: after recovery the gate no longer reports an orphan', !SC.gate(f.opts()).blocking.some((b) => b.status === 'orphan'));
  // a capture whose ledger append failed is repaired by the next capture (and the duplicate is linked, not dropped)
  const h = fixture('sc07b');
  h.owner('Voeg een header toe', 'sx'); h.tick(5);
  fs.appendFileSync(h.p.ledger, '{ broken\n');
  const r1 = h.owner('Voeg een footer toe', 'sx');
  t('SC-07d: (setup) a broken ledger leaves the new prompt in the inbox only', !!r1.ledger_error);
  const fixedLines = linesOf(h.p.ledger).filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  fs.writeFileSync(h.p.ledger, fixedLines.join('\n') + '\n');
  h.tick(5);
  const r2 = h.owner('Voeg een footer toe', 'sx');
  const its = SC.list(h.opts());
  t('SC-07e: the retry links the duplicate and the orphan became an item', r2.duplicate === true && r2.duplicate_of === r1.pid && its.some((i) => i.pid === r1.pid), JSON.stringify({ r2, items: its.map((i) => [i.rid, i.pid]) }));
});

// ---------------------------------------------------------------- 25. SC-09 redact before cap, scrub metadata
section('25 SC-09', () => {
  const f = fixture('sc09');
  const body = 'MIIEowIBAAKCAQEA' + 'q8Zt3Wx9'.repeat(200);
  const pem = '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----';
  const text = 'Verander de config. ' + 'x'.repeat(20000 - 600) + ' ' + pem;
  const r = f.owner(text, 's1');
  const all = ['inbox', 'ledger', 'state', 'digest'].map((k) => (fs.existsSync(f.p[k]) ? fs.readFileSync(f.p[k], 'utf8') : '')).join('\n');
  t('SC-09a: a private key cut at the cap is redacted in full (no key body, no BEGIN marker stored)', !all.includes('q8Zt3Wx9') && !all.includes('MIIEowIBAAKCAQEA') && !all.includes('BEGIN RSA PRIVATE KEY'), all.slice(all.indexOf('BEGIN') - 20, all.indexOf('BEGIN') + 60));
  t('SC-09b: ... and the record says redacted', r.redacted === true);
  const fakeKey = 'sk-' + 'Zq9'.repeat(12);
  f.tick(5);
  SC.capture('Voeg een logo toe', f.opts({ session_id: 'sess ' + fakeKey, transcript_path: '/tmp/x-' + fakeKey + '.jsonl', source: 'cli' }));
  const inbox = fs.readFileSync(f.p.inbox, 'utf8');
  t('SC-09c: a secret in metadata (session id, transcript path) is scrubbed', !inbox.includes(fakeKey) && !inbox.includes(fakeKey.slice(3)), inbox.slice(-400));
  const pw = 'hunter2' + 'Xy7z' + 'Q9';
  SC.transition('R-0002', 'defer', { reason: 'wacht op password=' + pw }, f.opts());
  t('SC-09d: a secret in a free-text reason is scrubbed in the ledger', !fs.readFileSync(f.p.ledger, 'utf8').includes(pw));
  const long = f.owner('Voeg een lange tekst toe ' + 'y'.repeat(25000), 's2');
  const rec = S.readJsonl(f.p.inbox, false).find((x) => x.pid === long.pid);
  t('SC-09e: a prompt longer than the cap is kept up to the cap and marked truncated with its real length (SC-11 overflow)', rec && rec.truncated === true && rec.chars > 20000 && rec.text.length === 20000 && long.truncated === true, JSON.stringify(rec && { t: rec.truncated, c: rec.chars, l: rec.text.length }));
});

// ---------------------------------------------------------------- 26. SC-10 lock ownership
section('26 SC-10', () => {
  const f = fixture('sc10');
  f.owner('Voeg iets toe'); f.tick(5);
  const storePath = path.join(__dirname, 'forge-scribe-store.cjs');
  // (a) release never removes a lock that is not ours
  S.withLock(f.p, () => {
    fs.rmSync(f.p.lock, { recursive: true, force: true }); // our lock wrongly taken over ...
    const child = spawnSync(process.execPath, ['-e', 'const S=require(' + JSON.stringify(storePath) + ');S.withLock(S.paths(' + JSON.stringify(f.root) + '),()=>process.exit(0));'], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error('child could not take the lock: ' + child.stderr);
  });
  t('SC-10a: releasing never removes another holder\'s lock (ownership-checked release)', fs.existsSync(f.p.lock));
  fs.rmSync(f.p.lock, { recursive: true, force: true });
  // (b) a LIVE holder's lock is never reclaimed, however old it looks
  const child = spawn(process.execPath, ['-e', 'const S=require(' + JSON.stringify(storePath) + ');S.withLock(S.paths(' + JSON.stringify(f.root) + '),()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)});'], { stdio: 'ignore' });
  const until = Date.now() + 8000;
  while (!fs.existsSync(f.p.lock) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  let threw = null;
  try {
    const old = new Date(Date.now() - 3600 * 1000);
    try { fs.utimesSync(f.p.lock, old, old); } catch { /* pre-R3 directory lock age comes from mtime */ }
    S.withLock(f.p, () => 'got it', { staleMs: 0, waitMs: 1200 });
  } catch (e) { threw = e.message; }
  try { child.kill(); } catch { /* already gone */ }
  t('SC-10b: a live writer\'s lock is never reclaimed (pid alive), the waiter fails closed', /locked/.test(threw || ''), String(threw));
  const until2 = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  // (c) a crashed holder (dead pid, old) IS reclaimed
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.rmSync(f.p.lock, { recursive: true, force: true });
  fs.writeFileSync(f.p.lock, JSON.stringify({ pid: Number(dead.stdout), nonce: 'dead', started_at: new Date(Date.now() - 3600 * 1000).toISOString() }));
  let got = null;
  try { got = S.withLock(f.p, () => 'got it', { waitMs: 1500 }); } catch (e) { got = e.message; }
  t('SC-10c: a crashed holder\'s stale lock (dead pid) is reclaimed', got === 'got it', String(got));
});

// ---------------------------------------------------------------- 27. SC-11 dedupe per session, keep the duplicate
section('27 SC-11', () => {
  const f = fixture('sc11');
  const a = f.owner('Verander de knoppen naar groen', 's1'); f.tick(10);
  const b = f.owner('Verander de knoppen naar groen', 's2');
  t('SC-11a: the same words in ANOTHER session are a new prompt and a new item', b.duplicate === false && !!b.rid && b.rid !== a.rid, JSON.stringify(b));
  f.tick(10);
  const c = f.owner('Verander de knoppen naar groen', 's1');
  const recs = S.readJsonl(f.p.inbox, false);
  t('SC-11b: a repeat in the SAME session within the window is kept in the inbox with duplicate_of (never dropped)', c.duplicate === true && recs.length === 3 && recs[2].duplicate_of === a.pid && c.rid === a.rid, JSON.stringify(c));
  f.tick(60);
  const d = f.owner('Verander de knoppen naar groen', 's1');
  t('SC-11c: the same words after the short window are a new prompt', d.duplicate === false && !!d.rid);
  t('SC-11d: a duplicate link is not an orphan (the gate does not count it twice)', !SC.gate(f.opts()).blocking.some((x) => x.status === 'orphan'));
});

// ================================================================ Codex R5 regression tests — each one FAILS on
// the pre-R5 code (proven against a copy of the pre-fix files, WP-SCRIBE-R5) and passes after the fix.
console.log('\nCodex R5 regression tests (codex-r5-scribe-verify.md)');
const refusalOf = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message || e); } };

// ---------------------------------------------------------------- 30. SV-01 approval bound to ONE item
section('30 SV-01', () => {
  const f = fixture('sv01');
  const wps = [];
  for (let i = 1; i <= 8; i++) wps.push({ event_type: 'agent_work_package_created', wp_id: 'wp-' + i }, { event_type: 'wp_completed', wp_id: 'wp-' + i, event_id: 'e' + i });
  f.events('run-1', wps);
  for (let i = 1; i <= 8; i++) { f.owner('Voeg onderdeel ' + i + ' toe aan de site'); f.tick(5); }
  for (let i = 1; i <= 8; i++) { f.finish('R-000' + i, 'wp-' + i, 'run-1'); f.tick(5); }
  const q = f.owner('R-0001 approved?'); f.tick(5);
  t('SV-01a: a question ("R-0001 approved?") never approves R-0001', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: q.pid }, f.opts())));
  const mixed = f.owner('Approve R-0003, but R-0002 remains pending.'); f.tick(5);
  t('SV-01b: "Approve R-0003, but R-0002 remains pending." never approves R-0002', throwsRefused(() => SC.transition('R-0002', 'ack', { pid: mixed.pid }, f.opts())));
  let r3 = null; try { r3 = SC.transition('R-0003', 'ack', { pid: mixed.pid }, f.opts()); } catch (e) { r3 = { err: e.message }; }
  t('SV-01c: ... while the same prompt does approve R-0003 (the act is bound to its own item)', r3 && r3.status === 'acked', JSON.stringify(r3));
  const cond = f.owner('R-0004 approved if the tests pass'); f.tick(5);
  t('SV-01d: a conditional approval never authorises', throwsRefused(() => SC.transition('R-0004', 'ack', { pid: cond.pid }, f.opts())));
  const later = f.owner('Approve R-0005, not yet'); f.tick(5);
  t('SV-01e: a dangling negation in another clause ("…, not yet") never authorises', throwsRefused(() => SC.transition('R-0005', 'ack', { pid: later.pid }, f.opts())));
  const exc = f.owner('Alles akkoord behalve R-0006'); f.tick(5);
  t('SV-01f: a batch phrase with an exception never approves the excepted item', throwsRefused(() => SC.transition('R-0006', 'ack', { pid: exc.pid }, f.opts())));
  t('SV-01g: ... nor any other item (a batch act never has exceptions)', throwsRefused(() => SC.transition('R-0007', 'ack', { pid: exc.pid }, f.opts())));
  const yesNo = f.owner('Is R-0008 akkoord'); f.tick(5);
  t('SV-01h: a yes/no question without "?" ("Is R-0008 akkoord") never authorises', throwsRefused(() => SC.transition('R-0008', 'ack', { pid: yesNo.pid }, f.opts())));
  const why = refusalOf(() => SC.transition('R-0002', 'ack', { pid: mixed.pid }, f.opts()));
  t('SV-01i: the refusal names the clause that is not an act', /R-0002 remains pending/.test(why || ''), why);
  // the gate replays owner ops with the same binding: a by:'owner' ack written straight into the ledger is flagged
  const st = S.loadState(f.p);
  S.appendChained(f.p.ledger, { v: 1, seq: st.last_seq + 1, ts: new Date(Date.parse('2026-10-01T10:00:00Z')).toISOString(), op: 'ack', rid: 'R-0001', by: 'owner', pid: q.pid });
  const g = SC.gate(f.opts());
  t('SV-01j: the gate flags a by:owner ack whose prompt was only a question', g.blocking.some((b) => b.status === 'unauthorized-owner-op' && b.rid === 'R-0001'), JSON.stringify(g.blocking.filter((b) => b.rid === 'R-0001')));
  const ok = f.owner('Prima, R-0007 is goedgekeurd'); f.tick(5);
  t('SV-01k: an unambiguous approval of exactly one item still works', SC.transition('R-0007', 'ack', { pid: ok.pid }, f.opts()).status === 'acked');
});
section('30b SV-01', () => {
  // a deferred approval is no approval NOW (temporal hedges are conflict words)
  const h = fixture('sv01t');
  h.events('run-1', [{ event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' },
    { event_type: 'agent_work_package_created', wp_id: 'wp-2' }, { event_type: 'wp_completed', wp_id: 'wp-2', event_id: 'e2' }]);
  h.owner('Voeg een kaart toe'); h.tick(5);
  h.owner('Voeg een agenda toe'); h.tick(5);
  h.finish('R-0001', 'wp-1', 'run-1'); h.tick(5);
  h.finish('R-0002', 'wp-2', 'run-1'); h.tick(5);
  const tm = h.owner('Approve R-0001 tomorrow'); h.tick(5);
  t('SV-01l: "Approve R-0001 tomorrow" never approves R-0001 now', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: tm.pid }, h.opts())));
  const vw = h.owner('R-0002 akkoord, volgende week'); h.tick(5);
  t('SV-01m: "R-0002 akkoord, volgende week" (a hedge in another clause) never approves R-0002 now', throwsRefused(() => SC.transition('R-0002', 'ack', { pid: vw.pid }, h.opts())));
});

// ---------------------------------------------------------------- 31. SV-02 a split tracks every uncovered character span
section('31 SV-02', () => {
  const f = fixture('sv02');
  const p = f.owner('Thanks, add nightly backups.'); f.tick(5);
  SC.transition(p.rid, 'classify', { class: 'new', split: ['Thanks'] }, f.opts());
  const kids = SC.list(f.opts()).filter((i) => i.parent === p.rid);
  t('SV-02a: splitting off "Thanks" keeps "add nightly backups." as its own child', kids.some((k) => /nightly backups/.test(k.quote) && !/Thanks/.test(k.quote)), JSON.stringify(kids.map((k) => [k.rid, k.quote, k.class])));
  const thanks = kids.find((k) => k.quote === 'Thanks');
  if (thanks) SC.transition(thanks.rid, 'answer', { reason: 'noted' }, f.opts());
  const g = SC.gate(f.opts({ final: true }));
  t('SV-02b: answering the "Thanks" child never turns the final gate green — the backups request is still open', g.ok === false && g.blocking.some((b) => /backups/.test(b.title || '')), JSON.stringify(g.blocking));
  const q = f.owner('Add a blog and a footer.'); f.tick(5);
  SC.transition(q.rid, 'classify', { class: 'new', split: ['Add a blog'] }, f.opts());
  const qk = SC.list(f.opts()).filter((i) => i.parent === q.rid);
  t('SV-02c: the rest of a partly split sentence ("and a footer.") becomes a child too', qk.some((k) => /footer/.test(k.quote) && !/blog/.test(k.quote)), JSON.stringify(qk.map((k) => k.quote)));
  const z = f.owner('Voeg een banner toe'); f.tick(5);
  t('SV-02d: a split quote without words (" ") is refused', throwsRefused(() => SC.transition(z.rid, 'classify', { class: 'new', split: [' '] }, f.opts())));
  // the gate replays splits: a split written straight into the ledger that drops part of the prompt is flagged
  const h = fixture('sv02b');
  const o = h.owner('Voeg een blog toe en een footer.'); h.tick(5);
  const st = S.loadState(h.p);
  const kid = 'R-' + String(st.next_rid).padStart(4, '0');
  const ts = new Date(Date.parse('2026-10-01T10:00:00Z')).toISOString();
  S.appendChained(h.p.ledger, { v: 1, seq: st.last_seq + 1, ts, op: 'open', rid: kid, by: 'lead', pid: o.pid, parent: o.rid, quote: 'Voeg een blog toe', span: [0, 17], class: 'new', title: 'Voeg een blog toe' });
  S.appendChained(h.p.ledger, { v: 1, seq: st.last_seq + 2, ts, op: 'split', rid: o.rid, by: 'lead', children: [kid] });
  const g2 = SC.gate(h.opts());
  t('SV-02e: the gate flags a split that left part of the owner prompt in no child', g2.blocking.some((b) => b.status === 'uncovered-split' && b.rid === o.rid && /footer/.test(b.title)), JSON.stringify(g2.blocking));
  let re = null; try { re = SC.transition(o.rid, 'reopen', { reason: 're-split: the footer was lost' }, h.opts()); } catch (e) { re = { err: e.message }; }
  t('SV-02f: the flagged parent may be reopened (the way back), and the flag clears', re && re.status === 'open' && !SC.gate(h.opts()).blocking.some((b) => b.status === 'uncovered-split'), JSON.stringify(re));
});

// ---------------------------------------------------------------- 32. SV-03 supersede needs a replacement that keeps the work
section('32 SV-03', () => {
  const f = fixture('sv03b');
  f.events('run-1', [{ event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' },
    { event_type: 'agent_work_package_created', wp_id: 'wp-2' }, { event_type: 'wp_completed', wp_id: 'wp-2', event_id: 'e2' }]);
  f.owner('Add nightly backups'); f.tick(5);                  // R-0001
  f.owner('Why?'); f.tick(5);                                 // R-0002 question
  t('SV-03a: superseding a backup request by an open QUESTION is refused without the owner', throwsRefused(() => SC.transition('R-0001', 'supersede', { supersedes: 'R-0002' }, f.opts())));
  try { SC.transition('R-0002', 'answer', { reason: 'explained' }, f.opts()); } catch { /* answered or not: the next check decides */ }
  t('SV-03b: ... so answering the question never closes the backups request', SC.gate(f.opts({ final: true })).blocking.some((b) => b.rid === 'R-0001'), JSON.stringify(SC.gate(f.opts({ final: true })).blocking));
  f.owner('Add a status page'); f.tick(5);                    // R-0003
  f.owner('Add a cron job'); f.tick(5);                       // R-0004
  f.finish('R-0004', 'wp-1', 'run-1'); f.tick(5);
  const ack4 = f.owner('R-0004 akkoord'); f.tick(5);
  SC.transition('R-0004', 'ack', { pid: ack4.pid }, f.opts());
  t('SV-03c: an already ACKED item is no replacement', throwsRefused(() => SC.transition('R-0003', 'supersede', { supersedes: 'R-0004' }, f.opts())));
  f.owner('Add a sitemap'); f.tick(5);                        // R-0006 (R-0005 is the owner's ack prompt)
  f.owner('Add a contact page'); f.tick(5);                   // R-0007
  const dp = f.owner('R-0007 akkoord, volgende fase'); f.tick(5);
  SC.transition('R-0007', 'defer', { reason: 'next phase', pid: dp.pid }, f.opts());
  t('SV-03d: an owner-DEFERRED item is no replacement', throwsRefused(() => SC.transition('R-0006', 'supersede', { supersedes: 'R-0007' }, f.opts())));
  f.owner('Add a login page'); f.tick(5);                     // R-0009
  f.owner('Add a logout button'); f.tick(5);                  // R-0010
  f.finish('R-0010', 'wp-2', 'run-1'); f.tick(5);
  t('SV-03e: a DONE item (no outstanding work) is no replacement', throwsRefused(() => SC.transition('R-0009', 'supersede', { supersedes: 'R-0010' }, f.opts())));
  f.owner('Add a search page'); f.tick(5);                    // R-0011
  f.owner('Add search filters to the shop'); f.tick(5);       // R-0012
  const sup = SC.transition('R-0011', 'supersede', { supersedes: 'R-0012' }, f.opts());
  t('SV-03f: an open WORK item is a valid replacement (the scope carries forward)', sup.status === 'superseded' && sup.superseded_by === 'R-0012');
  t('SV-03g: cycle — superseding the replacement back by the superseded item is refused', throwsRefused(() => SC.transition('R-0012', 'supersede', { supersedes: 'R-0011' }, f.opts())));
  // the gate replays agent supersedes: forged ops written straight into the ledger are flagged (cycle + unbacked)
  const h = fixture('sv03c');
  h.owner('Add a blog'); h.tick(5);        // R-0001
  h.owner('Add a footer'); h.tick(5);      // R-0002
  h.owner('Waarom?'); h.tick(5);           // R-0003 question
  h.owner('Add a header'); h.tick(5);      // R-0004
  const st = S.loadState(h.p);
  const ts = new Date(Date.parse('2026-10-01T10:00:00Z')).toISOString();
  S.appendChained(h.p.ledger, { v: 1, seq: st.last_seq + 1, ts, op: 'supersede', rid: 'R-0001', by: 'lead', supersedes: 'R-0002' });
  S.appendChained(h.p.ledger, { v: 1, seq: st.last_seq + 2, ts, op: 'supersede', rid: 'R-0002', by: 'lead', supersedes: 'R-0001' });
  S.appendChained(h.p.ledger, { v: 1, seq: st.last_seq + 3, ts, op: 'supersede', rid: 'R-0004', by: 'lead', supersedes: 'R-0003' });
  const g = SC.gate(h.opts());
  t('SV-03h: the gate flags a forged supersede cycle (R-0001 <-> R-0002)', g.blocking.some((b) => ['unbacked-supersede', 'supersede-cycle'].includes(b.status) && (b.rid === 'R-0001' || b.rid === 'R-0002')), JSON.stringify(g.blocking));
  t('SV-03i: the gate flags a forged supersede by an open question (R-0004 by R-0003)', g.blocking.some((b) => b.status === 'unbacked-supersede' && b.rid === 'R-0004'), JSON.stringify(g.blocking));
});

// ---------------------------------------------------------------- 33. SV-06 anchors outside any recent-run window
section('33 SV-06', () => {
  const f = fixture('sv06x');
  for (let i = 0; i < 3; i++) { f.owner('Voeg onderdeel ' + i + ' toe'); f.tick(5); }
  const ll = linesOf(f.p.ledger), il = linesOf(f.p.inbox);
  f.events('run-anchor', [{ event_type: 'scribe_head', seq: 1, _forge_verify: { scribe_head: { ledger_lines: ll.length, ledger_head: sha(ll[ll.length - 1]), inbox_lines: il.length, inbox_head: sha(il[il.length - 1]) } } }]);
  const anchorLog = path.join(f.root, '.claude', 'forge-runs', 'run-anchor', 'events.jsonl');
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(anchorLog, hourAgo, hourAgo);
  for (let i = 0; i < 12; i++) f.events('run-newer-' + String(i).padStart(2, '0'), [{ event_type: 'agent_note', note: 'no scribe anchor here' }]);
  const g0 = SC.gate(f.opts());
  t('SV-06 setup: the intact store agrees with its anchor (no integrity problem)', g0.problems.length === 0, JSON.stringify(g0.problems));
  fs.rmSync(path.join(f.root, '.claude', 'forge-scribe'), { recursive: true, force: true });
  const g = SC.gate(f.opts());
  t('SV-06a: the anchor in the 13th-newest run is still checked: the removed scribe store is NOT "gate OK"', g.ok === false && g.anchors_checked >= 1 && g.problems.some((p) => /truncated|fewer/.test(p)), JSON.stringify({ ok: g.ok, anchors: g.anchors_checked, problems: g.problems }));
  // an anchor-bearing log whose mtime was set back before any epoch is still read (selection by content)
  const h = fixture('sv06y');
  for (let i = 0; i < 2; i++) { h.owner('Verander tekst ' + i); h.tick(5); }
  const hl = linesOf(h.p.ledger), hi = linesOf(h.p.inbox);
  h.events('run-old-mtime', [{ event_type: 'scribe_head', seq: 1, _forge_verify: { scribe_head: { ledger_lines: hl.length, ledger_head: sha(hl[hl.length - 1]), inbox_lines: hi.length, inbox_head: sha(hi[hi.length - 1]) } } }]);
  const longAgo = new Date(Date.parse('2026-01-01T00:00:00Z'));
  fs.utimesSync(path.join(h.root, '.claude', 'forge-runs', 'run-old-mtime', 'events.jsonl'), longAgo, longAgo);
  fs.writeFileSync(h.p.ledger, hl[0] + '\n');
  const gh = SC.gate(h.opts());
  t('SV-06b: an anchor log with a back-dated mtime is still checked: a truncated ledger is caught', gh.ok === false && gh.problems.some((p) => /truncated|fewer|differs/.test(p)), JSON.stringify({ anchors: gh.anchors_checked, problems: gh.problems }));
  // a large run log is read in chunks: an anchor behind > 3 MB of padding is found
  const k = fixture('sv06z');
  k.owner('Voeg een pagina toe'); k.tick(5);
  const kl = linesOf(k.p.ledger), ki = linesOf(k.p.inbox);
  const pad = []; for (let i = 0; i < 30000; i++) pad.push({ event_type: 'agent_note', note: 'padding line ' + i + ' ' + 'p'.repeat(90) });
  k.events('run-big', pad.concat([{ event_type: 'scribe_head', seq: 30001, _forge_verify: { scribe_head: { ledger_lines: kl.length, ledger_head: sha(kl[kl.length - 1]), inbox_lines: ki.length, inbox_head: sha(ki[ki.length - 1]) } } }]));
  t('SV-06c: an anchor at the end of a > 3 MB run log is found (chunked read, no size cut-off)', SC.gate(k.opts()).anchors_checked === 1 && fs.statSync(path.join(k.root, '.claude', 'forge-runs', 'run-big', 'events.jsonl')).size > 3 * 1024 * 1024);
});

// ---------------------------------------------------------------- 34. SV-07 import scrubs before it caps
section('34 SV-07', () => {
  const f = fixture('sv07i');
  const max = Number(cfg.caps.max_prompt_chars) || 20000;
  const tok = 'ghp_' + 'Q7wZ2kLm9XpR4tVb8NcY1dFh6JsA3eGu0iKo';
  const text = 'Rotate token ' + 'x'.repeat(max - 8 - 14) + ' ' + tok + ' soon';   // the cap falls inside the token
  t('SV-07 setup: the cap cuts the token (8 of its characters lie before the cap)', text.slice(0, max).endsWith(tok.slice(0, 8)));
  const r = SC.importLines([{ text, source: 'tasks/NOTES.md:3' }], f.opts());
  const ledger = fs.existsSync(f.p.ledger) ? fs.readFileSync(f.p.ledger, 'utf8') : '';
  const op = S.readJsonl(f.p.ledger, false).find((x) => x && x.op === 'open');
  t('SV-07a: a secret crossing the cap is redacted in full in an imported item (no "ghp_" prefix stored)', r.imported.length === 1 && !ledger.includes('ghp_') && !ledger.includes(tok.slice(4, 8)), ledger.slice(ledger.indexOf('ghp_') - 20, ledger.indexOf('ghp_') + 30));
  t('SV-07b: ... and the import op says redacted', !!op && op.redacted === true, JSON.stringify(op && { redacted: op.redacted, truncated: op.truncated }));
  t('SV-07c: a short import is unchanged by the pipeline (same quote, same idempotency key as before)', (() => {
    const g = fixture('sv07j');
    const one = SC.importLines([{ text: '  TODO: rollback-script schrijven  ', source: 'a.md:1' }], g.opts());
    const o = S.readJsonl(g.p.ledger, false).find((x) => x && x.op === 'open');
    return one.imported.length === 1 && o.quote === 'TODO: rollback-script schrijven' && o.import_key === sha('a.md\nTODO: rollback-script schrijven');
  })());
});

// ---------------------------------------------------------------- 35. SV-08 reclaim never displaces a live lock; fenced writes
section('35 SV-08', () => {
  const f = fixture('sv08');
  f.owner('Voeg iets toe'); f.tick(5);
  const lp = f.p.lock;
  const DEAD = 2147480001, LIVE_A = 2147480002, LIVE_B = 2147480003;   // fake pids: the seam decides who is alive
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const L0 = JSON.stringify({ pid: DEAD, nonce: 'dead-L0', started_at: hourAgo });
  const L1 = JSON.stringify({ pid: LIVE_A, nonce: 'live-A', started_at: hourAgo });
  const L2 = JSON.stringify({ pid: LIVE_B, nonce: 'live-B', started_at: new Date().toISOString() });
  fs.writeFileSync(lp, L0);
  let interleaved = false;
  const alive = (pid) => {
    if (pid === DEAD) {
      // between R1's judgement and its rename: reclaimer R2 removes the dead L0 and acquirer A takes a LIVE lock L1
      if (!interleaved) { interleaved = true; fs.rmSync(lp, { force: true }); fs.writeFileSync(lp, L1); }
      return false;
    }
    return pid === LIVE_A || pid === LIVE_B || pid === process.pid;
  };
  const realLink = fs.linkSync;
  let blocked = false;
  fs.linkSync = function patchedLink(src, dst) { // acquirer B grabs the free lock path right before any put-back
    if (!blocked && path.resolve(String(dst)) === path.resolve(lp)) { blocked = true; if (!fs.existsSync(lp)) fs.writeFileSync(lp, L2); }
    return realLink.apply(fs, arguments);
  };
  let err = null;
  try { S.withLock(f.p, () => 'R1 holds the lock', { waitMs: 300, pidAlive: alive }); } catch (e) { err = String(e && e.message || e); } finally { fs.linkSync = realLink; }
  let now = null; try { now = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { now = null; }
  const dir = path.dirname(lp);
  const stranded = fs.readdirSync(dir).filter((n) => n.startsWith('.lock') && n !== '.lock').filter((n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').includes('live-A'); } catch { return false; } });
  t('SV-08a: three-party interleaving — A\'s LIVE lock is still at the lock path (never renamed away by a reclaimer)', !!now && now.nonce === 'live-A', JSON.stringify(now));
  t('SV-08b: ... and no copy of A\'s lock is stranded under a claim name', stranded.length === 0, stranded.join(','));
  t('SV-08c: ... and the reclaimer fails closed ("store is locked") instead of taking a live lock', /locked/.test(err || ''), String(err));
  for (const n of fs.readdirSync(dir)) if (n.startsWith('.lock')) { try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* best effort */ } }
  // fencing of every protected write: a writer whose lock was taken over writes neither state.json nor DIGEST.md
  const g = fixture('sv08f');
  g.owner('Voeg iets anders toe'); g.tick(5);
  const res = {};
  const stateBefore = fs.readFileSync(g.p.state, 'utf8');
  S.withLock(g.p, () => {
    fs.writeFileSync(g.p.lock, JSON.stringify({ pid: process.pid + 7, nonce: 'taker', started_at: new Date().toISOString() })); // taken over
    res.state = refusalOf(() => S.saveState(g.p, S.loadState(g.p)));
    res.digest = refusalOf(() => SC.digest(g.opts({ write: true })));
  });
  try { fs.rmSync(g.p.lock, { force: true }); } catch { /* best effort */ }
  t('SV-08d: a writer whose lock was taken over cannot write state.json (fenced)', /fencing|lock was lost/.test(res.state || ''), String(res.state));
  t('SV-08e: ... nor DIGEST.md (fenced)', /fencing|lock was lost/.test(res.digest || ''), String(res.digest));
  t('SV-08f: ... and state.json is untouched', fs.readFileSync(g.p.state, 'utf8') === stateBefore);
});

// ---------------------------------------------------------------- 36. SV-09 recovery in bounded batches
section('36 SV-09', () => {
  const f = fixture('sv09');
  f.owner('Voeg een footer toe', 'sx'); f.tick(5);
  for (let i = 0; i < 40; i++) {
    const text = 'Verander onderdeel ' + i + ' naar blauw';
    S.appendChained(f.p.inbox, { v: 1, pid: 'P-' + String(i + 2).padStart(6, '0'), ts: new Date(Date.parse('2026-10-01T09:30:00Z')).toISOString(), session_id: 'sx', source: 'hook', text, redacted: false, text_sha256: S.sha256(text) });
  }
  const r = SC.recover(f.opts({ max: 5 }));
  t('SV-09a: recover({max: 5}) folds at most 5 orphans of a 40-prompt backlog', r.length === 5, String(r.length));
  t('SV-09b: ... and reports how many are left', r.left === 35, String(r.left));
  t('SV-09c: ... the rest stay blocking orphans in the gate', SC.gate(f.opts()).blocking.filter((b) => b.status === 'orphan').length === 35);
  const r0 = SC.recover(f.opts({ deadline: Date.now() - 1 }));
  t('SV-09d: with the deadline already passed no orphan is folded', r0.length === 0 && r0.left === 35, JSON.stringify({ n: r0.length, left: r0.left }));
  const c = SC.capture('Voeg een kaart toe', f.opts({ session_id: 'sy', recoverMax: 3 }));
  t('SV-09e: capture folds only its bounded batch first and still captures the new prompt', !!c.rid && c.recovered === 3 && c.orphans_left === 32, JSON.stringify({ rid: c.rid, rec: c.recovered, left: c.orphans_left }));
  const all = SC.recover(f.opts());
  t('SV-09f: an explicit recover() (CLI) still folds everything that is left', all.length === 32 && !SC.gate(f.opts()).blocking.some((b) => b.status === 'orphan'));
});

// ================================================================ WP-SCRIBE-REPEAT: owner repeats
// The owner had to ask SIX times for parallel lanes (verbatim below). From the second time on each prompt must carry
// repeat_of + an increasing repeat_count; unrelated prompts must never be flagged.
const OWNER_LANE_REPEATS = [
  'zet extra lanes open zodat er parralel aan de gan kan gaan alleen als ze niet elkaar botsen!',
  'start wel 8 lanes en maak er gebruik van als het kan en zo niet leg me uit!?',
  'als de 8 lanes 1x is gebruikt stopt het we willen het consistant hebben! tot 80% usage vraag ook niet steeds zolang ze elkaar maar niet botsen!',
  'kan je niet parallel werken?',
  'meer lanes?',
  'ik moet steeds vragen om extra parallel agents te vragen dit moet globaal niet meer gebeuren!',
];
const OWNER_UNRELATED = ['ruim alle onnodige dingen op ik heb geen ruimte meer!', 'Licentie MIT en logo (anvil + amber) bevestig of kies een alternatief bevestigd'];
section('40 REPEAT', () => {
  const f = fixture('repeat');
  const caps = OWNER_LANE_REPEATS.map((m) => { const r = f.owner(m, 'sRep'); f.tick(60); return r; });
  t('REP-a: the first lane prompt is not a repeat', !caps[0].repeat_of && !caps[0].repeat_count, JSON.stringify(caps[0]));
  const counts = caps.slice(1).map((c) => c.repeat_count);
  t('REP-b: prompts 2..6 are each flagged with an increasing repeat_count 2..6', counts.join(',') === '2,3,4,5,6', counts.join(','));
  t('REP-c: every repeat names the earlier lane item(s) in repeat_of', caps.slice(1).every((c, i) => Array.isArray(c.repeat_of) && c.repeat_of.length >= 1 && c.repeat_of.every((r) => caps.slice(0, i + 1).some((e) => e.rid === r))), JSON.stringify(caps.map((c) => c.repeat_of)));
  t('REP-d: the capture receipt shows REPEAT x<n> of R-..', /· REPEAT x6 of R-\d{4}/.test(caps[5].receipt), caps[5].receipt);
  t('REP-e: the repeat note carries the HARD RULE instruction word for word', caps[5].repeat_note && caps[5].repeat_note.includes("— the owner had to ask again: create/refresh the HARD RULE now (global CLAUDE.md 'Owner repeats' rule 1) and apply it in this turn"), caps[5].repeat_note);
  const st = S.loadState(f.p);
  t('REP-f: the earlier items keep their own text and gain no repeat field', st.items[caps[0].rid].quote === OWNER_LANE_REPEATS[0] && !st.items[caps[0].rid].repeat_of && st.items[caps[1].rid].quote === OWNER_LANE_REPEATS[1] && st.items[caps[1].rid].repeat_count === 2);
  const un = OWNER_UNRELATED.map((m) => { const r = f.owner(m, 'sRep'); f.tick(60); return r; });
  t('REP-g: unrelated owner prompts (cleanup, licence/logo) are NOT flagged', un.every((c) => !!c.rid && !c.repeat_of && !/REPEAT/.test(c.receipt)), JSON.stringify(un.map((c) => [c.rid, c.repeat_of])));
  const d = SC.digest(f.opts());
  t('REP-h: the digest head shows the unaddressed repeat with the HARD RULE instruction', /^Scribe: .*· R-\d{4} REPEAT x6 of .*create\/refresh the HARD RULE now/.test(d.split('\n')[0]) && d.length <= cfg.caps.digest_max_chars, d.split('\n')[0]);
  t('REP-i: the digest item line carries a REPEAT tag', d.split('\n').some((l) => l.startsWith(caps[5].rid + ' [') && /REPEAT x6/.test(l)));
  const li = spawnSync(process.execPath, [CLI, 'list'], { encoding: 'utf8', env: envFor(f) });
  t('REP-j: `forge-scribe.cjs list` shows a REPEAT marker (and that no HARD RULE is linked yet)', li.status === 0 && new RegExp(caps[5].rid + ' \\[[^\\]]+\\] REPEAT x6 of .*no HARD RULE linked yet').test(li.stdout), li.stdout + li.stderr);
  t('REP-k: unrelated items have no marker in list', !new RegExp(un[0].rid + ' .*REPEAT').test(li.stdout));
  const v = SC.verifyChains(f.opts());
  t('REP-l: the inbox + ledger hash chains still verify with repeat fields', v.ok === true, JSON.stringify(v).slice(0, 300));
  const gr = SC.gate(f.opts());
  const activeN = Object.values(S.loadState(f.p).items).filter((i) => S.ACTIVE.includes(i.status)).length;
  t('REP-m: a repeat adds no gate blocker of its own (visible obligation, not blocking): blockers = the active items, no extra problem', gr.blocking.length === activeN && !gr.problems.some((p) => /repeat/i.test(p)), JSON.stringify({ blocking: gr.blocking.length, activeN, problems: gr.problems }));
  // the link that closes the obligation: vocabulary checks (existing validations untouched)
  t('REP-n: repeat-rule on an item that is not a repeat is refused', /not a repeat/.test(refusal(() => SC.transition(caps[0].rid, 'repeat-rule', { ref: { type: 'standing_rule', ref: 'SR-1' } }, f.opts())) || ''));
  t('REP-o: repeat-rule with an unknown standing rule is refused', /standing rule SR-404 not found/.test(refusal(() => SC.transition(caps[5].rid, 'repeat-rule', { ref: { type: 'standing_rule', ref: 'SR-404' } }, f.opts())) || ''));
  t('REP-p: repeat-rule with an unknown ref type is refused', /unknown ref type/.test(refusal(() => SC.transition(caps[5].rid, 'repeat-rule', { ref: { type: 'commit', ref: 'abc1234' } }, f.opts())) || ''));
  t('REP-q: standing_rule DONE evidence stays preference-only (not widened)', /only valid for a preference item/.test(refusal(() => { SC.transition(caps[5].rid, 'link', { wp_ids: ['wp-r'], run_id: 'run-rep' }, f.opts()); SC.transition(caps[5].rid, 'start', {}, f.opts()); SC.transition(caps[5].rid, 'done', { evidence: { type: 'standing_rule', ref: 'SR-1' } }, f.opts()); }) || ''));
  f.events('run-rep', [{ event_type: 'decision_logged', event_id: 'ev-dec-1', note: 'HARD RULE: always open 8 parallel lanes' }]);
  t('REP-r: repeat-rule with a missing decision_logged event is refused', /no decision_logged event ev-nope/.test(refusal(() => SC.transition(caps[5].rid, 'repeat-rule', { ref: { type: 'decision_logged', ref: 'ev-nope' }, run_id: 'run-rep' }, f.opts())) || ''));
  const before = S.loadState(f.p).items[caps[5].rid].status;
  const linked = SC.transition(caps[5].rid, 'repeat-rule', { ref: { type: 'decision_logged', ref: 'ev-dec-1' }, run_id: 'run-rep' }, f.opts());
  t('REP-s: repeat-rule with a real decision_logged event links the HARD RULE and leaves the status unchanged', linked.repeat_rule_ref && linked.repeat_rule_ref.ref === 'ev-dec-1' && linked.status === before, JSON.stringify(linked));
  t('REP-t: once the chain has a HARD RULE link the digest head no longer asks for it', !/REPEAT/.test(SC.digest(f.opts()).split('\n')[0]) && S.unaddressedRepeats(S.loadState(f.p)).length === 0);
  t('REP-u: the chain still verifies after the link', SC.verifyChains(f.opts()).ok === true);
  const g = fixture('repeat-sr');
  fs.writeFileSync(path.join(g.root, 'standing.user.json'), JSON.stringify({ rules: [{ id: 'SR-lanes', text: 'always parallel lanes' }] }));
  const g1 = g.owner(OWNER_LANE_REPEATS[0], 's'); g.tick(60);
  const g2 = g.owner(OWNER_LANE_REPEATS[4], 's'); g.tick(60);
  const gl = SC.transition(g2.rid, 'repeat-rule', { ref: { type: 'standing_rule', ref: 'SR-lanes' } }, g.opts());
  t('REP-v: repeat-rule with an existing standing rule id links it', !!g1.rid && gl.repeat_rule_ref && gl.repeat_rule_ref.type === 'standing_rule');
  // eligibility: cancelled / superseded / answered-question / ack / pid-less (imported) earlier items are not candidates
  const q = 'voeg een watchdog toe die vastgelopen agents stopt';
  const base = { rid: 'R-0001', pid: 'P-1', class: 'new', quote: q };
  const elig = (o) => !!C.findRepeats(q, [Object.assign({}, base, o)], cfg);
  t('REP-w: an open earlier ask is a candidate; cancelled, superseded, an answered question, an ack and an imported note are not',
    elig({ status: 'open' }) && elig({ status: 'done' }) && !elig({ status: 'cancelled' }) && !elig({ status: 'superseded' })
    && !elig({ status: 'answered', class: 'question' }) && !elig({ status: 'open', class: 'ack' }) && !elig({ status: 'open', pid: null }));
  // latency: the comparison is cheap (token sets) — 400 candidate items
  const items = [];
  for (let i = 0; i < 400; i++) items.push({ rid: 'R-' + String(i + 1).padStart(4, '0'), pid: 'P-' + i, status: 'open', class: 'new', quote: 'Verander onderdeel ' + i + ' van de pagina naar een andere kleur en lettertype ' + 'x'.repeat(i % 50) });
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 10; k++) C.findRepeats(OWNER_LANE_REPEATS[5], items, cfg);
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  t('REP-x: findRepeats over 400 candidate items stays cheap (< 50 ms per prompt; ' + per.toFixed(2) + ' ms)', per < 50);
  t('REP-y: classifier unit — unrelated prompts share no repeat with the lane chain', OWNER_UNRELATED.every((m) => !C.findRepeats(m, OWNER_LANE_REPEATS.map((q, i) => ({ rid: 'R-000' + (i + 1), pid: 'P-' + i, status: 'open', class: 'new', quote: q })), cfg)));
});

// ================================================================ WP-REPEAT-FP: quiet rules
// First-day false positive: the status question 'open vragen nog voor mij of wat ik moet doen?' was flagged REPEAT x4
// through the generic word 'vragen' + the cue 'ik moet'. Real repeats must still chain; status questions must not.
const OWNER_REAL_REPEATS = [
  'de forge is gebouwd om parallel aan te gang te gaan en moet er steeds om vragen dit moet niet meer een hard rule zijn',
  'ik moet het steeds herhalen heb je dat ook gemerkt terwijl ik er steeds omvraag! maak er een hard rule van!',
];
const OWNER_NOT_REPEATS = [
  'open vragen nog voor mij of wat ik moet doen?',
  'wat moeten er nog gebeuren?',
  'wat moeten er nog gedaan worden?',
  'moet ik nog wat doen?',
  'ruim alle onnodige dingen op ik heb geen ruimte meer!',
  'alleen van dit project die niet meer worden gebruikt!',
  'Licentie MIT en logo (anvil + amber) bevestig of kies een alternatief bevestigd',
];
section('41 REPEAT-FP', () => {
  const f = fixture('repeat-fp');
  const lane = OWNER_LANE_REPEATS.map((m) => { const r = f.owner(m, 'sFp'); f.tick(60); return r; });
  t('RFP-a: the six lane prompts still chain x2..x6', lane.slice(1).map((c) => c.repeat_count).join(',') === '2,3,4,5,6' && !lane[0].repeat_of, lane.map((c) => c.repeat_count).join(','));
  const real = OWNER_REAL_REPEATS.map((m) => { const r = f.owner(m, 'sFp'); f.tick(60); return r; });
  t('RFP-b: "de forge is gebouwd om parallel ... hard rule zijn" is flagged as a repeat of the lane chain (x7)', real[0].repeat_count === 7 && real[0].repeat_of.every((r) => lane.some((e) => e.rid === r)), JSON.stringify([real[0].repeat_of, real[0].repeat_count]));
  t('RFP-c: "ik moet het steeds herhalen ... hard rule" is flagged (repeat of the hard-rule parallel ask)', Array.isArray(real[1].repeat_of) && real[1].repeat_of.includes(real[0].rid) && real[1].repeat_count >= 2, JSON.stringify([real[1].repeat_of, real[1].repeat_count]));
  const quiet = OWNER_NOT_REPEATS.map((m) => { const r = f.owner(m, 'sFp'); f.tick(60); return r; });
  t('RFP-d: status questions, cleanup, project scope and licence/logo prompts are NOT flagged against the chain', quiet.every((c) => !!c.rid && !c.repeat_of && !/REPEAT/.test(c.receipt)), JSON.stringify(quiet.map((c, i) => [OWNER_NOT_REPEATS[i].slice(0, 30), c.repeat_of, c.repeat_count])));
  // the real owner order of 2026-10-09/10 (R-0001..R-0015): exactly the real repeats are flagged
  const REAL_ORDER = [
    [OWNER_LANE_REPEATS[0], false], [OWNER_LANE_REPEATS[2], true], ['wat moeten er nog gedaan worden?', false],
    ['Licentie MIT en logo (anvil + amber)\tbevestig of kies een alternatief bevestigd\n\nen doe de rest joun keuze! de slimste en de beste keuze!', false],
    ['moet ik nog wat doen?', false], [OWNER_LANE_REPEATS[3], true], [OWNER_LANE_REPEATS[5], true],
    ['de forge is gebouwd  om parallel aan te gang te gaan en moet er steeds om vragen dit moet niet meer gebeuren en een hard rule zijn!', true],
    [OWNER_NOT_REPEATS[4], false], [OWNER_NOT_REPEATS[5], false], ['wat moeten er nog gebeuren?', false],
    [OWNER_LANE_REPEATS[4], true], [OWNER_REAL_REPEATS[1], true], ['open vragen nog voor mij of wat ik moet doen?', false],
  ];
  const items = [];
  const got = REAL_ORDER.map(([q], i) => {
    const r = C.findRepeats(q, items, cfg);
    items.push({ rid: 'R-' + String(i + 1).padStart(4, '0'), pid: 'P-' + i, status: 'open', class: /\?\s*$/.test(q) && !/parallel|lanes/.test(q) ? 'question' : 'new', quote: q, repeat_of: r ? r.repeat_of : undefined });
    return !!r;
  });
  t('RFP-e: replaying the real owner order flags exactly the real repeats (the status question last is quiet)', got.every((g, i) => g === REAL_ORDER[i][1]), JSON.stringify(got));
  // unit: the three quiet rules
  t('RFP-f: generic words are stopwords — the status question has no scoring tokens at all', C.repeatTokens('open vragen nog voor mij of wat ik moet doen?', cfg).size === 0 && ['vragen', 'vraag', 'moet', 'moeten', 'doen', 'nog', 'wat', 'voor', 'mij', 'open', 'ask', 'need', 'question', 'status'].every((w) => C.repeatConfig(cfg).stop.has(w)));
  const chain = OWNER_LANE_REPEATS.map((q, i) => ({ rid: 'R-000' + (i + 1), pid: 'P-' + i, status: 'open', class: 'new', quote: q }));
  t('RFP-g: cue words alone never create a repeat (no distinctive shared token)', !C.findRepeats('ik moet steeds weer opnieuw vragen, nogmaals!', chain, cfg) && !C.findRepeats('ik moet het weer vragen', chain, cfg));
  t('RFP-h: one shared generic word plus a cue is not a repeat (the R-0015 shape against R-0007)', !C.findRepeats('open vragen nog voor mij of wat ik moet doen?', [chain[5]], cfg));
  t('RFP-i: a pure status question is not flagged against a non-question ask even when it shares a weight-2 concept', !C.findRepeats('zijn er nog open lanes?', chain, cfg) && C.repeatStatusQuestion('zijn er nog open lanes?', cfg) === true);
  t('RFP-j: the same question WITH a complaint cue is no longer pure and is flagged', !!C.findRepeats('zijn er nog steeds geen parallel lanes?', chain, cfg) && C.repeatStatusQuestion('zijn er nog steeds geen parallel lanes?', cfg) === false);
  t('RFP-k: a status question can still repeat an earlier QUESTION', !!C.findRepeats('wat is er nog open bij de watchdog?', [{ rid: 'R-0001', pid: 'P-1', status: 'open', class: 'question', quote: 'wat is de status van de watchdog?' }], cfg));
  t('RFP-l: a non-status question ("kan je niet parallel werken?", "meer lanes?") is not a status question', !C.repeatStatusQuestion(OWNER_LANE_REPEATS[3], cfg) && !C.repeatStatusQuestion(OWNER_LANE_REPEATS[4], cfg));
  t('RFP-m: distinctive = a concept token or a plain word >= distinctive_min_len; short plain words are not', C.repeatDistinctive('#extra', cfg) && C.repeatDistinctive('rule', cfg) && !C.repeatDistinctive('mit', cfg));
});

// ---------------------------------------------------------------- WP-ACK-TEXT repeated identical owner acks
// Real incident 2026-10-10: the owner said "R-0001 klopt, R-0002 klopt, R-0004 klopt." at 23:27:54 (items still planned)
// and again ~17 min later, typed while a turn ran (Claude Code logged it as a queued_command under the RUNNING turn's
// prompt id, absorbed at 23:44:21). The owner check took the OLDEST transcript entry with that prompt id and text, dated
// the second ack at 23:27:54 and refused it. These tests pin the nearest-to-capture rule and keep SC-01/SC-02 intact.
section('WP-ACK-TEXT', () => {
  const ACK = 'R-0001 klopt, R-0002 klopt.';
  const PID = 'p-turn-' + rnd(); // Claude Code reuses one prompt id for the repeated text (same turn)
  const typed = (f, sess, o) => f.entry(ACK, sess, Object.assign({ promptId: PID }, o || {}));
  const real = { uuid: null }; // the real hook records no uuid (inbox P-000017/P-000018: "uuid":null)
  const f = fixture('acktext');
  f.events('run-1', [
    { event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' },
    { event_type: 'agent_work_package_created', wp_id: 'wp-2' }, { event_type: 'wp_completed', wp_id: 'wp-2', event_id: 'e2' },
  ]);
  f.owner('Voeg een contactformulier toe', 'sA'); f.tick(5); // R-0001
  f.owner('Voeg een nieuwsbrief toe', 'sA'); f.tick(5);      // R-0002
  const first = f.hookCapture(ACK, { session: 'sA', entry: typed(f, 'sA'), extra: real }); f.tick(30); // nothing done yet
  f.finish('R-0001', 'wp-1', 'run-1'); f.tick(17 * 60);
  const second = f.hookCapture(ACK, { session: 'sA', entry: typed(f, 'sA'), extra: real }); f.tick(60); // T0+17min: R-0001 done
  const third = f.hookCapture(ACK, { session: 'sA', entry: typed(f, 'sA'), extra: real }); f.tick(30);  // still before R-0002 is done
  f.finish('R-0002', 'wp-2', 'run-1'); f.tick(10 * 60);
  // an agent re-captures the identical text later WITHOUT a new owner message in the transcript
  const replay = f.hookCapture(ACK, { session: 'sA', entry: null, extra: { prompt_id: PID, uuid: null } }); f.tick(5);

  t('ACK-2: the FIRST identical ack (said before R-0001 was done) is still refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: first.pid }, f.opts())));
  t('ACK-3: a third identical ack captured BEFORE R-0002 was done cannot approve it', throwsRefused(() => SC.transition('R-0002', 'ack', { pid: third.pid }, f.opts())));
  t('ACK-3b: ... nor can the second one (also before R-0002 was done)', throwsRefused(() => SC.transition('R-0002', 'ack', { pid: second.pid }, f.opts())));
  const why = refusal(() => SC.transition('R-0002', 'ack', { pid: replay.pid }, f.opts()));
  t('ACK-6b: a later re-capture with no new transcript entry near it matches nothing (the old identical entries are > skew away)', why && /was not found as an owner message/.test(why), why);
  let acked = null; let err = null;
  try { acked = SC.transition('R-0001', 'ack', { pid: second.pid }, f.opts()); } catch (e) { err = e.message; }
  t('ACK-1: the SECOND identical ack, said after R-0001 was done, authorises the ack', acked && acked.status === 'acked' && acked.acked_by_pid === second.pid, err || JSON.stringify(acked));

  // unit: transcriptEntryOf picks the entry closest to the capture time, within the skew
  const u = fixture('acktext-unit');
  const tp = path.join(u.tr, 'sU.jsonl');
  const T0 = Date.parse('2026-10-10T23:27:54.577Z');
  const iso = (ms) => new Date(ms).toISOString();
  const max = Number(cfg.caps && cfg.caps.max_prompt_chars) || 20000;
  const recAt = (ms, o) => Object.assign({ ts: iso(ms), prompt_id: PID, session_id: 'sU', uuid: null, text_sha256: S.sha256(S.normalizePrompt(ACK, max).text) }, o || {});
  const line = (o) => JSON.stringify(Object.assign({ type: 'user', uuid: 'u-' + rnd(), promptId: PID, sessionId: 'sU', message: { role: 'user', content: ACK } }, o));
  fs.writeFileSync(tp, [line({ timestamp: iso(T0) }), line({ timestamp: iso(T0 + 17 * 60000) })].join('\n') + '\n');
  const at0 = S.transcriptEntryOf(tp, recAt(T0), cfg);
  t('ACK-4: two identical entries, capture time equal to the first -> the first is chosen', at0 && at0.entry.timestamp === iso(T0), JSON.stringify(at0));
  const at17 = S.transcriptEntryOf(tp, recAt(T0 + 17 * 60000 + 1500), cfg);
  t('ACK-4b: capture 1.5 s after the second -> the second is chosen (never simply the oldest)', at17 && at17.entry.timestamp === iso(T0 + 17 * 60000), JSON.stringify(at17));
  const tp1 = path.join(u.tr, 'sU1.jsonl');
  fs.writeFileSync(tp1, line({ timestamp: iso(T0), sessionId: 'sU' }) + '\n');
  const once = S.transcriptEntryOf(tp1, recAt(T0 + 3000), cfg);
  t('ACK-5: text that appears once, captured 3 s later, matches as before', once && once.said === T0, JSON.stringify(once));
  t('ACK-6: an entry farther than the skew (10 min) from the capture time does not match', S.transcriptEntryOf(tp1, recAt(T0 + 10 * 60000), cfg) === null);
  const wide = Object.assign({}, cfg, { owner_check: Object.assign({}, cfg.owner_check, { transcript_match_skew_sec: 900 }) });
  t('ACK-6c: the skew comes from FORGE_SCRIBE.json owner_check.transcript_match_skew_sec (900 s -> the 10 min entry matches)', !!S.transcriptEntryOf(tp1, recAt(T0 + 10 * 60000), wide) && Number(cfg.owner_check.transcript_match_skew_sec) === 120);

  // the real shape: a queued_command typed mid-turn, absorbed later under the running turn's prompt id
  const queued = (ms, src, o) => JSON.stringify(Object.assign({ type: 'attachment', uuid: 'a-' + rnd(), sessionId: 'sU', timestamp: iso(ms),
    attachment: Object.assign({ type: 'queued_command', prompt: [{ type: 'text', text: ACK }], source_uuid: src, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: iso(ms), humanTurn: true }, o || {}) }));
  const removed = (ms, src) => JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: iso(ms), sessionId: 'sU', content: ACK, reason: 'absorbed_mid_turn', commandUuid: src });
  const tpQ = path.join(u.tr, 'sQ.jsonl');
  fs.writeFileSync(tpQ, [line({ timestamp: iso(T0) }), queued(T0 + 5 * 60000, 'q1'), removed(T0 + 16 * 60000 + 27000, 'q1')].join('\n') + '\n');
  const q = S.transcriptEntryOf(tpQ, recAt(T0 + 16 * 60000 + 26000), cfg);
  t('ACK-7: a queued owner message is matched at its absorption (16 min) and dated when typed (5 min)', q && q.entry.type === 'attachment' && q.said === T0 + 5 * 60000, JSON.stringify(q));
  const tpQ2 = path.join(u.tr, 'sQ2.jsonl');
  fs.writeFileSync(tpQ2, [queued(T0 + 5 * 60000, 'q2'), removed(T0 + 6 * 60000, 'q2'), line({ timestamp: iso(T0 + 30 * 60000) })].join('\n') + '\n');
  t('ACK-7b: a queued message before the turn of that prompt id started is not a candidate', S.transcriptEntryOf(tpQ2, recAt(T0 + 6 * 60000), cfg) === null);
  const tpQ3 = path.join(u.tr, 'sQ3.jsonl');
  fs.writeFileSync(tpQ3, [line({ timestamp: iso(T0) }), queued(T0 + 5 * 60000, 'q3', { origin: { kind: 'task-notification' } }), removed(T0 + 6 * 60000, 'q3')].join('\n') + '\n');
  t('ACK-7c: a queued entry that is not of human origin never counts', S.transcriptEntryOf(tpQ3, recAt(T0 + 6 * 60000), cfg) === null);

  // end to end with the queued shape (exactly the incident): first ack typed before done, repeat queued after done
  const g = fixture('acktext-queued');
  g.events('run-1', [{ event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' }]);
  g.owner('Voeg een contactformulier toe', 'sG'); g.tick(5); // R-0001
  const one = 'R-0001 klopt.';
  const gTp = path.join(g.tr, 'sG.jsonl');
  const g1 = g.hookCapture(one, { session: 'sG', entry: g.entry(one, 'sG', { promptId: PID }), extra: real }); g.tick(30);
  g.finish('R-0001', 'wp-1', 'run-1'); g.tick(5 * 60);
  const typedAt = Date.parse(g.opts().now().toISOString());
  g.tick(11 * 60);
  const absorbedAt = Date.parse(g.opts().now().toISOString());
  fs.appendFileSync(gTp, JSON.stringify({ type: 'attachment', uuid: 'a-' + rnd(), sessionId: 'sG', timestamp: iso(typedAt), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: one }], source_uuid: 'qg', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: iso(typedAt), humanTurn: true } }) + '\n'
    + JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: iso(absorbedAt + 1000), sessionId: 'sG', content: one, commandUuid: 'qg' }) + '\n');
  const g2 = g.hookCapture(one, { session: 'sG', entry: null, extra: { prompt_id: PID, uuid: null } }); g.tick(5);
  t('ACK-8a: the typed first ack (before done) is refused', throwsRefused(() => SC.transition('R-0001', 'ack', { pid: g1.pid }, g.opts())));
  let gAck = null; let gErr = null;
  try { gAck = SC.transition('R-0001', 'ack', { pid: g2.pid }, g.opts()); } catch (e) { gErr = e.message; }
  t('ACK-8: the repeat typed mid-turn (queued_command, same prompt id) after done authorises the ack', gAck && gAck.status === 'acked', gErr || JSON.stringify(gAck));
});

// ---------------------------------------------------------------- WP-ACK-IMAGE an owner message with an attached image
// Live defect 2026-10-11 (P-000019): the transcript entry's content was [text, image, text]; the hook stored the text parts
// joined with a newline (image dropped). userText accepted text-only arrays, so the entry was no candidate and the ack was
// refused as "not found as an owner message". The comparable text is now ALL text parts joined (image/document parts
// ignored), compared after collapsing whitespace on both sides.
section('WP-ACK-IMAGE', () => {
  const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const A = 'R-0001 en R-0002 kloppen.';
  const B = 'lopen deze ook vast?';
  /** ackWith(name, parts, inboxText) -> 'acked' or the refusal: R-0001 done BEFORE the prompt, then the prompt with the
   *  given transcript content parts, captured by the hook as inboxText. */
  const ackWith = (name, parts, inboxText) => {
    const f = fixture('ackimg-' + name);
    f.events('run-1', [{ event_type: 'agent_work_package_created', wp_id: 'wp-1' }, { event_type: 'wp_completed', wp_id: 'wp-1', event_id: 'e1' }]);
    f.owner('Voeg een contactformulier toe', 'sI'); f.tick(5); // R-0001
    f.finish('R-0001', 'wp-1', 'run-1'); f.tick(60);
    const e = f.entry(inboxText, 'sI', { origin: { kind: 'human' }, message: { role: 'user', content: parts } });
    const p = f.hookCapture(inboxText, { session: 'sI', entry: e, extra: { uuid: null } }); f.tick(5);
    try { return SC.transition('R-0001', 'ack', { pid: p.pid }, f.opts()).status; } catch (err) { return 'refused: ' + err.message; }
  };
  const tx = (s) => ({ type: 'text', text: s });
  const r1 = ackWith('tit', [tx(A), IMG, tx(B)], A + '\n' + B);
  t('IMG-1: [text, image, text] (the live P-000019 shape) authorises the ack of an item done before the prompt', r1 === 'acked', r1);
  const r2 = ackWith('itt', [IMG, tx(A), tx(B)], A + '\n' + B);
  t('IMG-2: the same with the image part first authorises the ack', r2 === 'acked', r2);
  const r2b = ackWith('ws', [tx(A), IMG, tx(B)], A + '\n\n' + B + ' ');
  t('IMG-2b: whitespace differences between the inbox text and the joined parts (blank line, trailing space) still match', r2b === 'acked', r2b);
  const r3 = ackWith('word', [tx(A), IMG, tx('lopen deze niet vast?')], A + '\n' + B);
  t('IMG-3: text parts that differ from the inbox text by one word are NOT matched', /was not found as an owner message/.test(r3), r3);
  const r4 = ackWith('only', [IMG], A);
  t('IMG-4: an image-only message (no text) is no owner text and never matches', /was not found as an owner message/.test(r4), r4);
  const imgOnly = { type: 'user', message: { role: 'user', content: [IMG] } };
  t('IMG-4b: userText of an image-only entry is null', S.userText(imgOnly) === null);
  const r5 = ackWith('single', [tx(A + '\n' + B)], A + '\n' + B);
  t('IMG-5: a single text part behaves as before', r5 === 'acked', r5);
  const r5b = ackWith('string', A + '\n' + B, A + '\n' + B);
  t('IMG-5b: a plain string content behaves as before', r5b === 'acked', r5b);
  const toolRes = { type: 'user', message: { role: 'user', content: [tx(A), { type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } };
  t('IMG-6: a content array with a tool_result part is never owner text', S.userText(toolRes) === null);
  t('IMG-6b: userText joins the text parts of [text, image, text] with a newline, image ignored', S.userText({ type: 'user', message: { role: 'user', content: [tx(A), IMG, tx(B)] } }) === A + '\n' + B);
});

// ================================================================ WP-ACK-LIST — a list of R-ids with ONE shared
// affirmative predicate ("R-0006, R-0007, …, R-0016 en R-0012 kloppen.") authorises each listed id. Live defect: that exact
// owner sentence was refused because only "klopt" (singular) was an ack word and the bare ids bound to the plural clause.
console.log('\nWP-ACK-LIST regression tests (shared predicate over a list of ids)');
section('34 ACK-LIST', () => {
  /** listFixture(done) — 16 items; the ids in `done` are finished (wp_completed), the others only linked (planned). */
  const listFixture = (name, done) => {
    const f = fixture('acklist-' + name);
    const evs = [];
    for (let i = 1; i <= 16; i++) evs.push({ event_type: 'agent_work_package_created', wp_id: 'wp-' + i }, { event_type: 'wp_completed', wp_id: 'wp-' + i, event_id: 'e' + i });
    f.events('run-1', evs);
    for (let i = 1; i <= 16; i++) { f.owner('Voeg onderdeel nummer ' + i + ' toe aan de site'); f.tick(5); }
    const rid = (i) => 'R-' + String(i).padStart(4, '0');
    for (let i = 1; i <= 16; i++) {
      if (done.includes(i)) f.finish(rid(i), 'wp-' + i, 'run-1');
      else SC.transition(rid(i), 'link', { wp_ids: ['wp-' + i], run_id: 'run-1' }, f.opts());
      f.tick(5);
    }
    return { f, rid };
  };
  const ackOf = (f, id, pid) => { try { return SC.transition(id, 'ack', { pid }, f.opts()).status; } catch (e) { return 'refused: ' + e.message; } };
  const OWNER = 'R-0006, R-0007, R-0008, R-0009, R-0010, R-0014, R-0016 en R-0012 kloppen.';
  const LISTED = ['R-0006', 'R-0007', 'R-0008', 'R-0009', 'R-0010', 'R-0014', 'R-0016', 'R-0012'];
  const DONE = [6, 7, 8, 9, 10, 12, 14, 16];

  { // the owner's exact sentence
    const { f } = listFixture('owner', DONE);
    const p = f.owner(OWNER); f.tick(5);
    const res = LISTED.map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-1: the owner\'s exact sentence authorises all eight listed ids', res.every(([, s]) => s === 'acked'), JSON.stringify(res));
  }
  { // a trailing exception poisons the whole shared act
    const { f } = listFixture('maar', DONE);
    const p = f.owner(OWNER.replace(/\.$/, ', maar R-0012 niet.')); f.tick(5);
    const res = LISTED.map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-2: with a trailing "maar R-0012 niet" it authorises none', res.every(([, s]) => /^refused/.test(s)), JSON.stringify(res));
  }
  { // a condition
    const { f } = listFixture('als', DONE);
    const p = f.owner(OWNER.replace(/\.$/, ' als de tests slagen.')); f.tick(5);
    const res = LISTED.map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-3: with "als de tests slagen" it authorises none', res.every(([, s]) => /^refused/.test(s)), JSON.stringify(res));
  }
  { // one listed item is not done: refused by name, the others still approved
    const { f } = listFixture('planned', [6, 7]);
    const p = f.owner('R-0006, R-0007 en R-0011 kloppen.'); f.tick(5);
    const r6 = ackOf(f, 'R-0006', p.pid), r7 = ackOf(f, 'R-0007', p.pid), r11 = ackOf(f, 'R-0011', p.pid);
    t('LIST-4: a list with a still-planned item approves the done ones', r6 === 'acked' && r7 === 'acked', JSON.stringify([r6, r7]));
    t('LIST-4b: ... and refuses the planned item by name', /^refused/.test(r11) && /R-0011/.test(r11), r11);
  }
  { // mixed singular and shared predicates
    const { f } = listFixture('mixed', [1, 2, 3]);
    const p = f.owner('R-0001 klopt, R-0002 en R-0003 kloppen'); f.tick(5);
    const res = ['R-0001', 'R-0002', 'R-0003'].map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-5: "R-0001 klopt, R-0002 en R-0003 kloppen" approves all three', res.every(([, s]) => s === 'acked'), JSON.stringify(res));
  }
  { // a question
    const { f } = listFixture('question', DONE);
    const p = f.owner(OWNER.replace(/\.$/, '?')); f.tick(5);
    const res = LISTED.map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-6: the same list ending with a question mark authorises none', res.every(([, s]) => /^refused/.test(s)), JSON.stringify(res));
  }
  { // never extended to an id the prompt did not name (no ranges)
    const { f } = listFixture('extend', [6, 7, 8]);
    const p = f.owner('R-0006 en R-0008 kloppen.'); f.tick(5);
    t('LIST-7: "R-0006 en R-0008 kloppen" never approves R-0007', /^refused/.test(ackOf(f, 'R-0007', p.pid)));
    const r = f.owner('R-0006 tot en met R-0008 kloppen.'); f.tick(5);
    t('LIST-7b: a range ("tot en met") is not read as a list and never approves the id inside it', /^refused/.test(ackOf(f, 'R-0007', r.pid)));
  }
  { // the form that already worked keeps working
    const { f } = listFixture('repeat', [1, 2, 4]);
    const p = f.owner('R-0001 klopt, R-0002 klopt, R-0004 klopt'); f.tick(5);
    const res = ['R-0001', 'R-0002', 'R-0004'].map((id) => [id, ackOf(f, id, p.pid)]);
    t('LIST-8: "R-0001 klopt, R-0002 klopt, R-0004 klopt" still approves all three', res.every(([, s]) => s === 'acked'), JSON.stringify(res));
  }
  // pure classifier checks of the binding rule
  t('LIST-9: "R-0006 klopt maar R-0007 niet" never approves R-0007', C.authorizes('R-0006 klopt maar R-0007 niet.', 'R-0007', 'ack', cfg).ok === false);
  t('LIST-9b: a shared act with an exception ("R-0002 en R-0003 akkoord, maar R-0004 niet") approves none of the shared ids',
    ['R-0002', 'R-0003', 'R-0004'].every((id) => C.authorizes('R-0002 en R-0003 akkoord, maar R-0004 niet.', id, 'ack', cfg).ok === false));
  t('LIST-9c: a negation inside the list ("R-0002, R-0003 niet en R-0004 kloppen") approves none',
    ['R-0002', 'R-0003', 'R-0004'].every((id) => C.authorizes('R-0002, R-0003 niet en R-0004 kloppen.', id, 'ack', cfg).ok === false));
  t('LIST-9d: the shared predicate never serves a cancel', C.authorizes(OWNER, 'R-0006', 'cancel', cfg).ok === false);
  t('LIST-9e: the English/ampersand form "R-0001, R-0002 & R-0003 confirmed." approves each id',
    ['R-0001', 'R-0002', 'R-0003'].every((id) => C.authorizes('R-0001, R-0002 & R-0003 confirmed.', id, 'ack', cfg).ok === true));
});

for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log('\nforge-scribe tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
