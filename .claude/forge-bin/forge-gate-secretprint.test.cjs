#!/usr/bin/env node
'use strict';
// forge-gate-secretprint.test.cjs — (2026-09-27, independent Codex review of the integration,
// findings F1/F2). Dedicated coverage for the secret-print command gate beyond hard-gates.json's own
// examples.match/no_match (already swept by forge-actiongate.test.cjs section 1):
//
//   F1  the grep-family `-o`/`--only-matching` exemption was UNSOUND (`grep -o '.*' .env` kept the flag while
//       still printing the whole line) and has been removed entirely; the sanctioned replacement is the
//       dedicated helper forge-env-names.cjs, which must never itself trip this gate.
//   F2  git content-display (`git show <rev>:<secret>`, `git show <rev> -- <secret>`,
//       `git cat-file -p/--textconv/--filters <rev>:<secret>`), common credential filenames beyond
//       `.env`/keys/`.claude/.credentials.json` (`credentials.json`, `service-account*.json`, `*.p12`/`*.pfx`,
//       `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.docker/config.json`, `.aws/credentials`), and
//       `find`/`xargs` indirection (`-exec`, and the piped `| xargs` form via a NEW pattern_line) all used to
//       bypass the gate entirely.
//
// This file also proves (as promised in hard-gates.json's secret-print `_gate_coverage_note`) that a
// representative sample of settings.json's permissions.deny list and this gate's own target list stay in
// sync, and that the gate's quote-mask protection (a search tool's own quoted MENTION of a dangerous shape)
// still holds for the new find/xargs pattern_line, through a REAL spawned hook process — never a probe string
// placed on this test's own command line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const gate = require('./forge-actiongate.cjs');
const hook = require('./forge-gate-hook.cjs');
const data = require('./forge-gate-data.cjs');
const quotes = require('./forge-gate-quotes.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-gate-secretprint tests (WP-K1: secret-print F1 -o removal, F2 git-show/credentials/find-xargs)');

// ---------------------------------------------------------------------------
// 1) F1 — the -o/--only-matching exemption is gone; a raw classify() call now catches it
// ---------------------------------------------------------------------------
console.log('\n1) F1 — grep -o/--only-matching no longer exempts a secret target');

for (const cmd of ["grep -o '^[A-Z_]*=' .env", "grep -io '^[a-z_]*=' .env", "rg --only-matching '^[A-Z_]*=' .env", "grep -o '.*' .env"]) {
  t('classify() now fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), 'expected secret-print in ' + JSON.stringify(gate.classify(cmd).matched));
  });
}

// ---------------------------------------------------------------------------
// 2) F1 — the sanctioned replacement never trips the gate, and does what it promises
// ---------------------------------------------------------------------------
console.log('\n2) F1 — forge-env-names.cjs is the safe replacement');

t('classify() stays silent for the helper\'s own command line against a real .env target', () => {
  assert.strictEqual(gate.classify('node .claude/forge-bin/forge-env-names.cjs .env').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('node .claude/forge-bin/forge-env-names.cjs .env --json').matched.includes('secret-print'), false);
});

const ENV_NAMES = require('./forge-env-names.cjs');
t('forge-env-names.cjs never returns or logs a value, only names, even for malformed lines', () => {
  const sample = ['# comment', 'DATABASE_URL=postgres://user:pass@host/db', 'export API_KEY=sk-secret',
    '  SPACED = value with spaces', '', 'not a valid line', '123BAD=nope', 'KEY-WITH-DASH=nope', '=novalue',
    'LAST_ONE=final'].join('\n');
  const names = ENV_NAMES.envNames(sample);
  assert.deepStrictEqual(names, ['DATABASE_URL', 'API_KEY', 'SPACED', 'LAST_ONE']);
  for (const n of names) assert.ok(!/secret|pass|http/i.test(n), 'a value leaked into the name list: ' + n);
});

// ---------------------------------------------------------------------------
// 3) F2a — git show / git cat-file content reveal
// ---------------------------------------------------------------------------
console.log('\n3) F2a — git show / git cat-file content-display of a secret path');

for (const cmd of ['git show HEAD:.env', 'git show HEAD -- .env', 'git show origin/main:.env',
  'git -C /repo show HEAD:.env', 'git cat-file -p HEAD:.env', 'git cat-file --textconv HEAD:.env',
  'git cat-file --filters HEAD:secrets/api.json']) {
  t('classify() fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['git show HEAD~1:src/app.js', 'git show --stat HEAD', 'git show HEAD -- src/app.js',
  'git cat-file -t HEAD:src/app.js', 'git cat-file -s HEAD:src/app.js', 'git log --stat -- .env', 'git log --oneline -- .env',
  'git diff --stat -- .env', 'git diff --name-only -- .env', 'git diff -- .env.example', 'git log -p -- src/app.js']) {
  t('classify() stays silent: ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// Codex stop-gate K1-01: patch-producing git commands on a secret path fire; metadata-only forms stay allowed.
for (const cmd of ['git log -p -- .env', 'git log --patch -- .env.local', 'git log -L 1,5:.env', 'git diff -- .env',
  'git diff HEAD~1 .env', 'git diff --cached .env.production', 'git blame .env', 'git annotate secrets/api.json',
  'git whatchanged -p -- .env']) {
  t('classify() fires secret-print (patch of a secret path): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}

// ---------------------------------------------------------------------------
// 4) F2b — common credential filenames beyond .env/keys/.claude/.credentials.json
// ---------------------------------------------------------------------------
console.log('\n4) F2b — credentials.json, service-account*.json, .p12/.pfx, .npmrc/.pypirc/.netrc, .git-credentials, .docker/config.json, .aws/credentials');

for (const cmd of ['cat credentials.json', 'cat my-credentials-backup.json', 'type service-account-key.json',
  'Get-Content backup.p12', 'cat cert.pfx', 'cat .npmrc', 'cat .pypirc', 'cat .netrc', 'cat .git-credentials',
  'cat .docker/config.json', 'cat .aws/credentials', 'type .aws\\credentials']) {
  t('classify() fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() stays silent for an unrelated .json file', () => {
  assert.strictEqual(gate.classify('cat package.json').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('cat tsconfig.json').matched.includes('secret-print'), false);
});

// ---------------------------------------------------------------------------
// 5) F2c — find -exec / find | xargs indirection (target named before the reader)
// ---------------------------------------------------------------------------
console.log('\n5) F2c — find -exec/xargs naming a secret target before the reader verb');

t('classify() fires secret-print for a find -exec clause', () => {
  assert.ok(gate.classify('find . -name .env -exec cat {} \\;').matched.includes('secret-print'));
});
t('classify() fires secret-print for the piped find | xargs form (via pattern_line)', () => {
  assert.ok(gate.classify('find . -name .env -print0 | xargs -0 cat').matched.includes('secret-print'));
  assert.ok(gate.classify('find . -iname .env | xargs cat').matched.includes('secret-print'));
});
t('classify() stays silent for find without a reader, or without a secret target', () => {
  assert.strictEqual(gate.classify('find . -name .env').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify("find . -name '*.js' -exec echo {} \\;").matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('find . -name "*.log" -print0 | xargs -0 wc -l').matched.includes('secret-print'), false);
});

// ---------------------------------------------------------------------------
// 6) settings.json permissions.deny stays in sync with a representative sample of this gate's target list
//    (promised by hard-gates.json's secret-print _gate_coverage_note)
// ---------------------------------------------------------------------------
console.log('\n6) settings.json permissions.deny cross-check');

const SETTINGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const DENY = SETTINGS.permissions && SETTINGS.permissions.deny || [];
t('settings.json denies Read of the classic secret shapes this gate also blocks at the shell-command level', () => {
  for (const shape of ['.env', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'secrets/**']) {
    assert.ok(DENY.some((d) => d.includes(shape)), 'settings.json permissions.deny no longer mentions ' + shape);
  }
});
t('every classic Read-denied shape still has a live secret-print command-level match', () => {
  const probes = { '.env': 'cat .env', '*.pem': 'cat x.pem', '*.key': 'cat x.key', 'id_rsa*': 'cat id_rsa',
    'id_ed25519*': 'cat id_ed25519', 'secrets/**': 'cat secrets/x.txt' };
  for (const [shape, cmd] of Object.entries(probes)) {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), shape + ' -> ' + cmd + ' no longer fires secret-print');
  }
});

// ---------------------------------------------------------------------------
// 7) end-to-end — real spawned forge-gate-hook.cjs process (never a probe string on this test's own argv)
// ---------------------------------------------------------------------------
console.log('\n7) end-to-end — real spawned forge-gate-hook.cjs process');

const HOOK = path.join(__dirname, 'forge-gate-hook.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-secretprint-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'project');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
function envFor() { return Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: PROJ }); }
function spawnHook(input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: envFor(), timeout: 15000 });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

t('spawned hook BLOCKS (exit 2, names secret-print): cat .aws/credentials', () => {
  const r = spawnHook(bash('cat .aws/credentials'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): git show HEAD:.env', () => {
  const r = spawnHook(bash('git show HEAD:.env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): find . -name .env -print0 | xargs -0 cat', () => {
  const r = spawnHook(bash('find . -name .env -print0 | xargs -0 cat'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): the dedicated helper reading .env by name only', () => {
  const r = spawnHook(bash('node .claude/forge-bin/forge-env-names.cjs .env'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): a search tool merely quoting the find/xargs shape as its own pattern data', () => {
  const r = spawnHook(bash('grep -rn "find . -name .env -print0 | xargs -0 cat" docs'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): .env.example stays readable', () => {
  const r = spawnHook(bash('cat .env.example'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): ls/test -f/git status/diff --stat/git ls-files stay allowed', () => {
  for (const cmd of ['ls .env', 'test -f .env', 'git status', 'git diff --stat', 'git ls-files']) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
});

// ---------------------------------------------------------------------------
// 8) N1 (independent Codex verification review) — git show/diff metadata-only forms are
// false positives. git show gains the same content-suppressing-option exemption git diff already had;
// git diff's own list also gains --raw, which had been missed.
// ---------------------------------------------------------------------------
console.log('\n8) N1 — git show/diff metadata-only forms (--name-only, --stat, --raw, -s, ...) stay silent');

const GIT_SHOW_ALLOWED_FLAGS = ['--name-only', '--name-status', '--stat', '--numstat', '--shortstat', '--summary', '--raw', '--no-patch', '-s'];
for (const flag of GIT_SHOW_ALLOWED_FLAGS) {
  const cmd = 'git show ' + flag + ' HEAD -- .env';
  t('classify() stays silent (git show ' + flag + '): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('classify() stays silent: git diff --raw -- .env', () => {
  assert.strictEqual(gate.classify('git diff --raw -- .env').matched.includes('secret-print'), false);
});
// COUNTEREXAMPLE, deliberately NOT exempted: `git diff --check` prints the offending lines THEMSELVES
// (e.g. "path/.env:3: trailing whitespace." followed by the actual "+DB_PASSWORD=..." content line) — it is
// a real content reveal, not a metadata-only summary, so it must stay blocked exactly like a plain
// `git diff -- .env` does. This pins the negative space: adding a flag to the exemption list is only safe
// when that flag genuinely never prints file content, and --check is the reminder of why that matters.
t('classify() still fires (git diff --check prints the offending lines themselves, not just metadata): git diff --check -- .env', () => {
  assert.ok(gate.classify('git diff --check -- .env').matched.includes('secret-print'));
});
t('end to end: the spawned hook allows every git show/diff metadata-only form and still blocks git diff --check', () => {
  for (const flag of GIT_SHOW_ALLOWED_FLAGS) {
    const cmd = 'git show ' + flag + ' HEAD -- .env';
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
  const rawR = spawnHook(bash('git diff --raw -- .env'));
  assert.strictEqual(rawR.status, 0, 'git diff --raw -- .env -> exit ' + rawR.status + ', stderr: ' + rawR.stderr);
  const checkR = spawnHook(bash('git diff --check -- .env'));
  assert.strictEqual(checkR.status, 2, 'git diff --check -- .env -> exit ' + checkR.status + ', stderr: ' + checkR.stderr);
  assert.ok(checkR.stderr.includes('secret-print'), checkR.stderr);
});

// Fixing the above surfaced a SEPARATE, pre-existing collision (see the gate's own _pattern_doc, "
// follow-up"): the plain reader-verb arm's `head` alternative is case-insensitive like the rest of this
// pattern, so it also matched git's own literal revision name "HEAD" — the show-specific exemption alone
// was not enough, because a DIFFERENT arm fired on "HEAD" regardless of which flag was present. Without the
// negative-lookbehind fix, EVERY assertion above with a literal "HEAD" in the command would still fail.
t('the head/HEAD collision is closed: a genuine standalone "head .env" still fires, "git ... HEAD ... .env" never fires via that arm', () => {
  assert.ok(gate.classify('head .env').matched.includes('secret-print'), 'a real head command must still be caught');
  assert.strictEqual(gate.classify('git show --name-only HEAD -- .env').matched.includes('secret-print'), false);
  assert.ok(gate.classify('git show HEAD -- .env').matched.includes('secret-print'), 'the show arm itself must still fire without an exemption flag');
});

// ---------------------------------------------------------------------------
// 9) (independent review + the Lead's own live use of the gate) — a search tool's own
//    PATTERN argument (grep/egrep/fgrep/rg/Select-String/sls/findstr) must never fire this gate merely
//    because it CONTAINS a secret-shaped substring; only a FILE argument may.
// ---------------------------------------------------------------------------
console.log('\n9) WP-M1 — secret-print no longer fires on a search tool\'s own PATTERN argument');

// 9a — the task's own 5 must-ALLOW examples, proven at the raw classify() level (not merely via the separate
// forge-gate-data.cjs pre-classify stripping pass — see 9d below for that layer's own coverage).
for (const cmd of ['grep -rn "\\.env" src/', 'git ls-files | grep -i "\\.env"', 'rg -l "DATABASE_URL|\\.env" .',
  'Select-String -Pattern "\\.env" -Path src\\*.js', 'findstr /s ".env" *.js']) {
  t('classify() stays silent (pattern argument, not a file): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
// 9b — the task's own 6 must-BLOCK examples stay blocked (unchanged behaviour, pinned against regression).
for (const cmd of ['grep -i SECRET .env', 'grep -e x .env.local', 'rg API_KEY .env.production',
  'Select-String -Path .env -Pattern x', 'findstr x .env', "grep -o '.*' .env"]) {
  t('classify() still fires (a real file target): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
// 9c — the classifier-level fix also covers shapes the task's own examples never quoted: an UNQUOTED pattern,
// and the grep-family's --regexp=/--file= ATTACHED flag form.
t('classify() stays silent for an UNQUOTED pattern argument (no data-stripping layer to lean on)', () => {
  assert.strictEqual(gate.classify('grep -rn .env src/').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('findstr .env *.js').matched.includes('secret-print'), false);
});
t('classify() stays silent for the --regexp= attached flag form (a pattern)', () => {
  assert.strictEqual(gate.classify("rg --regexp=.env src/").matched.includes('secret-print'), false);
});
// (Lead): --file= NAMES A FILE the tool reads, so a secret file there must fire.
t('classify() fires for the --file= attached flag form naming a secret file', () => {
  assert.strictEqual(gate.classify("grep --file=.env notes.txt").matched.includes('secret-print'), true);
});
// 9d — the DANGEROUS direction this fix also closes: quoting a real secret FILE target must never exempt it,
// whether the pattern comes from an explicit -e/flag or the implicit first-positional fallback, and whether
// or not forge-gate-data.cjs's own pre-classify stripping runs first (proven end-to-end via the real spawned
// hook, never merely via classify() on text this test typed unstripped).
for (const cmd of ["grep API_KEY '.env'", "grep -e SECRET '.env'", "Select-String -Pattern x -Path '.env'"]) {
  t('classify() fires for a QUOTED secret file target (quoting must never exempt a real file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('end to end: the spawned hook still BLOCKS a quoted secret FILE target (forge-gate-data.cjs no longer erases it)', () => {
  const r = spawnHook(bash("grep API_KEY '.env'"));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('end to end: the spawned hook ALLOWS every one of the 5 task examples (full pipeline, not just classify())', () => {
  for (const cmd of ['grep -rn "\\.env" src/', 'rg -l "DATABASE_URL|\\.env" .', 'findstr /s ".env" *.js']) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
  const ps = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Select-String -Pattern "\\.env" -Path src\\*.js' } }),
    encoding: 'utf8', env: envFor(), timeout: 15000,
  });
  assert.strictEqual(ps.status, 0, 'exit ' + ps.status + ', stderr: ' + ps.stderr);
});
// 9e — forge-gate-data.cjs's own narrowed pre-classify stripping, tested directly (unit-level, not just via
// the spawned hook above): it now only ever picks the recognised PATTERN word(s), never a FILE argument, even
// when the file argument happens to be quoted.
t('forge-gate-data.cjs::searchPatternWords() only ever names the PATTERN word, never a quoted FILE argument', () => {
  const segs = data.scanWords("grep API_KEY '.env'", 'Bash');
  const ws = segs[0].words;
  const picked = data.searchPatternWords('grep', ws);
  assert.strictEqual(picked.size, 1);
  assert.ok(picked.has(ws[1]), 'API_KEY (the implicit positional pattern) must be picked');
  assert.ok(!picked.has(ws[2]), '\'.env\' (the quoted FILE target) must NOT be picked');
});
t('forge-gate-data.cjs::stripInertData() leaves a quoted secret FILE target intact, but still strips a quoted pattern', () => {
  const r = data.stripInertData("grep 'API_KEY' '.env'", 'Bash');
  assert.strictEqual(r.text, "grep '' '.env'", 'the pattern is stripped, the file target is not');
});
t('forge-gate-data.cjs::stripInertData() strips nothing at all when the (implicit-positional) pattern is unquoted — nothing whole-quoted to strip', () => {
  const r = data.stripInertData("grep API_KEY '.env'", 'Bash');
  assert.strictEqual(r.text, "grep API_KEY '.env'", 'unquoted words are never stripped; classify() itself handles this case (see 9c)');
});
t('Select-String never gets an implicit positional pattern from forge-gate-data.cjs either (deliberately no fallback)', () => {
  const segs = data.scanWords("Select-String -Path .env", 'PowerShell');
  const picked = data.searchPatternWords('select-string', segs[0].words);
  assert.strictEqual(picked.size, 0);
});

// ---------------------------------------------------------------------------
// 10) (Codex stop-gate review of) — F1: the search-tool head must be resolved ONLY at
//     the segment's true command position (never found by scanning every word for a matching name); F2:
//     -e/--regexp/-f/--file flag detection AND the implicit positional-pattern fallback must both stop at a
//     standalone `--`, in both the classifier (this file) and the pre-classify stripping layer (gate-data.cjs).
// ---------------------------------------------------------------------------
console.log('\n10) WP-M2 — F1 command-position-only head, F2 -- (end of options) boundary');

// 10a — F1: a search-tool NAME appearing later in the segment must never exempt the REAL leading reader verb.
for (const cmd of ['cat grep .env', 'type rg .env', 'head findstr .env.local']) {
  t('classify() still fires (F1: a search-tool name later in the segment must not exempt the real leading verb): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() still fires across a `;`-separated segment too: echo grep; cat .env', () => {
  assert.ok(gate.classify('echo grep; cat .env').matched.includes('secret-print'));
});

// 10b — F2: option parsing stops at a standalone `--`. A `-e`/`-f` flag AFTER `--` is a literal pattern, not a
// flag, so what follows it is still a plain FILE argument.
for (const cmd of ['grep -- -e .env', 'grep -- TOKEN .env', 'rg -- -e .env.production', 'grep -e x -- .env']) {
  t('classify() fires (F2: -- ends OPTION parsing; a word after it is a plain FILE unless it is the positional pattern): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -rn -- "\\.env" src/', 'grep -rn "\\.env" src/']) {
  t('classify() stays silent (F2 negative space: a real pattern before/after -- is still just the pattern): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// 10c — F1: the ONLY wrapper commands the head resolver looks past are sudo/command/builtin/env — names
// forge-gate-quotes.cjs's own matchWrapper()/stripWrapperOptions() already resolves, including each wrapper's
// OWN flags (sudo's `-u root`, env's own `FOO=bar` assignment), never a naive `/^sudo\s+/`.
for (const cmd of ['sudo grep -rn "\\.env" src/', 'sudo -u root grep -rn "\\.env" src/', 'env grep -rn "\\.env" src/',
  'env FOO=bar grep -rn "\\.env" src/', 'command grep -rn "\\.env" src/', 'builtin grep -rn "\\.env" src/',
  'FOO=1 grep -rn "\\.env" src/']) {
  t('classify() stays silent (F1: a recognised wrapper/env-assignment in front of a real search tool is still just a pattern): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
for (const cmd of ['sudo cat .env', 'env cat .env', 'command grep SECRET .env']) {
  t('classify() still fires (a wrapper never turns a REAL reader/file target into an exempt pattern): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() still fires for a wrapper OUTSIDE the narrow allow-list (deliberately conservative, not a gap)', () => {
  // "timeout" is a real wrapper name forge-gate-quotes.cjs knows, but it is NOT in SEARCH_TOOL_WRAPPER_NAMES —
  // the safe direction is to keep blocking rather than silently widen the exemption to every wrapper shape.
  assert.ok(gate.classify('timeout 5 grep -rn "\\.env" src/').matched.includes('secret-print'));
});

// 10d — direct unit coverage of the two new exported helpers.
t('resolveSearchToolHead() resolves past sudo/env/command/builtin and their own flags, never past an unlisted wrapper', () => {
  assert.strictEqual(gate.resolveSearchToolHead('sudo -u root grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('env FOO=bar grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('command grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('builtin grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('FOO=1 grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('timeout 5 grep x').rest, 'timeout 5 grep x');
  assert.strictEqual(gate.resolveSearchToolHead('cat grep x').rest, 'cat grep x');
});
t('SEARCH_TOOL_WRAPPER_NAMES is exactly the four documented wrapper names', () => {
  assert.deepStrictEqual([...gate.SEARCH_TOOL_WRAPPER_NAMES].sort(), ['builtin', 'command', 'env', 'sudo']);
});

// 10e — forge-gate-data.cjs's own searchPatternWords() must apply the SAME -- boundary (the pre-classify
// stripping layer, so a real secret FILE argument after -- is never erased as if it were inert pattern data).
t('forge-gate-data.cjs::searchPatternWords() never picks a FILE positioned after -- as the pattern, even when the explicit flag itself sits after --', () => {
  const segs = data.scanWords("grep -- -e '.env'", 'Bash');
  const ws = segs[0].words;
  const picked = data.searchPatternWords('grep', ws);
  assert.strictEqual(picked.size, 1);
  assert.ok(picked.has(ws[2]), '"-e" (the literal pattern text right after --) must be picked');
  assert.ok(!picked.has(ws[3]), "'.env' (the real FILE after --) must NOT be picked");
});
t('forge-gate-data.cjs::stripInertData() leaves a quoted secret FILE target after -- intact', () => {
  const r = data.stripInertData("grep -- -e '.env'", 'Bash');
  assert.strictEqual(r.text, "grep -- -e '.env'", 'nothing quoted here is the pattern position, so nothing is stripped');
});

// 10f — end-to-end, the real spawned hook, for a representative subset of the above (never a probe string on
// this test's own command line — the same convention section 7 already established).
t('spawned hook BLOCKS (exit 2, names secret-print): cat grep .env', () => {
  const r = spawnHook(bash('cat grep .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep -- -e .env', () => {
  const r = spawnHook(bash('grep -- -e .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): grep -rn -- "\\.env" src/ (pattern after --, real file elsewhere)', () => {
  const r = spawnHook(bash('grep -rn -- "\\.env" src/'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): sudo grep with a pattern-position secret mention', () => {
  const r = spawnHook(bash('sudo grep -rn "\\.env" src/'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook BLOCKS (exit 2): sudo cat .env (a wrapper never exempts a real reader command)', () => {
  const r = spawnHook(bash('sudo cat .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 11) (Lead, adversarial probe): -f/--file NAMES A FILE the tool reads (its patterns). It still
// marks "a pattern was given explicitly" (every remaining positional is a file) but its value is never exempted.
console.log('\n11) grep/rg -f/--file: the pattern-source file is a file target');
for (const cmd of ['grep -f .env config.txt', 'grep -o -f .env notes.txt', 'grep --file=.env notes.txt', 'rg -f .env.local src']) {
  t('classify() fires secret-print (-f names the secret file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -f patterns.txt -rn src/', 'grep -e "\\.env" -f patterns.txt src/', 'grep --file=patterns.txt src/']) {
  t('classify() stays silent (-f names a non-secret file): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): grep -o -f .env notes.txt', () => {
  const r = spawnHook(bash('grep -o -f .env notes.txt'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// ---------------------------------------------------------------------------
// 12) (independent review RB2-1) — the old exemption only ever recognised the EXACT words
//     -e/--regexp/-f/--file (or an attached --name= form); every OTHER flag was merely "starts with -/-- so
//     skip it", with no notion of which flags take a VALUE. classifySearchWords() in forge-gate-quotes.cjs
//     (shared verbatim by this file's own veto and forge-gate-data.cjs's pre-classify layer) replaces that
//     with a real, closed, per-tool option-table walk. Regression proof against the ACTUAL pre-fix code (via
//     `git show HEAD:<path>` into a scratch copy, never git stash — same convention 's own doc comment
//     names): every 12b fixture below ALLOWED on pre-fix code (a false ALLOW); "grep -A 3"/"rg -g"/"rg -t"
//     BLOCKED on pre-fix code (a false BLOCK) — all 14 flip to the correct verdict with this fix.
// ---------------------------------------------------------------------------
console.log('\n12) WP-M3 RB2-1 — real per-tool option-table walk (grep/rg/findstr arity, not just exact -e/-f)');

// 12a — must-ALLOW: a value-taking flag's own value must never be mistaken for the implicit pattern (the false
// BLOCK direction: "-A 3"/"-C2"/"--include="/"-f"/rg's "-g"/"-t" all used to defeat the implicit-pattern rule).
for (const cmd of ['grep -A 3 "\\.env" src/', 'grep -C2 "\\.env" src/', 'grep -rn --include=*.js "\\.env" src/',
  'grep -f patterns.txt src/', 'grep -e "\\.env" -rn src/', 'rg -g "*.js" "\\.env"', 'rg -t js "\\.env"',
  'findstr /s /i ".env" *.js']) {
  t('classify() stays silent (a flag\'s own value is correctly consumed, the real pattern is picked): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
// 12b — must-BLOCK: a pattern/file flag's value in ANY shape besides the one exact form /M2 recognised
// used to be missed entirely, so the real FILE right after it was wrongly read as the implicit pattern.
for (const cmd of ['grep -eTOKEN .env', 'grep -vf .env', 'grep -Ff .env', 'grep -wf .env', 'grep -rf .env',
  'grep --reg=x .env', 'grep --fil .env', 'grep -Q ".env" file', 'findstr /C:TOKEN .env',
  'findstr /G:secret.key results.txt', 'rg -r .env pattern src', 'grep -vex .env']) {
  t('classify() fires (a real file target reached via a flag shape the old exact-word check missed): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
// 12c — a non-numeric context/count value fails the WHOLE segment closed (no exemption at all: the base gate's
// own broad regex is left to decide, which can only ever ADD a block here, never a new allow).
t('classify() fires when a context flag\'s own value is not numeric (ambiguous -> fail closed, not a guess)', () => {
  assert.ok(gate.classify('grep -A x .env').matched.includes('secret-print'));
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep -vf .env', () => {
  const r = spawnHook(bash('grep -vf .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): grep -A 3 "\\.env" src/ (numeric context value correctly consumed)', () => {
  const r = spawnHook(bash('grep -A 3 "\\.env" src/'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});

// 12d — direct unit coverage of the shared parser itself (forge-gate-quotes.cjs), both tools' own tables.
console.log('\n12d — classifySearchWords() direct unit coverage');
t('grep -A 3 consumes the numeric value and picks the real pattern', () => {
  const r = quotes.classifySearchWords('grep', ['-A', '3', '.env', 'src/']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.patternIdx], [2]);
});
t('rg -r takes a value (unlike grep\'s no-value -r) — the exact per-tool arity split this task names', () => {
  const rg = quotes.classifySearchWords('rg', ['-r', '.env', 'pattern', 'src']);
  assert.strictEqual(rg.ok, true);
  assert.ok(!rg.patternIdx.has(1), '.env (rg -r\'s own replacement value) must not be exempted');
  const grp = quotes.classifySearchWords('grep', ['-r', '.env', 'src/']);
  assert.strictEqual(grp.ok, true);
  assert.ok(grp.patternIdx.has(1), '.env (grep -r is no-value, so this is the implicit pattern) must be exempted');
});
t('an unknown flag fails the whole segment closed', () => {
  assert.strictEqual(quotes.classifySearchWords('grep', ['-Q', '.env', 'file']).ok, false);
});
t('a dangling value-taking flag with nothing after it fails closed, never throws', () => {
  assert.strictEqual(quotes.classifySearchWords('grep', ['-A']).ok, false);
  assert.strictEqual(quotes.classifySearchWords('grep', ['-e']).ok, false);
});
t('findstr /C: fills the pattern slot inline, unlike a bare positional', () => {
  const r = quotes.classifySearchWords('findstr', ['/C:TOKEN', '.env']);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.patternIdx.has(1), '.env must not be exempted once /C: already supplied the pattern');
});
t('findstr /G:/F: name a FILE findstr reads — never exempted, even though they mark the pattern slot filled', () => {
  const r = quotes.classifySearchWords('findstr', ['/G:secret.key', 'results.txt']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.patternIdx.size, 0);
});
t('a "--fil"/"--fi=" abbreviation resolves to --file unambiguously (curated table, see forge-gate-quotes.cjs)', () => {
  assert.strictEqual(quotes.classifySearchWords('grep', ['--fil', '.env']).ok, true);
  assert.deepStrictEqual([...quotes.classifySearchWords('grep', ['--fil', '.env']).patternIdx], []);
});
t('a "--reg="/"--regex" abbreviation resolves to --regexp unambiguously', () => {
  const r = quotes.classifySearchWords('grep', ['--regex', 'x', '.env']);
  assert.strictEqual(r.ok, true);
  assert.ok(r.patternIdx.has(1) && !r.patternIdx.has(2));
});
t('an ambiguous long-option abbreviation fails closed rather than guessing', () => {
  // "--c" is a genuine prefix collision inside grep's own curated table (count/context/...): real GNU
  // getopt_long would reject it as ambiguous too, so failing closed here matches real tool behaviour.
  assert.strictEqual(quotes.classifySearchWords('grep', ['--c', '.env']).ok, false);
});

// 12e — parity: forge-actiongate.cjs and forge-gate-data.cjs must reach the SAME pattern-position verdict for
// every fixture above — the "one shared parser, used identically by both" design this task asked for, proven
// by driving each layer through its OWN real, exported entry points (never a hand-rolled re-tokenizer).
console.log('\n12e — parity: both gate layers agree on the pattern position for every WP-M3 fixture');
function actiongatePatternRaws(cmd) {
  const resolved = gate.resolveSearchToolHead(cmd);
  const split = gate.splitSegmentWords(resolved.rest);
  const texts = split.words.map((w) => gate.wordText(w, split.mask));
  const head = texts[0].toLowerCase();
  const tool = head === 'rg' ? 'rg' : head === 'findstr' ? 'findstr' : 'grep';
  const restTexts = texts.slice(1);
  const result = quotes.classifySearchWords(tool, restTexts);
  return result.ok ? [...result.patternIdx].map((i) => restTexts[i]).sort() : null;
}
function gateDataPatternRaws(cmd) {
  const segs = data.scanWords(cmd, 'Bash');
  const ws = segs[0].words;
  const h = (ws[0] && !ws[0].spans.length ? ws[0].raw.toLowerCase() : '').split(/[\\/]/).pop().replace(/\.exe$/, '');
  return [...data.searchPatternWords(h, ws)].map((w) => w.raw).sort();
}
for (const cmd of ['grep -A 3 .env src/', 'grep -C2 .env src/', 'grep -f patterns.txt src/',
  'rg -g *.js .env', 'rg -t js .env', 'grep -eTOKEN .env', 'grep -vf .env', 'grep --fil .env',
  'rg -r .env pattern src', 'grep -vex .env', 'grep -rn .env src/']) {
  t('actiongate and gate-data agree on the pattern position: ' + cmd, () => {
    assert.deepStrictEqual(gateDataPatternRaws(cmd), actiongatePatternRaws(cmd) || [], cmd);
  });
}
t('parity holds for the fail-closed (ok:false) direction too — gate-data picks nothing either', () => {
  assert.strictEqual(actiongatePatternRaws('grep -Q .env file'), null);
  assert.deepStrictEqual(gateDataPatternRaws('grep -Q .env file'), []);
});

// ---------------------------------------------------------------------------
// 13) REWORK (Lead adversarial probe of commit 32ddb16) — two more false-ALLOW groups in the
//     shared option-table walk itself, both fixed with a design change to classifySearchWords():
//
//   GROUP A (argument permutation): real grep/rg use GNU getopt semantics — options and positionals may be
//     freely interleaved, so `grep .env -e TOKEN` means exactly the same thing as `grep -e TOKEN .env`: TOKEN
//     is the pattern, ".env" is a real file grep opens. The original single-pass walk decided a positional's
//     fate the MOMENT it saw it, so a positional appearing BEFORE a later -e/--regexp/-f/--file was wrongly
//     read as the implicit pattern. Fixed with two passes: pass 1 detects whether an explicit pattern source
//     exists ANYWHERE in the pre-`--` region; pass 2 pre-arms `patternClaimed` to that result, so no positional
//     can ever claim the slot once a real source exists, regardless of position.
//
//   GROUP B (include-type filters that SELECT secret files): grep's --include and a non-negated rg -g/--glob/
//     --iglob value genuinely restrict which files get read and printed — `grep -rn --include=.env TOKEN .`
//     really does search every .env file it finds. The original design treated the whole "filter" bucket
//     (include AND exclude together) as always exempt, which is only safe for EXCLUSION criteria (a file that
//     is excluded can never be read). Fixed by splitting the bucket into filterExempt (grep's --exclude/
//     --exclude-dir/--color/--colour; rg's -t/--type/-T/--type-not, since a "type" is a category name, never a
//     filename), filterInclude (grep's --include, never exempt), and filterGlob (rg's -g/--glob/--iglob: exempt
//     ONLY when the value starts with "!", gitignore-style negation — every other value is an inclusion).
//
// Every case in the Lead's own probe file (gate-probe-m3-lead.json) is mirrored here as a native classify()
// fixture, plus one spawned-hook case per group (never a probe string on this test's own command line).
// ---------------------------------------------------------------------------
console.log('\n13) WP-M3 rework — argument permutation (group A) + include-vs-exclude filters (group B)');

// 13a — group A: an explicit pattern/file option appearing AFTER the first positional must still win; no
// positional may claim the implicit-pattern slot once a real source exists anywhere in the region.
for (const cmd of ['grep .env -e TOKEN', 'grep .env --regexp=TOKEN', 'grep .env -f patterns.txt',
  'rg .env -e TOKEN', 'grep TOKEN .env -r', 'grep -e TOKEN -- -e .env', 'grep -rnfx .env',
  'grep -A 3 TOKEN .env', 'grep -m1 TOKEN .env', 'grep -C x .env', 'grep -rn "\\.env" src/ .env',
  'findstr TOKEN .env', 'findstr /R /C:x .env', 'grep -P TOKEN .env', 'grep --color=always TOKEN .env',
  'sudo grep -eTOKEN .env', 'egrep -vf .env notes.txt', 'rg -Ff .env notes.txt']) {
  t('classify() fires (group A: an explicit pattern/file source elsewhere means every positional is a file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -- .env notes.txt', 'grep --context=3 "\\.env" src/', 'findstr ".env" notes.txt']) {
  t('classify() stays silent (group A negative space: no explicit source anywhere, the positional really is the pattern): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): grep .env -e TOKEN (group A, argument permutation)', () => {
  const r = spawnHook(bash('grep .env -e TOKEN'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 13b — group B: an INCLUSION filter that selects a secret-shaped file must fire; an EXCLUSION filter (or an
// unrelated criterion like grep's --color or rg's -t/--type) must stay silent/exempt as before.
for (const cmd of ['grep -rn --include=.env TOKEN .', 'grep -rn --include="*.env" TOKEN src/',
  'rg -g .env TOKEN', 'rg -g "*.env" TOKEN .', 'rg --glob=.env TOKEN', 'rg --iglob .ENV TOKEN']) {
  t('classify() fires (group B: an INCLUSION filter selecting a secret-shaped file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -rn --include=*.js "\\.env" src/', 'rg -g "*.js" "\\.env"']) {
  t('classify() stays silent (group B negative space: an inclusion filter that does NOT select a secret file): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): rg -g .env TOKEN (group B, include-type filter)', () => {
  const r = spawnHook(bash('rg -g .env TOKEN'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 13c — group B counterfactual: an EXCLUSION filter must stay exempt even though it shares a flag/value shape
// with the inclusion cases above — this is the "keep exempt" half of the fix, not just the "now blocks" half.
for (const cmd of ['grep --exclude=*.env "\\.env" src/', 'grep --exclude-dir=.env "\\.env" src/',
  'rg -g "!*.env" "\\.env"', 'rg --type-not js "\\.env"', 'rg -t js "\\.env"']) {
  t('classify() stays silent (group B counterfactual: an EXCLUSION criterion, or an unrelated type/colour filter, stays exempt): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// 13d — the remaining plain probe cases (already covered indirectly, pinned directly here too so this file
// alone documents the Lead's full case list without needing the external probe JSON to reconstruct intent).
for (const cmd of ['git ls-files | grep -i "\\.env"', 'grep -rn "\\.env" src/', 'grep -f patterns.txt src/']) {
  t('classify() stays silent (plain allow, pinned against regression): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// 13e — parity (both gate layers agree) for a representative case from each group, reusing the SAME real
// exported entry points section 12e already established.
for (const cmd of ['grep .env -e TOKEN', 'rg -g .env TOKEN', 'grep --exclude=*.env .env src/']) {
  t('actiongate and gate-data agree on the pattern position (WP-M3 rework): ' + cmd, () => {
    assert.deepStrictEqual(gateDataPatternRaws(cmd), actiongatePatternRaws(cmd) || [], cmd);
  });
}

// ---------------------------------------------------------------------------
// 14) ROUND 3 (Codex stop-time review finding M3-1, HIGH) — round 2's group-B fix decided
//     each exclusion criterion's exemption from its OWN value alone, independent of every other word in the
//     segment. Both real tools let a LATER inclusion silently override an EARLIER exclusion for the SAME
//     file: GNU grep's own manual states "if contradictory --include and --exclude options are given, the
//     last matching one wins"; ripgrep's glob matching is gitignore-style, where a later --glob can
//     re-include what an earlier one excluded. Live repro: `rg --hidden --glob='!*.env' --glob='.*' TOKEN`
//     used to exempt "!*.env" (its own value starts with "!") while ".*" (given AFTER it) actually
//     re-includes every dotfile for real ripgrep, `.env` included — the classifier stayed silent on the
//     only secret-shaped text in the line. Fixed by making an exclusion criterion's exemption depend on the
//     WHOLE region, not just its own value: exempt ONLY when NO inclusion filter (grep's --include, or an rg
//     glob/iglob value that does NOT start with "!") exists ANYWHERE in the pre-`--` region — order-
//     independent by construction, proven directly below with the order reversed.
// ---------------------------------------------------------------------------
console.log('\n14) WP-M3 round 3 (Codex M3-1) — a later inclusion must revoke an earlier exclusion\'s exemption, and vice versa');

// 14a — must-BLOCK: a later inclusion overrides an earlier exclusion (or vice versa — order must not matter).
for (const cmd of ["rg --hidden --glob='!*.env' --glob='.*' TOKEN", "rg -g '!*.env' -g '*' TOKEN .",
  "rg -g '.*' -g '!*.env' TOKEN", 'grep -r --exclude=*.env --include=.* TOKEN .']) {
  t('classify() fires (round 3: an inclusion filter revokes every exclusion\'s exemption in the same region): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
// 14b — must stay ALLOW: a lone exclusion, or only exclusions, with no inclusion anywhere, keeps its exemption.
for (const cmd of ["rg -g '!*.env' TOKEN src", 'grep -rn --exclude=*.env TOKEN src/',
  "rg -g '!*.env' -g '!*.pem' TOKEN src", 'rg -g "*.js" "\\.env"', 'grep -rn --include=*.js "\\.env" src/']) {
  t('classify() stays silent (round 3 negative space: no inclusion filter anywhere, or an inclusion that is not secret-shaped): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): a later rg glob overrides an earlier exclusion', () => {
  const r = spawnHook(bash("rg --hidden --glob='!*.env' --glob='.*' TOKEN"));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep --include after --exclude (GNU grep "last matching wins")', () => {
  const r = spawnHook(bash('grep -r --exclude=*.env --include=.* TOKEN .'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): a lone exclusion glob with no inclusion anywhere keeps its exemption', () => {
  const r = spawnHook(bash("rg -g '!*.env' TOKEN src"));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});

// 14c — direct unit coverage of the shared parser: order-independence and the "only when no inclusion
// anywhere" rule, checked directly against classifySearchWords() rather than only through classify().
t('a later rg glob overriding an earlier exclusion loses the exemption', () => {
  const r = quotes.classifySearchWords('rg', ['--hidden', "--glob=!*.env", '--glob=.*', 'TOKEN']);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.patternIdx.has(1), '"!*.env" must stay visible once a later inclusion glob exists');
  assert.deepStrictEqual([...r.patternIdx], [3], 'only TOKEN (the real pattern) should be exempt');
});
t('order does not matter: an EARLIER inclusion glob also revokes a LATER exclusion\'s exemption', () => {
  const r = quotes.classifySearchWords('rg', ['-g', '.*', '-g', '!*.env', 'TOKEN']);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.patternIdx.has(3), '"!*.env" must stay visible even though the inclusion glob came FIRST');
});
t('grep: --include after --exclude also revokes the exclusion\'s exemption', () => {
  const r = quotes.classifySearchWords('grep', ['-r', '--exclude=*.env', '--include=.*', 'TOKEN', '.']);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.patternIdx.has(1), '--exclude=*.env must stay visible once --include is present anywhere');
});
t('a lone exclusion glob, or only exclusions, with no inclusion anywhere keeps its exemption', () => {
  const lone = quotes.classifySearchWords('rg', ['-g', '!*.env', 'TOKEN', 'src']);
  assert.ok(lone.patternIdx.has(1), '"!*.env" alone (no inclusion anywhere) must stay exempt');
  const both = quotes.classifySearchWords('rg', ['-g', '!*.env', '-g', '!*.pem', 'TOKEN', 'src']);
  assert.ok(both.patternIdx.has(1) && both.patternIdx.has(3), 'two exclusions, still no inclusion, both stay exempt');
});
t('an unrelated filterExempt (rg -t/--type, grep --color) stays unconditionally exempt even alongside an inclusion filter', () => {
  const r = quotes.classifySearchWords('rg', ['-t', 'js', '-g', '.env', 'TOKEN']);
  assert.strictEqual(r.ok, true);
  assert.ok(r.patternIdx.has(1), '"js" (the -t value) is unconditionally exempt, unaffected by this fix\'s scope');
  assert.ok(!r.patternIdx.has(3), '".env" (a non-negated glob value) was already never-exempt before this fix, unchanged');
});

// 14d — the honesty question (Lead): a recursive search naming NO secret-shaped filename at all
// stays silent today — the base regex has nothing to trigger on, a separate, honestly-documented limitation
// (see hard-gates.json's own _not_caught note) that this round's fix does not and cannot close.
t('classify() stays silent for a recursive/hidden search with no secret-shaped text anywhere in the line', () => {
  assert.strictEqual(gate.classify("rg --hidden --glob='.*' TOKEN").matched.includes('secret-print'), false);
});

// 15) (Codex stop-time review F1, HIGH): GNU grep's --color[=WHEN] / --colour[=WHEN] take an OPTIONAL value
// that only counts when glued with "=". The table treated a bare --color as consuming the NEXT word, so in
// `grep --color API_KEY .env` API_KEY became the colour value and .env the pattern (exempt): a false ALLOW.
console.log('\n15) grep --color / --colour: optional, attached-only value');
for (const cmd of ['grep --color API_KEY .env', 'grep --colour API_KEY .env', 'grep --color -r TOKEN .env', 'egrep --color SECRET .env.local']) {
  t('classify() fires (a bare --color takes no value): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep --color=always -rn "\\.env" src/', 'grep --color "\\.env" -rn src/', 'grep --colour=never TOKEN src/']) {
  t('classify() stays silent (the pattern position is still data): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('classifySearchOptionWord: a bare --color is novalue, --color=always carries an attached value', () => {
  const table = quotes.SEARCH_TOOL_OPTION_TABLES.grep;
  assert.strictEqual(quotes.classifySearchOptionWord(table, '--color').category, 'novalue');
  const glued = quotes.classifySearchOptionWord(table, '--color=always');
  assert.strictEqual(glued.valueMode, 'attached');
  assert.strictEqual(glued.attachedValue, 'always');
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep --color API_KEY .env', () => {
  const r = spawnHook(bash('grep --color API_KEY .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 16) (Lead probe after the --color fix): the target `secrets/` only matched a path INSIDE the folder,
// so a search of the folder itself, or a git pathspec naming it, read every file in it unseen. `secrets` now also
// counts when the word ends right there; a file merely named like it (secrets.md, my-secrets.txt) does not.
console.log('\n16) the secrets folder named without a trailing slash');
for (const cmd of ['grep -r TOKEN secrets', 'rg TOKEN secrets', 'findstr /D:secrets TOKEN *', 'git log -p -- secrets', 'git diff -- secrets', 'grep -rn TOKEN ./secrets']) {
  t('classify() fires: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -rn "secrets" src/', 'ls secrets', 'mkdir secrets', 'cat secrets.md', 'cat my-secrets.txt', 'git log --oneline -- secrets']) {
  t('classify() stays silent: ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): grep -r TOKEN secrets', () => {
  const r = spawnHook(bash('grep -r TOKEN secrets'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 17) (and GATE-2): words are split on whitespace only, so a redirection glued to a pattern
// word (grep -e '.*'<.env) was exempted as the pattern while the shell reads .env through "<". A word with an
// unquoted redirection or command substitution now turns the exemption off in both layers. And the full spellings
// --fixed-strings / --files-with-matches / --files-without-match are recognised (exact only, no prefix matching).
console.log('\n17) glued redirections and full fixed-strings spellings');
for (const cmd of ["grep -e '.*'<.env", 'grep -e x<.env', 'grep TOKEN<.env', 'rg TOKEN<.env.local', 'grep -e "$(cat .env)" src/', 'grep --fixed-strings TOKEN .env', 'grep --fil .env notes.txt']) {
  t('classify() fires: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ["grep -e '<div' src/", 'grep -rn "<div" src/', "grep --fixed-strings '.env' src/", "grep -r --files-with-matches '.env' src/", "rg --fixed-strings '.env' src"]) {
  t('classify() stays silent: ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('hasUnquotedShellSyntax: redirection and substitution outside quotes only', () => {
  assert.strictEqual(quotes.hasUnquotedShellSyntax("'.*'<.env"), true);
  assert.strictEqual(quotes.hasUnquotedShellSyntax('"$(cat x)"'), true);
  assert.strictEqual(quotes.hasUnquotedShellSyntax("'<div'"), false);
  assert.strictEqual(quotes.hasUnquotedShellSyntax('"<div"'), false);
  assert.strictEqual(quotes.hasUnquotedShellSyntax('a\\<b'), false);
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep -e \'.*\'<.env', () => {
  const r = spawnHook(bash("grep -e '.*'<.env"));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// ---------------------------------------------------------------------------
// 18) (security review L/M finding on the login vault): the account
//     rotator's vault folder ~/.claude/forge-accounts holds full Claude logins, so it is a secret target for
//     the shell route (this gate) AND the Read tool (settings.json deny). A file merely NAMED like it is not.
// ---------------------------------------------------------------------------
console.log('\n18) account-rotator vault folder (forge-accounts) is a secret target');
const VAULT_READS = ['cat ~/.claude/forge-accounts/work.json', 'type C:\\Users\\me\\.claude\\forge-accounts\\work.json',
  'Get-Content $HOME/.claude/forge-accounts/prive.json', 'grep -r refreshToken ~/.claude/forge-accounts',
  'rg accessToken ~/.claude/forge-accounts/', 'cat forge-accounts/.credentials.pre-switch.json', 'more forge-accounts\\extra.prev.json'];
for (const cmd of VAULT_READS) {
  t('classify() fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), JSON.stringify(gate.classify(cmd).matched));
  });
}
for (const cmd of ['node .claude/forge-bin/account-rotator.cjs status', 'cat docs/forge-accounts.md', 'cat my-forge-accounts-notes.txt', 'ls ~/.claude/forge-accounts']) {
  t('classify() stays silent: ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('SECRET_TARGET_RE mirrors the vault folder, so a search tool\'s pattern veto never exempts a vault FILE argument', () => {
  assert.ok(gate.SECRET_TARGET_RE.test('~/.claude/forge-accounts/work.json'));
  assert.ok(gate.SECRET_TARGET_RE.test('forge-accounts'));
  assert.strictEqual(gate.SECRET_TARGET_RE.test('forge-accounts.md'), false);
});
t('settings.json denies the Read tool on the vault folder too (both routes closed)', () => {
  assert.ok(DENY.includes('Read(~/.claude/forge-accounts/**)'), 'settings.json permissions.deny lacks the vault folder');
});
t('spawned hook BLOCKS (exit 2, names secret-print): a read of a vault slot', () => {
  const r = spawnHook(bash('cat ~/.claude/forge-accounts/work.json'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// ---------------------------------------------------------------------------
// 19) WP-GATEFP: false positives that cost two lanes real time. A search over ORDINARY source files
//     whose PATTERN holds a secret-shaped word was blocked as soon as the segment also carried a harmless output
//     redirect (2>/dev/null, 2>&1, > file, 2>$null): the pattern-position veto refuses any unquoted `>`, so the
//     pattern word was tested as if it were a file. The hook now re-judges a secret-print-only block once with
//     those redirects blanked; every real secret read below must still block.
// ---------------------------------------------------------------------------
console.log('\n19) WP-GATEFP — benign source-file searches pass; real secret reads still block');
const hookDecide = (command, tool) => hook.decide({ hook_event_name: 'PreToolUse', tool_name: tool || 'Bash', tool_input: { command }, cwd: process.cwd() }, {});
const GATEFP_BENIGN = [
  'grep -o "\\.env" .claude/forge-bin/forge-sync*.cjs 2>/dev/null',
  'grep -o "secrets" .claude/forge-bin/forge-sync*.cjs 2>&1 | head',
  "grep -o 'credentials.json' .claude/forge-bin/forge-sync*.cjs 2>&1",
  'grep -o "id_rsa" .claude/forge-bin/forge-sync*.cjs 2> /dev/null',
  'grep -rIl "\\.env" .claude/forge-bin 2>/dev/null',
  'grep -n secrets .claude/forge-bin/forge-sync.cjs 2>/dev/null',
  'grep -o "\\.pem" .claude/forge-bin/forge-sync*.cjs > _scratch/out.txt',
  'grep -c "\\.env" .claude/forge-bin/forge-sync.cjs 2>$null',
  'rg -o "\\.env\\b" .claude/forge-bin 2>/dev/null',
  'grep -o "forge-accounts" .claude/forge-bin/forge-sync*.cjs 2>/dev/null',
  'grep -o "readLockStatus" .claude/forge-bin/forge-sync*.cjs',
  'grep -rIl "secret\\|token" .claude/forge-bin',
  'grep -rIl "secrets\\|token" .claude',
  'rg -n "password|credentials" .claude/forge-bin',
  'grep -n "api_key" .claude/forge-bin/forge-config.cjs',
  'cat .claude/forge-bin/forge-secret-scrub.cjs',
  'head -50 .claude/forge-bin/forge-gate-secretprint.test.cjs',
  'sed -n 1,40p .claude/forge-bin/forge-gate-secretprint.test.cjs',
  'grep -n "token" .claude/forge-bin/forge-gate-secretprint.test.cjs',
  'cat .claude/forge-bin/forge-secret-scrub.cjs 2>/dev/null',
];
for (const cmd of GATEFP_BENIGN) {
  t('hook allows a benign source-file search/read: ' + cmd, () => {
    const d = hookDecide(cmd);
    assert.strictEqual(d.block, false, 'blocked: ' + JSON.stringify(d.gates) + ' ' + d.why);
  });
}
for (const cmd of ['Get-Content .claude/forge-bin/forge-secret-scrub.cjs -TotalCount 40', 'Select-String -Pattern "token" -Path .claude/forge-bin/forge-scribe.cjs']) {
  t('hook allows a benign PowerShell read: ' + cmd, () => { assert.strictEqual(hookDecide(cmd, 'PowerShell').block, false); });
}
const GATEFP_TRUE = [
  ["grep -o '^[A-Z_]*=' .env", 'Bash'], ['cat id_rsa', 'Bash'], ['type credentials.json', 'PowerShell'],
  ['Get-Content .env', 'PowerShell'], ['find secrets/ -type f | xargs cat', 'Bash'], ['git show HEAD:.env', 'Bash'],
  // the redirect re-check must never clear these: the secret file is still a real read target
  ['grep -o "\\.env" .env 2>/dev/null', 'Bash'], ['grep -o x src/a.cjs 2>/dev/null <.env', 'Bash'],
  ['grep -o x src/a.cjs 2>/dev/null .env', 'Bash'], ['grep x src/a.cjs 2>/dev/null; cat .env', 'Bash'],
  ['cat .env 2>/dev/null', 'Bash'], ['grep -o "\\.env" src/a.cjs 2>/dev/null | xargs cat .env', 'Bash'],
  ['grep -o "$(cat .env)" src/a.cjs 2>/dev/null', 'Bash'], ['grep -o x src/a.cjs 2>.env', 'Bash'],
  ['grep -e x src/a.cjs 2>/dev/null secrets/prod.txt', 'Bash'], ['grep x src/a.cjs >>/dev/null <id_rsa', 'Bash'],
  ['Get-Content .env 2>$null', 'PowerShell'], ['grep -rn token ~/.claude/forge-accounts 2>/dev/null', 'Bash'],
];
for (const [cmd, tool] of GATEFP_TRUE) {
  t('hook still BLOCKS a real secret read: ' + cmd, () => {
    const d = hookDecide(cmd, tool);
    assert.strictEqual(d.block, true, 'allowed: ' + d.why);
    assert.ok(d.gates.includes('secret-print'), JSON.stringify(d.gates));
  });
}
t('a secret-print block that ALSO names another gate is never relaxed', () => {
  const d = hookDecide('grep -o "\\.env" src/a.cjs 2>/dev/null; rm -rf ./src');
  assert.strictEqual(d.block, true);
  assert.ok(d.gates.includes('destructive-delete'), JSON.stringify(d.gates));
});
t('neutralizeSafeRedirects blanks only unquoted harmless output redirects, same length', () => {
  const n = hook.neutralizeSafeRedirects;
  const a = 'grep -o "\\.env" src/a.cjs 2>/dev/null 2>&1 > out.txt';
  const r = n(a);
  assert.strictEqual(r.length, a.length);
  assert.ok(!/>/.test(r), r);
  assert.ok(r.includes('"\\.env"'), 'the pattern itself is untouched');
  assert.strictEqual(n('grep x a.cjs <.env'), 'grep x a.cjs <.env', 'an input redirect is never touched');
  assert.strictEqual(n('grep x a.cjs 2>.env'), 'grep x a.cjs 2>.env', 'a secret-shaped redirect target is never blanked');
  assert.strictEqual(n('grep "a 2>/dev/null" b.cjs'), 'grep "a 2>/dev/null" b.cjs', 'a quoted > is data, not a redirect');
  assert.strictEqual(n('grep x a.cjs 2>$(cat .env)'), 'grep x a.cjs 2>$(cat .env)', 'a substitution target is never blanked');
  assert.strictEqual(n('grep x a.cjs2>/dev/null'), 'grep x a.cjs2>/dev/null', 'a redirect glued to a word is left alone');
  assert.strictEqual(n('grep "x a.cjs 2>/dev/null'), null, 'unterminated quoting -> cannot judge');
});
t('spawned hook: benign redirect-shaped search exits 0, the same search on .env exits 2', () => {
  const ok = spawnHook(bash('grep -o "\\.env" .claude/forge-bin/forge-sync.cjs 2>/dev/null'));
  assert.strictEqual(ok.status, 0, 'exit ' + ok.status + ', stderr: ' + ok.stderr);
  const bad = spawnHook(bash('grep -o "\\.env" .env 2>/dev/null'));
  assert.strictEqual(bad.status, 2, 'exit ' + bad.status + ', stderr: ' + bad.stderr);
  assert.ok(bad.stderr.includes('secret-print'), bad.stderr);
});

// ---------------------------------------------------------------------------
// 20) WP-GATEFP2. The WP-GATEFP relaxation blanked `*>out` in bash (a glob WORD plus a
//     redirect: `grep *>out .env` read .env) and `0>`/`7>`..`9>` in PowerShell (literal ARGUMENTS there), and a
//     throw in it fell to the non-blocking classifier-unavailable path. Separately (pre-existing, not WP-GATEFP) the
//     classifier split a segment at the `&` of `>&`/`&>`, so `grep *>&2 .env` and `grep -e abc 3>&2 .env` passed.
//     Key cases spawn the REAL hook; section 19's benign commands above must all stay allowed.
// ---------------------------------------------------------------------------
console.log('\n20) WP-GATEFP2 — shell-specific redirects, fail-closed second pass, linear rebuild, & split closed');
const pwsh = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } });
const GATEFP2_BASH_BLOCK = [
  'grep *>&2 .env', 'grep -e *>&1 .env', 'grep -r *>&2 ./.env', 'rg *>&2 .env', // owner list
  'grep *>out .env', 'grep *>/dev/null .env', 'grep *>>out .env', 'grep -e *>out .env', // the WP-GATEFP regression form
  'grep -e abc 3>&2 2>/dev/null .env', 'cat 2>&1 .env', 'grep x &>out.txt .env', 'grep ?>&2 .env', // the `&` split
];
for (const cmd of GATEFP2_BASH_BLOCK) {
  t('spawned hook (Bash tool) BLOCKS exit 2: ' + cmd, () => {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
    assert.ok(r.stderr.includes('secret-print'), r.stderr);
  });
}
const GATEFP2_PS_BLOCK = [
  'Select-String -Pattern 7> out .env', 'Select-String -Pattern 0> out .env', 'Select-String -Pattern 9> out .env',
  'Select-String -Pattern &> out .env', 'Select-String -Pattern 8> out .env', 'Select-String -Pattern 1>&2 .env',
  'grep.exe --% 2>x .env',
];
for (const cmd of GATEFP2_PS_BLOCK) {
  t('spawned hook (PowerShell tool) BLOCKS exit 2: ' + cmd, () => {
    const r = spawnHook(pwsh(cmd));
    assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
    assert.ok(r.stderr.includes('secret-print'), r.stderr);
  });
}
for (const [cmd, mk] of [['grep -o "\\.env" .claude/forge-bin/forge-sync.cjs 2>&1', bash], ['npm test 2>&1 | tail -5', bash],
  ['Select-String -Pattern "\\.env" -Path .claude/forge-bin/forge-sync.cjs 2>$null', pwsh]]) {
  t('spawned hook ALLOWS exit 0 (no new false positive): ' + cmd, () => {
    const r = spawnHook(mk(cmd));
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
  });
}
t('neutralizeSafeRedirects is shell-specific (real Git Bash / Windows PowerShell 5.1 semantics)', () => {
  const n = hook.neutralizeSafeRedirects;
  // WP-GATEFP3 moved `7>&2`, `0>x`, `3>/dev/null` to the blanked list below: real bash reads ANY single
  // digit N in `N>`/`N>&M` as a redirect. Two digits and the `{fd}>` word form stay unblanked (they keep blocking).
  for (const s of ['grep *>out .env', 'grep *>&2 .env', 'grep 10>/dev/null y', 'grep {fd}>/dev/null y', 'grep x 3>.env']) assert.strictEqual(n(s, 'Bash'), s, s);
  for (const s of ['grep x 2>&1', 'grep x >&2', 'grep x 1>&2', 'grep x &>/dev/null', 'grep x &>>log', 'grep x 1>>log', 'grep x 2>/dev/null',
    'grep 7>&2 x', 'grep 0>x y', 'grep 3>/dev/null y']) {
    assert.ok(!/>/.test(n(s, 'Bash')), s + ' -> ' + n(s, 'Bash'));
  }
  for (const s of ['sls -Pattern 7> o .env', 'sls -Pattern 0> o .env', 'sls -Pattern 9> o .env', 'sls -Pattern &> o .env', 'sls x 1>&2', 'sls x >&1']) {
    assert.strictEqual(n(s, 'PowerShell'), s, s);
  }
  for (const s of ['sls x *>$null', 'sls x 2>&1', 'sls x 3>&1', 'sls x *>&1', 'sls x 6>o', 'sls x 2>>log', 'sls x *>>log', 'sls x 1>o']) {
    assert.ok(!/>/.test(n(s, 'PowerShell')), s + ' -> ' + n(s, 'PowerShell'));
  }
  assert.strictEqual(n('grep x 2>/dev/null', 'Zsh'), null, 'an unknown shell cannot be judged');
  assert.strictEqual(n('grep x 2>/dev/null'), n('grep x 2>/dev/null', 'Bash'), 'shell omitted = Bash');
});
t('glueRedirectAmpersands: only the & of >&, <& and &> becomes a space (never && or a background &)', () => {
  const g = hook.glueRedirectAmpersands;
  assert.strictEqual(g('grep -e x 3>&2 .env'), 'grep -e x 3> 2 .env');
  assert.strictEqual(g('grep x &>out .env'), 'grep x  >out .env');
  assert.strictEqual(g('cat <&3'), 'cat < 3');
  assert.strictEqual(g('a && b & c'), 'a && b & c');
  assert.strictEqual(g('a &&>b'), 'a &&>b');
});
t('relaxRefused: defence-in-depth shapes refuse the relaxation; section 19\'s benign commands do not', () => {
  const R = hook.relaxRefused;
  for (const s of ['grep *>&2 .env', 'grep ?>out x', 'grep [a]>out x', 'grep x >*', 'grep x 2>$LOG', 'grep x 2>${null}', 'grep x 2>$(echo a)',
    'grep x >(cat)', 'grep x <a.cjs', 'grep x a.cjs 2>/dev/null <<< y', 'grep `echo x` a.cjs 2>/dev/null', "sls x a.cjs 2>$null; @'\ny\n'@",
    "grep $'x' a 2>/dev/null", 'grep \\"x a 2>/dev/null', 'grep.exe --% 2>x .env', 'grep x a 2>/dev/null | tee o',
    'sls x a 2>$null | Out-File o', 'sls x a 2>$null | Set-Content o', 'sls x a 2>$null | Add-Content o', 'sls x a 2>&1 | Tee-Object o']) {
    assert.strictEqual(R(s), true, s);
  }
  for (const s of GATEFP_BENIGN) assert.strictEqual(R(s), false, s);
});
t('defence in depth through the hook: a refused shape keeps its secret-print block', () => {
  // each of these would be cleared by the relaxation alone; only the refusal keeps the block. WP-GATEFP3:
  // the PowerShell `*>$null` case that stood here is a real all-streams redirect and is now allowed (section 21); the
  // bash `*>` glob form below keeps the refusal.
  for (const [cmd, tool] of [['grep -o "\\.env" src/a.cjs 2>/dev/null | tee out.txt', 'Bash'], ['grep -o "\\.env" src/a.cjs 2>$LOG', 'Bash'],
    ["grep -o $'\\.env' src/a.cjs 2>/dev/null", 'Bash'], ['Select-String -Pattern "\\.env" -Path src/a.cjs 2>$null | Out-File o.txt', 'PowerShell'],
    ['grep -o "\\.env" src/a.cjs *>/dev/null', 'Bash']]) {
    const d = hookDecide(cmd, tool);
    assert.strictEqual(d.block, true, cmd + ' allowed: ' + d.why);
  }
});
t('F3 unit: relaxSecretPrint keeps the block on a throw, a watchdog failure, an unclean re-check, bad quoting or an unknown shell', () => {
  const block = { block: true, gates: ['secret-print'], reason: 'r', why: 'command-gate' };
  const cmd = 'grep -o "\\.env" src/a.cjs 2>/dev/null';
  const clean = () => ({ verdict: { block: false, gates: [] } });
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Bash', () => { throw new Error('boom'); }), block);
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Bash', () => ({ final: { block: true, gates: ['command-too-large'] } })), block);
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Bash', () => ({ verdict: { block: false, warn: true, gates: [] } })), block);
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Bash', () => undefined), block);
  assert.strictEqual(hook.relaxSecretPrint(block, 'grep "x 2>/dev/null', 'Bash', clean), block, 'unterminated quoting');
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Zsh', clean), block, 'unknown shell');
  assert.strictEqual(hook.relaxSecretPrint(block, cmd, 'Bash', clean).block, false, 'only a fully clean re-check clears');
});
t('F3 in-process: a throw injected into the second pass keeps the FIRST verdict — exit 2, never the exit-1 "NOT checked" path', () => {
  const orig = quotes.scanQuotes; // the first pass runs in the watchdog Worker (its own module copy); only the main-thread second pass sees this
  quotes.scanQuotes = () => { throw new Error('injected second-pass fault (test)'); };
  try {
    for (const cmd of ['grep -o "\\.env" src/a.cjs 2>/dev/null', 'grep -o x src/a.cjs 2>/dev/null .env']) {
      const r = hook.run(JSON.stringify(bash(cmd)), {});
      assert.strictEqual(r.exitCode, 2, cmd + ': exit ' + r.exitCode + ' (' + r.why + ')');
    }
  } finally { quotes.scanQuotes = orig; }
});
t('F3 spawned: a REAL hook process whose second pass throws (fault injected on the main thread via --require) exits 2', () => {
  const pre = path.join(TMP, 'f3-preload.cjs');
  fs.writeFileSync(pre, "if (require('worker_threads').isMainThread) { const q = require(" + JSON.stringify(path.join(__dirname, 'forge-gate-quotes.cjs'))
    + "); q.scanQuotes = () => { throw new Error('injected second-pass fault (test)'); }; }\n");
  const cmd = 'grep -o "\\.env" src/a.cjs 2>/dev/null';
  const r = spawnSync(process.execPath, ['--require', pre, HOOK], { input: JSON.stringify(bash(cmd)), encoding: 'utf8', env: envFor(), timeout: 15000 });
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.strictEqual(spawnHook(bash(cmd)).status, 0, 'control: without the fault the same command is cleared');
});
t('F4: 40,000 redirects neutralize in linear time; the hook decides well under the 4 s deadline (allow, or fail closed)', () => {
  const big = 'grep -o "\\.env" src/a.cjs' + ' > a'.repeat(40000);
  let t0 = Date.now();
  const n = hook.neutralizeSafeRedirects(big, 'Bash');
  const nMs = Date.now() - t0;
  assert.ok(nMs < 1000, 'neutralizeSafeRedirects took ' + nMs + 'ms (the quadratic rebuild took ~2000ms)');
  assert.strictEqual(n.length, big.length);
  assert.ok(!n.includes('>'), 'every harmless redirect blanked');
  t0 = Date.now();
  const d = hookDecide(big);
  const dMs = Date.now() - t0;
  assert.ok(dMs < 4000, 'decide took ' + dMs + 'ms');
  assert.ok(!d.warn, 'never the non-blocking "NOT checked" path: ' + d.why);
  assert.ok(d.block === false || d.gates.includes('command-too-large'), JSON.stringify(d.gates) + ' ' + d.why);
});

// Real-shell pins: the rules above rest on what bash / Windows PowerShell 5.1 really do. Harmless probes in this test's
// own temp dir, on a DUMMY file that is secret-shaped by NAME only (.env holding the text DUMMY_VALUE). Skipped, never
// counted as passed, when the shell is missing.
const SEM = path.join(TMP, 'semantics');
fs.mkdirSync(SEM, { recursive: true });
fs.writeFileSync(path.join(SEM, '.env'), 'DUMMY_VALUE=abc 7> marker\n');
fs.writeFileSync(path.join(SEM, 'a'), 'not a secret\n');
const SEM_ECHO = path.join(SEM, 'echo.cjs');
fs.writeFileSync(SEM_ECHO, "require('fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n");
const semArgv = (f) => { try { return JSON.parse(fs.readFileSync(path.join(SEM, f), 'utf8')); } catch { return null; } };
const BASH_EXE = (process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]
  : ['/bin/bash', '/usr/bin/bash']).find((p) => fs.existsSync(p)) || null;
if (!BASH_EXE) console.log('  skip real-bash pins — no bash found');
else {
  t('real bash: `*>out` keeps `*` as an ARGUMENT, `2>`/`&>` do not, and `grep *>out .env` really reads the file', () => {
    const fwd = (p) => p.replace(/\\/g, '/');
    const run = (f, form) => spawnSync(BASH_EXE, ['-c', '"' + fwd(process.execPath) + '" "' + fwd(SEM_ECHO) + '" ' + form],
      { cwd: SEM, encoding: 'utf8', env: Object.assign({}, process.env, { ARGV_OUT: path.join(SEM, f) }) });
    run('b1.json', '*>o1 X'); run('b2.json', '2>o2 X'); run('b3.json', '&>o3 X');
    const g = semArgv('b1.json');
    assert.ok(Array.isArray(g) && g.length >= 2 && g[g.length - 1] === 'X' && g[0] !== 'X', 'glob expansion expected before X: ' + JSON.stringify(g));
    assert.deepStrictEqual(semArgv('b2.json'), ['X']);
    assert.deepStrictEqual(semArgv('b3.json'), ['X']);
    const rd = spawnSync(BASH_EXE, ['-c', 'grep *>out .env; cat out'], { cwd: SEM, encoding: 'utf8' });
    assert.ok(rd.stdout.includes('DUMMY_VALUE'), 'bash did not read the dummy file: ' + JSON.stringify(rd.stdout + rd.stderr));
  });
}
const PS_OK = process.platform === 'win32' && !spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 60000 }).error;
if (!PS_OK) console.log('  skip real-PowerShell pins — no Windows PowerShell found');
else {
  t('real Windows PowerShell: `0>`/`7>`/`9>` and `--% 2>x` are ARGUMENTS, `2>&1`/`*>` are redirects, and `Select-String -Pattern 7>` reads the file', () => {
    const line = (f, form) => "$env:ARGV_OUT='" + path.join(SEM, f) + "'\n& '" + process.execPath + "' '" + SEM_ECHO + "' " + form + '\n';
    const ps1 = path.join(SEM, 'p.ps1');
    fs.writeFileSync(ps1, line('p7.json', '7> o X') + line('p0.json', '0> o X') + line('p9.json', '9> o X') + line('p21.json', '2>&1 X')
      + line('pstar.json', '*>o7 X') + 'Select-String -Pattern 7> -Path .env\n' + line('pstop.json', '--% 2>o8 X'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { cwd: SEM, encoding: 'utf8', timeout: 60000 });
    assert.deepStrictEqual(semArgv('p7.json'), ['7>', 'o', 'X']);
    assert.deepStrictEqual(semArgv('p0.json'), ['0>', 'o', 'X']);
    assert.deepStrictEqual(semArgv('p9.json'), ['9>', 'o', 'X']);
    assert.deepStrictEqual(semArgv('p21.json'), ['X']);
    assert.deepStrictEqual(semArgv('pstar.json'), ['X']);
    assert.deepStrictEqual(semArgv('pstop.json'), ['2>o8', 'X']);
    assert.ok((r.stdout || '').includes('DUMMY_VALUE'), 'Select-String did not read the dummy file: ' + JSON.stringify((r.stdout || '') + (r.stderr || '')));
  });
}

// ---------------------------------------------------------------------------
// 21) WP-GATEFP3. G1: the classifier split a segment at the bar of the clobber
//     operator `[n]>|`, so `cat >|out .env` lost its file argument (real bash copied/printed the file); the hook now
//     glues that bar like the `&` of `>&`. G3: the relaxation refusals for `<`, tee/Out-File/... and a glob touching
//     `>` read QUOTED search data as syntax. G4: bash accepts ANY single-digit fd prefix. G5: PowerShell `*>` is a real
//     all-streams redirect. Every case spawns the REAL hook; section 19's 22 benign commands are re-run spawned too.
// ---------------------------------------------------------------------------
console.log('\n21) WP-GATEFP3 — clobber >| glued, quote-aware refusals, any single-digit bash fd, PowerShell *> streams');
const spawnExpect = (cmd, mk, code) => {
  const r = spawnHook(mk(cmd));
  assert.strictEqual(r.status, code, 'exit ' + r.status + ', stderr: ' + r.stderr);
  if (code === 2) assert.ok(r.stderr.includes('secret-print'), r.stderr);
};
const GATEFP3_BLOCK = [
  // bare, 1-, 2- and 3-prefixed clobber with a secret file argument after the operator (Bash tool)
  ['cat >|out .env', bash], ['head >|out .env', bash], ['grep LEAK >|out .env', bash], ['grep LEAK 1>|out .env', bash],
  ['grep LEAK 2>|/dev/null .env', bash], ['grep LEAK 3>|out .env', bash], ['cat a.txt 2>&1 >|out .env', bash],
  ['bash -c "cat >|out .env"', bash], ["sh -c 'grep LEAK 2>|/dev/null .env'", bash],
  ['grep -o "\\.env" src/a.cjs 2>/dev/null >|out .env', bash],
  // PowerShell tool: `>|` is a parse error there; still blocked conservatively
  ['cat >|out .env', pwsh], ['Get-Content >|out .env', pwsh], ['Select-String -Pattern LEAK >|out .env', pwsh],
  ['Select-String -Pattern LEAK 1>|out .env', pwsh], ['Select-String -Pattern LEAK 2>|out .env', pwsh],
  ['Select-String -Pattern LEAK 3>|out .env', pwsh], ['grep LEAK 2>|/dev/null .env', pwsh],
  // the same text UNQUOTED stays refused; a quoted writer NAME still runs; a `<` inside a live $(...) stays visible
  ['grep tee.*\\.env src/a.cjs 2>/dev/null', bash], ['grep <tag>.*\\.env src/a.cjs 2>/dev/null', bash],
  ['grep -e "\\.env" src/a.cjs 2>/dev/null | tee out.txt', bash], ['grep -e "\\.env" src/a.cjs 2>/dev/null | "tee" out.txt', bash],
  ['grep -e "\\.env" src/a.cjs 2>/dev/null | t"ee" out.txt', bash], ['grep "$(cat <.env)" src/a.cjs 2>/dev/null', bash],
  ['grep -e x src/a.cjs 2>/dev/null "<".env', bash],
  // a real read, a secret-shaped target, two digits and the {fd} word form keep blocking
  ['grep x 3>/dev/null .env', bash], ['grep -e abc 0>/dev/null .env', bash], ['grep x 9>out .env', bash],
  ['grep "\\.env" src/a.cjs 3>.env', bash], ['grep "\\.env" src/a.cjs 10>/dev/null', bash], ['grep "\\.env" src/a.cjs {fd}>/dev/null', bash],
  // PowerShell keeps a secret-shaped target and a real read blocked; bash keeps the `*` glob refusal
  ['Select-String -Pattern "\\.env" -Path src/a.cjs *>.env', pwsh], ['Select-String -Pattern x *>out .env', pwsh],
  ['Select-String -Pattern x *>$null .env', pwsh], ['grep -o "\\.env" src/a.cjs *>/dev/null', bash], ['grep *>/dev/null .env', bash],
  ['grep -o "\\.env" src/a.cjs *>&1', bash],
];
for (const [cmd, mk] of GATEFP3_BLOCK) {
  t('spawned hook (' + (mk === bash ? 'Bash' : 'PowerShell') + ' tool) BLOCKS exit 2: ' + cmd, () => spawnExpect(cmd, mk, 2));
}
const GATEFP3_ALLOW = [
  // quoted search data is data again
  ['grep "tee.*\\.env" src/a.cjs 2>/dev/null', bash], ['grep "<tag>.*\\.env" src/a.cjs 2>/dev/null', bash],
  ['Select-String -Pattern "tee.*\\.env" -Path src/a.cjs 2>$null', pwsh],
  // any single-digit fd prefix in bash
  ['grep "\\.env" src/a.cjs 3>/dev/null', bash], ['grep "\\.env" src/a.cjs 0>/dev/null', bash], ['grep "\\.env" src/a.cjs 9>/dev/null', bash],
  ['grep "\\.env" src/a.cjs 7>&2', bash], ['grep "\\.env" src/a.cjs 3>out.txt', bash],
  // PowerShell all-streams redirects into a null sink or a plain file
  ['Select-String -Pattern "\\.env" -Path src/a.cjs *>$null', pwsh], ['Select-String -Pattern "\\.env" -Path src/a.cjs *>&1', pwsh],
  ['Select-String -Pattern "\\.env" -Path src/a.cjs *>out.txt', pwsh], ['Select-String -Pattern "\\.env" -Path src/a.cjs *>>log.txt', pwsh],
];
for (const [cmd, mk] of GATEFP3_ALLOW) {
  t('spawned hook (' + (mk === bash ? 'Bash' : 'PowerShell') + ' tool) ALLOWS exit 0: ' + cmd, () => spawnExpect(cmd, mk, 0));
}
for (const cmd of GATEFP_BENIGN) t('spawned hook (Bash tool) still ALLOWS section 19 benign: ' + cmd, () => spawnExpect(cmd, bash, 0));
for (const cmd of ['Get-Content .claude/forge-bin/forge-secret-scrub.cjs -TotalCount 40', 'Select-String -Pattern "token" -Path .claude/forge-bin/forge-scribe.cjs']) {
  t('spawned hook (PowerShell tool) still ALLOWS section 19 benign: ' + cmd, () => spawnExpect(cmd, pwsh, 0));
}
t('glueRedirectAmpersands: the bar of [n]>| becomes a space; a pipe after a space or a quote is untouched', () => {
  const g = hook.glueRedirectAmpersands;
  assert.strictEqual(g('cat >|out .env'), 'cat > out .env');
  assert.strictEqual(g('grep x 2>|/dev/null .env'), 'grep x 2> /dev/null .env');
  assert.strictEqual(g('cat a 2>&1 >|out .env'), 'cat a 2> 1 > out .env');
  assert.strictEqual(g('grep x >o | head'), 'grep x >o | head');
  assert.strictEqual(g('grep "a"|cat'), 'grep "a"|cat');
  assert.strictEqual(g('a >|| b'), 'a > | b', 'only the bar right after > is glued');
});
t('relaxRefused (G3/G5): quoted data is data, unquoted syntax refuses, PowerShell *> is a stream redirect', () => {
  const R = hook.relaxRefused;
  for (const s of ['grep "tee.*\\.env" src/a.cjs 2>/dev/null', 'grep "<tag>.*\\.env" src/a.cjs 2>/dev/null', "grep 'a*>b' src/a.cjs 2>/dev/null",
    'grep "x | Out-File" src/a.cjs 2>/dev/null']) assert.strictEqual(R(s), false, s);
  for (const s of ['grep tee.*\\.env src/a.cjs 2>/dev/null', 'grep <tag>.*\\.env src/a.cjs 2>/dev/null', 'grep a*>b src/a.cjs',
    'grep x a 2>/dev/null | "tee" o', 'grep x a 2>/dev/null | t"ee" o', 'grep x a 2>/dev/null | t\\ee o', 'grep x a 2>/dev/null | "/usr/bin/tee" o',
    "sls x a 2>$null | & 'Out-File' o",
    'grep "$(cat <a)" b 2>/dev/null', 'echo a\\>&b 2>/dev/null', 'echo a\\>|b 2>/dev/null', 'grep "x 2>/dev/null']) assert.strictEqual(R(s), true, s);
  for (const s of ['sls x a *>$null', 'sls x a *>&1', 'sls x a *>>log', 'sls x a 2>$null;*>$null']) {
    assert.strictEqual(R(s, 'PowerShell'), false, 'PowerShell: ' + s);
    assert.strictEqual(R(s, 'Bash'), true, 'Bash: ' + s);
    assert.strictEqual(R(s), true, 'omitted shell = Bash: ' + s);
  }
  for (const s of ['sls x a x*>$null', 'sls x a ?>$null', 'sls x a }>$null', 'sls x a >*']) assert.strictEqual(R(s, 'PowerShell'), true, 'PowerShell: ' + s);
});
t('neutralizeSafeRedirects (G4): bash blanks any single-digit fd, never two digits, {fd} or a secret-shaped target', () => {
  const n = hook.neutralizeSafeRedirects;
  for (const s of ['grep x 3>/dev/null', 'grep x 0>o', 'grep x 9>>log', 'grep x 7>&2', 'grep x 0>&1', 'grep x 5> o']) assert.ok(!/>/.test(n(s, 'Bash')), s + ' -> ' + n(s, 'Bash'));
  for (const s of ['grep x 10>/dev/null', 'grep x {fd}>/dev/null', 'grep x 3>.env', 'grep x 3>$LOG', 'grep x 3>|o', 'grep x3>/dev/null']) assert.strictEqual(n(s, 'Bash'), s, s);
  assert.strictEqual(n('sls x 0>o', 'PowerShell'), 'sls x 0>o', 'PowerShell keeps 0> as an argument (section 20 pin)');
});
t('timing: 38,000 clobber/digit redirects (190k chars) decide under the 4 s deadline and never take the "NOT checked" path', () => {
  const big = 'grep -o "\\.env" src/a.cjs' + ' 3>|a 7>&2'.repeat(19000);
  const t0 = Date.now();
  const d = hookDecide(big);
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, 'decide took ' + ms + 'ms');
  assert.ok(!d.warn, d.why);
  assert.strictEqual(d.block, true, 'a clobber redirect is never blanked, so the secret-shaped pattern word keeps its block: ' + d.why);
});

if (BASH_EXE) {
  t('real bash: [n]>| is ONE redirect operator (the next word is its target), any single digit N> is a redirect, and the clobber forms read the file', () => {
    const fwd = (p) => p.replace(/\\/g, '/');
    const run = (f, form) => spawnSync(BASH_EXE, ['-c', '"' + fwd(process.execPath) + '" "' + fwd(SEM_ECHO) + '" ' + form],
      { cwd: SEM, encoding: 'utf8', env: Object.assign({}, process.env, { ARGV_OUT: path.join(SEM, f) }) });
    for (const [f, form, want] of [['c0.json', '>|oc0 X', ['X']], ['c1.json', '1>|oc1 X', ['X']], ['c2.json', '2>|oc2 X', ['X']], ['c3.json', '3>|oc3 X', ['X']],
      ['d3.json', '3>/dev/null X', ['X']], ['d0.json', '0>od0 X', ['X']], ['d9.json', '9>od9 X', ['X']], ['d7.json', '7>&2 X', ['X']],
      ['de.json', '-e 3>&2 X', ['-e', 'X']]]) {
      run(f, form);
      assert.deepStrictEqual(semArgv(f), want, form);
    }
    for (const cmd of ['cat >|oc4 .env; cat oc4', 'grep DUMMY 2>|/dev/null .env', 'grep DUMMY 3>|oc5 .env', 'cat a 2>&1 >|oc6 .env; cat oc6']) {
      const rd = spawnSync(BASH_EXE, ['-c', cmd], { cwd: SEM, encoding: 'utf8' });
      assert.ok(rd.stdout.includes('DUMMY_VALUE'), cmd + ': bash did not read the dummy file: ' + JSON.stringify(rd.stdout + rd.stderr));
    }
  });
}
if (PS_OK) {
  t('real Windows PowerShell: `>|` is a parse error (nothing runs), `*>$null`/`*>&1` are redirects, and `-Pattern *>&1 .env` reads no file', () => {
    const line = (f, form) => "$env:ARGV_OUT='" + path.join(SEM, f) + "'\n& '" + process.execPath + "' '" + SEM_ECHO + "' " + form + '\n';
    const runPs = (name, body) => {
      const ps1 = path.join(SEM, name);
      fs.writeFileSync(ps1, body);
      return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { cwd: SEM, encoding: 'utf8', timeout: 60000, input: '' });
    };
    const bad = runPs('p21a.ps1', line('pc.json', '>|oc X'));
    assert.strictEqual(semArgv('pc.json'), null, 'the program must not run after `>|`');
    assert.ok(/redirection|ParserError|Missing file/i.test(bad.stderr || ''), 'expected a parse error: ' + bad.stderr);
    const ok = runPs('p21b.ps1', line('pn.json', '*>$null X') + line('p1.json', '*>&1 X') + 'Select-String -Pattern *>&1 .env\n');
    assert.deepStrictEqual(semArgv('pn.json'), ['X']);
    assert.deepStrictEqual(semArgv('p1.json'), ['X']);
    assert.ok(!(ok.stdout || '').includes('DUMMY_VALUE'), '-Pattern *>&1 .env must not print the file: ' + JSON.stringify(ok.stdout));
  });
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
