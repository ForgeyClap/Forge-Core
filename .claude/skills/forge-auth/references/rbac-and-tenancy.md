# forge-auth — roles, permissions, ownership, tenancy

RBAC, permission-based and resource-ownership patterns adapted from wshobson/agents `auth-implementation-patterns`
(MIT); organisation/role ideas pattern-adapted (no text) from clerk/skills `clerk-orgs`. Provenance: `../SKILL.md`.

## Model
- Check **permissions** in code (`invoice:delete`), and map **roles** to permission sets in one place. Code that
  asks `if role === 'admin'` everywhere becomes impossible to change.
- Three questions on every request: is the caller authenticated? may this role do this action? may this caller
  touch THIS record (owner, tenant, share)? The third is where most real breaches happen (IDOR/BOLA).
- Deny by default: unknown role, missing permission or missing tenant = no access.
- Put the decision in one function/module (`can(user, action, resource)`), call it from every enforcement point,
  and test it as a table of cases.

## Ownership
- Load the record scoped by owner/tenant (`WHERE id = $1 AND tenant_id = $2`), or let RLS do it
  (`forge-database`). Return 404 rather than 403 when existence itself is sensitive.
- Never accept `userId`, `tenantId`, `role` or `ownerId` from the request body for authorization; take them
  from the verified session.
- Mass assignment: allow-list writable fields so a user cannot set `role`, `tenant_id` or `is_admin` through an
  update form.

## Multi-tenant
- Every tenant-owned row carries `tenant_id`; every query and policy filters on it; caches and search indexes are
  keyed by tenant too.
- The active tenant comes from the session (an org claim or a server-side membership lookup), not from a URL
  parameter alone; a slug in the URL is checked against the user's memberships.
- Invitations: single-use, expiring, bound to the invited email; role set by the inviter's permissions, never by
  the invitee.
- Hosted providers with organisations (Clerk, WorkOS, Supabase with a members table): still re-check org
  membership and role on the server for every mutation.

## Admin and support access
- Admin areas behind their own permission, MFA required, separate from customer roles.
- Impersonation: explicit, logged (who, whom, when, why), time-boxed, visibly bannered, and unable to change
  credentials or payment details.
- Role changes take effect immediately: re-check from the store, or revoke sessions, instead of trusting a
  role claim baked into a long-lived token.
