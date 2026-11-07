# forge-n8n — hard rules in detail

Detail behind the hard rules in `../SKILL.md`. The deeper how-to lives in the `n8n-*` skills
(`n8n-node-configuration`, `n8n-expression-syntax`, `n8n-code-javascript`, `n8n-validation-expert`);
this file holds the rules Forge enforces on top of them. Field names follow the community n8n-mcp tool
family; check them against the connected instance before you rely on them.

## 1. Error handling posture by workflow shape

| Workflow shape | Posture |
|---|---|
| Webhook or API (anything with a Respond to Webhook node) | Required: every fallible node's error output wired on both halves, status code matches the cause |
| Scheduled, queue worker, agent tool (unattended) | Required: an Error Trigger workflow plus `retryOnFail` on idempotent network nodes (section 3) |
| A one-off the owner runs and watches | Optional: the default `onError: "stopWorkflow"` is acceptable, the red node is visible |

The dividing line: if anyone other than the person running it sees the result (a downstream system, an
end user, an alert channel), the failure must be handled, not swallowed.

## 2. Error outputs (the two halves)

- `onError` values: `stopWorkflow` (default, halts), `continueRegularOutput` (error item goes down the
  normal output; almost always wrong, downstream keeps going on error-shaped data),
  `continueErrorOutput` (error item goes down `main[1]`; the one to wire).
- Both halves, then verify with the workflow JSON (`n8n_get_workflow` or the export): the node has
  `onError: "continueErrorOutput"` and `connections["<node>"].main[1]` contains the handler.
- Several fallible nodes may fan in to one error responder; keeps the canvas readable.
- A wired error output whose handler drops the data counts as "handled": the Error Trigger workflow
  will not fire for it. Only catch per node when the handler does something with the error.
- Do not catch an exception inside a Code node and return it as normal data. Let it throw and route it
  through the error output, or handle it deliberately and say why in the node note.

### Failures the error output never sees
- A JavaScript error inside `{{ }}` (a missing path, `JSON.parse` on bad input, a JMESPath syntax
  error): the field becomes `null` and the item takes the success path.
- A Python Code node rejected before it runs (a blocked import) or returning the wrong shape: the node
  is marked failed but the unchanged input items leave through the success output.
- Guard the data, not only the node: after a transform whose output matters, an IF or Filter checks
  that the produced field is present (`!== undefined && !== null`) and sends a miss down the error path.

## 3. Retries

`retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 5000` on a network node only when a repeat is
harmless: reads, GETs, an upsert keyed on an id, or a write that carries an idempotency key. The engine
caps `maxTries` at 5 and `waitBetweenTries` at 5000 ms, and retries on any error (it cannot tell a `400`
from a `503`). A call that must not repeat an outside effect (send a mail or message, create a record,
order or payment, a POST without an idempotency key) first gets an idempotency key or a dedupe check;
without one, switch retries off for that node and route its error output. Shared retry and dead-letter rules:
`../../forge-integration/references/webhooks.md` section 4.

## 4. Response shapes for webhook workflows

- Webhook trigger uses `responseMode: "responseNode"`; every path ends at a Respond node.
- `4xx` is decided before the work: one IF node with one boolean condition per input rule (combinator
  `and`); false goes to a `400` Respond with a static `validation_error` body that names the expected
  fields so the caller can correct itself.
- `5xx` comes out of error outputs: a Switch on the error message classifies the cause, one static
  Respond per status, `options.fallbackOutput: "extra"` feeding a `500` Respond.

| Cause | Status | `error` code |
|---|---|---|
| Required field missing or wrong type | 400 | `validation_error` |
| Auth missing or invalid | 401 | `unauthorized` |
| Authenticated but not allowed | 403 | `forbidden` |
| Referenced record absent in your data | 404 | `not_found` (branch on the lookup result, not its error) |
| Duplicate or conflicting state | 409 | `conflict` |
| Caller over the rate limit | 429 | `rate_limit_exceeded` plus a `Retry-After` header |
| Node failed, cause unknown | 500 | `internal_error` |
| Third-party API answered with an error | 502 | `upstream_error` |
| Downstream temporarily unavailable | 503 | `service_unavailable` |
| Third-party API timed out | 504 | `upstream_timeout` |

- The code is set in `options.responseCode` on each Respond node; a top-level `responseCode` is ignored
  and the default is `200`, also on error branches.
- Body `{ "error": "<code>", "message": "<sentence>" }`. The full error (stack, upstream body) goes to a
  private log, never into the response.
- A webhook that changes state, sends messages, touches production data or triggers a paid action never
  runs with `authentication: "none"`.

## 5. The Error Trigger workflow (catch-all)

- A separate workflow starting with an Error Trigger node: capture, then notify.
- The alert names the workflow, the failed node, the real error message and links to the editor and the
  failed execution.
- Alert on a different channel than the monitored workflows use, with a fallback (for example a Data
  Table row) so a down channel cannot swallow the alert.
- Assigning it (Workflow Settings → Error Workflow) is a UI step on the community MCP. Build the
  workflow, then put the UI step in the owner queue. The instance-native MCP may expose a setting for
  it; use it only when that family is the one connected.

## 6. Expression rules

- Webhook data lives under `$json.body` (the root also holds headers, params and query).
- Wrap once: `{{ $json.x }}`. Double braces print literally; text without braces is a literal string.
- The `=` prefix belongs only in JSON mode or when the whole field is an expression; in a text field it
  is printed.
- Node references are quoted and case-sensitive: `$('Fetch Order').item.json.id`; with `$node["Name"]`
  always add `.json`.
- Field names with spaces use brackets (`$json["first name"]`); array indexes use brackets, not dots.
- Webhook paths are static; dynamic parts use URL parameters (`orders/:orderId`), never an expression.
- `$env` does not work in expressions (it throws at runtime). Secrets come from credentials; shared
  non-secret settings from instance variables or a Data Table.
- In a long or branchy workflow reference the stable source node by name instead of `$json`, which
  silently changes meaning when a node is inserted. Where branches converge, reference a named merge
  point, never "whatever `$json` the last branch left".
- No function bodies inside `{{ }}` in a normal node. Several statements are code: use a native node
  plus short expressions, or a Code node with a `Why Code:` note.
- To see an error that resolved to `null`, wrap the expression temporarily in a try/catch that prints
  the message, fix the path, then remove the wrapper.

## 7. Code-node rules

- Default to JavaScript; Python only when the owner asks (native Python has no n8n helpers and no
  imports by default).
- Return the mode-portable shape: an array of `{ json: { ... } }` items.
- `$input.all()` and `$input.first()` work in "Run Once for All Items"; `$input.item` exists only in
  "Run Once for Each Item".
- No `{{ }}` inside code; the code reads the data directly.
- Outbound HTTP from code uses `this.helpers.httpRequest()`; the bare `$helpers` global is undefined in
  the task-runner sandbox. Prefer the HTTP Request node, which carries credentials and retries.
- Hashing and HMAC use the native Crypto node, XML/RSS the native XML node; not hand-written code.
- An aggregation over `$input.all()` runs once (`executeOnce: true` on the node) or it repeats per item.
- An agent's Code Tool has a different contract (its input arrives as the query); use the
  `n8n-code-tool` skill for it.

## 8. Review checklist (run before the validation gate)

Must fix:
- Tokens, keys or passwords typed into node fields, Set nodes or Code nodes.
- Placeholder credential ids left in a `credentials` block (omit the block when the real id is unknown).
- User input inside a SQL text instead of query parameters.
- Merge with three or more sources but the input count still at two; Merge input index off by one.
- Error output enabled but unwired, or wired but not enabled.
- Switch without a fallback output.
- A sensitive webhook with `authentication: "none"`.
- An error branch that answers `200`.

Should fix:
- A Set node that only re-maps fields for the next node (inline the expressions at the consumer).
- A Code node doing a native node's job; a Code or HTTP Request node without its `Why Code:` /
  `Why HTTP:` note.
- HMAC computed over `JSON.stringify($json.body)` instead of the raw body.
- `$json.x` deep in a branchy workflow; `$env` anywhere.
- A Date & Time node that drops the other input fields when downstream still needs them
  (`options.includeInputFields: true`).

Then: `validate_workflow`, then re-read the JSON for the items validation cannot see, then one test
execution with the output values read.

## Provenance

Rules rewritten in Forge words from czlonkowski/n8n-skills at e037563e101749e630e6688d121d04529fe6ee7b
(MIT; skills n8n-error-handling, n8n-expression-syntax, n8n-code-javascript, n8n-validation-expert),
with ideas from n8n-io/skills at 27b6b9f429ac0be90cae764512dbc579d7107e95 (Apache-2.0, ideas only).
Excluded: every tool-call snippet, example workflow JSON, install or update command. Full table and the
MIT notice: `../SKILL.md` → Provenance.
