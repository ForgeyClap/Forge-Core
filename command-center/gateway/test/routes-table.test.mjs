// WP A11 part 1: contract test for server.mjs's ordered route table. The table replaced ~50 inline
// if-branches; first match wins, so a lost, duplicated, reordered or re-homed route changes this
// snapshot and fails here. Update the snapshot ONLY together with a deliberate route change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRoutes } from '../src/server.mjs';

// kind | method | path (string, or RegExp source) | module | handler
const EXPECTED = [
  ['stream', '*', '/api/events/stream', 'projects', 'eventsStream'],
  ['stream', 'GET', '^\\/api\\/conversations\\/([^/]+)\\/stream$', 'conversations', 'stream'],
  ['api', '*', '/api/health', 'system', 'health'],
  ['api', 'GET', '/api/ui-session', 'server', 'status'],
  ['api', 'GET', '/api/discord/status', 'discord', 'status'],
  ['api', 'POST', '/api/discord/start', 'discord', 'start'],
  ['api', 'POST', '/api/discord/stop', 'discord', 'stop'],
  ['api', 'POST', '/api/discord/connect', 'discord', 'connect'],
  ['api', 'POST', '/api/discord/guild', 'discord', 'guild'],
  ['api', 'GET', '/api/discord/projects-dir', 'discord', 'projectsDirGet'],
  ['api', 'POST', '/api/discord/projects-dir', 'discord', 'projectsDirPost'],
  ['api', 'GET', '/api/discord/browse-folder', 'discord', 'browse'],
  ['api', 'GET', '/api/discord/activity', 'discord', 'activity'],
  ['api', 'POST', '/api/projects', 'projects', 'create'],
  ['api', '*', '/api/projects', 'projects', 'list'],
  ['api', '*', '/api/projects/install-status', 'projects', 'installStatus'],
  ['api', '*', '/api/runs', 'projects', 'runs'],
  ['api', 'GET', '^\\/api\\/runs\\/([^/]+)\\/team-chat$', 'projects', 'teamChat'],
  ['api', '*', '/api/events', 'projects', 'events'],
  ['api', '*', '/api/missions', 'projects', 'missions'],
  ['api', '*', '/api/agents', 'registry', 'agents'],
  ['api', 'PATCH', '^\\/api\\/agents\\/([^/]+)\\/model$', 'registry', 'agentModel'],
  ['api', '*', '^\\/api\\/projects\\/([^/]+)\\/profile$', 'projects', 'profile'],
  ['api', 'GET', '/api/mindmaps', 'files', 'mindmaps'],
  ['api', 'GET', '/api/account-rotation', 'server', 'accountRotation'],
  ['api', '*', '/api/skills', 'registry', 'skills'],
  ['api', '*', '/api/models', 'system', 'models'],
  ['api', 'GET', '/api/providers', 'providers', 'list'],
  ['api', 'GET', '/api/providers/keys', 'providers', 'keys'],
  ['api', 'POST', '/api/providers/keys/reload', 'providers', 'keysReload'],
  ['api', 'POST', '^\\/api\\/providers\\/([a-z0-9][a-z0-9-]{0,62})\\/test$', 'providers', 'test'],
  ['api', 'GET', '^\\/api\\/providers\\/([a-z0-9][a-z0-9-]{0,62})\\/login-hint$', 'providers', 'loginHint'],
  // Eigen API (ANY-MODEL-PLAN 2.2 D): added deliberately on 2026-11-02.
  ['api', 'GET', '/api/providers/custom', 'providers-custom', 'list'],
  ['api', 'POST', '/api/providers/custom', 'providers-custom', 'create'],
  ['api', 'PATCH', '^\\/api\\/providers\\/custom\\/(custom-[a-z0-9][a-z0-9-]{0,40})$', 'providers-custom', 'update'],
  ['api', 'DELETE', '^\\/api\\/providers\\/custom\\/(custom-[a-z0-9][a-z0-9-]{0,40})$', 'providers-custom', 'remove'],
  ['api', '*', '/api/checkup', 'system', 'checkup'],
  ['api', '*', '/api/proof', 'run-views', 'proof'],
  ['api', '*', '/api/chat-runs', 'run-views', 'chatRuns'],
  ['api', '*', '/api/pending-asks', 'run-views', 'pendingAsks'],
  ['api', '*', '/api/agent-dispatches', 'run-views', 'agentDispatches'],
  ['api', '*', '/api/active-runs', 'system', 'activeRuns'],
  ['api', '*', '/api/usage', 'system', 'usage'],
  ['api', '*', '^\\/api\\/artifacts\\/([^/]+)\\/content$', 'files', 'artifactContent'],
  ['api', '*', '/api/tools', 'registry', 'tools'],
  ['api', '*', '/api/mcp', 'registry', 'mcp'],
  ['api', '*', '/api/capabilities', 'registry', 'capabilities'],
  ['api', 'GET', '/api/config', 'registry', 'configGet'],
  ['api', 'POST', '/api/config', 'registry', 'configPost'],
  // App router (APP-ROUTER-DESIGN.md 6.1, P3): added deliberately on 2026-11-02.
  ['api', 'GET', '/api/app-router', 'app-router', 'get'],
  ['api', 'POST', '/api/app-router', 'app-router', 'save'],
  ['api', 'GET', '/api/app-router/status', 'app-router', 'status'],
  ['api', 'POST', '/api/app-router/profiles', 'app-router', 'createProfile'],
  ['api', 'POST', '^\\/api\\/app-router\\/targets\\/([a-z0-9][a-z0-9-]{0,31})\\/test$', 'app-router', 'testTarget'],
  ['api', '*', '/api/files', 'files', 'list'],
  ['api', '*', '/api/files/read', 'files', 'read'],
  ['api', '*', '/api/recovery', 'run-views', 'recovery'],
  ['api', '*', '/api/checkpoints', 'run-views', 'checkpoints'],
  ['api', '*', '/api/approvals', 'run-views', 'approvals'],
  ['api', 'GET', '/api/jobs', 'jobs', 'jobsList'],
  ['api', 'GET', '/api/jobs/detail', 'jobs', 'jobDetail'],
  ['api', 'GET', '/api/forge-ops/killswitch/status', 'forge-ops', 'killswitchStatus'],
  ['api', 'GET', '/api/forge-ops/rollback/list', 'forge-ops', 'rollbackList'],
  ['api', 'GET', '/api/forge-ops/rollback/plan', 'forge-ops', 'rollbackPlan'],
  ['api', 'GET', '/api/conversations', 'conversations', 'list'],
  ['api', 'POST', '/api/conversations', 'conversations', 'create'],
  ['api', 'GET', '^\\/api\\/conversations\\/([^/]+)$', 'conversations', 'read'],
  ['api', 'DELETE', '^\\/api\\/conversations\\/([^/]+)$', 'conversations', 'remove'],
  ['api', 'PATCH', '^\\/api\\/conversations\\/([^/]+)$', 'conversations', 'rename'],
  ['api', 'POST', '^\\/api\\/conversations\\/([^/]+)\\/messages$', 'conversations', 'sendMessage'],
  ['api', 'POST', '^\\/api\\/conversations\\/([^/]+)\\/attachments$', 'conversations', 'attach'],
  ['api', 'POST', '^\\/api\\/conversations\\/([^/]+)\\/stop$', 'conversations', 'stop'],
  ['api', 'POST', '^\\/api\\/conversations\\/([^/]+)\\/fork$', 'conversations', 'fork'],
  ['api', 'POST', '^\\/api\\/ask$', 'ask', 'ask'],
  ['api', 'POST', '^\\/api\\/ask\\/([^/]+)\\/answer$', 'ask', 'answer'],
  ['api', 'POST', '/api/permissions/request', 'permissions', 'request'],
  ['api', 'GET', '/api/permissions/pending', 'permissions', 'pending'],
  ['api', 'POST', '^\\/api\\/permissions\\/([^/]+)\\/wait$', 'permissions', 'wait'],
  ['api', 'POST', '^\\/api\\/permissions\\/([^/]+)\\/answer$', 'permissions', 'answer'],
];

const rows = () => describeRoutes().map((r) => [r.kind, r.method, r.path, r.module, r.handler]);

test('the route table matches the snapshot exactly (order, method, path, module, handler)', () => {
  assert.deepEqual(rows(), EXPECTED);
});

test('no (kind, method, path) pair is registered twice', () => {
  const keys = rows().map(([kind, method, p]) => kind + ' ' + method + ' ' + p);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, []);
});
