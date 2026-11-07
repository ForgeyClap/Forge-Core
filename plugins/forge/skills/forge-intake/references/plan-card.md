# forge-intake — the plan card (modernization WP 3.2)

SKILL.md section 1b keeps the five rules; this file keeps the full contract of `.claude/forge-bin/forge-plan-card.cjs`.

## Why

Forge should think WITH the owner, not interrogate them. The intake answers its own questions (silent by default), asks at most one, and then shows ONE card: what will be built, what it will NOT do, and which steps really need the owner. Work stops only for a real blocker (a hard gate, or `plan-approval: always`), and only the packages that hold that blocker wait. This follows the owner's own rules: "Approval given once for a scope stays valid for that whole scope", finish independent work first and batch owner-gated items at the end, and the standing rule `does-it-for-you` ("it does not ask 'shall I continue?' between phases — only a hard gate or a real usage-limit pause interrupts").

## The flow

1. **Goal**: the owner's words, one line.
2. **Real intent**: why they want it (who has the problem, how success shows). Inferred from the request, the scan and `.claude/.forge-setup.json`, never asked separately.
3. **Assumptions**: every gap Forge decided itself, with its F-id where there is one. Sources: `node .claude/forge-bin/forge-promptcheck.cjs plan-input "<raw request>"` (the same scoring as `ask`, re-shaped), the bank question's `beginner.assume`, the project profile.
4. **At most ONE question**: only when two readings lead to materially different builds, or for an outward or irreversible action (THE QUESTION POLICY in SKILL.md). Pick it from the vetted bank with `forge-plan-card.cjs question --domain <slug> [--trigger F<id>]`. It comes with 2–4 choices and the default Forge uses when the owner does not answer.
5. **Plan card**: render it with `--run <run_id>`; it is saved and logged every time.
6. **Proceed**: exit 0 means build now. Exit 3 means the card needs the owner: post the card, the one question (if any) and the approval request in ONE message, start every package listed in `ready`, and wait only with the packages in `blocked`.

## Mission JSON

| Field | Required | Shape | Notes |
|---|---|---|---|
| `goal` | yes | string | one line |
| `intent` | no | string | the real intent; the card says "not stated" when absent |
| `domain` | no | string | the project type (`forge-router` slug) |
| `assumptions` | yes (may be empty) | string, `{id?, text}` or `{id, nl, en}` | the promptcheck shape is accepted as is |
| `question` | no | `{text, choices[2-4], default, answer?, recommended?, id?}` or null | text, choices and default may be a string or `{nl, en}`; `recommended` is an index or null (default 0) |
| `questions` | no | array | only for the cap check: more than ONE entry is refused (exit 2) |
| `packages` | yes (at least 1) | `{id, goal, owns[], route, deps[]?, owner?}` | `owns: []` means read-only; `route` is quick, build or deep (escalate is never chosen up front) |
| `risks` | yes (may be empty) | string[] | |
| `wont_do` | yes (at least 1) | string[] | negations live here; it is never classified |
| `gates` | yes (may be empty) | string or `{text, wp?, id?, command?, path?}` | `wp` links the gate to its package; `id` must be a forge-actiongate gate id |
| `proof` | yes (at least 1) | string[] | how done is proven |
| `approval` | no | `{card?, gates?}` | what the owner already approved (see below) |
| `switches` | no | object from `forge-anticipate.cjs plan --json` (`switches`: `{v, announcement, auto_enabled[], waits_for_owner[], already_on[], respected_off[]}`) | copied unchanged; the card prints the announcement and each `waits_for_owner` label under "Switches (anticipation)" / "Schakelaars (vooruitgedacht)"; part of the card hash (absent = the hash of before); a non-object is a warning and is ignored |

Unknown keys are reported as warnings and never dropped silently. A refused mission lists every problem at once (exit 2): missing goal, an escalate route, a dependency cycle, an unknown dependency or gate id, a gate `wp` that is not a package, an empty `wont_do` or `proof`, more than one owner question, a question without choices or default.

## Hard-gate items

The classifier is reused, never re-implemented: `forge-actiongate.cjs` `classify()` over `.claude/config/orchestration/hard-gates.json` runs on

- every declared gate (its text, plus its `command` and `path` when given);
- the mission goal and every package goal (an action the mission did not declare is still found);
- every `owns[]` path, through the write-outside-root check (a leading `~` is expanded to the home folder first, because the classifier would otherwise read it as a folder inside the project).

A declared gate always counts, also when the classifier does not recognise its words (`recognized: false`, shown as `owner-gate`): fail-closed. A gate found but not declared counts too, and the card says where it was found. The classifier is a classifier, not a proof: an action it does not recognise (for example "lanceer de site" or "laat de klant het weten" in plain words; checked against forge-actiongate.cjs classify on 2026-10-24, WP 2.9c — since WP 3.3 it does recognise "publish to the marketplace" and "delete the old folder") must be declared under `gates`.

Each item gets a key `<gate>@<wp|mission>:<8 hex of the text>`. A changed text is a new key.

## The verdict

| `plan-approval` | needsApproval | stop | Who waits |
|---|---|---|---|
| `auto` | never | none | nobody; the card is still rendered and logged, and a gate action still stops at the action itself (gate hook, forge-actiongate) |
| `gated` (default) | when at least one gate item is not approved | `gated-packages` | the packages holding an open gate item plus every package that depends on them; a gate item without `wp` makes it `all` |
| `always` | until the owner approved THIS card | `all` | every package |

The setting is read through `forge-config.cjs` (`/forge config set plan-approval auto|gated|always`). `--mode` overrides it for one run and the card shows the source ("per-run flag"); the Lead only passes `--mode` when the owner said so for that run.

Exit codes: 0 = no approval needed · 3 = approval needed · 2 = usage or invalid mission · 1 = internal error. `question` exits 0 (one question or an honest null); `validate-bank` exits 0 when valid and 3 when not; both exit 1 when the bank cannot be read.

## Approval: never asked twice

`--json` carries `approvalRecord: {card: <sha256>, gates: [<keys>]}`. When the owner says yes, copy it into the mission as `approval` and re-render:

- `approval.card` equal to the card hash (the full hash or its first 12+ characters) approves the whole card in every mode;
- `approval.gates` approves those gate items in `gated` mode even after the rest of the card changed, so a later edit only asks about the new or changed gate items.

Approving the card is not the gate's own yes. A gate action still goes through its own yes-path (the gate hook `--once` path for the command gates) when it is reached, batched at the end of the mission.

## Expected lanes

Packages are grouped in waves by their `deps` (has no dependencies). Inside a wave, packages whose `owns` overlap (the same file, a folder that contains the other, or a glob over it) share one lane, because one writer per file is a hard rule. The card lists each wave with its lane count, the peak, and every collision.

## The question bank

`.claude/config/intake/question-bank.json` holds the vetted questions per domain (`universal` plus one `byType` set per domain). Every question has choices (`beginner.options` / `options_nl`, at most 3 outcome options plus "something else") and a default (`beginner.assume` / `assume_nl`). Its `one_question_policy` block pins the cap at 1; `forge-plan-card.cjs validate-bank` checks every question and refuses any other cap. `forge-intake.cjs` still reads the same bank for `/forge interview`.

## Example

```json
{ "goal": "Add a contact page to the demo site", "intent": "Visitors can reach the owner without email",
  "assumptions": [{ "id": "F2", "text": "A preview to review, not live" }], "question": null,
  "packages": [
    { "id": "A", "goal": "Build the contact page", "owns": ["src/contact.js"], "route": "build", "owner": "build-boss" },
    { "id": "B", "goal": "Test the contact page", "owns": ["tests/contact.test.js"], "route": "quick", "deps": ["A"] },
    { "id": "C", "goal": "Publish the site", "owns": [], "route": "quick", "deps": ["A", "B"] } ],
  "risks": ["The form may need a backend later"], "wont_do": ["No email sending"],
  "gates": [{ "text": "deploy the site to production", "wp": "C" }], "proof": ["npm test is green", "a screenshot"] }
```

With `plan-approval: gated` this exits 3: the card lists `deploy` for WP C, `blocked` is `["C"]` and `ready` is `["A", "B"]`, so Forge builds and tests now and asks once, at the end, before the deploy.

## What this does not prove

The card proves what the plan says and which steps the classifier sees as gates. It does not prove the plan is complete, that a package's real commands stay inside its `owns`, or that the classifier saw every risky word. The gate hook and forge-actiongate still guard each action when it runs.

## Meta missions (A2)
A META mission tests, evaluates or installs Forge in OTHER project folders that run their own runs. Run `forge-anticipate.cjs plan|apply ... --scope meta`: this run then declares one tooling type (`code`) instead of the projects' craft types and hands no project skills to the start-of-agent fallback (`skills_withheld_meta`). The text is also detected as meta when it names both separate folders and installing or testing Forge; `--scope project` turns that detection off.
