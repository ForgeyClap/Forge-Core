// FU-STEP2 security fix round (Security Boss FAIL, HIGH): the Vite dev origins (:5173) are trusted ONLY
// when the gateway was started with the explicit dev switch FORGE_DEV_ORIGINS=1. Without it a page on
// :5173 (the default port of every Vite project the owner or the agent runs) is a foreign origin: no
// CORS answer, so it can read nothing, and a same-site cookie write from it is refused. The desktop app
// and forge-cc-launch never set the switch.
//
// security.mjs reads the switch once, when it loads (like the UI secret). The wiring is proven in a real
// child process per value; the pure parser is tested directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as security from '../src/security.mjs';

const SECURITY_URL = new URL('../src/security.mjs', import.meta.url).href;
const DEV = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** allowedOrigins() as seen by a fresh gateway process whose environment has FORGE_DEV_ORIGINS = value
 *  (undefined = not set at all). */
function originsInFreshProcess(value) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'FORGE_DEV_ORIGINS') delete env[key];
  if (value !== undefined) env.FORGE_DEV_ORIGINS = value;
  const script = 'const s = await import(' + JSON.stringify(SECURITY_URL) + ');'
    + ' process.stdout.write(JSON.stringify({ origins: [...s.allowedOrigins()], left: process.env.FORGE_DEV_ORIGINS ?? null }));';
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
}

test('RED-first: a gateway started WITHOUT FORGE_DEV_ORIGINS=1 does not trust the Vite dev origins', () => {
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1x', '11']) {
    const { origins } = originsInFreshProcess(value);
    for (const dev of DEV) assert.ok(!origins.includes(dev), JSON.stringify(value) + ': ' + dev + ' must not be allowed');
    assert.ok(origins.includes('http://127.0.0.1:4100'), 'the gateway keeps its own origin');
  }
});

test('a gateway started WITH FORGE_DEV_ORIGINS=1 trusts exactly the two Vite dev origins on top of its own', () => {
  for (const value of ['1', ' 1 ']) {
    const { origins } = originsInFreshProcess(value);
    for (const dev of DEV) assert.ok(origins.includes(dev), JSON.stringify(value) + ': ' + dev);
    assert.deepEqual([...origins].sort(), ['http://127.0.0.1:4100', 'http://localhost:4100', ...DEV].sort());
  }
});

test('RED-first: devOriginsEnabled is a pure parser: only the value 1 switches dev mode on', () => {
  assert.equal(typeof security.devOriginsEnabled, 'function', 'security.mjs must export devOriginsEnabled()');
  assert.equal(security.devOriginsEnabled({ FORGE_DEV_ORIGINS: '1' }), true);
  assert.equal(security.devOriginsEnabled({ FORGE_DEV_ORIGINS: ' 1 ' }), true);
  for (const env of [{}, { FORGE_DEV_ORIGINS: '' }, { FORGE_DEV_ORIGINS: '0' }, { FORGE_DEV_ORIGINS: 'true' }, { FORGE_DEV_ORIGINS: 1 }, { forge_dev_origins_x: '1' }]) {
    assert.equal(security.devOriginsEnabled(env), false, JSON.stringify(env));
  }
  assert.equal(security.DEV_ORIGINS_ENV, 'FORGE_DEV_ORIGINS');
  assert.ok(!/^(cc_|claude_|programfiles)/i.test(security.DEV_ORIGINS_ENV), 'the switch is never forwarded to a claude child');
});

test('RED-first: the in-process switch seam follows the dev switch and null restores the start-up reading', () => {
  assert.equal(typeof security._setDevOriginsForTests, 'function', 'security.mjs must export _setDevOriginsForTests()');
  try {
    security._setDevOriginsForTests(true);
    for (const dev of DEV) assert.equal(security.crossSiteOk({ headers: { origin: dev } }), true, dev);
    assert.equal(security.corsOrigin({ headers: { origin: DEV[1] } }), DEV[1]);
    security._setDevOriginsForTests(false);
    for (const dev of DEV) {
      assert.equal(security.crossSiteOk({ headers: { origin: dev } }), false, dev);
      assert.equal(security.corsOrigin({ headers: { origin: dev } }), null, dev);
      assert.equal(security.cookieSiteOk({ headers: { origin: dev, 'sec-fetch-site': 'same-site' } }), false, dev);
    }
  } finally {
    security._setDevOriginsForTests(null);
  }
  if (!security.devOriginsEnabled(process.env)) {
    assert.equal(security.crossSiteOk({ headers: { origin: DEV[0] } }), false, 'restored to the start-up reading of this process (no switch)');
  }
});
