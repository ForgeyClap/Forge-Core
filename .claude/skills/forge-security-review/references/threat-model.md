# forge-security-review — Short threat model

Keep it to one screen per feature. It exists to aim the review, not to fill a template.

## 1. Draw the boundaries (in words is fine)
- Actors: anonymous visitor, signed-in user, admin, third-party service, the agent itself.
- Assets: accounts, personal data, money, secrets, availability, the owner's reputation.
- Trust boundaries: browser to server, server to DB, server to third-party API, webhook in, file upload in,
  LLM input/output.
- Entry points: every route, webhook, queue consumer, CLI flag, uploaded file and scheduled job that changes
  state. List them; a missed entry point is a missed check.

## 2. Walk STRIDE over each entry point
| Letter | Question |
|---|---|
| Spoofing | Can someone pretend to be another user or a trusted service (forged webhook, stolen token)? |
| Tampering | Can input, a stored record or a file be changed where it should not be? |
| Repudiation | Would we know who did it (audit log for money, permission and data changes)? |
| Information disclosure | Can data leak through responses, errors, logs, URLs, caches or other tenants? |
| Denial of service | Can one client exhaust CPU, memory, queue, paid API quota or storage? |
| Elevation of privilege | Can a normal user reach admin actions or another tenant's data? |

## 3. Rank and decide
For each threat: likelihood (low/medium/high) x impact (low/medium/high), the existing control, and the
decision: mitigate now, accept with a reason (owner decides), or track. High x high is fixed before release.

## 4. Feed the review
Every "mitigate now" threat becomes a concrete check in the review, with a test that proves the control
(for example a forged webhook signature is rejected with 401).
