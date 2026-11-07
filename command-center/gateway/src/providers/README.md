# Provider layer (WP B2 part 1)

This folder holds the provider registry and adapters for Forge Systeem. It has zero runtime dependencies: `node:http`, `node:https` and `node:child_process` only. Part 2 wires it into the gateway: see "Gateway wiring (part 2)" below.

Source of truth for provider facts: `docs/forge-systeem/PROVIDER-CATALOGUE.md` (checked 2026-11-01). Plan: `docs/FORGE_SYSTEEM_PLAN.md` §4.3.

## Files

| File | Role |
|---|---|
| `registry.json` | One entry per catalogue provider (35). Holds no keys. |
| `registry.schema.json` | Schema for the registry. `schema-validate.mjs` implements the keyword subset it uses and rejects any other keyword. |
| `registry.mjs` | `loadRegistry()`, which fails loudly on a bad entry. Also `resolveBaseURL()` and the semantic rules. |
| `index.mjs` | `createProvider(id, opts)` plus the public exports. Importing it has no side effects. |
| `provider-base.mjs` | The uniform Provider interface. |
| `key-provider.mjs` | The `KeyProvider` interface: `EnvKeyProvider`, `MemoryKeyProvider`, `ChainKeyProvider`. |
| `redact-guard.mjs` | `Redactor`, `ProviderError`, `ERROR_CODES`. |
| `http.mjs` | Transport: timeouts, bounded retry, error classification. |
| `stream-parse.mjs` | SSE parser (handles comment lines, `[DONE]`, CRLF split across chunks) and NDJSON parser. |
| `events.mjs` | Normalised request and event shapes, plus request validation. |
| `adapters/openai-compatible.mjs`, `openai-format.mjs`, `openai-stream.mjs` | `chat-completions` and `responses` styles, plus the quirks table. |
| `adapters/anthropic.mjs` | Messages API, `anthropic-version: 2026-10-21`. Never sends temperature, top_p or top_k. |
| `adapters/gemini-native.mjs` | Model listing and Test only. Native chat is NOT implemented (see below). |
| `adapters/ollama.mjs` | Chat via `/v1`. Native `/api` for tags, pull, delete, show and the `num_ctx` option. |
| `cli/cli-resolve.mjs` | Finds and runs a CLI safely. Includes the Windows npm-shim resolver and a probe env with no API keys. |
| `cli/cli-claude.mjs` | Detection only. Chat is a handoff to the existing exec pipeline. |
| `cli/cli-codex.mjs`, `cli/codex-app-server.mjs` | Detection, plus a stdio JSON-RPC client for `codex app-server`. |
| `cli/cli-generic.mjs` | `gemini-cli` and `grok-build-cli`: detection via `--version` only. |
| `testing/mock-http-server.mjs` | In-process loopback mock server used by the tests. B8's mock providers can reuse it. |

## Provider interface

```js
const p = createProvider('groq', { keyProvider, vars, timeouts });
p.info()                     // card data: label, auth type, key NAME, terms note, caveat, verification. Never a value.
await p.health()             // remote: config only, NO network. Local servers and CLIs: a real probe.
await p.listModels()         // { models: [{ id, ... }], source: 'endpoint'|'static'|'controlplane', note? }
await p.testConnection({ model? })  // cheapest authenticated call of the family (catalogue §5)
for await (const ev of p.chat({ model, messages, stream, tools, options })) { ... }
```

- **Results** of `health()` and `testConnection()` are `{ ok, state, latencyMs, detail, ... }`. `state` is one of: `connected`, `configured`, `reachable`, `not-configured`, `auth-failed`, `unreachable`, `needs-model`, `not-found`, `rate-limited`, `error`, `not-implemented`, `not-installed`, `not-connected`, `signed-in`, `unknown-auth`.
- **`chat()` never throws.** Each event is one of:
  - `text` (`text`)
  - `tool_call` (`id`, `name`, `arguments` parsed or `null`, `rawArguments`)
  - `usage` (`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `cacheWriteTokens`). `inputTokens` is ALL input, including cache reads and writes, for every adapter: OpenAI-style `prompt_tokens`/`input_tokens` already count cached tokens; Anthropic's `input_tokens` excludes them, so the adapter adds `cache_read_input_tokens` and `cache_creation_input_tokens`. `cachedInputTokens` is the cache-read part, `cacheWriteTokens` the cache-write part (Anthropic bills those at a premium; OpenAI reports none, so `null`).
  - `done` (`stopReason`, `model`)
  - `error` (`code`, `message`, `status`, `retryable`, `provider`)

  Success ends with exactly one `done`; failure ends with exactly one `error`. That includes a missing key, which is reported before any network call. `cli-codex` adds `approval` events (see below).
- **Messages:** `{ role: system|user|assistant|tool, content, toolCalls?, toolCallId? }`.
- **Tools:** `{ name, description?, parameters? }`.
- **`options`:** `maxTokens`, `temperature`, `topP`, `stop`, `seed`, `n`, `toolChoice` (`auto|none|required|{name}`), `responseFormat`, `logprobs`, `parallelToolCalls`, `numCtx` (Ollama), `extraBody` (cannot override `model`, `messages`, `input`, `stream` or `tools`), `timeouts` (`{ connectTimeoutMs, firstByteTimeoutMs, totalTimeoutMs, idleTimeoutMs }`), `signal`.
  - **`cli-codex` only:** `cwd` (REQUIRED, absolute path: the folder the codex thread works in; a chat without it is refused with `CONFIG` before anything is spawned), `sandbox` (`read-only` default, `workspace-write` on request; `danger-full-access` is refused), `idleTimeoutMs` (silence allowed inside one turn, default 120 s; paused while an approval is pending).

## KeyProvider and redaction

```js
interface KeyProvider { getKey(name): Promise<string|null>; describe(): { kind, persistent } }
```

`EnvKeyProvider` is the implementation used today. The Electron app will add a `SafeStorageKeyProvider`: the main process decrypts with async `safeStorage` and answers over IPC. `ChainKeyProvider` lets that provider take priority over env. Adapters do not change.

Rules:
- Key names are validated as `UPPER_SNAKE_CASE`.
- A value is returned to the adapter and registered with the shared `Redactor`. It is never logged and never written to disk.
- The redactor removes every registered value, whatever its shape, plus well-known shapes: `sk-`, `sk-ant-`, `nvapi-`, `gsk_`, `xai-`, `AIza`, `hf_`, `AKIA`, `ABSK`, JWT, and the `Authorization`, `x-api-key`, `api-key` and `?key=` forms.
- `ProviderError` redacts its message when it is built, so no error object can carry a key.
- Error messages name the host only, never the full URL.

## Reliability

- **Timeouts in three phases** (`http.mjs` `DEFAULTS`; corrected after the B2 review, which found the first version timed a non-streamed chat out at 15 s while waiting for headers):
  1. *Connect + send*, `connectTimeoutMs` 15 s: until the request (headers and body) has been handed to the socket, which implies TCP and TLS are up.
  2. *First byte*: a buffered call may wait the whole `totalTimeoutMs` (300 s) for headers, because a non-streamed chat only sends headers when the answer is complete; a stream waits `firstByteTimeoutMs` (60 s, covers an Ollama cold model load); GET/HEAD wait the smaller of `firstByteTimeoutMs` and `totalTimeoutMs`.
  3. *Body*: the rest of `totalTimeoutMs` for a buffered body; `idleTimeoutMs` 90 s between stream chunks (Ollama pull: 5 min).
  Health probes pass `connectTimeoutMs: 3000, totalTimeoutMs: 5000`.
- **Retry.** GET/HEAD retry twice, everything else once (`GET_MAX_RETRIES`, `POST_MAX_RETRIES`), with exponential backoff and full jitter. Retried: a failure BEFORE the body left this process (refused, DNS, connect timeout), and an explicit rejection by the server (408, 429, 500/502/503/504/529). `Retry-After` is honoured up to 20 s; a longer wait is not retried.
- **No replay once the body was sent.** A POST whose body reached the socket is never sent again: a header-wait timeout, a reset or an idle stall after that point is a final error (`retryable: false`, message says "not retried"). Only GET/HEAD may be retried after a header-wait timeout. Nothing at all is retried after a 2xx. Proven in `test/providers-http.test.mjs` by counting the requests the mock server received.
- **Body caps.** Buffered bodies are capped at 8 MB. A single SSE line is capped at 4 MB.
- **Ollama delete** requires `{ confirm: true }`. Pull and delete are refused for Ollama Cloud.

## Adding a provider

1. Add an entry to `registry.json`. Use `templateVars` with anchored patterns for any `{region}`, `{resource}`, `{account_id}`, `{workspace}` or `{port}` in the URL.
2. Use `quirks` for parameter differences: `dropParams`, `forceN1`, `dropMessageName`, `temperatureFloor`, `renameParams`, `streamUsageOption`, `noToolsWhileStreaming`, `maxTokensParam`, `storeFalse`.
3. Set `verification` honestly (`verified`, `partial` or `unverified`). Use `streaming`/`toolCalling: "unverified"` for anything not confirmed.
4. Run `node --test test/providers-registry.test.mjs`. The loader rejects:
   - missing or unknown fields
   - http for a remote provider, or a non-loopback address for a local one
   - an undeclared template variable
   - an auth header in `extraHeaders`
   - any key-shaped value
   - keyed auth without `keyEnvName`
5. If the family is new, add an adapter class to `index.mjs` and a mock-server test with a happy path, a streaming path and one error path.

## Terms of service rules (catalogue §3)

- **Subscriptions are never API keys.**
  - The `cli-claude` and `cli-codex` adapters only start the unmodified `claude` or `codex` binaries.
  - They never open, read, copy or store `~/.claude/.credentials.json`, `~/.codex/auth.json` or any OAuth token.
  - Sign-in state comes only from the CLI itself (`claude auth status --json`, `codex login status`, app-server `account/read` with `refreshToken:false`). Personal fields such as email and organisation are dropped as soon as they are read.
- **No `--bare` for claude.** It would skip the user's own sign-in. The registry lists it in `forbiddenArgs`.
- **Codex.** Forge never calls `account/login/start`; the user runs `codex login` themselves. Forge refuses `account/chatgptAuthTokens/refresh` and every other unknown server request with a JSON-RPC error. `clientInfo.name` is the truthful `forge-systeem`, confirmed live in the server's user agent.
- **Gemini CLI OAuth is never reused.** Use `gemini-openai` with an AI Studio key.
- **Every subscription entry has `noticeRequired: true`.** The UI must show `tosNote` and get an explicit acknowledgement before first use. The note includes the quota warning for multi-agent fan-out.
- **CLI probes run with `probeEnv()`.** This is an allowlist with no `*_API_KEY` or auth tokens, so they report the user's own sign-in. A real child process proves this in `providers-cli.test.mjs`.

## Not implemented (honest gaps)

- **Gemini native chat** (`generateContent`/`streamGenerateContent`): not verified on 2026-11-01, so not built. `chat()` returns `NOT_IMPLEMENTED` and points to `gemini-openai`.
- **Bedrock:** SigV4/IAM auth and control-plane model listing are not built. Bedrock API keys (Bearer) work through the OpenAI-compatible Responses route.
- **Azure:** Entra ID bearer tokens are not built. Vercel OIDC is not built.
- **Perplexity:** the Agent API path is unverified, and legacy Sonar chat completions ended 2026-09-27.
- **Reasoning and thinking deltas** are not surfaced yet. Only the five event types above are emitted.
- **Codex:** the WSL install and `CODEX_HOME` detection are partial (only `codexHomeSet` is reported). Approval `accept()` is supported only for command and file-change approvals; the other approval kinds support `decline()` only.
- **Codex `chat()` starts a fresh ephemeral thread per call and sends only the last user message.** Earlier turns of a Forge conversation are not carried over yet. Part 2 keeps one codex thread per conversation (`thread/resume`) and stores the thread id with the shared session store (A4).
- **On Windows, `child.kill()` hits only the npm launcher (`codex.js`).** The native binary shares our pipes and exits on EOF or a broken pipe; EOF is the normal shutdown, and exit 0 was measured live.

## Tests

| Command | What it covers |
|---|---|
| `node --test test/providers-registry.test.mjs test/providers-redact.test.mjs test/providers-stream-parse.test.mjs test/providers-http.test.mjs test/providers-openai.test.mjs test/providers-anthropic.test.mjs test/providers-gemini.test.mjs test/providers-ollama.test.mjs test/providers-cli.test.mjs` | All mock tests. Each uses its own in-process loopback server or the mock app-server fixture. `providers-http.test.mjs` covers the timeout phases and the no-replay rule (slow headers, hung POST, reset after send, retry counts). |
| `FORGE_LIVE=1 node --test test/providers-ollama.live.test.mjs test/providers-claude.live.test.mjs test/providers-codex.live.test.mjs` | Live tests. Without `FORGE_LIVE=1` they are skipped. |

What the live tests do:
- **Ollama:** real chats on the local `qwen2.5:0.5b` with the DEFAULT timeouts (no override), including a tool call that must be named `get_weather`. Never pulls or deletes a model.
- **Claude:** detection only.
- **Codex:** detection, then a real app-server handshake with an empty temporary `CODEX_HOME`, so no credential exists and no turn is started.

`test/fixtures/mock-codex-app-server.mjs` exits at once unless `MOCK_CODEX_MODE` is set, because Node's default `node --test` globs also run every `.mjs` under `test/`.

## Catalogue corrections found by this lane

1. **Local hosts.** Use `127.0.0.1` instead of `localhost`, and make the port a template variable, for Ollama, LM Studio, llama.cpp, vLLM, Jan and LiteLLM. `0.0.0.0:4000` is LiteLLM's bind address, not a client target. vLLM's default port 8000 is an assumption and is marked unverified.
2. **Ollama's `/v1` honours `stream_options.include_usage`.** Measured live on 0.40.13: usage arrives in the last chunk.
3. **Codex wire format checked against `codex app-server generate-json-schema` (codex-cli 0.156.1).**
   - `turn/start` requires `threadId` and `input` (`[{ type: 'text', text }]`); its optional `sandboxPolicy` is an object whose only required field is `type` (`readOnly` | `workspaceWrite` | `dangerFullAccess` | `externalSandbox`).
   - `thread/start` takes `sandbox` as the kebab-case `SandboxMode` enum (`read-only` | `workspace-write` | `danger-full-access`) and `cwd`; both are nullable in the schema, so when omitted the user's own `~/.codex` config decides. Forge therefore always sends both (sandbox `read-only` unless the caller asks for `workspace-write`), and repeats the sandbox as `turn/start.sandboxPolicy`. The response echoes `sandbox: { type: readOnly | workspaceWrite | ... }`.
   - `account/read` takes `refreshToken` and returns `{ account|null, requiresOpenaiAuth }`.
   - Command and file-change approval decisions are `accept`, `acceptForSession`, `decline` and `cancel`. The legacy kinds use `approved` and `denied`.
   - Token usage arrives as `thread/tokenUsage/updated` with `last` and `total`.
4. **Codex sign-in state on this PC.** `codex login status` reports "Logged in using ChatGPT", although the owner said there is no Codex subscription. The stored sign-in may be stale. The adapter therefore reports `signed-in`, not `connected`, and runs no turn (owner-gated).
5. **Claude Code 2.1.316 has `claude auth status --json`.** It returns `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`, plus personal fields that the adapter drops. This is the CLI-only sign-in check the catalogue (§5) left open.
6. **The Codex desktop app runs its own `codex app-server` (separate binary under `AppData\Local\OpenAI\Codex\bin`).** Forge must never treat that process as its own.

## Gateway wiring (part 2, WP B2 part 2)

Contract: `_scratch/b2/contract-providers.md` (routes, status words, env names); desktop side: `_scratch/b2/contract-keys.md`.

| File | Role |
|---|---|
| `key-provider.mjs` `VaultEnvKeyProvider`, `GatewayKeyStore` | Keys from the desktop vault arrive as `FORGE_KEY_<keyEnvName>` at spawn. They are captured once (when `models.mjs` loads, before the server listens) and **deleted from `process.env`**, so no child the gateway starts can inherit them. The plain name (`OPENAI_API_KEY`) is the fallback. Status = present, source (`vault`/`env`), last4 (keys of 16+ characters only). A key change restarts the gateway (desktop contract); no route accepts a key. |
| `provider-status.mjs` | Pure mapping: adapter state to `verbonden` / `niet verbonden` / `geen sleutel` / `niet geinstalleerd` / `fout`; who pays, price band, limits; the official sign-in command (`claude auth login`, `codex login`) that the user runs, never the gateway. |
| `provider-hub.mjs` | Caches (status 60 s, stale-while-revalidate, in-flight shared), probes and the Test call. GET makes no outbound call to a paid API; Test is the only one. `nvidia-nim` uses ONLY the existing `nvidia-provider.cjs` probe (one NVIDIA path). |
| `../routes/providers.mjs` | `GET /api/providers`, `POST /api/providers/:id/test`, `GET /api/providers/keys`, `POST /api/providers/keys/reload`, `GET /api/providers/:id/login-hint`. Registered by the Lead from `_scratch/b2/patches-gw.md`. |
| `../models.mjs` | `GET /api/models` gains a `providers` block (configured providers with models, who pays, price band, limits; waits at most 2.5 s, else `pending: true`). The NVIDIA fields are unchanged. |

Under the Node test runner (`NODE_TEST_CONTEXT`) the default hub does not spawn CLIs, touch local servers or run the NVIDIA CLI unless `FORGE_LIVE=1`; tests inject their own hub (`_setProviderHubForTests`). Tests: `providers-key-store`, `routes-providers`, `models-providers`, `models-vault-scrub`; live: `FORGE_LIVE=1 node --test test/providers-hub.live.test.mjs`.

Still open after part 2: codex chats are not wired into conversations; Ollama pull/delete routes; a `SafeStorage`-backed hot reload (the desktop chose restart); `loadRegistry()` fail-loud at startup in `bin.mjs` (today an invalid registry answers 503 on the provider routes).

## Wiring plan for part 2 (as written in part 1; superseded by the section above where they differ)

1. **Startup.** Call `loadRegistry()` in `bin.mjs`/`server.mjs` startup. A `RegistryError` stops the gateway with the listed problems (fail loud).
2. **Routes** (after A11 splits `server.mjs` into `routes/*.mjs`):
   - `GET /api/providers`: `info()` and `health()` per provider. Health makes no network calls for remote providers.
   - `POST /api/providers/:id/test`: `testConnection()`. Run only on the user's click, because it is outbound.
   - `GET /api/providers/:id/models`: `listModels()`.
   - `POST /api/providers/ollama-local/pull`: SSE progress.
   - `DELETE /api/providers/ollama-local/models/:name`: only after a UI confirmation; pass `confirm: true`.
   - All behind the existing auth and CSRF guard in `security.mjs`.
3. **`models.mjs` (A8).** Keep the NVIDIA matrix view. Add a `providers` block built from `listModels()` of the enabled providers. `nvidia-nim` in the registry is the same endpoint as the existing `nvidia-provider.cjs`; part 2 picks one path and does not run both.
4. **Accounts cards (B0b/B1 UI).** Show one card per `info()`: auth type, who is billed (`subscription`), `tosNote` with an acknowledgement when `noticeRequired`, `caveat`, `verification` and `verifiedOn`, a Test button, Fetch models, and the key's variable NAME. Values are entered once in the Electron main process (`safeStorage`) and are never sent back to the renderer.
5. **Claude chats** keep using `exec-lifecycle.mjs`. `ClaudeCliProvider.handoff()` documents the argv and env contract, and `detectClaude()` can replace the ad-hoc `executionAvailability()` text in the Accounts card. Unify `resolveCli('claude')` with `exec-cli.mjs` `resolveClaudeCliPath()` in one place (A8 decides).
6. **Codex chats** go through `CodexCliProvider.chat()`. The caller MUST pass `options.cwd` (the conversation's project folder, absolute) and may pass `options.sandbox: 'workspace-write'` after the user chose it in the UI; the default is `read-only`. The UI turns `approval` events into the existing permission-card design and answers with `accept()` or `decline()`. An unanswered approval pauses the turn; it is never marked failed. Pin the schema per detected CLI version.
7. **Electron.** `process.execPath` is `electron.exe` inside the app, so the npm-shim path needs `ELECTRON_RUN_AS_NODE=1` or the bundled node runtime. Decide this in B1.
