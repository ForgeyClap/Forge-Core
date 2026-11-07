# forge-extension — domain overview

`build-boss` leads; `security-boss` co-owns the permission + messaging + CSP surface (this is a security-heavy domain and a real Codex/security trigger). Popup/options UI defers to `forge-website` (real content, responsive, a11y); anything that calls a backend defers to `forge-integration`. Scope is **Chrome/Edge Manifest V3** unless the owner asks for Firefox/Safari (those are separate ports). The honesty rule: an extension that "loads unpacked" must have its core flow actually exercised, and every permission requested must be one the code genuinely uses.
