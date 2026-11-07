// WP A11 part 1 review follow-up (a): the optional-module loader behind GET /api/account-rotation.
// Fixtures are dot-prefixed so 'node --test' (which runs every file under test/) never runs them as tests.
// Before the fix the route mapped ANY ERR_MODULE_NOT_FOUND to 404 not_found, so a present module
// with a broken import inside it was silently reported as "not shipped". Now only an absent module
// FILE is null (-> 404); a broken present module is logged and the error propagates (-> 500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOptionalModule } from '../src/routes/optional-module.mjs';

const FIXTURES = new URL('./fixtures/routes-optional-module/', import.meta.url);

test('an absent optional module file resolves to null (the route answers 404 not_found)', async () => {
  const result = await loadOptionalModule(new URL('not-shipped.mjs', FIXTURES));
  assert.equal(result, null);
});

test('a present optional module loads normally', async () => {
  const mod = await loadOptionalModule(new URL('.present.mjs', FIXTURES));
  assert.equal(mod.value, 'loaded');
});

test('a present module with a broken import propagates ERR_MODULE_NOT_FOUND and logs it', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  await assert.rejects(
    loadOptionalModule(new URL('.broken-import.mjs', FIXTURES)),
    (err) => err && err.code === 'ERR_MODULE_NOT_FOUND',
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /broken-import\.mjs is present but failed to load/);
});

test('an injected missing path is null only because the file is absent, not because of the error code', async () => {
  const missing = new URL('injected-missing.mjs', FIXTURES);
  const notFound = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
  const importer = async () => { throw notFound; };
  assert.equal(await loadOptionalModule(missing, { importer, exists: () => false }), null);
  const logged = [];
  const origError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    await assert.rejects(loadOptionalModule(missing, { importer, exists: () => true }), (err) => err === notFound);
  } finally {
    console.error = origError;
  }
  assert.equal(logged.length, 1);
});

test('any other load error propagates even when the file is absent', async (t) => {
  t.mock.method(console, 'error', () => {});
  const boom = Object.assign(new Error('syntax'), { code: 'ERR_SOMETHING_ELSE' });
  await assert.rejects(
    loadOptionalModule(new URL('x.mjs', FIXTURES), { importer: async () => { throw boom; }, exists: () => false }),
    (err) => err === boom,
  );
});
