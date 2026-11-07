# Dependency graphs, splits and preset teams

Read this when you shape the waves, or choose which Bosses form the team.

## Graph patterns

| Pattern | Shape | Parallelism | Risk | Use when |
|---|---|---|---|---|
| Independent | A, B, C → integrate | Maximum | Incompatibilities show up late, at integration | Cards touch fully separate files and modules |
| Sequential | A → B → C | None | One delay cascades | Each card really consumes the previous output (avoid if you can) |
| Diamond | A → (B, C) → D | B and C together | A is a bottleneck | B and C both need A's contract (shared types) |
| Fork-join (waves) | → → | Inside each wave | Sync delay at each wave boundary | Natural phases: contract → build → test |
| Two chains | A → B → C and A → D → E | Two chains at once | The chains drift apart in approach | Two independent features from one shared start |

In a Workflow: a wave is one `await parallel([...])`. A chain is a `pipeline()` or consecutive awaits that pass each result into
the next prompt. Keep prompts derived from args and earlier results only, so a resumed run replays cleanly.

## Anti-patterns
- **Cycle (deadlock):** A needs B, B needs C, C needs A. Fix: move the shared piece into its own card in an earlier wave.
- **Habit edge:** B waits on A although B does not use A's output. Fix: drop the edge and run B in the earlier wave.
- **Star bottleneck:** one slow card A feeds five others. Fix: split A, or ship A's contract first as a tiny card.
- **Hidden shared file:** two cards both "just add a line" to the same registry or index. Fix: give the file to one card or to
  the integrator, and let the others report the line they need.

## Worked splits
- **CRUD resource by layer:** data layer (model, migration, repository) → service and validation → routes and controller →
  tests. This is a chain, so parallelism is low. Prefer vertical slices (one card per endpoint group, owning its own route,
  service and test files) once the shared model card is merged.
- **Docs and code together:** the code card owns the source files; the docs card owns `docs/...` and reads the code card's
  interface. Docs run in the same wave when the interface is fixed in the contract card, otherwise in the next wave.
- **Skill work:** one card per skill folder. Registry rows, AGENTS.md and other generated indexes stay with the integrator, who
  regenerates them once after the merge.

## Preset teams with Forge Bosses

| Team | Members | Shape | Use when |
|---|---|---|---|
| Review | Review Boss (correctness, architecture) + Security Boss + Test Boss | 3 read-only cards, one dimension each | A diff needs a multi-angle review. Give each a distinct dimension so findings do not duplicate. |
| Debug | 2 to 3 read-only investigators (Build Boss or `deep` agents in read mode), one hypothesis each | Parallel, then the Lead picks | A bug with several plausible causes. Each states what would confirm and what would falsify its hypothesis, with `file:line` evidence. The fix is one later write card. |
| Feature | Lead + 2 Build Boss cards | Contract card, then 2 parallel builders | A feature that splits into two file sets. |
| Fullstack | Lead + UI Boss + Build Boss (API) + Test Boss | UI and API in parallel, tests last | Front end, back end and tests all change. |
| Research | 2 to 3 Search Boss cards, one question each | Parallel, read-only | Comparing options, libraries or sources. For deep, source-verified work use the `deep-research` workflow instead. |
| Security | Security Boss cards per surface (injection, auth, dependencies, secrets/config) | Parallel, read-only | A full audit. Two surfaces are enough for a quick scan. |
| Migration | Lead + 2 Build Boss cards + Verify Boss | Plan, 2 parallel migrators, verify | A framework or API version change spread over many files. Each migrator owns a module set and follows written old→new rules. |

Rules for custom teams:
1. Every team has one coordinator: the Lead.
2. Match the role to a Boss whose tools fit. A Boss without write tools never gets a write card.
3. No duplicate roles. Two agents with the same dimension waste tokens and produce the same findings twice.
4. Define ownership before dispatch, not during.
5. Stay small. Each member above four costs more coordination than it returns, unless the cards are fully independent and
   read-only.
