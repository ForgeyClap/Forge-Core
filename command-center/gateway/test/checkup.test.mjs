// WP B6 — GET /api/checkup (checkup.mjs) with a stubbed execFile, fetch, statfs and access: no real
// process is ever spawned and nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckup, getCheckup, parseSignedIn, _resetCheckupCacheForTests } from '../src/checkup.mjs';

/** A fake execFile driven by a table `"<file> <args...>" -> { stdout } | { error } | { hang }`. */
function fakeExecFile(table, calls = []) {
  return (file, args, options, callback) => {
    const key = [file, ...args].join(' ');
    calls.push({ file, args, options });
    const entry = table[key];
    if (!entry) return setImmediate(() => callback(new Error('not found: ' + key), ''));
    if (entry.hang) return undefined; // never answers: exercises the deadline
    setImmediate(() => callback(entry.error ? new Error(entry.error) : null, entry.stdout ?? ''));
    return undefined;
  };
}

function okFetch(body) {
  return async () => ({ ok: true, json: async () => body });
}

function failFetch() {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

const BASE = {
  platform: 'win32',
  env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
  nodeVersion: '24.18.0',
  diskPath: 'C:\\Users\\someone',
  statfs: async () => ({ bavail: 50_000_000, bsize: 4096 }),
  access: async () => undefined,
  port: 4123,
};

const FULL_TABLE = {
  'where claude': { stdout: 'C:\\Tools\\claude.exe\r\n' },
  'C:\\Tools\\claude.exe --version': { stdout: '2.1.316 (Claude Code)\n' },
  'C:\\Tools\\claude.exe auth status --json': {
    stdout: JSON.stringify({ loggedIn: true, email: 'person@example.com', orgName: 'Somebody', subscriptionType: 'max' }),
  },
  'where codex': { stdout: 'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n' },
  'C:\\Windows\\system32\\cmd.exe /d /s /c ""C:\\npm\\codex.cmd" --version"': { stdout: 'codex-cli 0.48.0\n' },
  'where ollama': { stdout: 'C:\\Ollama\\ollama.exe\r\n' },
  'where git': { stdout: 'C:\\Git\\cmd\\git.exe\r\n' },
  'C:\\Git\\cmd\\git.exe --version': { stdout: 'git version 2.51.0.windows.1\n' },
};

test('reports every tool found, with versions, sign-in state, Ollama models, disk, port and folder access', async () => {
  const calls = [];
  const result = await buildCheckup({
    ...BASE,
    execFile: fakeExecFile(FULL_TABLE, calls),
    fetch: okFetch({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:4b' }, { bogus: 1 }] }),
    projectDir: 'C:\\Users\\someone\\Documents\\Forge Projecten\\site',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.claude, { found: true, version: '2.1.316', signedIn: true });
  assert.deepEqual(result.codex, { found: true, version: '0.48.0' });
  assert.deepEqual(result.ollama, { found: true, up: true, models: ['llama3.2:latest', 'qwen3:4b'] });
  assert.deepEqual(result.node, { version: '24.18.0' });
  assert.deepEqual(result.git, { found: true, version: '2.51.0' });
  assert.equal(result.disk_free_gb, 204.8);
  assert.equal(result.port, 4123);
  assert.equal(result.writable_project_dir, true);
  assert.equal(result.timed_out, false);
  // Every call is execFile with a timeout and a hidden window; the .cmd shim goes through cmd.exe verbatim.
  for (const call of calls) {
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 4000, 'each probe has its own timeout');
    assert.equal(call.options.windowsHide, true);
  }
  const shim = calls.find((c) => /cmd\.exe$/.test(c.file));
  assert.equal(shim.options.windowsVerbatimArguments, true);
});

test('never passes the account e-mail or organisation on: only the loggedIn boolean survives', async () => {
  const result = await buildCheckup({ ...BASE, execFile: fakeExecFile(FULL_TABLE), fetch: failFetch() });
  const text = JSON.stringify(result);
  assert.ok(!text.includes('person@example.com'));
  assert.ok(!text.includes('Somebody'));
  assert.ok(!text.includes('max'));
  assert.equal(parseSignedIn('{"loggedIn":false}'), false);
  assert.equal(parseSignedIn('not json'), null);
  assert.equal(parseSignedIn('{"loggedIn":"yes"}'), null);
});

test('missing tools and a stopped Ollama are reported as not found, never guessed', async () => {
  const result = await buildCheckup({ ...BASE, execFile: fakeExecFile({}), fetch: failFetch() });
  assert.deepEqual(result.claude, { found: false, version: null, signedIn: null });
  assert.deepEqual(result.codex, { found: false, version: null });
  assert.deepEqual(result.ollama, { found: false, up: false, models: [] });
  assert.deepEqual(result.git, { found: false, version: null });
  assert.equal(result.writable_project_dir, null, 'no folder asked about');
});

test('a bare npm shim without extension is not executed on Windows', async () => {
  const calls = [];
  const result = await buildCheckup({
    ...BASE,
    execFile: fakeExecFile({ 'where codex': { stdout: 'C:\\npm\\codex\r\n' } }, calls),
    fetch: failFetch(),
  });
  assert.deepEqual(result.codex, { found: false, version: null });
  assert.ok(!calls.some((c) => c.file === 'C:\\npm\\codex'));
});

test('an unsafe shim path is never handed to cmd.exe', async () => {
  const calls = [];
  await buildCheckup({
    ...BASE,
    execFile: fakeExecFile({ 'where codex': { stdout: 'C:\\evil&calc\\codex.cmd\r\n' } }, calls),
    fetch: failFetch(),
  });
  assert.ok(!calls.some((c) => /cmd\.exe$/.test(c.file)));
});

test('sign-in state is unknown (null) when the auth command fails, while the version still shows', async () => {
  const table = { ...FULL_TABLE, 'C:\\Tools\\claude.exe auth status --json': { error: 'unknown command' } };
  const result = await buildCheckup({ ...BASE, execFile: fakeExecFile(table), fetch: failFetch() });
  assert.deepEqual(result.claude, { found: true, version: '2.1.316', signedIn: null });
});

test('a hanging probe cannot hold the answer past the budget', async () => {
  const table = { ...FULL_TABLE, 'where git': { hang: true } };
  const started = Date.now();
  const result = await buildCheckup({ ...BASE, execFile: fakeExecFile(table), fetch: failFetch(), budgetMs: 150 });
  assert.ok(Date.now() - started < 2000, 'answered well inside the budget');
  assert.equal(result.timed_out, true);
  assert.deepEqual(result.git, { found: false, version: null });
  assert.equal(result.claude.found, true, 'the other probes still report');
});

test('folder access: unwritable, network path and relative path', async () => {
  const denied = await buildCheckup({
    ...BASE,
    execFile: fakeExecFile({}),
    fetch: failFetch(),
    access: async () => {
      throw new Error('EACCES');
    },
    projectDir: 'C:\\Program Files\\x',
  });
  assert.equal(denied.writable_project_dir, false);

  let accessCalled = false;
  const spy = async () => {
    accessCalled = true;
  };
  const unc = await buildCheckup({ ...BASE, execFile: fakeExecFile({}), fetch: failFetch(), access: spy, projectDir: '\\\\host\\share\\x' });
  assert.equal(unc.writable_project_dir, null);
  const relative = await buildCheckup({ ...BASE, execFile: fakeExecFile({}), fetch: failFetch(), access: spy, projectDir: 'relative\\dir' });
  assert.equal(relative.writable_project_dir, null);
  assert.equal(accessCalled, false, 'a network or relative path is never touched');
});

test('disk space is null when it cannot be read', async () => {
  const result = await buildCheckup({
    ...BASE,
    execFile: fakeExecFile({}),
    fetch: failFetch(),
    statfs: async () => {
      throw new Error('ENOSYS');
    },
  });
  assert.equal(result.disk_free_gb, null);
});

test('getCheckup shares one answer for repeated calls within the cache window', async () => {
  _resetCheckupCacheForTests();
  let spawns = 0;
  const execFile = (file, args, options, callback) => {
    spawns += 1;
    setImmediate(() => callback(new Error('missing'), ''));
  };
  const opts = { ...BASE, execFile, fetch: failFetch() };
  const [a, b] = await Promise.all([getCheckup(opts), getCheckup(opts)]);
  const c = await getCheckup(opts);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(spawns, 4, 'one where-lookup per tool, once');
  _resetCheckupCacheForTests();
});
