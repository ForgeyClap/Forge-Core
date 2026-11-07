# forge-extension — hard rules (full text)

## Hard rules (non-negotiable)
- **Least-privilege permissions.** Request only the `permissions` + `host_permissions` the code actually uses; prefer `activeTab` and `optional_permissions` over a blanket `<all_urls>`. Each permission is justifiable in one sentence. Over-broad scope is both a Web Store rejection risk and a user-trust failure.
- **No remotely-hosted code (MV3 policy).** All executable JS ships inside the package — **no** `eval`, `new Function` on remote strings, or `<script src>` from a CDN. Remote code is a hard Chrome Web Store rejection.
- **Safe content-script + messaging.** Content scripts run in the page's hostile context: validate every `chrome.runtime.onMessage` payload **and check `sender`**; never trust or `eval` `window.postMessage` data from the page; keep `externally_connectable` narrow. `web_accessible_resources` scoped to specific matches, never `<all_urls>`.
- **Strict CSP kept strict.** MV3's default extension CSP (`script-src 'self'`) is not weakened — no `'unsafe-eval'`, no `'unsafe-inline'`, no remote script sources. Sandboxed pages only if genuinely required, narrowly.
- **Termination-resilient service worker.** The MV3 background is an **event-driven service worker**, not a persistent page: listeners registered at top level, no reliance on in-memory global state surviving, durable state persisted to `chrome.storage`.
- **No secrets in the package; store-policy compliance.** No API secret baked into the extension (it's extractable); real secrets sit behind a backend, OAuth via `chrome.identity` with minimal scopes. Single clear purpose, accurate description, privacy disclosure if user data is handled, no obfuscated code.
