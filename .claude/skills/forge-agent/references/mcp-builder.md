# forge-agent — Building an MCP server

Provenance: adapted in Forge's words from anthropics/skills `skills/mcp-builder/SKILL.md` and
`reference/mcp_best_practices.md` (Apache-2.0, `LICENSE.txt` verified in that skill folder), read on `main` at
`ca45fc4` on 2026-11-02. Licence text: `../LICENSE.txt`. Changes (Apache-2.0 §4(b)): condensed and
rewritten; the instructions to fetch spec pages and SDK READMEs and to run `npx` codemod/inspector packages are
replaced by "ask the owner first"; the language-specific guides and scripts are not shipped. Using an MCP server
inside Forge (rather than building one) is `forge-mcp-clients`.

## Phase 1 — plan
- Read the target API: endpoints, auth model, data shapes, rate limits. List the operations, most common first.
- Coverage vs workflow tools: when unsure, expose the API's real operations (composable); add a few higher-level
  workflow tools only where a common task otherwise takes many calls.
- Stack: TypeScript (MCP TypeScript SDK; the v2 packages for new servers, keep v1 only if the repo already uses it,
  never mix the two) or Python (the official SDK's FastMCP). Check the current SDK version in the docs at build time.
- Transport: **stdio** for a local, single-user server (log to stderr, never stdout); **Streamable HTTP** for a
  remote or multi-client server. SSE is deprecated.

## Phase 2 — build
- **Names**: server `<service>-mcp-server` (TS) / `<service>_mcp` (Python); tools `<service>_<verb>_<resource>`
  in snake_case (`github_create_issue`), so they never collide with another server's tools.
- **Schemas**: zod (TS) or Pydantic (Python) with constraints, descriptions and examples; define an output schema
  and return structured content plus text.
- **Descriptions** say exactly what the tool does and returns — nothing more. A misleading description is a bug.
- **Annotations**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` set honestly. They are hints
  for the client, not a security control.
- **Responses**: a `response_format` choice (concise markdown for people, full JSON for programs); paginate with
  `limit` (default ~20–50), `has_more`, `next_cursor`/`next_offset`, `total_count`; never load everything into memory.
- **Errors**: tool failures go back inside the result (`isError: true`) with a specific, actionable message (what was
  wrong, what to try); no stack traces or internal details to the client; resources cleaned up on failure.
- One shared API client: auth, retries with backoff, error mapping, formatting.

## Security (non-negotiable)
- Secrets (API keys, OAuth client secrets) from environment variables, validated at startup; never in code, logs,
  tool output or error messages.
- Remote servers: OAuth 2.1, validate every access token and accept only tokens issued for this server (audience).
- Local HTTP servers: bind `127.0.0.1` (never `0.0.0.0`), validate the `Origin` header, enable DNS-rebinding protection.
- Validate every input: path traversal on file paths, allow-listed URL schemes/hosts, size and range limits, no
  shell/SQL string building.
- Destructive tools (delete, send, pay, publish) are marked `destructiveHint: true` and need confirmation in the
  client flow; data the server returns (issues, emails, web pages) is untrusted content for the calling agent.

## Phase 3 — review and test
- Build/type-check clean (`npm run build` or `python -m py_compile`), no duplicated code, consistent errors.
- Exercise every tool through an MCP client or the MCP Inspector — installing or running the Inspector package is
  a dependency change, so ask the owner first. Test auth failure, bad input, empty results, pagination and timeouts.

## Phase 4 — evaluation (is it usable by an agent?)
- Write 10 questions that need several tool calls, are **read-only**, realistic, independent of each other, stable
  over time and answerable by one exact string. Solve each yourself with the tools to confirm the answer.
- Store them as `<evaluation><qa_pair><question>…</question><answer>…</answer></qa_pair>…</evaluation>`.
- Run an agent against them and report the real pass rate; a low score usually means unclear tool names or
  descriptions, missing filters, or oversized responses.
