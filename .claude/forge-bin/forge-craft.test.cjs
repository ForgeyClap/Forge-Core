#!/usr/bin/env node
'use strict';
/**
 * forge-craft.test.cjs — tests for the craft lens (modernization Phase I, work package I.3).
 * Proves on the REAL lens files: the expected deliverable types exist and validate; every stakeholder has a block
 * check; every cited source still resolves to its file, heading or rule id and quote; an unknown type falls back to
 * the generic lens and says so; no command ever emits a pass or a filled mark. Mutation tests prove the detectors:
 * a corrupted citation, a removed stakeholder, a stakeholder without a block check or a result field each fail.
 * Temp fixtures live in the OS temp folder and are removed at the end.
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const C = require('./forge-craft.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(__dirname, 'forge-craft.cjs');
const run = (args, root) => spawnSync(process.execPath, [TOOL, ...args, '--root', root || ROOT], { encoding: 'utf8', windowsHide: true });
const clone = (v) => JSON.parse(JSON.stringify(v));
const EXPECTED = ['web-ui', 'copy-and-content', 'code', 'automation-workflow', 'documents-and-spreadsheets', 'data-and-reports',
  'game-and-interactive', 'cli-and-devtools', 'api-and-integration', 'voice-and-chat', 'generic'];
const devTree = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'config', 'forge-dev-tree.json'), 'utf8')).dev_tree === true; } catch { return false; } })();
const real = {};
for (const ty of EXPECTED) real[ty] = C.loadLens(ROOT, ty);
const tmpDirs = [];
function tmpRoot() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-craft-')); tmpDirs.push(d); return d; }
function write(root, rel, text) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

console.log('forge-craft tests (craft lens: schema, citations, fallback, never-pass, mutation)');

// ---- A. the real lenses ---------------------------------------------------------------------------------------
t('the lens folder holds exactly the 11 expected deliverable types', () => {
  const got = C.lensTypes(ROOT).slice().sort(), want = EXPECTED.slice().sort();
  ok(JSON.stringify(got) === JSON.stringify(want), 'got ' + got.join(','));
});
for (const ty of EXPECTED) {
  t(ty + ': loads, is valid JSON and passes the schema', () => {
    const r = real[ty];
    ok(r && !r.error, 'not loadable: ' + (r && r.error));
    ok(r.valid, r.problems.join('; '));
  });
  t(ty + ': 2..5 stakeholders, at most 20 checks, every stakeholder has at least one block check', () => {
    const l = real[ty].lens;
    ok(l.stakeholders.length >= 2 && l.stakeholders.length <= 5, 'stakeholders ' + l.stakeholders.length);
    ok(l.checks.length >= 1 && l.checks.length <= 20, 'checks ' + l.checks.length);
    for (const s of l.stakeholders) ok(l.checks.some((c) => c.stakeholder === s.id && c.severity === 'block'), 'no block check for ' + s.id);
  });
  t(ty + ': every check is cited (path + quote + one locator) or professional practice (one-line rationale only)', () => {
    for (const c of real[ty].lens.checks) {
      if (c.provenance === 'cited') ok(c.source.path && c.source.quote && (!!c.source.section !== !!c.source.rule_id) && !('rationale' in c.source), c.id + ' citation shape');
      else ok(c.provenance === 'professional_practice' && Object.keys(c.source).join() === 'rationale' && !/\n/.test(c.source.rationale), c.id + ' rationale shape');
    }
  });
  t(ty + ': every cited source resolves to its file, heading or rule id, and quote' + (devTree ? ' (development tree: docs/ must resolve too)' : ''), () => {
    const v = C.verifyLensCitations(real[ty].lens, ROOT);
    ok(v.ok, v.problems.join('; '));
    ok(v.checked === real[ty].lens.checks.filter((c) => c.provenance === 'cited').length, 'checked ' + v.checked);
    if (devTree) ok(v.unavailable.length === 0, 'unavailable in the dev tree: ' + v.unavailable.join('; '));
    else ok(v.unavailable.every((u) => / docs\//.test(' ' + u.split(': ')[1])), 'only docs/ citations may be unavailable outside the dev tree');
  });
}
t('lens domains are real domain-catalog.json domains, and validate reports every lens clean', () => {
  const v = C.validateAll(ROOT);
  ok(v.ok && v.fallback_present, JSON.stringify(v.lenses.filter((l) => !l.ok)));
  ok(v.lenses.length === EXPECTED.length, 'lenses ' + v.lenses.length);
});
t('CLI validate exits 0 on the real lenses and prints the provenance split', () => {
  const r = run(['validate']);
  ok(r.status === 0, 'exit ' + r.status + ' ' + r.stdout + r.stderr);
  ok(/all valid, citations found/.test(r.stdout) && /cited/.test(r.stdout) && /professional practice/.test(r.stdout), r.stdout);
});

// ---- B. fallback to the generic lens --------------------------------------------------------------------------
t('lens --type <unknown> falls back to the generic lens and says so (exit 0)', () => {
  const r = run(['lens', '--type', 'podcast']);
  ok(r.status === 0, 'exit ' + r.status + ' ' + r.stderr);
  ok(/^NOTE: no lens for "podcast": using the generic lens/m.test(r.stdout), r.stdout.slice(0, 400));
  ok(/^Craft lens: generic \(v1\)/.test(r.stdout), r.stdout.slice(0, 200));
  const j = JSON.parse(run(['lens', '--type', 'podcast', '--json']).stdout);
  ok(j.type === 'generic' && j.notices.length === 1 && /podcast/.test(j.notices[0]), JSON.stringify(j.notices));
});
t('plan --deliverables keeps known types in order, adds generic once for any number of unknown ones', () => {
  const j = JSON.parse(run(['plan', '--deliverables', 'web-ui, podcast,quiz,web-ui', '--json']).stdout);
  ok(JSON.stringify(j.deliverables) === '["web-ui","generic"]', JSON.stringify(j.deliverables));
  ok(j.notices.length === 2, JSON.stringify(j.notices));
  ok(/review-template --deliverables "web-ui,generic"/.test(j.next), j.next);
});
t('plan --domain maps catalog domains to lenses (user-facing lenses first, code last); an unknown domain -> generic', () => {
  const w = JSON.parse(run(['plan', '--domain', 'website', '--json']).stdout).deliverables;
  ok(w[0] === 'web-ui' && w.includes('copy-and-content') && w[w.length - 1] === 'code', JSON.stringify(w));
  const g = JSON.parse(run(['plan', '--domain', 'game', '--json']).stdout).deliverables;
  ok(JSON.stringify(g) === '["game-and-interactive","code"]', JSON.stringify(g));
  const u = JSON.parse(run(['review-template', '--domain', 'not-a-domain', '--json']).stdout);
  ok(JSON.stringify(u.deliverables) === '["generic"]' && u.notices.some((n) => /not a domain in domain-catalog/.test(n)), JSON.stringify(u.notices));
});

// ---- B2. I.8b: deliverable words select lenses (selected_by), unknown types get the closest lens + generic ----------
const planOf = (args) => { const r = run(['plan'].concat(args, ['--json'])); ok(r.status === 0, args.join(' ') + ' exit ' + r.status + ' ' + r.stderr); return JSON.parse(r.stdout); };
t('documents-and-spreadsheets is reachable: from the request (NL and EN) and from the name of an unknown type', () => {
  const nl = planOf(['--domain', 'invoice-spreadsheet', '--text', 'Maak een Excel-spreadsheet voor mijn accountant met alle facturen van dit kwartaal']).deliverables;
  ok(nl.includes('documents-and-spreadsheets') && nl[nl.length - 1] === 'generic', JSON.stringify(nl));
  const en = planOf(['--domain', 'data', '--text', 'Build an inventory spreadsheet with a weekly count sheet the floor staff can print']).deliverables;
  ok(en.includes('data-and-reports') && en.includes('documents-and-spreadsheets') && !en.includes('generic'), JSON.stringify(en));
  const slug = planOf(['--domain', 'contract-generator']);
  ok(slug.deliverables.includes('documents-and-spreadsheets') && slug.deliverables.includes('generic') && slug.selection.some((s) => s.type === 'documents-and-spreadsheets' && s.from === 'type name'), JSON.stringify(slug.selection));
  const pdf = planOf(['--domain', 'contract-generator', '--text', 'Maak een generator die huurcontracten opstelt met een pdf die de huurder kan ondertekenen']);
  ok(pdf.selection.some((s) => s.type === 'documents-and-spreadsheets' && s.words.length), JSON.stringify(pdf.selection));
});
t('an unknown type gets the CLOSEST lenses by deliverable words AND generic as the safety net (never only generic when a lens fits)', () => {
  for (const [d, text, want] of [['podcast-pipeline', 'build a pipeline that writes show notes and chapter markers and prepares the episode page', ['copy-and-content', 'web-ui', 'code']],
    ['church-newsletter', 'Maak een maandelijkse nieuwsbrief voor onze kerkgemeente', ['copy-and-content']], ['sensor-dashboard', 'Build a dashboard with live greenhouse sensor values', ['web-ui']],
    ['habit-tool', 'een kleine tool die mijn gewoontes bijhoudt', ['code']]]) {
    const j = planOf(['--domain', d, '--text', text]);
    ok(want.every((x) => j.deliverables.includes(x)) && j.deliverables[j.deliverables.length - 1] === 'generic', d + ': ' + JSON.stringify(j.deliverables));
    ok(j.notices.some((n) => /closest lenses by the deliverable words/.test(n) && /generic lens as the safety net/.test(n)), d + ' notice: ' + JSON.stringify(j.notices));
  }
});
t('payments with a donor or checkout page also gets the web-ui lens; payments without a page does not', () => {
  const page = planOf(['--domain', 'payments', '--text', 'Create a donation page for our animal shelter with monthly gifts through Mollie']).deliverables;
  ok(page[0] === 'web-ui' && page.includes('api-and-integration'), JSON.stringify(page));
  const back = planOf(['--domain', 'payments', '--text', 'Handle the Mollie refund webhook idempotently']).deliverables;
  ok(!back.includes('web-ui') && JSON.stringify(back) === JSON.stringify(planOf(['--domain', 'payments']).deliverables), JSON.stringify(back));
});
t('negative controls: stylesheet, databasetabel, nieuwsbrief (not "brief"), "keep it brief" and a 3D-print shop never select the documents lens', () => {
  for (const text of ['update the stylesheet of the homepage', 'voeg een kolom toe aan de databasetabel', 'Maak een nieuwsbrief voor de leden', 'keep it brief and friendly', 'a webshop for my 3D-print studio']) {
    const j = planOf(['--domain', 'website', '--text', text]);
    ok(!j.deliverables.includes('documents-and-spreadsheets'), text + ': ' + JSON.stringify(j.deliverables));
  }
  const word = C.lexOf('de trainingssessie in de databasetabel');
  ok(!C.wordHit(word, 'tabel') && C.wordHit(C.lexOf('de huurcontracten'), '-contract') && C.wordHit(C.lexOf('twee facturen'), '-factuur-') && !C.wordHit(C.lexOf('the stylesheet'), 'sheet'), 'wordHit direction');
});
t('a known domain without --text is unchanged, and --text without --domain still plans (closest lenses + generic)', () => {
  ok(JSON.stringify(planOf(['--domain', 'website']).deliverables) === JSON.stringify(planOf(['--domain', 'website', '--text', 'a landing page']).deliverables), 'website + landing page');
  const only = planOf(['--text', 'een rapport in pdf voor de klant']).deliverables;
  ok(JSON.stringify(only) === '["documents-and-spreadsheets","generic"]', JSON.stringify(only));
});
t('MUTATION: a malformed selected_by (one language, a short compound marker, an empty word) fails the schema', () => {
  for (const [sb, re] of [[{ en: ['sheet'] }, /two non-empty lists/], [{ en: ['sheet'], nl: ['-app'] }, /compound marker/], [{ en: ['***'], nl: ['tabel'] }, /holds no word/], [{ en: ['a'], nl: ['b'], de: ['c'] }, /two non-empty lists/]]) {
    const l = clone(real['documents-and-spreadsheets'].lens); l.selected_by = sb;
    const v = C.validateLens(l, { type: 'documents-and-spreadsheets' });
    ok(!v.ok && v.problems.some((p) => re.test(p)), JSON.stringify(sb) + ': ' + JSON.stringify(v.problems));
  }
});

// ---- B3. I.9: an app people use selects the web-ui lens (selected_together), a CLI or backend-only request does not ----
const webUi = (domain, text) => planOf(['--domain', domain, '--text', text]).deliverables.includes('web-ui');
t('selected_together: "app/platform/tool" + people + "can/kunnen/laten" in one sentence selects web-ui (NL and EN), the type stays as given', () => {
  for (const [d, text] of [['recipe-app', 'Build a recipe app where people can save recipes, scale the servings and turn a recipe into a shopping list.'],
    ['recipe-app', 'Maak een app waarmee mensen recepten kunnen delen'], ['booking-app', 'an app where users can book a table'],
    ['salon', 'een platform dat klanten laat reserveren'], ['vocab', 'a tool that lets students practise vocabulary']]) ok(webUi(d, text), d + ': ' + text);
  const j = planOf(['--domain', 'recipe-app', '--text', 'Maak een app waarmee mensen recepten kunnen delen']);
  const s = j.selection.find((x) => x.type === 'web-ui');
  ok(s && s.from === 'request' && JSON.stringify(s.words) === '["app","mensen","kunnen"]', JSON.stringify(j.selection));
  ok(j.deliverables[j.deliverables.length - 1] === 'generic' && j.notices.some((n) => /"recipe-app" is not a domain/.test(n)), 'an unknown type keeps the safety net: ' + JSON.stringify(j));
});
t('negative controls: a cron job, a rename script, a CLI or backend-only tool, an old-files cleaner and words split over two sentences never select web-ui', () => {
  for (const text of ['a cron job that cleans old logs', 'een script dat bestanden hernoemt', 'a CLI tool that users can run from the terminal',
    'a backend-only tool where users can sync contacts', 'an internal tool that can rename files', 'een tool die bestanden ouder dan 30 dagen kan opruimen',
    'Speed up the export tool. People say it can take minutes.']) ok(!webUi('code-task', text), text);
  ok(!webUi('cli', 'Build a CLI app where users can parse logs'), 'a known cli domain with an app people use from the command line');
});
t('the type name never triggers selected_together, and selected_by hit words are listed once', () => {
  ok(!C.selectTypes(ROOT, { domain: 'app-users-can' }).types.includes('web-ui'), 'type name');
  const code = planOf(['--domain', 'recipe-app', '--text', 'a recipe app']).selection.find((x) => x.type === 'code');
  ok(code && JSON.stringify(code.words) === '["app"]', JSON.stringify(code));
  ok(JSON.stringify(C.togetherHit('an app. users can book', real['web-ui'].lens.selected_together)) === 'null', 'sentence scope');
});
t('MUTATION: a malformed selected_together (one group, five groups, a group in one language, an unknown key, not a list) fails the schema', () => {
  const g = { en: ['app'], nl: ['app'] };
  for (const [st, re] of [[[{ all: [g] }], /selected_together\[0\]/], [[{ all: [g, g, g, g, g] }], /selected_together\[0\]/], [[{ all: [g, { en: ['users'] }] }], /all\[1\]: lens.selected_by must be/],
    [[{ all: [g, g], when: g }], /selected_together\[0\]/], [{ all: [g, g] }, /must be \[\{all/], [[{ all: [g, g], unless: { en: ['-cli'], nl: ['cli'] } }], /unless: .*compound marker/]]) {
    const l = clone(real['web-ui'].lens); l.selected_together = st;
    const v = C.validateLens(l, { type: 'web-ui' });
    ok(!v.ok && v.problems.some((p) => re.test(p)), JSON.stringify(st) + ': ' + JSON.stringify(v.problems));
  }
});

// ---- B4. I.10: a pitch deck is a document; the bare word "invoice" is not (only next to a deliverable verb or noun) ----
const docs = (domain, text) => planOf(['--domain', domain, '--text', text]).deliverables.includes('documents-and-spreadsheets');
t('the documents lens selects a pitch deck, an investor deck and a Dutch pitchdeck, and an invoice someone makes, writes or prints', () => {
  for (const [d, text] of [['pitch-deck', 'Make a ten-slide pitch deck for our bakery franchise to show investors next week'], ['deck', 'an investor deck with last year\'s numbers'],
    ['deck', 'Maak een pitchdeck voor de bank'], ['invoice-tool', 'Make an invoice template for my cleaning business'], ['fullstack', 'Write an invoice document for client X'],
    ['billing', 'generate a printable invoice for every order']]) ok(docs(d, text), d + ': ' + text);
});
t('negative controls: invoices as database data, a card deck, a deck builder and a bare invoice mention never select the documents lens', () => {
  for (const [d, text] of [['migration', 'Migrate our customer database from MySQL to Postgres without downtime and keep the old customer IDs working for the invoices.'],
    ['fullstack', 'Migrate the invoices table to the new schema'], ['fullstack', 'Make the invoices table faster in the database'],
    ['game', 'Build a card game where players build a deck of 40 cards'], ['website', 'A website for our deck building company'],
    ['api', 'An endpoint that returns the invoices of a customer']]) ok(!docs(d, text), d + ': ' + text);
});

// ---- C. the tool never emits a pass and never fills a mark -----------------------------------------------------
const FILL_KEYS = ['mark', 'answer', 'evidence', 'finding', 'fix_or_weakness', 'notice_in_10_seconds', 'notice_on_closer_inspection', 'deliverable', 'where', 'reviewer'];
const RESULT_KEYS = ['status', 'passed', 'pass', 'verdict', 'result', 'score'];
function walk(v, fn, k) { fn(k, v); if (Array.isArray(v)) v.forEach((x) => walk(x, fn, null)); else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, fn, kk); }
t('no command prints PASS / PASSED, a result key or a filled mark, for any lens, in text or JSON', () => {
  const calls = [];
  for (const ty of EXPECTED) calls.push(['lens', '--type', ty], ['plan', '--deliverables', ty], ['review-template', '--type', ty]);
  calls.push(['plan', '--deliverables', EXPECTED.join(',')], ['review-template', '--deliverables', EXPECTED.join(',')], ['lens', '--list'], ['validate']);
  for (const args of calls) {
    for (const json of [false, true]) {
      const r = run(json ? args.concat('--json') : args);
      ok(r.status === 0, args.join(' ') + ' exit ' + r.status + ' ' + r.stderr);
      ok(!/\bPASS(ED)?\b/.test(r.stdout), args.join(' ') + ' printed PASS');
      if (!json) continue;
      walk(JSON.parse(r.stdout), (k, v) => {
        if (k && RESULT_KEYS.includes(k)) throw new Error(args.join(' ') + ' JSON carries a result key "' + k + '"');
        if (k && FILL_KEYS.includes(k) && v !== null) throw new Error(args.join(' ') + ' JSON pre-fills "' + k + '"');
      });
    }
  }
});
t('the review template carries every check of every stakeholder, all unmarked, plus the not-done rule', () => {
  const j = JSON.parse(run(['review-template', '--type', 'web-ui', '--json']).stdout);
  const checks = j.lenses[0].stakeholders.flatMap((s) => s.checks);
  ok(checks.length === real['web-ui'].lens.checks.length && checks.every((c) => c.mark === null), 'checks ' + checks.length);
  ok(JSON.stringify(j.marks) === JSON.stringify(C.MARKS) && j.stated_weaknesses.length === 0, 'marks/weaknesses');
  ok(j.rules.some((x) => /DEFECT or NOT_INSPECTED means the deliverable is not done/.test(x)), 'not-done rule missing');
  const txt = run(['review-template', '--type', 'web-ui']).stdout;
  ok(/^# Craft review: web-ui/.test(txt) && /## Stated weaknesses/.test(txt) && /either above 0 means not done/.test(txt), txt.slice(0, 300));
});

// ---- D. mutation: the detectors catch real breakage ------------------------------------------------------------
t('MUTATION: a corrupted quote in a real lens is reported against that check id', () => {
  const l = clone(real['web-ui'].lens);
  const c = l.checks.find((x) => x.provenance === 'cited' && x.source.section);
  c.source.quote = c.source.quote + ' (this sentence was never written)';
  const v = C.verifyLensCitations(l, ROOT);
  ok(!v.ok && v.problems.some((p) => p.startsWith(c.id + ': quote')), JSON.stringify(v.problems));
});
t('MUTATION: a wrong heading, a wrong rule id and a missing .claude/ file are each reported', () => {
  const l = clone(real['web-ui'].lens);
  const md = l.checks.find((x) => x.source.section && x.source.path.startsWith('.claude/'));
  const js = l.checks.find((x) => x.source.rule_id);
  md.source.section = 'No Such Heading Anywhere';
  js.source.rule_id = 'no-such-rule-id';
  const v = C.verifyLensCitations(l, ROOT);
  ok(v.problems.some((p) => p.startsWith(md.id + ': no heading')) && v.problems.some((p) => p.startsWith(js.id + ': rule id')), JSON.stringify(v.problems));
  const l2 = clone(real['code'].lens);
  l2.checks[0].source.path = '.claude/skills/forge-not-there/SKILL.md';
  ok(C.verifyLensCitations(l2, ROOT).problems.some((p) => /does not exist/.test(p)), 'missing .claude file not reported');
});
t('MUTATION: removing a stakeholder fails the schema (its checks name an undeclared stakeholder)', () => {
  const l = clone(real['code'].lens);
  l.stakeholders = l.stakeholders.filter((s) => s.id !== 'operator');
  const v = C.validateLens(l, { type: 'code' });
  ok(!v.ok && v.problems.some((p) => /"operator" is not a declared stakeholder/.test(p)), JSON.stringify(v.problems));
});
t('MUTATION: a stakeholder whose block checks are all downgraded to warn fails the schema', () => {
  const l = clone(real['voice-and-chat'].lens);
  for (const c of l.checks) if (c.stakeholder === 'staff') c.severity = 'warn';
  const v = C.validateLens(l, { type: 'voice-and-chat' });
  ok(!v.ok && v.problems.some((p) => /stakeholder "staff" has no block check/.test(p)), JSON.stringify(v.problems));
});
t('MUTATION: result fields, bad provenance shapes, oversize lenses and wrong names are all rejected', () => {
  const base = real['generic'].lens;
  const cases = [
    ['a status on a check', (l) => { l.checks[0].status = 'CLEAN'; }, /not a lens field/],
    ['a mark on the lens', (l) => { l.mark = 'CLEAN'; }, /not a lens field/],
    ['professional practice with a path', (l) => { l.checks[0].provenance = 'professional_practice'; }, /source\.(path|quote|section) is not a lens field|rationale must be/],
    ['cited without a quote', (l) => { delete l.checks[0].source.quote; }, /source\.quote is missing/],
    ['cited with section and rule_id', (l) => { l.checks[0].source.rule_id = 'x'; }, /exactly one of section or rule_id/],
    ['a two-line rationale', (l) => { l.checks.push({ id: 'extra', stakeholder: 'checker', claim: 'A claim long enough to count.', how_to_inspect: 'An inspection long enough to count.', evidence_required: 'Evidence long enough to count.', severity: 'warn', provenance: 'professional_practice', source: { rationale: 'line one\nline two' } }); }, /one line/],
    ['a stub claim', (l) => { l.checks[0].claim = 'Looks fine.'; }, /claim must be concrete/],
    ['a duplicate check id', (l) => { l.checks[1].id = l.checks[0].id; }, /is a duplicate/],
    ['21 checks', (l) => { while (l.checks.length < 21) l.checks.push(Object.assign(clone(l.checks[0]), { id: 'c' + l.checks.length })); }, /1\.\.20 checks/],
    ['a severity outside block|warn', (l) => { l.checks[0].severity = 'critical'; }, /not block\|warn/],
  ];
  for (const [name, mutate, re] of cases) {
    const l = clone(base); mutate(l);
    const v = C.validateLens(l, { type: 'generic' });
    ok(!v.ok && v.problems.some((p) => re.test(p)), name + ': ' + JSON.stringify(v.problems));
  }
  ok(!C.validateLens(clone(base), { type: 'web-ui' }).ok, 'a type that differs from the file name must fail');
});
t('CLI on a temp root: a stale citation makes validate exit 3 and lens print STALE LENS; docs/ gaps are only "not shipped"', () => {
  const root = tmpRoot();
  write(root, '.claude/skills/demo/SKILL.md', '# Demo\n\n## Hard rules\n- The **exact** rule text lives here.\n\n## Other\n- unrelated\n');
  const lens = clone(real['generic'].lens);
  for (const c of lens.checks) { c.provenance = 'cited'; c.source = { path: '.claude/skills/demo/SKILL.md', section: 'Hard rules', quote: 'The exact rule text lives here.' }; }
  lens.checks[0].source = { path: 'docs/missing-provenance.md', section: 'Any', quote: 'anything' };
  write(root, '.claude/config/quality/lenses/generic.json', JSON.stringify(lens));
  let r = run(['validate'], root);
  ok(r.status === 0 && /development-tree docs not shipped here/.test(r.stdout), 'clean temp root: exit ' + r.status + ' ' + r.stdout);
  write(root, '.claude/skills/demo/SKILL.md', '# Demo\n\n## Hard rules\n- Someone rewrote this rule.\n');
  r = run(['validate'], root);
  ok(r.status === 3 && /quote "The exact rule text/.test(r.stdout), 'stale: exit ' + r.status + ' ' + r.stdout);
  r = run(['lens', '--type', 'generic'], root);
  ok(r.status === 0 && /STALE LENS generic/.test(r.stdout), 'lens on a stale lens: exit ' + r.status);
});
t('CLI on a temp root: an invalid or unparsable lens exits 3 and lists nothing; a missing generic lens fails validate', () => {
  const root = tmpRoot();
  const bad = clone(real['code'].lens); bad.stakeholders = bad.stakeholders.slice(0, 1);
  write(root, '.claude/config/quality/lenses/code.json', JSON.stringify(bad));
  let r = run(['lens', '--type', 'code'], root);
  ok(r.status === 3 && /is invalid/.test(r.stderr) && r.stdout === '', 'invalid: exit ' + r.status);
  write(root, '.claude/config/quality/lenses/code.json', '{ not json');
  r = run(['plan', '--deliverables', 'code'], root);
  ok(r.status === 3 && /not valid JSON/.test(r.stderr), 'unparsable: exit ' + r.status);
  r = run(['validate'], root);
  ok(r.status === 3 && /generic fallback lens is missing/.test(r.stdout), 'no fallback: exit ' + r.status + ' ' + r.stdout);
});

// ---- E. CLI contract ------------------------------------------------------------------------------------------
t('usage errors exit 2; help exits 0', () => {
  for (const args of [[], ['lens'], ['plan'], ['review-template'], ['lens', '--type'], ['frobnicate']]) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });
    ok(r.status === 2 && /usage:/.test(r.stderr), JSON.stringify(args) + ' exit ' + r.status);
  }
  ok(run(['help']).status === 0, 'help');
});
t('lens --schema is JSON; lens --list --json lists the 11 lenses as valid with counts', () => {
  ok(JSON.parse(run(['lens', '--schema']).stdout).title === 'Forge craft lens', 'schema');
  const ls = JSON.parse(run(['lens', '--list', '--json']).stdout).lenses;
  ok(ls.length === 11 && ls.every((l) => l.valid && l.checks > 0 && l.block > 0), JSON.stringify(ls.map((l) => l.type)));
});
t('output is deterministic (two runs are byte-identical)', () => {
  const a = run(['review-template', '--domain', 'website', '--json']).stdout, b = run(['review-template', '--domain', 'website', '--json']).stdout;
  ok(a === b && a.length > 1000, 'differs or empty');
});
t('in-process main() matches the CLI and needs no process state', () => {
  const lines = [];
  const code = C.main(['lens', '--type', 'code', '--json'], { out: (s) => lines.push(s), err: (s) => lines.push(s), root: ROOT });
  ok(code === 0 && JSON.parse(lines.join('\n')).type === 'code', 'main exit ' + code);
});

// ---- F. wiring: the skill and the three Boss steps ------------------------------------------------------------
t('the forge-craft skill: <= 4 KB, description <= 200 chars, NL + EN triggers in when_to_use', () => {
  const p = path.join(ROOT, '.claude', 'skills', 'forge-craft', 'SKILL.md');
  const txt = fs.readFileSync(p, 'utf8');
  ok(Buffer.byteLength(txt, 'utf8') <= 4096, 'SKILL.md is ' + Buffer.byteLength(txt, 'utf8') + ' bytes');
  const fm = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(txt) || [])[1] || '';
  ok(/^name: forge-craft$/m.test(fm), 'name');
  const desc = ((/^description: "(.*)"$/m.exec(fm) || [])[1] || '');
  ok(desc.length >= 40 && desc.length <= 200, 'description length ' + desc.length);
  const wtu = ((/^when_to_use: "(.*)"$/m.exec(fm) || [])[1] || '').toLowerCase();
  for (const w of ['klaar', 'af', 'oplever', 'design', 'ziet er', 'review', 'polish', 'sloppy', 'details']) ok(wtu.includes(w), 'when_to_use lacks "' + w + '"');
});
t('Verify Boss, Review Boss and UI Boss each carry the craft step in their body (not the frontmatter)', () => {
  for (const [agent, re] of [['verify-boss', /forge-craft\.cjs (lens|plan)/], ['review-boss', /quality\/lenses\//], ['ui-boss', /forge-craft\.cjs review-template/]]) {
    const txt = fs.readFileSync(path.join(ROOT, '.claude', 'agents', agent + '.md'), 'utf8');
    const end = txt.indexOf('\n---', 4);
    ok(end > 0 && re.test(txt.slice(end)) && !/craft/i.test(txt.slice(0, end)), agent + ' craft step missing or in the frontmatter');
  }
});

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
