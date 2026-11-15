# Default behaviour and quality skills

Every Forge agent gets its behaviour and quality skills by default. They come from one declared source and are measured as delivered. A Lead does not have to remember to map them.

## The one source

`.claude/config/orchestration/FORGE_DEFAULT_SKILLS.json` declares what each agent gets:

| Key | What it means |
|---|---|
| `conduct` | `forge-conduct`: the seven house rules. Every agent preloads it, and every report ends with the line `conduct: forge-conduct v1`. |
| `role_baseline` | Up to 3 behaviour skills per Boss role, for example Build Boss: `forge-testing`, `forge-debug`, `ponytail`. |
| `specialists` | A specialist inherits the baseline of its role, for example `electron-pro` gets the Build Boss baseline. |
| `specialist_extra` | Extra skills for one specialist only. |
| `agent_domain` | Domain skills for one agent only, for example UI Boss: `forge-website`, `forge-mobile`, `forge-verify`. Specialists do not inherit it. |
| `file_less` | Agent types without an agent file, such as `general-purpose`. They get the skills injected at start. |
| `global_agents` | The global GOAT agents (`triage`, `quick`, `build`, `deep`, `escalate`, `verifier`). They preload `forge-conduct` when they are installed. |
| `moments` | One directive line for the main session: a vague owner prompt leads to `forge-prompt-coach`, and new work leads to `forge-brainstorm`. |
| `limits` | The hard limits below. |

The source names only skills that ship with Forge, meaning a folder under `.claude/skills/` with a `SKILL.md`. Plugin skills stay on demand. They are listed per agent in the hand-kept "On demand, when relevant" sentence of its agent file.

## What an agent preloads

`preloadFor(agent)` is the conduct skill, then the role baseline, then the agent domain. Each name appears once, and there are at most 32 names. Claude Code injects the full text of every preloaded skill when the agent starts. Built-in agent types never preload. For them, and for file-less agents, the SubagentStart hook injects the skill pointers instead, in at most 10,000 characters.

## Keeping agent files in step

Never hand-edit the `skills:` list, the `Skill` tool entry, or the text between `<!-- forge-skills:begin -->` and `<!-- forge-skills:end -->` in an agent file. Edit the source and run the generator:

```
node .claude/forge-bin/forge-agent-skills-sync.cjs --check   # exit 1 = drift, names the file
node .claude/forge-bin/forge-agent-skills-sync.cjs --write   # rewrites skills:, Skill tool, generated text, skill map
```

Only agents whose policy class already runs commands get the `Skill` tool: `full-build` and `exec-reviewer`. A skill can register hooks once invoked, so read-only and no-exec agents read a skill's `SKILL.md` file instead.

## Measured, not assumed

A preload fails silently when a skill is missing, is turned off in `skillOverrides`, carries `disable-model-invocation: true`, or is misspelled. So delivery is measured:

- **SubagentStart** records `skills_preloaded` for each agent start, stamped with the `defaults_sha` of the source.
- **SubagentStop** records `skills_opened` and `conduct_seen`, which is true when the report ends with the canary line.
- The run-contract rule `skill-delivered` counts a skill as delivered when it was preloaded or opened.
- The feature registry gives every skill row a `use` field (`used`, `unused-in-runs` or `not-measured`), counted over the last 10 runs by `forge-skill-use.cjs`.

## Guarded by the doctor

`node .claude/forge-bin/forge-doctor.cjs` runs two checks and one advisory for the default skills. Both checks are enforced (red) in the Forge development tree. In a synced project they run as well and name every problem, but they never turn the doctor red there, the same rule the doctor uses for `skill_adapters`. A project without `FORGE_DEFAULT_SKILLS.json` (an install from before the default skills) shows them as n/a.

### `default_skills`

Red in each of these cases, and every red line names the agent, the skill and the fix:

- the agent files drift from the source;
- a listed skill has no `SKILL.md`;
- a listed skill carries `disable-model-invocation: true`;
- a preloaded skill is set to `off` in `skillOverrides` (read from the user, project and local settings files);
- a no-exec agent preloads a skill with hooks or a dynamic-command line;
- the `Skill` tool sits on the wrong policy class;
- an agent has more than 32 skills;
- an injection is over 10,000 characters.

It also measures delivery over the last 10 runs. Only SubagentStart lines stamped with the current `defaults_sha` (the hash of the source as it is now) count, so lines written under an older source do not count against it.

- A declared skill that was never delivered (not preloaded, not opened) to an agent type that was measured is red.
- An agent type with no measured start in that window is SKIP: printed, never red.
- `conduct_seen` mostly false for an agent type is an advisory: the skill arrived, but the reports did not end with the canary line.

A global GOAT agent that is not installed is also SKIP. A skill set to `name-only` in `skillOverrides` is an advisory, never red.

### `memory_order`

`FORGE_MEMORY.md` is newest-first. The check is red when a `## Status` block sits below an older one, and it names both headings and their line numbers. A project with no memory file yet is n/a.

### `listing_budget` (advisory)

Warns when the skill listing would drop descriptions: the estimate of the listed skills against 1% of the context window (8,000 characters for 200,000 tokens, 40,000 for 1,000,000). Plugin skills are not counted, so the estimate is a lower bound. It is never red. Only the owner changes settings files, so the advisory names the exact key (`skillListingBudgetFraction`, or `name-only` in `skillOverrides`) and the doctor never writes it.

The doctor reads the real home folder only when it checks its own project. Any other root, such as a test fixture, is checked without the machine's skills and settings.

## Limits

| Limit | Value |
|---|---|
| `forge-conduct` length | at most 80 lines |
| Role-baseline skills besides `forge-conduct` | at most 3 |
| Skills per agent | at most 32 |
| SubagentStart injection | at most 10,000 characters |
| Moment directive | at most 300 characters |
