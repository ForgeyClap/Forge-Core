# Incident runbooks — SEV table, runbook shape, communicator, safe commands

Adapted in Forge words from wshobson/agents `plugins/incident-response/skills/incident-runbook-templates` (SKILL.md and
its details reference; MIT, (c) 2024 Seth Hobson). Its Kubernetes, cloud-CLI and SQL command blocks, chat and paging
tool names, and the network-policy example are not taken. This is the last link of the Forge rollout path: a rollback
trigger from `ship-readiness` fired, or an alert went off.

## Severity (pick one in the first five minutes; raise it later rather than argue)
| SEV | impact | first response | example |
|---|---|---|---|
| SEV1 | full outage, data loss or a security breach | within 15 minutes, owner told at once | site down, payments failing, leaked data |
| SEV2 | major degradation, a critical feature broken | within 30 minutes | login fails for some users, checkout errors |
| SEV3 | minor impact, a workaround exists | within 2 hours | a report page is slow, one non-critical job fails |
| SEV4 | minimal or cosmetic | next working day | a typo, a misaligned button |
Response times are starting values; a solo owner project writes its own. A suspected data or security incident is SEV1
plus `security-boss` (and `forge-security-review`), whatever the traffic numbers say.

## Roles
- **Incident lead** (on a Forge run: the Lead): decides, keeps the timeline, assigns steps. Does not also write updates.
- **Communicator:** only writes status updates, on a fixed rhythm, even when nothing changed. In Forge an agent
  **drafts** every update; posting to a public status page, a client, a chat channel or by mail is the owner's step
  (outbound). Internal run notes may be written directly.
- **Fixer** (Build Boss or the owner): runs the runbook steps the lead assigns, one at a time, and reports the output.
Solo owner: the agent still separates the roles in writing, so the update rhythm is not lost while fixing.

## Status update template (every 15 minutes for SEV1/SEV2)
```
STATUS  <service>  <SEV>  <time>
State: Investigating | Mitigating | Monitoring | Resolved
Impact: what is broken, who is affected, roughly what share of traffic
Doing now: <one or two lines>
Next update: <time, 15 minutes from now>
```
Resolution note adds: duration, impact count, cause in one sentence, what fixed it, follow-up (postmortem date, fix
ticket). No secrets, tokens, customer names or raw stack traces in any update.

## Runbook shape (one per service or failure family)
Top of the file, before anything else:
- **Metadata:** last verified (date), owner, review rhythm (after every SEV1/SEV2 and at least every quarter).
- **Quick checklist** that mirrors the section numbers, so a tired reader can tick progress without reading prose:
  1. declare SEV and open the incident notes, 2. check service health, 3. check what changed recently (deploys, config,
  flags), 4. roll back if a recent change is the likely cause (owner go), 5. draft the first status update,
  6. escalate when unresolved after the agreed time.

Then nine sections:
1. **Overview and impact:** what the service does, who depends on it, what "broken" costs.
2. **Detection:** which alerts fire, at which thresholds, and the dashboard that shows it.
3. **First triage (five minutes):** reachability, dependency status, recent changes, a symptom → section table
   (everything failing → 4.1, slow → 4.2, some requests failing → 4.3, sudden traffic spike → 4.4).
4. **Mitigation per symptom:** the smallest safe step first (flag off, roll back the last deploy, scale up, rate-limit),
   each step numbered.
5. **Root-cause investigation:** where to look after the bleeding stopped (logs, traces, error tracking:
   `logging.md`, `opentelemetry.md`, `sentry.md`); the method is `forge-debug`.
6. **Resolution:** the real fix, through the normal build, review and deploy path, never hot-patched in production.
7. **Verification and rollback:** health route, error rate back at baseline, latency, the critical flow by hand; and
   how to undo each mitigation.
8. **Communication:** the templates above, who receives drafts.
9. **Escalation matrix:** condition → who → how (for example: SEV1 unresolved after 15 minutes → owner by phone; data
   or security suspected → owner + security-boss; money at stake → owner).

## Every command in a runbook carries three lines
- **Prerequisite:** what must be true for it to work (right account, right environment, tool installed).
- **Expected output:** what success looks like.
- **If this fails:** the next step, so the reader is never stuck at 3 AM.
Steps that work in staging often fail in a real incident because their preconditions are gone; the prerequisite line is
what catches that.

## Dangerous commands: dry run first
- Before any destructive or mass-changing command (terminating connections, deleting or updating rows, clearing a
  queue, purging a cache, removing a volume) run the **read-only count** with the same filter and show the number:
  how many rows, connections or items would be hit.
- Write the expected safe range in the runbook ("continue only when the count is under <N>"); outside that range, stop
  and ask the owner.
- Destructive data steps need the owner's yes during the incident too: state what is lost, wait for the go
  (`.claude/skills/forge-devops/references/destructive-commands.md`). Take a backup or snapshot first when the platform allows it.
- Stopping a process: the exact PID you resolved (for example the one listening on the service port), never by image or
  process name, which takes down unrelated services.

## Keep runbooks alive
- Review after every SEV1/SEV2; update the "last verified" date only after actually walking the steps.
- Practice on a non-production target (a game day); an untested runbook is a guess.
- A small CI check may verify that the hostnames, routes and dashboards a runbook names still exist (read-only).
- Every alert links to its runbook section; an alert without a runbook is a gap in `ship-readiness.md`.
- After resolution: a blameless postmortem (timeline, cause, what went well, actions with owners). Lessons that should
  change Forge itself go to the lesson memory through the Lead.
