# Containers — Dockerfile and Compose

Adapted in our own words from docker/skills (docker-build-strategies, docker-compose-patterns; Apache-2.0).
The templates below are Forge-written starting points, not copies of upstream templates.

## Dockerfile
- Start with the `# syntax=docker/dockerfile:1` line; set `WORKDIR` before any `COPY`/`RUN`; exec-form
  `ENTRYPOINT`/`CMD`; `EXPOSE` the port; add the OCI source label.
- **Multi-stage:** name stages (`AS build`, `AS runtime`); build tools stay in the build stage; copy only the artifact
  with `COPY --from=build`. Small runtime base: slim, distroless, alpine, or `scratch` for static binaries.
- **Cache order:** least-changing first. Copy dependency manifests and install before copying source. Use BuildKit
  cache mounts for npm/pip/go/apt instead of deleting caches in the same layer.
- **Pin** the base image to a version, and to a digest for production. Never `latest`.
- **Secrets:** never `ARG`/`ENV` for credentials, never `COPY` a credential file. Use a BuildKit secret mount
  (`RUN --mount=type=secret,id=...`, supplied with `docker buildx build --secret id=...,src=...`) and an SSH mount for
  private git. Expose only the key the build needs; keep host-key checking on.
- **Non-root:** create a user and group in the runtime stage, `COPY --chown=<uid>:<gid>` (numeric when combined with
  `--link`), put `USER` after the file operations. On distroless use the provided nonroot user.
- **`.dockerignore` always:** VCS and IDE folders, `node_modules`, virtualenvs, build output, docs, `.env*`, keys.
  It is defence in depth, not the only protection.

### Node template (adjust versions and paths to the project)
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json ./
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Python template
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip wheel --wheel-dir /wheels -r requirements.txt

FROM python:3.12-slim AS runtime
WORKDIR /app
RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --no-create-home app
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir --no-index /wheels/*.whl
COPY --chown=1000:1000 . .
USER 1000:1000
EXPOSE 8000
CMD ["python", "-m", "app"]
```

### `.dockerignore` starter
```
.git
.github
.vscode
.idea
node_modules
.venv
__pycache__
dist
build
coverage
*.log
.env
.env.*
*.pem
*.key
docs
```

Verify: build the image, then report its size and its configured user (from `docker image inspect`). If no Docker
daemon is available, mark the build not-run; do not claim it builds.

## Compose
- File name `compose.yaml`; development-only settings (bind mounts, debug ports, dev env) in the override file
  `compose.override.yaml`, which Compose loads automatically. Production-shaped settings stay in the base file.
- **Health checks** on every database and cache with its native client (`pg_isready`, `redis-cli ping`); start around
  interval 5s, timeout 3s, retries 3, start_period 10s. For images without a shell, use a small sidecar that shares the
  service's network namespace and checks localhost.
- **`depends_on` with `condition: service_healthy`** for services that must be ready; plain `depends_on` only waits
  for the container to start.
- **Named volumes** for data that must survive recreation; bind mounts only for source code in development. Do not
  mount the Docker socket unless the service truly needs it (it is root on the host).
- **`develop.watch`** instead of manual bind mounts: `sync` for source, `rebuild` for dependency manifests,
  `sync+restart` for config.
- **No default passwords in the file.** Use the fail-when-unset form `${DB_PASSWORD:?set DB_PASSWORD}` plus an
  `.env.example` with placeholders; never a fallback such as `${DB_PASSWORD:-postgres}`.
- `docker compose down -v` deletes the named volumes: Tier 3 in `destructive-commands.md`.

## Pitfalls (symptom → cause → first move)
Adapted from NousResearch/hermes-agent `docker-management` (MIT, (c) 2025 Nous Research), Forge words; its examples with
inline passwords and bare force-removes are not taken.

| symptom | usual cause | first move |
|---|---|---|
| container exits right after start | the main process finished or crashed | `docker logs <name>`; start a shell in the image with `--entrypoint` to look around |
| "port is already allocated" | another process holds the host port | `docker ps`, then `netstat -ano \| findstr :<port>` on Windows to see the owning PID; pick another port, or stop that exact PID only if you started it (never by image name) |
| "no space left on device" | Docker's disk (on Windows the WSL 2 virtual disk) is full | `docker system df`, then a **targeted** cleanup named to the owner first (Tier 2/3 in `destructive-commands.md`) |
| cannot reach the app from the host | the app listens on 127.0.0.1 inside the container | bind to `0.0.0.0` inside the container and check the `-p` / `ports` mapping |
| permission denied on a mounted folder | user id inside the container does not match the files | run as a fixed non-root user and set ownership in the image; on Windows prefer a named volume over a bind mount from the Windows drive |
| Compose services cannot reach each other | wrong network or a hostname other than the service name | services talk by service name; `docker compose config` shows the resolved file |
| every build reinstalls dependencies | layer order: source copied before the dependency manifests | copy manifests, install, then copy the source |
| image is huge | no multi-stage build, no `.dockerignore` | multi-stage build, slim base, `.dockerignore` |
| bind-mounted source does not hot-reload on Windows | file events do not cross from the Windows drive into the Linux VM | use `develop.watch`, or keep the project inside the WSL file system |

## Verify after every Docker operation
| after | check |
|---|---|
| start | `docker ps` shows status "Up" (and "healthy" when a health check exists) |
| logs | `docker logs --tail 20 <name>` shows no errors |
| ports | `docker port <name>`, then one request to the mapped port |
| build | `docker image ls <repo>` shows the tag; size and user reported |
| Compose | `docker compose ps`: every service running or healthy |
| cleanup | `docker system df` before and after, both numbers in the report |
Report a step that could not run (no Docker daemon, Docker Desktop not started) as not-run.
