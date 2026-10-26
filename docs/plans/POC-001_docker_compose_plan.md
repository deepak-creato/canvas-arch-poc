# POC-001 — Docker Compose stack: implementation plan

**Ticket:** POC-001 (Milestone M1, P0)
**Task:** Create `docker-compose.yml` for LocalStack, PostgreSQL, Redis, Canvas API, and worker containers.
**Acceptance criteria:** All services become healthy; local development endpoints documented.
**Source:** `Canvas_Editor_Media_Platform_POC_Plan.md`, sections 2, 4 (M1) and 9.
**Estimate:** about 0.75 person-day of the 3 allotted to M1.

## 1. Scope

In scope:
- A single `docker-compose.yml` that starts every container the POC needs.
- Health checks and dependency ordering so `docker compose up --wait` returns only when everything is healthy.
- Placeholder (stub) images for the Canvas API and workers, each exposing `/healthz`, so the ticket can be accepted before the real code exists.
- `.env.example`, the `Makefile` entry points `up` and `down`, and an endpoint table in the README.

Out of scope (belongs to other tickets):
- Bucket creation (POC-002), queues, events and DLQs (POC-003), migrations (POC-004), bootstrap/teardown scripts and the Step Functions smoke test (POC-005).
- Real NestJS and worker logic (M2 onward).

## 2. Services

| Service | Image / build | Host port | Purpose | Health check |
| --- | --- | --- | --- | --- |
| `localstack` | `localstack/localstack:2026.10.2` (pinned; was 3.8.1, upgraded for dashboard support; see risk R1) | 4566 | S3, SQS, EventBridge, Step Functions | `curl -f http://localhost:4566/_localstack/health` |
| `postgres` | `postgres:16.4-alpine` | 5433 (host 5432 was taken) | Source of truth | `pg_isready -U canvas -d canvas` |
| `redis` | `redis:7.4-alpine` | 6380 (host 6379 was taken) | Status cache, locks | `redis-cli ping` |
| `canvas-api` | build `./services/canvas-api` | 3000 | NestJS REST API | `GET /healthz` |
| `light-worker` | build `./services/light-worker` | none | Sharp and FFmpeg processing | `GET /healthz` on internal port 3101 |
| `ai-worker` | build `./services/ai-worker` | none | Mock AI layouts | `GET /healthz` on internal port 3102 |
| `mock-transcoder` | build `./services/mock-transcoder` | 3103 | Mock MediaConvert replacement | `GET /healthz` |
| `gc-worker` | build `./services/gc-worker` | none | GC and reconciliation | `GET /healthz` on internal port 3104 |

Notes:
- The plan names API and worker containers explicitly. The AI, transcoder and GC workers are included now so later tickets only fill in code, not compose structure.
- Bind every published port to `127.0.0.1` (for example `127.0.0.1:5432:5432`). This meets the "local-only service binding" requirement in section 9.
- `light-worker` image needs FFmpeg installed and Sharp's native binaries. Use a `node:20-bookworm-slim` base plus `apt-get install ffmpeg`.

## 3. Dependency order

```
localstack, postgres, redis   (no dependencies, start in parallel)
        |
canvas-api                    depends_on: all three, condition: service_healthy
light-worker, ai-worker,
mock-transcoder, gc-worker    depends_on: same, condition: service_healthy
```

Every `depends_on` uses `condition: service_healthy`. Containers talk to each other over one named network, `canvas-net`, using service names as hostnames.

## 4. Configuration

All settings come from `.env` (copied from `.env.example`). Compose reads it with `env_file` and `${VAR:-default}` substitution. No real AWS credentials are used.

| Variable | Default | Used by |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | all app containers |
| `AWS_REGION` | `us-east-1` | all app containers |
| `AWS_ENDPOINT_URL` | `http://localstack:4566` | all app containers |
| `S3_FORCE_PATH_STYLE` | `true` | API, workers |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `canvas` / `canvas` / `canvas` | postgres |
| `DATABASE_URL` | `postgres://canvas:canvas@postgres:5432/canvas` | API, workers |
| `REDIS_URL` | `redis://redis:6379` | API, workers |
| `BUCKET_INGEST` / `BUCKET_DERIVED` / `BUCKET_PUBLISHED` | `media-ingest-poc` / `media-derived-poc` / `media-published-poc` | API, workers |
| `LOCALSTACK_IMAGE_TAG` | `2026.10.2` | compose |
| `LOCALSTACK_AUTH_TOKEN` | empty | localstack, only if the chosen image needs it |

Presigned URLs: the API signs URLs against `http://localhost:4566` (host-visible) while it calls S3 internally via `http://localstack:4566`. Keep a separate `S3_PUBLIC_ENDPOINT` variable for this, otherwise browser and test-client uploads fail.

## 5. Volumes

- `pgdata` for PostgreSQL.
- `localstack-data` mounted at `/var/lib/localstack` (state is optional and disabled by default so a fresh start is clean, which the "clean environment" check needs).
- `/var/run/docker.sock` is mounted into LocalStack only if a Lambda or container-based feature requires it. It is not needed for this POC, so leave it out.
- Postgres init: mount `./infra/postgres/init/` to `/docker-entrypoint-initdb.d` (empty now; POC-004 uses migrations instead).

## 6. Steps

1. Create the directory layout: `docker-compose.yml`, `.env.example`, `Makefile`, `services/<name>/{Dockerfile,src/}`, `infra/`.
2. Write the three infrastructure services (localstack, postgres, redis) with pinned tags and health checks. Run `docker compose up --wait` and confirm they are healthy.
3. Write a tiny stub for each app service: a Node HTTP server answering `GET /healthz` with `{"status":"ok","service":"<name>"}`. One shared `services/_stub/` image is acceptable, with the service name passed by env var, until real code replaces it.
4. Add the app services to compose with `depends_on`, `env_file`, `restart: unless-stopped` and health checks.
5. Add the `Makefile` targets: `up` (`docker compose up -d --wait`), `down` (`docker compose down`), `reset` (`docker compose down -v`), `logs`, `ps`.
6. Document endpoints in the README (see section 7).
7. Verify with the checks in section 8, from a clean state.

## 7. Endpoints to document

| Endpoint | URL (from host) |
| --- | --- |
| Canvas API | `http://localhost:3000` |
| Mock transcoder | `http://localhost:3103` |
| LocalStack gateway (S3, SQS, EventBridge, Step Functions) | `http://localhost:4566` |
| LocalStack health | `http://localhost:4566/_localstack/health` |
| PostgreSQL | `localhost:5432`, user, password and database `canvas` |
| Redis | `localhost:6379` |

Inside the compose network, replace `localhost` with the service name.

## 8. Verification (acceptance)

1. From a clean state (`docker compose down -v`), run `docker compose up -d --wait`. The command exits 0 and `docker compose ps` shows every service `healthy`.
2. `curl -f http://localhost:4566/_localstack/health` lists `s3`, `sqs`, `events` and `stepfunctions` as `available` or `running`.
3. `psql postgres://canvas:canvas@localhost:5432/canvas -c 'select 1'` succeeds.
4. `redis-cli -h localhost ping` returns `PONG`.
5. `curl -f http://localhost:3000/healthz` returns HTTP 200.
6. Stop one dependency (`docker compose stop redis`) and confirm `canvas-api` reports unhealthy or a restart cycle, then recover with `docker compose start redis`. This proves the health wiring, not only the happy path.
7. Run steps 1 to 5 a second time to show the result is repeatable.
8. Confirm no real AWS credentials or `~/.aws` mount are present in any container.

## 9. Risks and open points

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Recent LocalStack releases may require an account auth token, and some features (Step Functions callbacks, EventBridge rules) differ between free and paid tiers. The master plan already flags licensing as unverified. | Decide the image and licence before writing compose. Pin the tag. If a token is required, take it from `.env` and never commit it. Record the decision in the decisions log. |
| R2 | LocalStack health reports ready before all services finish lazy initialisation. | Health check queries `/_localstack/health` for the four required services, not only HTTP 200. Provisioning scripts (POC-002, POC-003) must also retry. |
| R3 | Presigned URL host mismatch between container and host. | Separate internal and public S3 endpoint variables (section 4). |
| R4 | FFmpeg and Sharp image size and build time slow first start. | Use a multi-stage build and a BuildKit cache. |
| R5 | Port clashes with a local Postgres or Redis. | All host ports are overridable through `.env`. |

## 10. Definition of done

- `docker-compose.yml`, `.env.example`, `Makefile` and stub services committed.
- Section 8 checks 1 to 5 and 7 pass on a clean machine.
- Endpoint table present in the README.
- LocalStack image and licence decision (R1) recorded.
