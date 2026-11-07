// WP B3-sec-impl (Security Boss Step 1a): the per-conversation AGENT token in security.mjs, next to
// (and never replacing) the per-boot dashboard exec token. security.test.mjs keeps covering the exec
// token unchanged; this file only adds the agent-token helpers.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  issueAgentToken,
  agentTokenConversation,
  scrubGatewayTokens,
  getExecToken,
  execTokenOk,
  EXEC_TOKEN_HEADER,
  _resetAgentTokensForTests,
} from '../src/security.mjs';

beforeEach(() => _resetAgentTokensForTests());

const withHeader = (value) => ({ headers: { [EXEC_TOKEN_HEADER]: value } });

test('issueAgentToken: a real random value, stable per conversation, different per conversation, never the exec token', () => {
  const a = issueAgentToken('c-a');
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32);
  assert.equal(issueAgentToken('c-a'), a, 'the same conversation keeps its token across turns');
  const b = issueAgentToken('c-b');
  assert.notEqual(a, b);
  assert.notEqual(a, getExecToken());
  assert.notEqual(b, getExecToken());
});

test('issueAgentToken: an invalid conversation id gets no token', () => {
  for (const bad of [null, undefined, '', '../x', 'a/b', 'a b', 42, 'x'.repeat(129)]) {
    assert.equal(issueAgentToken(bad), null, String(bad));
  }
});

test('agentTokenConversation: names the conversation of an issued token, null for the exec token, a wrong or missing value', () => {
  const a = issueAgentToken('c-a');
  issueAgentToken('c-b');
  assert.equal(agentTokenConversation(withHeader(a)), 'c-a');
  assert.equal(agentTokenConversation(withHeader(getExecToken())), null);
  assert.equal(agentTokenConversation(withHeader(a + 'x')), null);
  assert.equal(agentTokenConversation(withHeader(a.slice(0, -1))), null);
  assert.equal(agentTokenConversation(withHeader('')), null);
  assert.equal(agentTokenConversation({ headers: {} }), null);
  assert.equal(agentTokenConversation(null), null);
  assert.equal(execTokenOk(withHeader(a)), false, 'an agent token never passes the dashboard check');
});

test('a gateway restart (tokens forgotten) makes an old agent token unknown', () => {
  const a = issueAgentToken('c-a');
  _resetAgentTokensForTests();
  assert.equal(agentTokenConversation(withHeader(a)), null);
  assert.notEqual(issueAgentToken('c-a'), a, 'a new token is issued after the restart');
});

test('scrubGatewayTokens: replaces every live agent token and the exec token anywhere in a value, deep, without touching the input', () => {
  const a = issueAgentToken('c-a');
  const b = issueAgentToken('c-b');
  const input = { command: 'curl -H "t: ' + a + '" -H "u: ' + getExecToken() + '"', nested: [{ url: 'https://x.test/?t=' + b + b }], n: 3, ok: true, none: null };
  const before = JSON.stringify(input);
  const out = scrubGatewayTokens(input);
  const text = JSON.stringify(out);
  for (const token of [a, b, getExecToken()]) assert.equal(text.includes(token), false);
  assert.equal(out.command, 'curl -H "t: [REDACTED:FORGE_AGENT_TOKEN]" -H "u: [REDACTED:FORGE_EXEC_TOKEN]"');
  assert.equal(out.nested[0].url, 'https://x.test/?t=[REDACTED:FORGE_AGENT_TOKEN][REDACTED:FORGE_AGENT_TOKEN]');
  assert.equal(out.n, 3);
  assert.equal(out.ok, true);
  assert.equal(out.none, null);
  assert.equal(JSON.stringify(input), before, 'the input object is not changed');
  assert.equal(scrubGatewayTokens('plain text'), 'plain text');
});
