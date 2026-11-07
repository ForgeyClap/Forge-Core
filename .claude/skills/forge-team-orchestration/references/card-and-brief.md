# Card shape and the cold brief

Read this when you write the cards for a parallel run, or the prompt a dispatched Boss receives.

## Card (as logged with the work package)

```json
{
  "id": "wp-auth-2",
  "title": "Login API endpoints",
  "owner": "Build Boss",
  "route": { "name": "deep", "model": "opus", "effort": "xhigh" },
  "wave": 2,
  "owns": ["src/api/login.js", "tests/login.test.js"],
  "reads": ["src/types/auth.js"],
  "forbidden": [".claude/FORGE_SKILL_REGISTRY.md", ".claude/settings.json"],
  "interface": {
    "imports": "AuthResponse from src/types/auth.js (owned by wp-auth-1)",
    "exports": "POST /api/login handler, used by wp-auth-3"
  },
  "acceptance": [
    "node --test tests/login.test.js exits 0",
    "a wrong password returns 401, not 500"
  ],
  "out_of_scope": ["password reset", "OAuth", "rate limiting"],
  "state": "ready",
  "evidence": [],
  "merge_gate": "Verify Boss PASS on the card, every changed file inside owns, full suite green after merge"
}
```

Rules:
- `owns` lists real project-relative paths with no wildcards. A new file counts too, so list it before the work starts.
- `reads` and `owns` never share a path within one card. A shared file appears under `owns` in exactly one card per wave.
- `acceptance` items are things a verifier can re-run. "Works well" is not a criterion.
- `evidence` is filled from what the agent returned and what Verify Boss re-ran, never from what was expected.

## The six-part brief (the dispatched agent's prompt)
A fresh agent has no memory of this conversation. Give it everything in the prompt:

```markdown
## Objective
<one or two sentences: what this card delivers>

## Owned files
- <path> — <purpose>
- <path> (new) — <purpose>
Shared, read only: <path>, <path>. Owned by other cards (do not edit): <card id>: <paths>.

## Requirements
1. <specific deliverable>
2. <specific deliverable>

## Interface contract
- Imports: <names and shapes this card consumes, and from which card>
- Exports: <names and shapes this card provides, and to which card>

## Acceptance criteria
- [ ] <command and expected result>
- [ ] <observable behaviour>

## Out of scope
- <explicitly excluded work>

Route: <route> (<model>/<effort>) · run=<run_id> · wp=<card id> · next Boss for hand-off: <name>.
Rules: work only inside the owned files; an edit you need elsewhere goes into your report, not into the tree; no commit,
push or delete; end with a forge-report block.
```

## Worked example: a login feature in three cards

| Card | Wave | Owner | owns | Depends on |
|---|---|---|---|---|
| wp-auth-1 shared contract | 1 | Build Boss (deep, opus/xhigh) | `src/types/auth.js`, `src/middleware/auth.js` | none |
| wp-auth-2 login flow | 2 | Build Boss (deep, opus/xhigh) | `src/api/login.js`, `src/pages/login.html`, `tests/login.test.js` | wp-auth-1 |
| wp-auth-3 registration flow | 2 | Build Boss (deep, opus/xhigh) | `src/api/register.js`, `src/pages/register.html`, `tests/register.test.js` | wp-auth-1 |
| wp-auth-4 security pass | 3 | Security Boss (deep, read-only) | none | wp-auth-2, wp-auth-3 |

Every auth card is route `deep`, however small it is: `.claude/FORGE_MODEL_ROUTING.json` → `precedence` puts anything that
touches auth, payments, data, migrations, production or security on deep regardless of size. Build Boss defaults to `build`,
so each `agent()` passes `model: 'opus', effort: 'xhigh'` explicitly. runs as one `parallel()` with two routed `agent()` calls. is read-only and reviews the merged tree. The Lead
merges and runs the full suite before starts.

## Rebalancing signals

| Signal | Likely cause | Action |
|---|---|---|
| A lane idle while others work | Uneven split | Refill it with the next card that does not collide. |
| A lane silent for a long time | Stuck or hung tool | Check the watchdog flag and transcript; stop that exact task and re-dispatch. |
| Every card blocked | Dependency problem | Shorten the critical path; finish the blocking card first. |
| One lane holds 3x the work | Card too big | Split it by file ownership into two cards. |
