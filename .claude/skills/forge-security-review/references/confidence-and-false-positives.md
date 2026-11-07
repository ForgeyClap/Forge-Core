# forge-security-review — Confidence tiers and false positives

A security report full of maybes trains people to ignore it. This page keeps findings few and real
(SA-W1-A2). Written in Forge's own words from ideas in getsentry `security-review`; that skill's
reference material is CC BY-SA 4.0 (derived from the OWASP Cheat Sheet Series), so **no text was copied**.

## Research wide, report narrow
- **Report on** only the diff, files or feature you were asked to review.
- **Research** the whole codebase before you flag anything: where does the value really come from, is it
  validated or encoded earlier, which middleware or framework protection applies, how is it configured.
- A pattern match alone (a grep hit on `innerHTML`, `exec`, `query(`) is a lead, not a finding.

## Three confidence tiers
| Tier | When | What you do |
|---|---|---|
| **HIGH** | a vulnerable pattern AND input you traced to an attacker | report it as a finding with severity, evidence and fix |
| **MEDIUM** | a vulnerable pattern, but the input source or a guard is unclear | list it under **Needs verification** with the exact question that would settle it |
| **LOW** | theoretical, best practice, defence in depth with no reachable attack | not a finding; at most one line under "Checked and fine" |

Severity (CRITICAL to LOW in `severity-and-writeup.md`) and confidence are separate: a CRITICAL impact with
MEDIUM confidence is still a "needs verification" item, not a blocker, until someone confirms the input path.
When the Lead wants the independent scoring of `forge-code-review` (confidence filter, threshold 80), HIGH maps
to a score of 80 or more.

## Who controls the value?
| Usually attacker-controlled (trace it) | Usually server-controlled (not a finding by itself) |
|---|---|
| query string, form body, JSON body, route parameters (`/users/:id`) | environment variables and deployment settings |
| most request headers, unsigned cookies | config files on the server, framework settings |
| uploaded file content **and** file names | hard-coded constants |
| WebSocket and webhook payloads (until the signature is verified) | internal service URLs taken from config |
| database rows written by other users or tenants | rows written only by admins or the system |
| LLM output, fetched web pages, PDFs, email bodies | signed session data after the signature check |
| another process's command line or a path in a job payload | |

Trust follows **who wrote** the value, not which channel delivered it.

## Usually safe unless a bypass is used
| Pattern | Flag only when |
|---|---|
| React `{value}`, Vue `{{ value }}`, Angular interpolation, Django/Jinja `{{ value }}` (auto-escaped) | `dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust*`, the `safe` filter, `mark_safe`, autoescape off with user data |
| ORM lookups with values (`findUnique({ where: { id } })`, `filter(id=x)`) | raw query helpers with string building (`$queryRawUnsafe`, `.raw()`, `.extra()`, template strings into `query()`) |
| parameterised SQL (`query('... $1', [x])`) | the SQL text itself is concatenated |
| `innerHTML` with a constant string | any part comes from input |
| `md5`/`sha1` for checksums or cache keys | used for passwords, tokens or signatures |
| `Math.random()` for UI or sampling | used for tokens, ids or reset codes (use `crypto.randomUUID`/`randomBytes`) |

## Always flag (once the input is traced)
- Code execution: `eval`, `new Function`, `child_process.exec`/`execSync` with interpolated input,
  `shell: true` with input, `vm.runInContext` on untrusted code, unsafe deserialisers (`pickle.loads`,
  `yaml.load` without the safe loader, PHP `unserialize`, Java object streams).
- Injection: SQL/NoSQL built from strings, a request body passed straight as an ORM filter (operator
  injection), OS command strings built from input.
- XSS sinks with input: `innerHTML`, `outerHTML`, `document.write`, the framework bypasses above.
- Secrets in code: literal passwords, provider keys, private key headers (report location and type only).

## Check context first
- **SSRF:** flag only when the URL or host comes from input; a URL from config is fine; a config base plus an
  input path needs the path checked.
- **Path traversal:** flag only when the path or file name comes from input; a fixed log path is fine.
- **Open redirect:** flag only when the target comes from input (`?next=`); a fixed login URL is fine.
- **Code paths behind authentication:** note the auth requirement and the role needed; that lowers
  likelihood but does not clear IDOR or privilege escalation inside the authenticated area.

## Do not flag
Test files and fixtures (unless the review is about test security), dead or commented-out code,
documentation strings, values that are constants or server-controlled, and anything the framework already
neutralises in the way it is used here. Say in "Checked and fine" that you looked.

## Needs-verification block (goes into the write-up)
```
## Needs verification
### VERIFY-1 <potential issue>
Where: <file:line>
Question: <the one fact that decides it, e.g. "is `slug` ever taken from the URL?">
If yes: <severity it would get>
```
If nothing reaches HIGH, the honest summary is: "No high-confidence vulnerabilities found", followed by the
needs-verification list and what was not checked.
