# Destructive commands — tiers

Forge rule: say what will be lost, then wait for an explicit yes. The Forge gate hook blocks some shell commands by
itself (recursive delete, kill by name, git commands that discard work), but it does not know Docker, Compose,
Terraform or platform CLIs. This list is the agent's own discipline. (Tier idea adapted from docker/skills
docker-destructive-guardrails, Apache-2.0; made stricter for Forge.)

## Tier 1 — allowed, then report
Only when ALL hold: the owner asked for it in this session, it targets ONE named resource, the agent created that
resource earlier in this session for testing, and no unsaved state is at risk.
- `docker stop`, `docker rm`, `docker rm -f` on such a container.
- `docker compose down` (WITHOUT `-v`) on a stack the agent started for testing.

## Tier 2 — confirm first (state the impact)
- `docker kill`; `docker stop` or `docker rm -f` on any container the agent did not create.
- Any sweep: `docker container prune`, "remove all containers", a command substitution over every container id.
- Anything the agent wants to do on its own initiative.
- Restarting or redeploying a shared service; a platform rollback (`wrangler rollback`, `vercel rollback`).

## Tier 3 — always confirm, list what is lost
- `docker system prune` (any flags), `docker image prune -a`, `docker rmi`, `docker volume rm` or `prune`,
  `docker network rm` or `prune`, `docker builder prune`, `docker buildx rm`, `docker context rm`.
- `docker compose down -v` (deletes named volumes, i.e. database data).
- `terraform destroy`; any `terraform apply` whose plan shows a destroy or replace; `terraform state rm`;
  `terraform import` against a live account; `-target` applies.
- `wrangler delete`; `wrangler secret put` and `secret delete` (they deploy immediately); remote KV/R2/D1 deletes;
  deleting a Vercel project, domain or environment variable.
- Force-push, branch delete, tag delete, release delete.

When in doubt, it is Tier 3. A safer alternative usually exists: `compose down` without `-v`, `restart`, a new named
volume, `terraform plan -destroy` to show the impact first.
