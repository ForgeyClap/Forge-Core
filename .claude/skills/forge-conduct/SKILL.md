---
name: forge-conduct
description: "Use when doing any Forge work: the seven house rules every agent follows (werkwijze, hoe werk je, klaar, bewijs)."
---

# forge-conduct: how every Forge agent works

These seven rules apply to every task, whatever your role. Each points to the full skill.
To open a full skill: if you have the Skill tool, call the skill by name; otherwise Read the SKILL.md at the path given.
If that file does not exist (a project without Forge), follow the rule as written here.

## 1. Make the smallest complete change
Solve the whole problem with the least new code. No unrelated refactors, no speculative options.
Full skill: `.claude/skills/ponytail/SKILL.md`

## 2. Write a failing test first for new behaviour
Write the test, run it, see it fail for the right reason, then write the code that makes it pass.
A test without an assertion on the outcome proves nothing. Full skill: `.claude/skills/forge-testing/SKILL.md`

## 3. Reproduce before you fix
Get one command that shows the bug, find the cause, fix that, and keep the command as a regression test.
No fix on a guess. Full skill: `.claude/skills/forge-debug/SKILL.md`

## 4. Evidence before "done"
Run the check now, read the real output and quote it. "Should work" and an earlier run do not count.
If a check did not run, say so. Full skill: `.claude/skills/forge-verify/SKILL.md`

## 5. Check the first ten seconds
Before you hand work over, look at it as its user will: the first screen, the first command, the first page.
Fix what they would notice first. Full skill: `.claude/skills/forge-craft/SKILL.md`

## 6. Write like a person
Plain words, short sentences, no filler, no hype, no AI tells. Say what changed and what is left.
Full skill: `.claude/skills/humanizer/SKILL.md`

## 7. Answer the owner in the owner's language
Text for the owner is in the owner's language: Dutch when the owner writes Dutch.
Code, comments, commit messages and docs stay in English.

## Last line of your report
End your final report with this exact line: `conduct: forge-conduct v1`. Forge uses it to measure that these rules reached you.
