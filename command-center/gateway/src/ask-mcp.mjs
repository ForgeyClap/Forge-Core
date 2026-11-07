#!/usr/bin/env node
// Forge Command Center gateway — forge-ask MCP server (feat-ask-owner).
//
// Standalone stdio MCP server. It is spawned by the `claude` CLI ITSELF (never by this gateway
// process directly) via the per-execution --mcp-config file `exec-argv.mjs` writes, so it runs in
// its own OS process and cannot share in-memory state with the gateway (`ask-store.mjs`) — it
// reaches the gateway only over plain HTTP, using `node:http` alone (zero-dependency, matching the
// rest of gateway/src). Deliberately NOT the global `fetch`: Node's built-in fetch (undici) applies
// a default dispatcher with a ~5-minute headersTimeout/bodyTimeout, which would abort a tool call
// that can legitimately stay open up to the ask-store's own real timeout (up to 30 minutes) — a
// plain `http.request()` has no such default, and this file sets its own generous, explicit one
// instead (see CLIENT_TIMEOUT_MS below).
//
// PROVEN SHAPE (2026-07-30 scratchpad spike — Build Boss read the working proof files before
// writing this): a minimal JSON-RPC-over-stdio handshake (initialize -> tools/list -> tools/call)
// really works when the spawning `claude -p ... --mcp-config <file> --strict-mcp-config` session
// calls the one tool this server exposes (`ask_owner`) and waits for its real result text.
//
// PERMISSION CORRECTION (coordinator-measured 2026-07-30, two real, non-mock runs): the argv
// `exec-argv.mjs` builds for the spawning session NEVER adds --allowed-tools/--disallowedTools
// alongside --mcp-config. A real test proved --allowed-tools silently starves every OTHER built-in
// tool (Write/Edit/Bash) while the model still claims success afterwards — exactly the dishonest,
// crippled-agent outcome this feature must never cause. --strict-mcp-config alone only restricts
// WHICH MCP SERVERS load (just this one), never which built-in tools the session may use.
'use strict';

import http from 'node:http';

// WP B1a: the gateway always passes its REAL origin in CC_ASK_GATEWAY_ORIGIN
// (exec-argv.mjs). This fallback only applies to a hand-started server: it follows the same port
// env the gateway reads (CC_PORT, then FORGE_GATEWAY_PORT), default 4100. This file runs as its
// own process, so it cannot ask the gateway's runtime-state for the port.
function fallbackGatewayOrigin(env) {
  for (const raw of [env.CC_PORT, env.FORGE_GATEWAY_PORT]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return 'http://127.0.0.1:' + n;
  }
  return 'http://127.0.0.1:4100';
}
const GATEWAY_ORIGIN = process.env.CC_ASK_GATEWAY_ORIGIN || fallbackGatewayOrigin(process.env);
const CONV_ID = process.env.CC_ASK_CONV_ID || '';
const TURN_ID = process.env.CC_ASK_TURN_ID || null;
const REQUEST_ID = process.env.CC_ASK_REQUEST_ID || null;
// WP B3-sec-impl (Security Boss Step 1a): this server authenticates with its conversation's AGENT
// token (CC_ASK_AGENT_TOKEN, set by the gateway in the `claude` child's environment), never the
// dashboard's exec token. The gateway accepts it only on /api/ask, /api/permissions/request and
// /api/permissions/:id/wait, all bound to this conversation; it is refused on every other write
// route. The header name stays the same; the route decides which kind of token it needs.
const AGENT_TOKEN = process.env.CC_ASK_AGENT_TOKEN || '';
const TOKEN_HEADER = 'x-cc-exec-token';
// Defensive backstop only — the gateway's own ask-store timeout is what actually resolves a call
// honestly (answered or a real "owner did not answer" outcome); this guards solely against the
// gateway process itself dying mid-wait, so it is set comfortably longer than that real timeout.
const CLIENT_TIMEOUT_MS = Number(process.env.CC_ASK_CLIENT_TIMEOUT_MS) > 0
  ? Number(process.env.CC_ASK_CLIENT_TIMEOUT_MS)
  : 32 * 60 * 1000;

let stdinBuffer = '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logErr(message) {
  try {
    process.stderr.write('[forge-ask] ' + message + '\n');
  } catch {
    /* best-effort only — a broken stderr pipe must never crash this process */
  }
}

const ASK_TOOL = {
  name: 'ask_owner',
  description:
    'Ask the human owner one or more questions through the Forge Command Center dashboard and WAIT ' +
    'for the REAL answer before continuing or assuming anything. Use this whenever a choice would ' +
    'materially change what gets built — a single call may carry up to 25 questions for a genuinely ' +
    'thorough intake. Each question may offer multiple-choice options; the dashboard always ALSO ' +
    'lets the owner type something else ("Anders...") instead of picking one. Never guess an answer ' +
    '— call this tool and wait for the real one.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Short label for this question (optional).' },
            question: { type: 'string', description: 'The actual question text shown to the owner.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional multiple-choice options. The owner can always type a free-text answer instead.',
            },
            multiSelect: { type: 'boolean', description: 'Whether the owner may pick more than one option.' },
            recommended: {
              type: 'string',
              description:
                'Optional: the EXACT text of the one option that is genuinely the best fit for THIS situation, based on what you actually examined (project state, owner words, trade-offs) — never by position, popularity or your own convenience. State the reasoning in the question text. Omit entirely when no option is clearly better.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

/** POSTs `body` as JSON to `pathname` on the gateway and resolves with the parsed JSON reply.
 *  Never throws; every failure resolves to `{ ok:false, error, status? }` (`status` only when the
 *  gateway answered). `timeoutMs` is this one HTTP call's own backstop (see the header). */
function postJson(pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    let url;
    try {
      url = new URL(pathname, GATEWAY_ORIGIN);
    } catch (err) {
      resolve({ ok: false, error: 'invalid CC_ASK_GATEWAY_ORIGIN: ' + (err && err.message ? err.message : String(err)) });
      return;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
          [TOKEN_HEADER]: AGENT_TOKEN,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* handled by the fallback below */
          }
          if (parsed === null || typeof parsed !== 'object') {
            resolve({ ok: false, status: res.statusCode, error: 'gateway returned a non-JSON response (HTTP ' + res.statusCode + ')' });
            return;
          }
          if (res.statusCode !== 200 || parsed.ok !== true) {
            resolve({ ok: false, status: res.statusCode, error: typeof parsed.error === 'string' ? parsed.error : 'gateway returned HTTP ' + res.statusCode });
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('the gateway did not respond within ' + timeoutMs + 'ms'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: 'could not reach the gateway at ' + GATEWAY_ORIGIN + ': ' + (err && err.message ? err.message : String(err)) });
    });
    req.end(bodyStr);
  });
}

/** POSTs the real questions to the gateway's `/api/ask` route and waits for its real response —
 *  this single HTTP call is what actually blocks until the owner answers or the ask times out. */
function postAsk(questions) {
  return postJson('/api/ask', { conv_id: CONV_ID, turn_id: TURN_ID, request_id: REQUEST_ID, questions }, CLIENT_TIMEOUT_MS);
}

async function handleAskCall(msg) {
  const args = (msg.params && msg.params.arguments) || {};
  const questions = Array.isArray(args.questions) ? args.questions : null;
  if (!questions || questions.length === 0) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'ask_owner was called with no questions — nothing was asked.' }], isError: true },
    });
    return;
  }

  const outcome = await postAsk(questions);
  if (!outcome.ok) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'Could not ask the owner: ' + outcome.error + ' — no answer was fabricated.' }], isError: true },
    });
    return;
  }
  if (outcome.timed_out) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{
          type: 'text',
          text: outcome.note || 'The owner did not answer within the time limit — no answer was fabricated. Proceed conservatively, or ask again.',
        }],
      },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ answers: outcome.answers }) }] } });
}

// WP B3 (plan 4.4): the permission prompt tool. exec-argv.mjs passes
// `--permission-prompt-tool mcp__forge-ask__permission_prompt`, so Claude Code calls this tool
// whenever a tool call in -p mode needs the user's permission (without it, such a call is denied).
// Contract (Claude Code docs, --permission-prompt-tool): the arguments are { tool_name, input,
// tool_use_id }; the result is ONE text block holding JSON
//   { "behavior": "allow", "updatedInput": { ...the input to run with... } }  or
//   { "behavior": "deny", "message": "why" }.
// The request is registered at POST /api/permissions/request and then long-polled at
// POST /api/permissions/<id>/wait. There is NO answer timeout: an unanswered card stays open
// ("Gepauzeerd" in the UI) and this call keeps waiting. Only a gateway that cannot be reached at all
// for RECONNECT_BUDGET_MS ends in a deny, and that deny says exactly why (never a silent one).
const PERMISSION_TOOL = {
  name: 'permission_prompt',
  description:
    'Forge internal: Claude Code calls this tool to ask the user for permission before another tool runs. ' +
    'Do not call it yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool that wants to run.' },
      input: { type: 'object', description: 'The input that tool would run with.' },
      tool_use_id: { type: 'string', description: 'The id of the tool_use block.' },
    },
    required: ['tool_name', 'input'],
  },
};

const POLL_WAIT_MS = Number(process.env.CC_PERMISSION_POLL_MS) > 0 ? Number(process.env.CC_PERMISSION_POLL_MS) : 25000;
const RECONNECT_BUDGET_MS = Number(process.env.CC_PERMISSION_RECONNECT_MS) > 0 ? Number(process.env.CC_PERMISSION_RECONNECT_MS) : 2 * 60 * 1000;
const RECONNECT_DELAY_MS = 1000;
const MAX_REREGISTER = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function permissionResult(id, decision) {
  const body = decision.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: decision.updatedInput }
    : { behavior: 'deny', message: decision.message || 'The user declined this action in Forge.' };
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
}

function registerPermission(args) {
  return postJson('/api/permissions/request', {
    conv_id: CONV_ID,
    turn_id: TURN_ID,
    request_id: REQUEST_ID,
    tool_name: args.tool_name,
    input: args.input,
    tool_use_id: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
  }, CLIENT_TIMEOUT_MS);
}

function unreachableDeny(error) {
  logErr('permission request: gateway unreachable for ' + RECONNECT_BUDGET_MS + 'ms: ' + error);
  return { behavior: 'deny', message: 'Forge could not reach the user to ask for permission (' + error + '). The action was not performed.' };
}

/** Registers the request and waits for the user's decision. Resolves to { behavior, updatedInput?, message? }. */
async function awaitPermission(args) {
  let registered = await registerPermission(args);
  let reRegistered = 0;
  let unreachableSince = null;
  for (;;) {
    if (!registered.ok) {
      if (registered.status !== undefined) {
        return { behavior: 'deny', message: 'Forge could not register this permission request (' + registered.error + '). The action was not performed.' };
      }
      unreachableSince = unreachableSince || Date.now();
      if (Date.now() - unreachableSince >= RECONNECT_BUDGET_MS) return unreachableDeny(registered.error);
      await sleep(RECONNECT_DELAY_MS);
      registered = await registerPermission(args);
      continue;
    }
    if (registered.decision && registered.decision.decided) return registered.decision;

    const polled = await postJson('/api/permissions/' + encodeURIComponent(registered.id) + '/wait', { wait_ms: POLL_WAIT_MS }, POLL_WAIT_MS + 15000);
    if (polled.ok && polled.decided) return polled;
    if (polled.ok) {
      unreachableSince = null;
      continue; // still waiting: ask again, there is no answer timeout
    }
    if (polled.status === 404 && reRegistered < MAX_REREGISTER) {
      // The gateway restarted and lost its in-memory store: register the same request again.
      reRegistered += 1;
      logErr('permission request ' + registered.id + ' is unknown to the gateway; registering it again');
      registered = await registerPermission(args);
      continue;
    }
    if (polled.status !== undefined) {
      return { behavior: 'deny', message: 'Forge lost this permission request (' + polled.error + '). The action was not performed.' };
    }
    unreachableSince = unreachableSince || Date.now();
    if (Date.now() - unreachableSince >= RECONNECT_BUDGET_MS) return unreachableDeny(polled.error);
    await sleep(RECONNECT_DELAY_MS);
  }
}

async function handlePermissionCall(msg) {
  const args = (msg.params && msg.params.arguments) || {};
  const validInput = args.input && typeof args.input === 'object' && !Array.isArray(args.input);
  if (typeof args.tool_name !== 'string' || args.tool_name.length === 0 || !validInput) {
    permissionResult(msg.id, { behavior: 'deny', message: 'permission_prompt was called without a tool_name and input; nothing was asked.' });
    return;
  }
  const decision = await awaitPermission(args);
  permissionResult(msg.id, decision);
}

async function handleToolCall(msg) {
  const name = msg.params && typeof msg.params.name === 'string' ? msg.params.name : ASK_TOOL.name;
  if (name === PERMISSION_TOOL.name) return handlePermissionCall(msg);
  return handleAskCall(msg);
}

process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString('utf8');
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never crashes this process
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forge-ask', version: '1.0.0' } },
      });
    } else if (msg.method === 'notifications/initialized') {
      // a notification carries no id and expects no response
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [ASK_TOOL, PERMISSION_TOOL] } });
    } else if (msg.method === 'tools/call') {
      handleToolCall(msg).catch((err) => {
        logErr('tools/call handler threw: ' + (err && err.message ? err.message : String(err)));
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'internal ask-mcp error: ' + (err && err.message ? err.message : String(err)) }], isError: true },
        });
      });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
