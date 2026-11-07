// WP B1a: the gateway's own origin follows the port it really listens on (origin allowlist, ask-MCP
// callback origin), the port env is parsed strictly, and GET /api/health carries a per-process
// instance_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  INSTANCE_ID, DEFAULT_GATEWAY_PORT, configuredGatewayPort, setGatewayPort, getGatewayPort, gatewayOrigin,
  isSameGatewayHealth,
} from '../src/runtime-state.mjs';
import { crossSiteOk, allowedOrigins, devOriginsEnabled } from '../src/security.mjs';
import { _buildAskMcpConfigObjectForTests } from '../src/exec-argv.mjs';
import { buildHealth } from '../src/health.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('configuredGatewayPort: CC_PORT wins over FORGE_GATEWAY_PORT; invalid values are ignored', () => {
  assert.equal(configuredGatewayPort({}), null);
  assert.equal(configuredGatewayPort({ CC_PORT: '5001', FORGE_GATEWAY_PORT: '5002' }), 5001);
  assert.equal(configuredGatewayPort({ FORGE_GATEWAY_PORT: '5002' }), 5002);
  assert.equal(configuredGatewayPort({ CC_PORT: 'abc', FORGE_GATEWAY_PORT: '5002' }), 5002);
  assert.equal(configuredGatewayPort({ CC_PORT: '0' }), null);
  assert.equal(configuredGatewayPort({ CC_PORT: '70000' }), null);
  assert.equal(configuredGatewayPort({ CC_PORT: '41.5' }), null);
});

test('the origin allowlist and the ask-MCP origin follow the actual port; the old 4100 origin is dropped', (t) => {
  const before = getGatewayPort();
  t.after(() => setGatewayPort(before));
  setGatewayPort(DEFAULT_GATEWAY_PORT);
  assert.equal(crossSiteOk({ headers: { origin: 'http://127.0.0.1:4100' } }), true);

  setGatewayPort(53127);
  assert.equal(gatewayOrigin(), 'http://127.0.0.1:53127');
  assert.ok(allowedOrigins().has('http://localhost:53127'));
  assert.equal(crossSiteOk({ headers: { origin: 'http://127.0.0.1:53127' } }), true);
  assert.equal(crossSiteOk({ headers: { origin: 'http://127.0.0.1:4100' } }), false, 'after a fallback 4100 is another process');
  // FU-STEP2 security fix round: the Vite dev origin is allowed only with the dev switch FORGE_DEV_ORIGINS=1.
  assert.equal(crossSiteOk({ headers: { origin: 'http://localhost:5173' } }), devOriginsEnabled(process.env), 'the Vite dev origin follows the dev switch');
  const cfg = _buildAskMcpConfigObjectForTests({ convId: 'c-1', turnId: 't-1', requestId: 'r-1' });
  assert.equal(cfg.mcpServers['forge-ask'].env.CC_ASK_GATEWAY_ORIGIN, 'http://127.0.0.1:53127');

  assert.throws(() => setGatewayPort(0), /invalid port/);
  assert.equal(getGatewayPort(), 53127, 'an invalid port never replaces the current one');
});

test('GET /api/health body carries a per-process instance_id, the real port and the data dir', async () => {
  assert.match(INSTANCE_ID, UUID_RE);
  const a = await buildHealth(Date.now());
  const b = await buildHealth(Date.now());
  assert.equal(a.instance_id, INSTANCE_ID);
  assert.equal(b.instance_id, a.instance_id, 'stable for the whole process');
  assert.equal(a.gateway.port, getGatewayPort());
  assert.equal(a.gateway.data_dir, COMMAND_CENTER_DATA_DIR);
});

test('isSameGatewayHealth: same data dir means a duplicate; an older gateway counts only on the default data dir', () => {
  const samePath = (x, y) => path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
  const ours = { dataDir: 'C:/data/a', projectRoot: 'C:/core', usesDefaultDataDir: false, samePath };
  assert.equal(isSameGatewayHealth({ gateway: { data_dir: 'C:/DATA/A' } }, ours), true);
  assert.equal(isSameGatewayHealth({ gateway: { data_dir: 'C:/data/b' } }, ours), false);
  assert.equal(isSameGatewayHealth({ gateway: { project_root: 'C:/core' } }, ours), false, 'older gateway, but we use a custom data dir');
  assert.equal(isSameGatewayHealth({ gateway: { project_root: 'C:/core' } }, { ...ours, usesDefaultDataDir: true }), true);
  assert.equal(isSameGatewayHealth(null, ours), false);
  assert.equal(isSameGatewayHealth({ hello: 'not a gateway' }, ours), false);
});
