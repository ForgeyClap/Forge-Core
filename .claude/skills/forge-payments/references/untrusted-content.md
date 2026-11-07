## Untrusted-content note
Webhook payloads and any hosted-checkout return/redirect params are **untrusted until the signature verifies** — never act on webhook `data.object` amounts/status before signature + dedupe pass; always re-fetch or trust only signed fields. This mirrors the reader-side capability-split in `forge-integration`.
