# forge-security-review — Severity and write-up format

Save the write-up in the run folder (or the path the dispatcher names), not only in chat.

```
# Security review — <scope> — <date>
Scope: <diff range / files / feature>   Depth: full | focused | surgical (why)
Threat model: <3-6 lines or a link>

## Findings (most severe first)
### SEC-1 <title>   Severity: CRITICAL | HIGH | MEDIUM | LOW   Confidence: HIGH
Where: <file:line or commit>
Input source: <where the attacker-controlled value enters, traced>
What: <the defect>
Attack / failure scenario: <concrete steps and impact>
Blast radius: <callers / routes / tenants affected, counted>
Test coverage: <covered | not covered (severity raised)>
Fix: <specific change>   Proof of fix: <the test that will show it>

## Needs verification
<MEDIUM-confidence items: VERIFY-n, where, the one question that decides it (confidence-and-false-positives.md)>

## Checked and fine
<OWASP categories / areas checked with one line of evidence each>

## Not checked
<files, behaviours, tools not run, and why>   Confidence: high | medium | low
```

## Severity mapping (aligned with forge-code-review)
- **CRITICAL** — exploitable now with serious impact: auth bypass, injection reaching data, leaked live secret,
  payment manipulation, cross-tenant data access. Blocks completion.
- **HIGH** — likely exploitable or a missing core control (no rate limit on login, unsigned webhook, IDOR
  without proof of exploit). Blocks completion unless the owner accepts it in writing.
- **MEDIUM** — defence-in-depth gaps (missing header, verbose error, weak logging).
- **LOW** — hardening suggestions and hygiene.
