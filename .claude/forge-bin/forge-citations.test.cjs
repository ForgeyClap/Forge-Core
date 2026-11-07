#!/usr/bin/env node
'use strict';
// forge-citations.test.cjs — behaviour tests for the citation ledger (W2-CITATIONS).
// Hermetic: every fixture lives in a fresh os.tmpdir() folder that is removed in `finally`.
// Covers: verbatim match, honest normalisation, near-miss = mismatch, missing source = unverified,
// report exit codes, label marking, path-escape refusal, oversize source, ledger integrity.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const C = require('./forge-citations.cjs');

const CLI = path.join(__dirname, 'forge-citations.cjs');
let passed = 0, failed = 0, skipped = 0;
const dirs = [];
function t(name, fn) {
  try {
    if (fn() === 'skip') { skipped++; console.log('  skip ' + name); }
    else { passed++; console.log('  ok   ' + name); }
  }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-citations-'));
  dirs.push(d);
  return d;
}
function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const PAGE = 'The bridge opened in 1932. It carries “six lanes” of traffic — plus a rail line –\n' +
  'and   spans   503 metres across the harbour. See the [official history](https://example.org/h) for more.\n' +
  'Engineers used **riveted steel** throughout.';

try {
  console.log('forge-citations tests');

  console.log('\n1) normalisation and matching');
  t('verbatim quote is found', () => {
    assert.strictEqual(C.quoteInText('The bridge opened in 1932.', PAGE), true);
  });
  t('whitespace runs and line breaks collapse', () => {
    assert.strictEqual(C.quoteInText('a rail line - and spans 503 metres', PAGE), true);
  });
  t('curly vs straight quotes and em/en dash vs hyphen match', () => {
    assert.strictEqual(C.quoteInText('carries "six lanes" of traffic - plus a rail', PAGE), true);
  });
  t('case is ignored', () => {
    assert.strictEqual(C.quoteInText('THE BRIDGE OPENED IN 1932', PAGE), true);
  });
  t('markdown link and emphasis are seen through', () => {
    assert.strictEqual(C.quoteInText('See the official history for more', PAGE), true);
    assert.strictEqual(C.quoteInText('Engineers used riveted steel throughout', PAGE), true);
  });
  t('near-miss (one changed number) is not a match', () => {
    assert.strictEqual(C.quoteInText('spans 530 metres across the harbour', PAGE), false);
  });
  t('near-miss (one changed word) is not a match', () => {
    assert.strictEqual(C.quoteInText('The bridge closed in 1932.', PAGE), false);
  });
  t('punctuation is not stripped (a dropped period-free variant still matches, an added word does not)', () => {
    assert.strictEqual(C.quoteInText('opened in 1932. It carries', PAGE), true);
    assert.strictEqual(C.quoteInText('opened in 1932, it carries', PAGE), false);
  });
  t('quote must not straddle a word boundary', () => {
    assert.strictEqual(C.quoteInText('he bridge opened in', PAGE), false);
    assert.strictEqual(C.quoteInText('across the harbou', PAGE), false);
  });
  t('empty quote never matches', () => {
    assert.strictEqual(C.quoteInText('', PAGE), false);
    assert.strictEqual(C.quoteInText('   ', PAGE), false);
  });

  console.log('\n2) evaluateClaim statuses');
  t('source present and quote found => verified', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across the harbour', source_path: 'src/page.txt' }, { root });
    assert.strictEqual(r.status, 'verified');
  });
  t('source present and quote absent => mismatch', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 530 metres across the harbour', source_path: 'src/page.txt' }, { root });
    assert.strictEqual(r.status, 'mismatch');
    assert.strictEqual(r.reason, 'quote_not_found');
  });
  t('missing source file => unverified (source_missing)', () => {
    const root = freshRoot();
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: 'src/nope.txt' }, { root });
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, 'source_missing');
  });
  t('url only, no saved text => unverified (no_local_source)', () => {
    const root = freshRoot();
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', url: 'https://example.org' }, { root });
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, 'no_local_source');
  });
  t('oversize source => unverified (source_too_large), never read whole', () => {
    const root = freshRoot();
    write(root, 'src/big.txt', 'x '.repeat(600) + 'spans 503 metres across');
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: 'src/big.txt' }, { root, maxBytes: 1000 });
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, 'source_too_large');
  });
  t('source outside the root => unverified (source_outside_root) unless allowed', () => {
    const root = freshRoot();
    const other = freshRoot();
    const outside = write(other, 'page.txt', PAGE);
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: outside }, { root });
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, 'source_outside_root');
    const r2 = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: outside }, { root, allowOutsideSources: true });
    assert.strictEqual(r2.status, 'verified');
  });
  t('relative ../ escape is refused as outside root', () => {
    const root = freshRoot();
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: '../x/page.txt' }, { root });
    assert.strictEqual(r.reason, 'source_outside_root');
  });
  t('quote shorter than 3 words => mismatch (quote_too_short)', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'bridge opened', source_path: 'src/page.txt' }, { root });
    assert.strictEqual(r.status, 'mismatch');
    assert.strictEqual(r.reason, 'quote_too_short');
  });

  console.log('\n3) CLI add / check / report');
  t('add appends a record with claim_id, status and retrieved_at; check rewrites statuses', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    let r = cli(root, ['add', '--run', 'r1', '--claim', 'Bridge is 503 m long', '--quote', 'spans 503 metres across the harbour', '--source', 'src/page.txt', '--source-id', 'S1', '--as-of', '2026-11-01']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /\[c1\] verified/);
    r = cli(root, ['add', '--run', 'r1', '--claim', 'Opened 1933', '--quote', 'The bridge opened in 1933', '--source', 'src/page.txt']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /\[c2\] mismatch/);
    const ledger = path.join(root, '.claude', 'forge-runs', 'r1', 'citations.jsonl');
    const recs = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(recs.length, 2);
    assert.strictEqual(recs[0].claim_id, 'c1');
    assert.strictEqual(recs[0].source_id, 'S1');
    assert.strictEqual(recs[0].retrieved_at, '2026-11-01');
    assert.ok(recs[0].checked_at);
    // change the source so c2 becomes verified, then check
    write(root, 'src/page.txt', PAGE + '\nThe bridge opened in 1933 after delays.');
    r = cli(root, ['check', '--run', 'r1', '--json']);
    assert.strictEqual(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.claims.find((c) => c.claim_id === 'c2').status, 'verified');
    const after = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(after[1].status, 'verified');
  });
  t('add refuses a duplicate --id and a bad --as-of', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    assert.strictEqual(cli(root, ['add', '--run', 'r1', '--id', 'c7', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt']).code, 0);
    assert.strictEqual(cli(root, ['add', '--run', 'r1', '--id', 'c7', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt']).code, 2);
    assert.strictEqual(cli(root, ['add', '--run', 'r1', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt', '--as-of', 'yesterday']).code, 2);
  });
  t('report: all verified => exit 0 with 100%', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    cli(root, ['add', '--run', 'r1', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt']);
    const r = cli(root, ['report', '--run', 'r1', '--json']);
    assert.strictEqual(r.code, 0, r.out + r.err);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.total, 1);
    assert.strictEqual(j.verified, 1);
    assert.strictEqual(j.verified_pct, 100);
  });
  t('report: a mismatch => exit 1', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    cli(root, ['add', '--run', 'r1', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt']);
    cli(root, ['add', '--run', 'r1', '--claim', 'y', '--quote', 'The bridge opened in 1999', '--source', 'src/page.txt']);
    const r = cli(root, ['report', '--run', 'r1', '--json']);
    assert.strictEqual(r.code, 1);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.mismatch, 1);
    assert.strictEqual(j.verified_pct, 50);
  });
  t('report: unverified only => exit 0, but --min-verified unmet => exit 1; no-source claims are listed', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    cli(root, ['add', '--run', 'r1', '--claim', 'x', '--quote', 'The bridge opened in 1932', '--source', 'src/page.txt']);
    cli(root, ['add', '--run', 'r1', '--claim', 'from memory', '--quote', 'some remembered words here']);
    let r = cli(root, ['report', '--run', 'r1', '--json']);
    assert.strictEqual(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.unverified, 1);
    assert.deepStrictEqual(j.without_source, ['c2']);
    r = cli(root, ['report', '--run', 'r1', '--min-verified', '60']);
    assert.strictEqual(r.code, 1);
    r = cli(root, ['report', '--run', 'r1', '--min-verified', '50']);
    assert.strictEqual(r.code, 0);
  });
  t('report on an empty/missing ledger => total 0, exit 0, and --min-verified fails it', () => {
    const root = freshRoot();
    const r = cli(root, ['report', '--run', 'empty', '--json']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(JSON.parse(r.out).total, 0);
    assert.strictEqual(cli(root, ['report', '--run', 'empty', '--min-verified', '1']).code, 1);
  });
  t('a corrupt ledger line is an error (exit 2), not silently skipped', () => {
    const root = freshRoot();
    write(root, 'l.jsonl', '{"claim_id":"c1","claim":"x","quote":"a b c"}\nnot json\n');
    const r = cli(root, ['report', '--ledger', 'l.jsonl']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /line 2/);
  });

  console.log('\n4) label');
  const DRAFT = '# Notes\n\nThe bridge spans 503 m.[^c1] It opened in 1999.[c2] Traffic is heavy.[c3]\n' +
    'Already marked.[c2] [unverified]\n\n```\ncode [c2] stays\n```\n';
  function labelFixture() {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    cli(root, ['add', '--run', 'r1', '--claim', 'a', '--quote', 'spans 503 metres across', '--source', 'src/page.txt']);
    cli(root, ['add', '--run', 'r1', '--claim', 'b', '--quote', 'The bridge opened in 1999', '--source', 'src/page.txt']);
    write(root, 'draft.md', DRAFT);
    return root;
  }
  t('marks mismatch and unknown ids, leaves verified ones, is idempotent, skips code fences', () => {
    const root = labelFixture();
    const r = cli(root, ['label', 'draft.md', '--run', 'r1']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('503 m.[^c1] It'), 'verified c1 untouched');
    assert.ok(r.out.includes('1999.[c2] [unverified]'), 'mismatch c2 marked');
    assert.ok(r.out.includes('heavy.[c3] [unverified]'), 'unknown c3 marked');
    assert.ok(!r.out.includes('[unverified] [unverified]'), 'idempotent on already-marked');
    assert.ok(r.out.includes('code [c2] stays\n'), 'code fence untouched');
    const again = C.labelMarkdown(r.out, new Map([['c1', 'verified'], ['c2', 'mismatch']]));
    assert.strictEqual(again.text, r.out, 'second pass changes nothing');
  });
  t('--write rewrites in place inside root; refuses a target outside root', () => {
    const root = labelFixture();
    const r = cli(root, ['label', 'draft.md', '--run', 'r1', '--write']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(fs.readFileSync(path.join(root, 'draft.md'), 'utf8').includes('1999.[c2] [unverified]'));
    const other = freshRoot();
    const outside = write(other, 'd.md', DRAFT);
    const r2 = cli(root, ['label', outside, '--run', 'r1', '--write']);
    assert.strictEqual(r2.code, 2);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), DRAFT, 'outside file unchanged');
  });

  console.log('\n5) path safety');
  t('a ledger path outside the root is refused (exit 2)', () => {
    const root = freshRoot();
    const other = freshRoot();
    const r = cli(root, ['add', '--ledger', path.join(other, 'c.jsonl'), '--claim', 'x', '--quote', 'a b c']);
    assert.strictEqual(r.code, 2);
    assert.ok(!fs.existsSync(path.join(other, 'c.jsonl')));
  });
  t('a run id with path characters is refused', () => {
    const root = freshRoot();
    assert.strictEqual(cli(root, ['report', '--run', '../evil']).code, 2);
  });
  t('isInside rejects sibling-prefix paths', () => {
    assert.strictEqual(C.isInside('/a/b', '/a/bc/x'), false);
    assert.strictEqual(C.isInside('/a/b', '/a/b/x'), true);
  });
  t('unknown command => exit 2 with usage', () => {
    const root = freshRoot();
    const r = cli(root, ['frobnicate']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /usage/i);
  });

  console.log('\n6) security review fixes (Security Boss, 2026-11-06)');
  // Replace fs methods for one call and record every path they were given.
  function withFsSpy(names, wrap, fn) {
    const orig = {};
    const calls = [];
    for (const n of names) {
      const [obj, key] = n === 'realpathSync.native' ? [fs.realpathSync, 'native'] : [fs, n];
      orig[n] = [obj, key, obj[key]];
      obj[key] = function (...a) { calls.push([n, String(a[0])]); return (wrap[n] || ((f, args) => f.apply(this, args)))(orig[n][2], a); };
    }
    try { return { result: fn(), calls }; } finally { for (const n of names) { const [obj, key, f] = orig[n]; obj[key] = f; } }
  }
  const FS_READS = ['realpathSync.native', 'statSync', 'lstatSync', 'existsSync', 'readFileSync'];
  const isUncArg = (c) => /^(\\\\|\/\/)/.test(c[1]);

  t('M1 label refuses a target outside the root even without --write, prints nothing', () => {
    const root = freshRoot();
    const other = freshRoot();
    const outside = write(other, 'd.md', 'x.[c1]\n');
    const r = cli(root, ['label', outside, '--run', 'r1']);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.out, '');
  });
  t('M1 label refuses secret-shaped names and non-markdown extensions inside the root', () => {
    const root = freshRoot();
    for (const rel of ['.env', '.env.md', 'id_rsa.txt', 'secrets/notes.md', 'notes.json', 'k.pem', '.credentials.json']) {
      write(root, rel, 'x.[c1]\n');
      const r = cli(root, ['label', rel, '--run', 'r1']);
      assert.strictEqual(r.code, 2, rel + ' should be refused');
      assert.strictEqual(r.out, '', rel + ' printed content');
    }
    write(root, 'ok.txt', 'x.[c1]\n');
    assert.strictEqual(cli(root, ['label', 'ok.txt', '--run', 'r1']).code, 0);
  });
  t('M2 UNC/device source paths are refused before any fs call, even with --allow-outside-sources', () => {
    const root = freshRoot();
    for (const p of ['\\\\example.invalid\\s\\x', '//example.invalid/s/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) {
      const { result, calls } = withFsSpy(FS_READS, {}, () =>
        C.evaluateClaim({ claim_id: 'c1', quote: 'a b c d', source_path: p }, { root, allowOutsideSources: true }));
      assert.strictEqual(result.status, 'unverified', p);
      assert.strictEqual(result.reason, 'source_unc_refused', p);
      assert.deepStrictEqual(calls.filter(isUncArg), [], p + ' reached fs');
    }
  });
  t('M2 a UNC ledger path is refused before any fs call', () => {
    const root = freshRoot();
    const { calls } = withFsSpy(FS_READS, {}, () => {
      assert.throws(() => C.ledgerPath(root, { ledger: '\\\\example.invalid\\s\\x.jsonl' }), /UNC|device/i);
    });
    assert.deepStrictEqual(calls.filter(isUncArg), []);
  });
  t('M3 default root is the repo that holds this file, never the home folder', () => {
    assert.strictEqual(C.resolveRoot({ scriptDir: __dirname }), path.resolve(__dirname, '..', '..'));
    const home = freshRoot();
    fs.mkdirSync(path.join(home, '.claude'));
    const proj = path.join(home, 'proj', 'sub');
    fs.mkdirSync(proj, { recursive: true });
    const noForge = freshRoot();
    assert.throws(() => C.resolveRoot({ scriptDir: noForge, cwd: proj, home }), /project root/i);
    fs.mkdirSync(path.join(home, 'proj', '.claude'));
    assert.strictEqual(C.resolveRoot({ scriptDir: noForge, cwd: proj, home }), path.join(home, 'proj'));
  });
  t('M3 --root that is the home folder or a drive root is refused', () => {
    assert.strictEqual(cli(os.homedir(), ['report', '--run', 'r1']).code, 2);
    assert.strictEqual(cli(path.parse(os.tmpdir()).root, ['report', '--run', 'r1']).code, 2);
  });
  t('L1 a realpath error on an existing path is outside, not a walk-up', () => {
    const root = freshRoot();
    write(root, 'locked/page.txt', PAGE);
    const { result } = withFsSpy(['realpathSync.native'], {
      'realpathSync.native': (f, a) => { if (String(a[0]).includes('locked')) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } return f(...a); },
    }, () => C.insideRoot(root, 'locked/page.txt'));
    assert.strictEqual(result, false);
    assert.strictEqual(C.insideRoot(root, 'not/yet/there.jsonl'), true);
  });
  t('L6 an unreadable source (EACCES/EPERM on stat) => unverified (source_unreadable), not source_missing', () => {
    const root = freshRoot();
    write(root, 'locked/page.txt', PAGE);
    for (const code of ['EACCES', 'EPERM']) {
      const { result } = withFsSpy(['statSync'], {
        statSync: (f, a) => { if (String(a[0]).includes('locked')) { const e = new Error('denied'); e.code = code; throw e; } return f(...a); },
      }, () => C.evaluateClaim({ claim_id: 'c1', quote: 'spans 503 metres across', source_path: 'locked/page.txt' }, { root }));
      assert.strictEqual(result.status, 'unverified', code);
      assert.strictEqual(result.reason, 'source_unreadable', code);
    }
  });
  t('L1 writing through a hard-linked ledger is refused', () => {
    const root = freshRoot();
    write(root, 'a.jsonl', '');
    fs.linkSync(path.join(root, 'a.jsonl'), path.join(root, 'b.jsonl'));
    const r = cli(root, ['add', '--ledger', 'b.jsonl', '--claim', 'x', '--quote', 'a b c']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /link/i);
  });
  t('L1 writing through a symlinked ledger is refused (skipped when symlinks need admin)', () => {
    const root = freshRoot();
    write(root, 'real.jsonl', '');
    try { fs.symlinkSync(path.join(root, 'real.jsonl'), path.join(root, 'ln.jsonl'), 'file'); }
    catch (e) { console.log('       (symlink not permitted: ' + e.code + ')'); return 'skip'; }
    assert.strictEqual(cli(root, ['check', '--ledger', 'ln.jsonl']).code, 2);
  });
  t('L1 symlink guard without admin: saveLedger refuses when lstat reports a symbolic link', () => {
    const root = freshRoot();
    const file = write(root, 'l.jsonl', '');
    withFsSpy(['lstatSync'], {
      lstatSync: (f, a) => { const st = f(...a); return path.resolve(String(a[0])) === path.resolve(file) ? Object.assign(Object.create(st), { isSymbolicLink: () => true }) : st; },
    }, () => assert.throws(() => C.saveLedger(file, [{ claim_id: 'c1' }]), /link/i));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '', 'target unchanged');
  });
  t('L2 temp file uses flag wx and a random suffix, and is removed when the rename fails', () => {
    const root = freshRoot();
    const file = path.join(root, 'l.jsonl');
    const { calls } = withFsSpy(['writeFileSync', 'renameSync'], {
      writeFileSync: (f, a) => { assert.strictEqual((a[2] || {}).flag, 'wx'); return f(...a); },
      renameSync: () => { const e = new Error('cross device'); e.code = 'EXDEV'; throw e; },
    }, () => assert.throws(() => C.saveLedger(file, [{ claim_id: 'c1' }]), /cross device/));
    const tmpName = calls.find((c) => c[0] === 'writeFileSync')[1];
    assert.match(path.basename(tmpName), /\.[0-9a-f]{12}\.tmp$/);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
  t('L3 a quote over 1000 characters is a mismatch (quote_too_long)', () => {
    const root = freshRoot();
    write(root, 'src/page.txt', PAGE);
    const r = C.evaluateClaim({ claim_id: 'c1', quote: 'word '.repeat(201), source_path: 'src/page.txt' }, { root });
    assert.strictEqual(r.status, 'mismatch');
    assert.strictEqual(r.reason, 'quote_too_long');
  });
  t('L3 one source shared by many claims is read once per run', () => {
    const root = freshRoot();
    const page = write(root, 'src/page.txt', PAGE);
    const recs = [1, 2, 3].map((i) => ({ claim_id: 'c' + i, quote: 'The bridge opened in 1932', source_path: 'src/page.txt' }));
    const { result, calls } = withFsSpy(['readFileSync'], {}, () => C.checkRecords(recs, { root }));
    assert.ok(result.every((r) => r.status === 'verified'));
    assert.strictEqual(calls.filter((c) => path.resolve(c[1]) === path.resolve(page)).length, 1);
  });
  t('L4 a ledger with a duplicate claim id or a bad id is refused (exit 2)', () => {
    const root = freshRoot();
    write(root, 'dup.jsonl', '{"claim_id":"c1","quote":"a b c"}\n{"claim_id":"c1","quote":"d e f"}\n');
    assert.strictEqual(cli(root, ['report', '--ledger', 'dup.jsonl']).code, 2);
    write(root, 'bad.jsonl', '{"claim_id":"c1\\u001b[31m","quote":"a b c"}\n');
    assert.strictEqual(cli(root, ['report', '--ledger', 'bad.jsonl']).code, 2);
  });
  t('info: Windows reserved names and trailing dot/space are refused in --run, --ledger and label', () => {
    const root = freshRoot();
    assert.strictEqual(cli(root, ['report', '--run', 'NUL']).code, 2);
    assert.strictEqual(cli(root, ['report', '--run', 'run.']).code, 2);
    assert.strictEqual(cli(root, ['report', '--ledger', 'x/CON.jsonl']).code, 2);
    assert.strictEqual(cli(root, ['report', '--ledger', 'x /l.jsonl']).code, 2);
    assert.strictEqual(cli(root, ['label', 'aux.md', '--run', 'r1']).code, 2);
  });
  t('info: isInside treats a "..name" child folder as inside', () => {
    assert.strictEqual(C.isInside('/a', '/a/..foo/x'), true);
    assert.strictEqual(C.isInside('/a', '/a/../b'), false);
  });
  console.log('\n9) refs: offline reference-list check (W2-CITE-MACHINE)');
  const kinds = (r) => r.findings.map((x) => x.kind + ':' + (x.id || '') + '@' + x.line).sort();
  const R = (text) => C.checkRefs(text);
  t('refs: a clean numeric document has no findings', () => {
    const r = R('Claim one [1]. Claims [2, 3] and [1-2].\n\n## References\n[1] A. One. 2020.\n[2] B. Two. 2021.\n[3] C. Three. 2022.\n');
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.references, 3);
    assert.strictEqual(r.markers, 3, 'three marker groups: [1], [2, 3], [1-2]');
  });
  t('refs: undefined marker, unused reference and duplicate id carry line numbers', () => {
    const r = R('Text [1] and [4].\n\n## Sources\n[1] One.\n[2] Two.\n[1] One again.\n');
    assert.deepStrictEqual(kinds(r), ['duplicate_reference:1@6', 'undefined_marker:4@1', 'unused_reference:2@5']);
  });
  t('refs: a range [2-4] and a list [1, 3] expand to each id', () => {
    const r = R('See [2-4] and [1, 3].\n\n## Bronnen\n1. One\n2. Two\n3. Three\n4. Four\n');
    assert.deepStrictEqual(r.findings, []);
    const r2 = R('See [2–5].\n\n## References\n[2] a\n[3] b\n[4] c\n');
    assert.deepStrictEqual(kinds(r2), ['undefined_marker:5@1']);
  });
  t('refs: footnotes [^id] are checked both ways, also without a references heading', () => {
    const r = R('A claim[^smith]. Another[^gone].\n\n[^smith]: Smith, 2024.\n[^extra]: Never cited.\n');
    assert.deepStrictEqual(kinds(r), ['undefined_marker:gone@1', 'unused_reference:extra@4']);
  });
  t('refs: author-year (Smith 2024), (Garcia et al. 2023; Jones & Lee 2021) against an author-year list', () => {
    const r = R('As shown (Smith 2024). Also (Garcia et al. 2023; Jones & Lee 2021). And (Brown 2019).\n\n## References\n- Smith, J. (2024). A title.\n- Garcia, M., Ruiz, P. (2023). Another.\n- Jones, A. and Lee, B. (2021). Third.\n- Unused, U. (2020). Fourth.\n');
    assert.deepStrictEqual(kinds(r), ['undefined_marker:brown 2019@1', 'unused_reference:unused 2020@7']);
  });
  t('refs: a parenthetical like (Q3 2024) or (Windows 2024) is not an author-year marker without an author-year list', () => {
    assert.deepStrictEqual(R('Shipped (Q3 2024) on (Windows 2024).\n').findings, []);
  });
  t('refs: markers in fenced code, inline code, links [1](url) and indexes arr[1] are ignored', () => {
    const r = R('Use `x[9]` and arr[7] and [5](https://e.org).\n```\nfoo[8]\n[6] not a ref\n```\nReal [1].\n\n## References\n[1] One.\n');
    assert.deepStrictEqual(r.findings, []);
  });
  t('refs: a reference-style link [text][2] counts as a use of [2]', () => {
    const r = R('See [the paper][2] and [1].\n\n## References\n[1]: https://a.example\n[2]: https://b.example\n');
    assert.deepStrictEqual(r.findings, []);
  });
  t('refs: numeric markers with no reference list at all is one no_reference_list finding', () => {
    const r = R('Claim [1]. Claim [2].\n');
    assert.deepStrictEqual(kinds(r), ['no_reference_list:@1']);
  });
  t('refs replay: a bracketed year in a table cell ("Set Up Claude Code [2026]") is not a citation marker', () => {
    assert.deepStrictEqual(R('| 150 | How To Set Up Claude Code [2026] | ok |\n').findings, []);
    const r = R('Text [2026] and [1].\n\n## References\n[1] One.\n[2026] A reference really numbered 2026.\n');
    assert.deepStrictEqual(r.findings, [], 'a defined [2026] still counts as used');
    assert.deepStrictEqual(kinds(R('Text [1] and [3].\n\n## References\n[1] One.\n')), ['undefined_marker:3@1'], 'small numbers are still checked');
  });
  t('refs replay: an interval "in [0,1]" and one lone JSON array [31,15,46,4,6] are not a citation style', () => {
    assert.deepStrictEqual(R('A score (a number in [0,1]) is used.\n').findings, []);
    assert.deepStrictEqual(R('"summary": "Tests: [31,15,46,4,6] for the stream and [18,3,10,2] for the rest"\n').findings, []);
    assert.deepStrictEqual(kinds(R('See [0, 1] and [2].\n\n## References\n[1] a\n')), ['undefined_marker:2@1', 'unused_reference:1@4'], 'only the [0, ..] group is skipped');
    assert.deepStrictEqual(kinds(R('Unsorted [3, 1] still cites.\n\n## References\n[1] a\n[2] b\n[3] c\n')), ['unused_reference:2@5'], 'an unsorted list is still a use when a list exists');
    assert.deepStrictEqual(kinds(R('Claim [1, 2]. Claim [3].\n')), ['no_reference_list:@1'], 'sorted groups still signal a citation style');
  });
  t('refs: a plain sources list with no markers anywhere is clean (a list, not a citation style)', () => {
    const r = R('Some text.\n\n## Sources\n1. https://a.example\n2. https://b.example\n- https://c.example\n');
    assert.deepStrictEqual(r.findings, []);
  });
  t('refs: the same DOI under two ids is a duplicate_work finding', () => {
    const r = R('A [1] B [2].\n\n## References\n[1] X. https://doi.org/10.1234/abc\n[2] X again. doi:10.1234/ABC\n');
    assert.deepStrictEqual(kinds(r), ['duplicate_work:2@5']);
  });
  t('refs: the heading section ends at the next heading of the same level', () => {
    const r = R('## References\n[1] One.\n\n## Appendix\nCites [1] and [2].\n');
    assert.deepStrictEqual(kinds(r), ['undefined_marker:2@5']);
  });

  console.log('\n10) refs: DOI and arXiv form');
  t('refs: valid DOIs (raw, doi:, https://doi.org/, with parentheses) pass', () => {
    const r = R('A 10.1000/xyz123 b doi:10.12345678/abc-def c https://doi.org/10.1016/S0140-6736(20)30183-5 d (https://doi.org/10.1145/3290605.3300857)\n');
    assert.deepStrictEqual(r.findings, []);
  });
  t('refs: malformed DOIs are findings: short registrant, no suffix, trailing punctuation', () => {
    const r = R('A doi:10.12/abc\nB https://doi.org/10.1234\nC see 10.1234/abc.\nD doi:10.1234/abc;\n');
    assert.deepStrictEqual(r.findings.map((x) => x.kind + '@' + x.line), ['malformed_doi@1', 'malformed_doi@2', 'malformed_doi@3', 'malformed_doi@4']);
    assert.match(r.findings[2].detail, /trailing/);
  });
  t('refs replay: "the Semantic Scholar Graph API (DOI:…)" is prose, not a malformed DOI; "DOI: 10.12/x" still is', () => {
    assert.deepStrictEqual(R('the Semantic Scholar Graph API (DOI:…) is a fallback\n').findings, []);
    assert.deepStrictEqual(R('DOI: 10.12/x\n').findings.map((x) => x.kind), ['malformed_doi']);
  });
  t('refs: a version number like 10.5 or 10.15.7 is not taken for a DOI', () => {
    assert.deepStrictEqual(R('Node 10.5 and macOS 10.15.7 and 10.1 percent.\n').findings, []);
  });
  t('refs: valid arXiv ids pass (new style with vN, 4-digit old numbering, old style archive/YYMMNNN, pdf url)', () => {
    const r = R('arXiv:2401.01234 and arXiv:2401.01234v2 and https://arxiv.org/abs/0704.0001 and arXiv:hep-th/9901001 and arXiv:math.GT/0309136 and https://arxiv.org/pdf/2312.12345v1.pdf\n');
    assert.deepStrictEqual(r.findings, []);
  });
  t('refs replay: "arXiv 2601.15808" (space, no colon) is checked; "arXiv papers" is not an id', () => {
    assert.deepStrictEqual(R('DeepVerifier, arXiv 2601.15808 ACL-2026. Many arXiv papers.\n').findings, []);
    assert.deepStrictEqual(R('see arXiv 2613.15808\n').findings.map((x) => x.kind), ['malformed_arxiv']);
  });
  t('refs replay (mutation of a real report): arXiv:2509.2514 (4 digits after 1501) and 1201.12345 (5 before) are malformed', () => {
    const r = R('paper arXiv:2509.2514\nold arXiv:1201.12345\nfirst arXiv:0703.0001\nok arXiv:1412.1234 and arXiv:1501.00001\n');
    assert.deepStrictEqual(r.findings.map((x) => x.kind + '@' + x.line), ['malformed_arxiv@1', 'malformed_arxiv@2', 'malformed_arxiv@3']);
  });
  t('refs: malformed arXiv ids are findings (month 13, too few digits, old style too short)', () => {
    const r = R('arXiv:2413.01234\nhttps://arxiv.org/abs/2401.123\narXiv:hep-th/99010\n');
    assert.deepStrictEqual(r.findings.map((x) => x.kind + '@' + x.line), ['malformed_arxiv@1', 'malformed_arxiv@2', 'malformed_arxiv@3']);
  });

  console.log('\n11) refs CLI: exit codes, --json, safety');
  t('refs CLI: exit 0 on a clean file, 1 with findings, --json lists them; no ledger flag needed', () => {
    const root = freshRoot();
    write(root, 'ok.md', 'A [1].\n\n## References\n[1] One.\n');
    write(root, 'bad.md', 'A [2].\n\n## References\n[1] One.\n');
    const ok = cli(root, ['refs', 'ok.md']);
    assert.strictEqual(ok.code, 0, ok.err);
    assert.match(ok.out, /PASS/);
    const bad = cli(root, ['refs', 'bad.md', '--json']);
    assert.strictEqual(bad.code, 1, bad.err);
    const j = JSON.parse(bad.out);
    assert.strictEqual(j.pass, false);
    assert.deepStrictEqual(j.findings.map((x) => x.kind).sort(), ['undefined_marker', 'unused_reference']);
    assert.strictEqual(j.findings.find((x) => x.kind === 'undefined_marker').line, 1);
  });
  t('refs CLI: usage and refused input exit 2 (no file, missing file, outside root, UNC, wrong extension, secret name, reserved name)', () => {
    const root = freshRoot();
    const outside = freshRoot();
    write(outside, 'x.md', 'A [1].\n');
    write(root, 'notes.json', '{}');
    write(root, 'secrets/r.md', 'A');
    assert.strictEqual(cli(root, ['refs']).code, 2);
    assert.strictEqual(cli(root, ['refs', 'missing.md']).code, 2);
    assert.strictEqual(cli(root, ['refs', path.join(outside, 'x.md')]).code, 2);
    assert.strictEqual(cli(root, ['refs', '\\\\host\\share\\r.md']).code, 2);
    assert.strictEqual(cli(root, ['refs', 'notes.json']).code, 2);
    assert.strictEqual(cli(root, ['refs', 'secrets/r.md']).code, 2);
    assert.strictEqual(cli(root, ['refs', 'CON.md']).code, 2);
  });
  t('refs CLI: a file over the size cap is refused (exit 2) and refs never writes', () => {
    const root = freshRoot();
    write(root, 'big.md', 'x'.repeat(5 * 1024 * 1024 + 1));
    assert.strictEqual(cli(root, ['refs', 'big.md']).code, 2);
    const f = write(root, 'r.md', 'A [3].\n\n## References\n[1] One.\n');
    const before = fs.readFileSync(f, 'utf8');
    assert.strictEqual(cli(root, ['refs', 'r.md']).code, 1);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['big.md', 'r.md']);
  });
  t('refs CLI: a UNC target is refused before any fs call', () => {
    const root = freshRoot();
    const io = { out: () => {}, err: () => {} };
    const { result, calls } = withFsSpy(FS_READS, {}, () => C.main(['refs', '\\\\evil-host\\share\\r.md', '--root', root], io));
    assert.strictEqual(result, 2);
    assert.ok(!calls.some((c) => /evil-host/.test(c[1])), 'no fs call saw the UNC path');
  });
  t('refs CLI: --help exits 0 and says it never fetches anything', () => {
    const r = spawnSync(process.execPath, [CLI, 'refs', '--help'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /never fetches/i);
  });
} finally {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.log('  cleanup warning: ' + e.message); } }
}

if (skipped) console.log(`\n${skipped} skipped (environment)`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
