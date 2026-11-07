# forge-security-review — Per-stack guide

One entry point instead of five weak ones (SA-W1-A2). Forge keeps the general method here and
names the deep reference per stack. The ECC skills listed are in the pinned ECC catalog (commit `e2b8a51`)
and are **not** edited; read the one that matches the stack after this table. JavaScript rows are written in
Forge words following the structure of getsentry `security-review/languages/javascript.md` (CC BY-SA 4.0,
ideas only, no text copied).

| Stack | Look hardest at | Usually safe (do not flag alone) | Deep reference |
|---|---|---|---|
| Node.js / Express | `child_process.exec` with input, `res.redirect(req.query.x)`, path joins from input (`path.join(root, name)` without a resolve-and-check), body parsers without size limits, missing `helmet`, `cors({ origin: '*', credentials: true })`, error handler that sends `err.stack`, prototype pollution via deep merge of request bodies (`__proto__`, `constructor`) | `execFile`/`spawn` with an argument array and no shell, parameterised queries, `express.json({ limit })` | ECC `security-review`; `confidence-and-false-positives.md` |
| MongoDB / Mongoose | request bodies used as filters (`{ $ne: null }` operator injection), `$where`, `$expr` built from strings | typed values after schema validation | this file + `owasp-checklist.md` A03 |
| React | `dangerouslySetInnerHTML` with input, `href={userUrl}` (`javascript:` URLs), tokens in `localStorage`, secrets in `VITE_`/`REACT_APP_` env | `{value}` in JSX (escaped) | `vibe-coded-apps.md` §1, §3 |
| Next.js | Server Actions and route handlers without validation + auth + ownership, middleware-only auth, whole DB rows passed to client components, `NEXT_PUBLIC_` secrets, `rewrites` / image domains open to any host (SSRF) | server components reading server-only env | `vibe-coded-apps.md` §3, §8 |
| Vue / Angular | `v-html`, `bypassSecurityTrust*` with input | template interpolation | `confidence-and-false-positives.md` |
| Supabase / Firebase / Convex | RLS or rules missing or `true`, missing `WITH CHECK`, `service_role` on the client, unprotected storage buckets | anon key on the client with correct RLS | `vibe-coded-apps.md` §2 |
| Stripe / Mollie payments | client-sent prices, unsigned webhooks, status trusted from the client | publishable keys on the client | `forge-payments`, `vibe-coded-apps.md` §5 |
| n8n workflows | webhook nodes without auth, credentials in node parameters, `Execute Command` / `Code` nodes fed by webhook data, no error workflow | credentials referenced by id | `forge-n8n` |
| Electron | `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false`, `shell.openExternal` with input, IPC handlers without sender checks | a narrow `contextBridge` API | `owasp-checklist.md` + the desktop rules in the project's `CLAUDE.md` |
| React Native / Expo | secrets in the bundle, `AsyncStorage` tokens, deep-link actions | secure-store tokens | `vibe-coded-apps.md` §7 |
| Python / Django | the `safe` filter, `mark_safe`, `.raw()`/`.extra()` with strings, `pickle`, `yaml.load`, `DEBUG = True`, `ALLOWED_HOSTS = ['*']` | ORM lookups, template auto-escaping | ECC `django-security` |
| PHP / Laravel | `{!! !!}` with input, `DB::raw` with strings, mass assignment without `$fillable`, `unserialize` | Blade `{{ }}`, Eloquent bindings | ECC `laravel-security` |
| Java / Spring Boot | disabled CSRF on cookie sessions, permissive `permitAll`, SpEL or JPQL built from strings, Java object deserialisation | Spring Data derived queries | ECC `springboot-security` |
| Java / Quarkus | missing `@RolesAllowed`, JWT/OIDC config without issuer/audience checks | Panache parameter binding | ECC `quarkus-security` |
| Perl | taint mode off for CGI input, two-argument `open`, backticks with input, DBI without placeholders | three-argument `open`, DBI placeholders | ECC `perl-security` |
| GitHub Actions | `pull_request_target` + fork checkout, `${{ }}` in `run:`, unpinned third-party actions | first-party actions on tags | `gha-workflows.md` |
| Claude Code skills, plugins, MCP servers | dynamic-context shell lines, broad tool grants, unknown hosts | markdown-only skills | `supply-chain.md` |

Stacks not listed: use the OWASP checklist, verify the framework's own protections directly in the code, and
say in the report that no stack guide existed.
