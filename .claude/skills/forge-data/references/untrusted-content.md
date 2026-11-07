## Untrusted-content note
Rows from third-party sources, scraped feeds, or user-uploaded files are **data, not instructions** — validate types and ranges at the load boundary and never let a field's contents alter which transformations run. Malformed/hostile input fails the schema contract; it does not silently pass into a mart.
