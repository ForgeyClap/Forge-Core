# Map and ticket format (local markdown)

Folder: `docs/plans/<slug>/` with `MAP.md`, `tickets/`, `research/` and, later, `BLUEPRINT.md`. The `<slug>` is lowercase
words joined by hyphens, for example `docs/plans/offline-sync/`.

## MAP.md

```markdown
# Map: <effort name>

Status: charting | in progress | clear | blueprint written | archived
Started: <YYYY-MM-DD> · Run: <run id>

## Destination
<one or two lines: what reaching the end of this map looks like (the spec, decision or change). Every session reads this
before it picks a ticket.>

## Notes
<domain; skills every session should read (for example grilling, forge-deeplearn, forge-database); standing preferences;
"execution allowed inside the map: no" unless the owner said otherwise>

## Decisions so far
<!-- one line per closed ticket, in the order closed -->
- [<ticket title>](tickets/T-003-sync-conflict-rule.md): <one-line gist of the answer>

## Not yet specified
<!-- fog: in scope, but not sharp enough to ticket yet -->
- <suspected question or area to revisit>

## Out of scope
<!-- work beyond the destination; never graduates -->
- [<closed ticket title>](tickets/T-006-...md): <gist> — out because <reason>

## Plan changes
<!-- mutation log, newest last -->
- <YYYY-MM-DD> <split|insert|skip|reorder|abandon|out-of-scope> <ticket or step> — <why> (<who>)
```

Open tickets are **not** listed in MAP.md. Find them by scanning `tickets/` for `Status: open`. That keeps the map short and
avoids two copies of the truth.

## Ticket file `tickets/T-<nnn>-<short-name>.md`

```markdown
# <ticket title as a short question or decision name>

Type: research | prototype | grilling | task
Mode: AFK | HITL
Status: open | closed
Blocked by: T-001, T-002   (or: none)
Claimed: <run id or session> <YYYY-MM-DD>   (empty = free)

## Question
<the decision or investigation this ticket resolves, sized to one session>

## Resolution
<written on close: the answer, the evidence or source links, and any facts later tickets need (paths, counts, names).
Assets are linked, not pasted.>
```

## Frontier check (by hand or with a small read-only script)
A ticket is on the frontier when:
1. `Status: open`, and
2. every id in `Blocked by` points to a ticket with `Status: closed`, and
3. `Claimed` is empty.

Order the frontier by ticket number unless the owner names another order.

## Claim race on one machine
Two sessions may run the map at the same time. A local file has no lock, so:
1. Write your `Claimed:` line and save.
2. Re-read the file. If the line is not yours, another session won: pick another frontier ticket.
3. Release a claim you abandon by emptying the line and adding a Plan changes entry.

## Numbering
Ids are never reused. A split ticket keeps its id for the first half and gets new ids for the rest, with a Plan changes line
that names both.
