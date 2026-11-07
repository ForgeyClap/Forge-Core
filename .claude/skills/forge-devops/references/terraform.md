# Terraform / OpenTofu — IaC

Two sources, both rewritten in Forge words: hashicorp/agent-skills terraform-style-guide (MPL-2.0, ideas only, no
text) and antonbabenko/terraform-skill (Apache-2.0, (c) 2026 Anton Babenko; adapted, changes listed in the SKILL.md
provenance). Every `apply`, `destroy`, state move and backend migration stays owner-gated.

## Response contract (every Terraform answer or work package ends with this)
1. **Assumptions and version floor:** runtime (`terraform` or `tofu`) and exact version, providers and their versions,
   state backend, where it runs (local, CI, a hosted runner), and how critical the environment is. Say an assumption
   out loud when the owner did not give it.
2. **Risk category** it addresses (table below), one or more.
3. **Chosen fix and its trade-off:** what was chosen, what was given up, why.
4. **Validation plan:** the exact commands for this runtime and risk (`fmt -check`, `validate`, `plan -out=<file>`,
   linters and policy scans).
5. **Rollback notes** for anything that changes or destroys state: how to undo it and which evidence to keep (the plan
   file, the state version, the output).

## Diagnose before you generate
Name the failure mode first, then write HCL. Writing code before naming the mode is how a rename turns into a
destroy-and-recreate.

| failure mode | what you see | first move |
|---|---|---|
| identity churn | addresses shift after a refactor, `count` indexes reshuffle | `for_each` with stable keys, a `moved` block, a plan that shows 0 destroy |
| secret exposure | secrets in defaults, `.tfvars`, state, CI logs or plan output | secret manager or a runtime lookup; `write_only` arguments on 1.11+ |
| blast radius | one huge stack, prod and non-prod share state, applies touch too much | split state per environment and component |
| destroy cascade | a targeted destroy removes more than expected (dependents via locals or `for_each`) | the safe-destroy protocol below |
| CI drift | the CI plan differs from the local plan, apply without a reviewed plan, unpinned versions | pin runtime and providers, commit the lock file, apply the reviewed plan file |
| compliance gap | no policy stage, no approval model, no kept evidence | policy scan on every path to apply, owner approval, keep the plan |
| testing blind spot | plan-only tests on computed values, indexing a set with `[0]` | `command = apply` tests for computed values, `for` over sets |
| state corruption | stuck lock, half-migrated backend, drift | stop, report, owner decides; never force-unlock on a guess |
| provider upgrade risk | breaking provider bump, unpinned modules | upgrade in its own branch and plan, separate from feature work |
| provisioner misuse | `local-exec` / `remote-exec` doing setup, secrets in provisioner output | move setup to the image or config tool; provisioners are a last resort |

## Safe-destroy protocol
- Never run a destroy (full or `-target`) before `terraform plan -destroy` has been shown to the owner with **every**
  resource that will go, including implicit dependents pulled in through locals or `for_each`.
- Never `-auto-approve` a destroy, and never on a production apply.
- A plan that contains a destroy or a replace is Tier 3 in `destructive-commands.md`: state what is lost, wait for a yes.

## Layout and style
- Separate `environments/` (prod, staging, dev) from reusable `modules/`; `examples/` doubles as docs and test fixtures.
  Module hierarchy: resource module (one connected group) → infrastructure module (several, one purpose) → composition
  (the whole estate).
- Standard files: `versions.tf`, provider setup, `main.tf` (resources and data sources), `variables.tf`, `outputs.tf`,
  locals. Keep variables and outputs sorted by name.
- `terraform fmt -recursive`; two-space indent. Resource block order: `count`/`for_each`, arguments, `tags`,
  `depends_on`, `lifecycle` last. Variable block order: description, type, default, validation, nullable, sensitive.
- Names: lowercase with underscores, a descriptive noun that does not repeat the resource type; keep `this` or `main`
  for a true singleton. Prefix variables with their context (`vpc_cidr_block`, not `cidr`).
- Every variable has a type and a description (`optional()` with typed defaults beats an untyped `map(any)`); every
  output has a description and exposes a stable subset, not a whole provider object.
- `count = condition ? 1 : 0` only for an on/off toggle. Items that can be reordered or removed use `for_each`
  (a list index is never a long-lived identity: removing the middle one moves every address after it).

## Pinning and versions
| part | strategy | example |
|---|---|---|
| runtime | stay on major 1, at least 1.9 (`~> 1.9` accepts 1.10 and 1.11; `~> 1.9.0` would pin the minor) | `required_version = "~> 1.9"` |
| providers | pin the major | `version = "~> 5.0"` |
| modules in production | pin exact | `version = "5.1.2"`; git modules to a tag or commit |
| modules in development | allow patch only (three parts after `~>`) | `version = "~> 5.1.0"` |

Commit the dependency lock file on purpose; runtime and provider upgrades go in their own change, never mixed with a
feature.

**Version floor before using a feature** (check the runtime first; an agent that emits a feature the runtime lacks
produces a config that does not even validate):

| feature | min version |
|---|---|
| `moved` blocks, `nullable = false` | 1.1 |
| `optional()` with defaults | 1.3 |
| `import` blocks, `check` blocks | 1.5 |
| native `terraform test` (OpenTofu starts here) | 1.6 |
| mock providers, `removed` blocks | 1.7 |
| provider-defined functions | 1.8 |
| cross-variable validation | 1.9 |
| S3 native lock file (`use_lockfile`) | 1.10 |
| `write_only` arguments (secret never stored in state) | 1.11 |

## State
- Never local state for a team or production: a private, encrypted remote backend with locking and versioning.
- Organise by environment, by component, or both (`prod/networking`, `prod/compute`, `staging/networking`). Split when
  teams or update rhythms differ or a stack grows past a few hundred resources; keep together what is tightly coupled.
- `sensitive = true` only hides a value in output; it is still in state in plain text. Keep secret material out of
  Terraform (runtime lookup from a secret manager) or use `write_only` on 1.11+.

## Never commit / always commit
- Never: state files and their backups, the local `.terraform` folder, saved plan files, `.tfvars` with real values,
  any credential.
- Always: the `.tf` files, the lock file, an example tfvars file with placeholders.

## Testing (pick the cheapest that proves the claim)
| situation | approach |
|---|---|
| syntax and shape | `fmt -check`, `validate` (free) |
| before a PR | plus tflint and a config scanner (trivy, checkov); report not-run when missing |
| simple logic on 1.6+ | native `terraform test`; `command = plan` for input-derived values, `command = apply` for computed values and set-type blocks |
| cost-sensitive unit tests on 1.7+ | mock providers |
| real integration | real infrastructure: paid, owner decision, tagged and cleaned up |

## Workflow and CI
1. `fmt -check` and `validate`, then linters and policy scans.
2. `plan -out=<file>`; show the owner the summary: adds, changes, and above all every destroy or replace.
3. The apply step applies **that reviewed plan file**; it never runs a fresh `plan` inside the apply job (that is how
   CI applies something nobody reviewed).
4. `apply` only after the owner approved that exact plan. Pipeline order: validate → test → plan → apply behind an
   environment with required reviewers; the policy scan sits on every path to apply.

## Review list
- Formatted and validates; standard layout; the response contract is present.
- Types and descriptions on variables, descriptions on outputs, `sensitive` where needed and no belief that it hides
  state.
- No hard-coded credentials; no secret in defaults, tfvars, outputs or provisioner output.
- Versions pinned, lock file committed, backend private with locking; features within the runtime floor.
- Refactors use `moved` blocks and the plan shows 0 destroy.
- Least-privilege IAM; no public buckets, no security group open to the whole internet, no default network, encryption at
  rest and in transit, unless the owner wrote down the reason.
