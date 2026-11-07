---
name: claude-md-improver
description: "Use when asked to check, update or fix CLAUDE.md files."
# A10 original description (listing budget): "Audit and improve CLAUDE.md files. Use when asked to check, audit, update or fix CLAUDE.md or project memory."
# W2-BUDGET original description (listing budget): "Audit and improve CLAUDE.md files. Use when asked to check, update or fix CLAUDE.md."
tools: Read, Glob, Grep, Bash, Edit
license: Apache-2.0 (complete terms in LICENSE.txt)
---

<!--
  Source: https://github.com/anthropics/claude-plugins-official
  Pinned commit: 6bfd4e0c6d3da6050984fa5ed8281d915fa7ed69
  Upstream path: plugins/claude-md-management/skills/claude-md-improver/
  License: Apache-2.0 -- complete terms in LICENSE.txt next to this file
  Forge vendor note: this provenance block and the frontmatter license: key added (Apache-2.0 section 4(b) change notice); the rest of the frontmatter, the body and all three upstream references files verbatim, EXCEPT the Forge-added parts marked "Forge addendum" (SA-W1-B4): one pointer paragraph before Phase 4, the section "Forge addendum" plus the provenance table at the end of the body, and the Forge-owned file references/forge-disclosure-doctrine.md (not upstream); LICENSE.txt is the plugin-root LICENSE, unmodified; not shipped from the plugin: README.md (plugin install notes that embed two screenshots), the two PNG screenshots and the .claude-plugin manifest; the command half of the plugin ships as the revise-claude-md command; no NOTICE file exists in the pinned plugin directory or repo root.
  Reviewed for prompt-injection patterns, hidden/zero-width/bidi/control unicode, network use and deletes by build-boss, 2026-09-24 -- clean; every upstream file sha256-verified against the pinned-commit manifest before copying.
-->

# CLAUDE.md Improver

Audit, evaluate, and improve CLAUDE.md files across a codebase to ensure Claude Code has optimal project context.

**This skill can write to CLAUDE.md files.** After presenting a quality report and getting user approval, it updates CLAUDE.md files with targeted improvements.

## Workflow

### Phase 1: Discovery

Find all CLAUDE.md files in the repository:

```bash
find . -name "CLAUDE.md" -o -name ".claude.md" -o -name ".claude.local.md" 2>/dev/null | head -50
```

**File Types & Locations:**

| Type | Location | Purpose |
|------|----------|---------|
| Project root | `./CLAUDE.md` | Primary project context (checked into git, shared with team) |
| Local overrides | `./.claude.local.md` | Personal/local settings (gitignored, not shared) |
| Global defaults | `~/.claude/CLAUDE.md` | User-wide defaults across all projects |
| Package-specific | `./packages/*/CLAUDE.md` | Module-level context in monorepos |
| Subdirectory | Any nested location | Feature/domain-specific context |

**Note:** Claude auto-discovers CLAUDE.md files in parent directories, making monorepo setups work automatically.

### Phase 2: Quality Assessment

For each CLAUDE.md file, evaluate against quality criteria. See [references/quality-criteria.md](references/quality-criteria.md) for detailed rubrics.

**Quick Assessment Checklist:**

| Criterion | Weight | Check |
|-----------|--------|-------|
| Commands/workflows documented | High | Are build/test/deploy commands present? |
| Architecture clarity | High | Can Claude understand the codebase structure? |
| Non-obvious patterns | Medium | Are gotchas and quirks documented? |
| Conciseness | Medium | No verbose explanations or obvious info? |
| Currency | High | Does it reflect current codebase state? |
| Actionability | High | Are instructions executable, not vague? |

**Quality Scores:**
- **A (90-100)**: Comprehensive, current, actionable
- **B (70-89)**: Good coverage, minor gaps
- **C (50-69)**: Basic info, missing key sections
- **D (30-49)**: Sparse or outdated
- **F (0-29)**: Missing or severely outdated

### Phase 3: Quality Report Output

**ALWAYS output the quality report BEFORE making any updates.**

Format:

```
## CLAUDE.md Quality Report

### Summary
- Files found: X
- Average score: X/100
- Files needing update: X

### File-by-File Assessment

#### 1. ./CLAUDE.md (Project Root)
**Score: XX/100 (Grade: X)**

| Criterion | Score | Notes |
|-----------|-------|-------|
| Commands/workflows | X/20 | ... |
| Architecture clarity | X/20 | ... |
| Non-obvious patterns | X/15 | ... |
| Conciseness | X/15 | ... |
| Currency | X/15 | ... |
| Actionability | X/15 | ... |

**Issues:**
- [List specific problems]

**Recommended additions:**
- [List what should be added]

#### 2. ./packages/api/CLAUDE.md (Package-specific)
...
```

> **Forge addendum (not upstream):** when an update would remove, move, shorten or split existing text, or
> the owner says the file is too big or rules get ignored, read `references/forge-disclosure-doctrine.md`
> first: signal triage, move verbatim, no false pointers, `@import` saves no context.

### Phase 4: Targeted Updates

After outputting the quality report, ask user for confirmation before updating.

**Update Guidelines (Critical):**

1. **Propose targeted additions only** - Focus on genuinely useful info:
   - Commands or workflows discovered during analysis
   - Gotchas or non-obvious patterns found in code
   - Package relationships that weren't clear
   - Testing approaches that work
   - Configuration quirks

2. **Keep it minimal** - Avoid:
   - Restating what's obvious from the code
   - Generic best practices already covered
   - One-off fixes unlikely to recur
   - Verbose explanations when a one-liner suffices

3. **Show diffs** - For each change, show:
   - Which CLAUDE.md file to update
   - The specific addition (as a diff or quoted block)
   - Brief explanation of why this helps future sessions

**Diff Format:**

```markdown
### Update: ./CLAUDE.md

**Why:** Build command was missing, causing confusion about how to run the project.

```diff
+ ## Quick Start
+
+ ```bash
+ npm install
+ npm run dev  # Start development server on port 3000
+ ```
```
```

### Phase 5: Apply Updates

After user approval, apply changes using the Edit tool. Preserve existing content structure.

## Templates

See [references/templates.md](references/templates.md) for CLAUDE.md templates by project type.

## Common Issues to Flag

1. **Stale commands**: Build commands that no longer work
2. **Missing dependencies**: Required tools not mentioned
3. **Outdated architecture**: File structure that's changed
4. **Missing environment setup**: Required env vars or config
5. **Broken test commands**: Test scripts that have changed
6. **Undocumented gotchas**: Non-obvious patterns not captured

## User Tips to Share

When presenting recommendations, remind users:

- **`#` key shortcut**: During a Claude session, press `#` to have Claude auto-incorporate learnings into CLAUDE.md
- **Keep it concise**: CLAUDE.md should be human-readable; dense is better than verbose
- **Actionable commands**: All documented commands should be copy-paste ready
- **Use `.claude.local.md`**: For personal preferences not shared with team (add to `.gitignore`)
- **Global defaults**: Put user-wide preferences in `~/.claude/CLAUDE.md`

## What Makes a Great CLAUDE.md

**Key principles:**
- Concise and human-readable
- Actionable commands that can be copy-pasted
- Project-specific patterns, not generic advice
- Non-obvious gotchas and warnings

**Recommended sections** (use only what's relevant):
- Commands (build, test, dev, lint)
- Architecture (directory structure)
- Key Files (entry points, config)
- Code Style (project conventions)
- Environment (required vars, setup)
- Testing (commands, patterns)
- Gotchas (quirks, common mistakes)
- Workflow (when to do what)

## Forge addendum (not upstream)

The upstream body above stays verbatim. Forge adds one rule set, kept in its own file so the vendored text
does not drift: `references/forge-disclosure-doctrine.md`. In short:
- Line count is a symptom to investigate, never a goal or a reported result.
- Triage each line with "if this is deleted, would Claude make a mistake?" before proposing a cut.
- Moving text is a byte-for-byte copy; shortening is a separate, declared change. Diff the conditions,
  numbers and negations of any compressed rule word by word.
- Every pointer names when to read the target, and the target is opened and checked before the pointer is written.
- An `@path` import loads in full at session start and saves no context.
- Project facts stay out of the global `~/.claude/CLAUDE.md`; editing that file needs the owner's permission.

Writing the craft of any agent document (skills, Boss prompts) is `forge-skill-authoring`; generating a new
project CLAUDE.md is `/forge-projectbrain`.

### Provenance of the Forge addendum
| Source | Path | Pinned SHA | Licence | Taken | Excluded |
|---|---|---|---|---|---|
| daymade/claude-code-skills | `daymade-claude-code/claude-md-progressive-disclosurer/SKILL.md` and its two upstream reference files (progressive_disclosure_principles.md, verification-recipes.md) | 8ebd4b540739966edd565dbdaa9b57717b93e78c | MIT | principles only, translated from Chinese and re-expressed: line count as symptom, signal triage, move versus compress, qualifier diff, whole-text match check, pointer trigger, false-pointer gate, `@import` saves no context, global versus project scope, emphasis discipline, per-section fate | the upstream scripts profile_claude_md.py, sink_sections.py and markdown_headings.py and their test_scripts.py (Python that writes files without a dry run), the Codex prompt-input audit command, the case-study texts |

MIT notice: "Permission is hereby granted, free of charge, to any person obtaining a copy of this software ...
The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND." Copyright (c) 2025 daymade (LICENSE
at the pinned SHA). The upstream skill itself stays Apache-2.0 under `LICENSE.txt`.
