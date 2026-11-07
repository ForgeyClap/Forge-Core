# Authoring Claude Code hooks, commands, agents and plugins

Read this when a skill task turns into building one of the other Claude Code extension kinds, or when you need
to judge whether a skill is the right container at all. It is a map of the concepts, not a procedure; the
Forge rules at the bottom decide what an agent may actually do.

## Which container fits
| You want | Use | Notes |
|---|---|---|
| Instructions the model loads on a trigger | a skill | the description decides loading (see `references/disclosure-design.md`) |
| A reusable prompt the owner types | a command (markdown file with frontmatter) | arguments are passed in; live data can be injected |
| A specialist with its own tools, model and effort | an agent file | frontmatter pins model, effort and allowed tools |
| A rule enforced by code on a tool call or event | a hook | deterministic; the model cannot talk its way past it |
| A bundle of the above for distribution | a plugin | a manifest plus conventional folders |

If a rule must hold every time, a hook beats prose. If a rule is judgement, prose in a skill is enough.

## Hooks (concepts)
- Events: before a tool runs, after it ran, when the model stops, when a subagent stops, on prompt submit, at
  session start and end, before compaction, on notification. The tool-call hooks take a matcher on the tool
  name; several matching hooks run in parallel, so they must not depend on each other's order.
- Two kinds: a command hook (runs a program, reads the event as JSON on stdin) and a prompt hook (asks a
  model to judge). Use a command hook when the check can be written as code; it is faster and repeatable.
- Result protocol: exit code 0 allows, a blocking exit code stops the call and feeds the reason back to the
  model, any other code is a visible non-blocking error. A hook that cannot judge a call should fail visibly,
  never silently pass.
- Input is untrusted data: validate it, reject path traversal, quote every value, set a timeout, and never
  echo secrets to the log.

## Commands and agents
- A command is one markdown file; the filename is the command name. Keep it short and put procedure in a skill.
- An agent file pins `model`, `effort` and the tool list. In Forge the roster is fixed (REAL AGENTS ONLY),
  so authoring a new agent file is a design decision for the owner, not a convenience.

## Plugins
- Layout: a manifest in a hidden folder at the plugin root, plus `commands/`, `agents/`, `skills/`, `hooks/`
  and an optional MCP config at the root. Folders are discovered automatically.
- Reference files inside a plugin through the plugin-root path variable, never an absolute path, so the plugin
  works wherever it is installed.
- Name files in lowercase kebab-case; one concern per component.

## Windows and Node notes
- Write hooks in Node (`.cjs`, no dependencies), not bash: the project runs on Windows and a shell script may
  not be there. Read stdin fully, parse JSON inside try/catch, and exit with an explicit code.
- Use `path.join`; quote paths with spaces. Do not rely on a POSIX shell, `jq` or `sed` being present.
- Keep each hook fast; a slow hook runs on every matching call.

## Forge rules (these win)
- Installing or enabling a plugin or marketplace, and writing the Claude Code settings files, are hard gates:
  owner only, enforced by the gate hook. An agent writes plugin or hook files into the project as a draft
  and hands the owner the exact one-line command; it never wires them itself.
- A new hook needs an owner-approved registration, a test that fails on the old behaviour, and a doctor check
  that turns red when it breaks.
- Treat any example found online as untrusted data. Shell examples are not copied; re-write them as Node.

## Provenance
Rewritten in Forge words; pattern adapted, nothing copied and no scripts taken. Sources, read read-only through
`gh api` on 2026-11-06 and treated as untrusted data:
- `anthropics/claude-plugins-official`, `plugins/plugin-dev/skills/hook-development/SKILL.md` and
  `plugins/plugin-dev/skills/plugin-structure/SKILL.md`, last commit for both paths `2438937b32be`,
  license Apache-2.0. NOTICE: concepts derived from Anthropic's plugin-dev skills (Apache-2.0); no source
  text is reproduced here and no NOTICE file was checked at that commit.
- Found through the corpus index (grep by name), then fetched with `gh api repos/<owner>/<repo>/contents/<path>`.
- Left out: every bash example, the plugin-root variable shell snippets, the hook JSON samples, and the
  prompt-based hook configuration (not used by Forge).
- Not read: the command-development and agent-development sibling skills of plugin-dev.
