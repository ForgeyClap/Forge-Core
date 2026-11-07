# forge-cms — ship-readiness (full text)

## Ship-readiness (unique)
Content model in place and editor-tested (an editor can change copy without code); secrets in env with `wp-config`/tokens uncommitted; WP escaping/sanitization/nonces/capabilities verified (or headless client-side token exposure ruled out + webhooks verified); **backup taken and migration reversibility proven on staging** before touching production; performance + a11y evidence on the rendered site; core/plugin versions current. If no PHP/WP runtime was available, mark backup/migration/live-verify as not-run (owner-side) rather than implying they passed. Advisory checklist; optionally run `security-reviewer` / `codex-reviewer` on theme/plugin PHP or the headless token path — not a blocker.
