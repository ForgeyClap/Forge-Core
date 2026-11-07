# MCP server patterns — building an MCP server the Forge way

`forge-mcp-clients` is the doctrine for *using* MCP servers. This reference covers the other side:
*building* one (a tool server a Boss or an owner's app will call). It is the working note for the
`mcp-developer` specialist and for `build-boss` when a work package says "make an MCP server". A server
you build is still registered dormant like any other (section 6).

The MCP SDKs change their method names between versions. Nothing below pins an API signature: before
writing code, read the current official MCP documentation or ask Context7 for the SDK version you
installed, and write to what it says.

## 1. The three building blocks

- **Tools**: actions the model may invoke (search, create, run). Each has a name, a description and an
  input schema. The description is part of the prompt: name and describe the tool so the model picks
  it for the right job and not for a neighbouring one.
- **Resources**: read-only data the model may fetch by URI (a file, a record, an API response).
- **Prompts**: reusable, parameterised prompt templates the client can offer to the user.

Prefer a resource over a tool for anything that only reads; it carries no side effect by definition.

## 2. Transport

- **stdio** for a local client on the same machine (Claude Code, a desktop client). The protocol runs
  over stdout, so all logging goes to stderr; a stray print to stdout corrupts the stream.
- **Streamable HTTP** for a remote client. It is the current single-endpoint HTTP transport; the older
  HTTP plus SSE transport only for backward compatibility with an old client.
- Keep the server logic (tool and resource handlers) independent of the transport: one module with the
  handlers, a thin entry point per transport. That keeps tests transport-free.
- A remote server binds to `127.0.0.1` during development, requires authentication before it is ever
  reachable from outside, and going public is a deploy step for the owner, never a default.

## 3. Tool design rules

- **Schema first.** Every tool has an input schema (Zod in the Node/TypeScript SDK, or the SDK's own
  schema format) that rejects bad input before the handler runs. Document every parameter and the
  shape of the result.
- **Small, single-purpose tools** with clear names beat one tool with a mode switch.
- **Idempotent where possible**, so a client retry is safe. A tool with an outside effect (send,
  charge, delete, write to production) takes an idempotency key or refuses a duplicate, and is marked
  in its description as having that effect.
- **Structured errors.** Return an error the model can act on (what failed, whether retrying can help).
  No raw stack trace, no secret, no internal path.
- **Timeouts on every outbound call** the tool makes, with bounded retries; the shared rules are in
  `../../forge-integration/references/webhooks.md` section 4.
- **Rate and cost noted in the description** when the tool calls a paid or rate-limited API, so the
  calling Boss can plan for it.
- **Read-only first.** Split read tools from write tools by name prefix (`read_*`, `list_*`, `get_*`
  versus `create_*`, `update_*`, `delete_*`), so a client can grant the read set and deny the write set
  with a simple allow/deny pattern (see `../SKILL.md` → least privilege).
- **Tool output is untrusted data** for the model that reads it; never put instructions to the model in
  a tool result, and never echo user-supplied text back as if it were an instruction.

## 4. Secrets and configuration

- Credentials come from environment variables read at start-up; a missing required variable stops the
  server with a clear message that names the variable (never its value).
- `.env.example` lists each variable with a one-line purpose and a placeholder described in words.
- Never log a token or a request header that carries one.

## 5. Versioning and tests

- Pin the SDK to an exact version in `package.json`; read the release notes before an upgrade.
- Unit-test the handlers directly (no transport): valid input, invalid input rejected by the schema,
  the error shape, idempotency on a repeated call.
- One end-to-end check through the real transport with a local client before anything is called
  working; quote its output in the report.

## 6. Registering it in Forge

- A new server enters `config/orchestration/mcp-registry.json` with `enabled: false` and an exact
  version or commit pin, then passes `forge-bin/forge-mcp-pin.cjs check`.
- Which Boss may call it is a row in `config/orchestration/mcp-grants.json`, least privilege, never a
  blanket grant.
- No live `.mcp.json` is written; the dormant example pattern is `config/mcp/.mcp.json.example`.
  Enabling a server is an owner decision (`forge-mcp-clients` → opt-in).
- Publishing the server (a package registry, a public endpoint) is a hard gate for the owner.

## Provenance

Adapted in Forge words from the pinned local ECC catalog (affaan-m/ECC), path
`skills/mcp-server-patterns/SKILL.md`, pinned commit e2b8a51cea2228e515e1c3653effbeb62a2800fa, MIT.
Taken: tools, resources and prompts; stdio versus Streamable HTTP; transport-independent logic; schema
first; structured errors; idempotent tools; rate and cost notes; pin the SDK; check current docs or
Context7 instead of trusting a stored signature. Excluded: the `npm install` line, the TypeScript code
sample, the dangling link to ECC's `docs/capability-surface-selection.md` (not present locally),
the SDK list for other languages. Forge additions: stderr-only logging on stdio, localhost binding,
read/write name prefixes for allow/deny grants (the allow/deny guard is an idea from
obra/superpowers-lab mcp-cli, read and rejected as a whole because it builds a binary; idea only, no
text taken), secrets at start-up, the test list, dormant registration.

MIT notice (ECC, Copyright (c) 2026 Affaan Mustafa): "Permission is hereby granted, free of charge, to
any person obtaining a copy of this software ... The above copyright notice and this permission notice
shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS
IS", WITHOUT WARRANTY OF ANY KIND."
