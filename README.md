# Canvas Editor Media Platform — LocalStack POC

Local-only POC. Scope and tickets: [Canvas_Editor_Media_Platform_POC_Plan.md](Canvas_Editor_Media_Platform_POC_Plan.md). AI context: [CLAUDE.md](CLAUDE.md).

## Quick start (fresh clone)

Requires Docker with Compose 2.20 or newer. No AWS account or AWS credentials; the `test`/`test` keys are fake. LocalStack 2026.x does need a LocalStack auth token (free account at https://app.localstack.cloud).

```bash
cp .env.example .env          # then set LOCALSTACK_AUTH_TOKEN in .env (never commit it)
make bootstrap                # preflight, start, health, all verification checks
```

`make bootstrap` is the M1 exit demo: it starts every service and shows an S3 upload under `staging/` arriving on the `light-processing` queue.

| Command | What it does |
| --- | --- |
| `make bootstrap` | preflight, build and start, health report, `make verify` |
| `make teardown` | stop everything and delete containers, volumes and network (clean slate; `make reset` is an alias) |
| `make up` / `make down` | start (with wait) / stop without deleting data |
| `make preflight` | check Docker, Compose, `.env`, token and free ports |
| `make health` | one report across containers, LocalStack, Postgres, Redis, API, buckets, queues, migrations |
| `make verify` | S3, events, schema and Step Functions checks (`verify-s3`, `verify-events`, `verify-schema`, `smoke-sfn`) |
| `make psql`, `make logs`, `make ps`, `make migrate` | helpers |

### Troubleshooting

- `preflight` says a port is in use: set the named `HOST_PORT_*` variable in `.env` to a free port.
- LocalStack exits with `License activation failed`: set `LOCALSTACK_AUTH_TOKEN` in `.env`.
- Strange state after an interrupted run: `make teardown && make bootstrap`.
- DBX or another host client: connect to `127.0.0.1:5433`, not host `postgres` (that name only resolves inside Docker).

## Local endpoints (host)

All ports bind to `127.0.0.1` and can be changed in `.env`.

| Service | URL / address | Notes |
| --- | --- | --- |
| Canvas API | `http://localhost:3000` | `GET /healthz` (stub until M2) |
| Mock transcoder | `http://localhost:3103` | `GET /healthz` (stub until M5) |
| LocalStack gateway | `http://localhost:4566` | S3, SQS, EventBridge, Step Functions |
| LocalStack health | `http://localhost:4566/_localstack/health` | |
| PostgreSQL | `localhost:5433` | user, password, db: `canvas` |
| Redis | `localhost:6380` | |

Worker containers (`light-worker`, `ai-worker`, `gc-worker`) expose `/healthz` only inside the compose network (ports 3101, 3102, 3104). Inside the network use service names instead of `localhost`.

Host ports 5433 and 6380 are used (not 5432/6379) to avoid clashing with local Postgres/Redis.

## S3 buckets (POC-002)

`media-ingest-poc`, `media-derived-poc`, `media-published-poc` are created on LocalStack start by `infra/localstack/init/01-buckets.sh` (idempotent; CORS on ingest and published). Check with `make verify-s3` (PUT, HEAD, GET, DELETE on each bucket).

## Queues and events (POC-003)

Created on LocalStack start by `infra/localstack/init/02-queues-events.sh` (idempotent):

- Queues: `light-processing`, `ai-requests`, each with a DLQ (`*-dlq`, `maxReceiveCount` 3).
- Uploads go under `staging/` in `media-ingest-poc`. S3 sends object events to the default EventBridge bus, and rule `ingest-staging-created` routes only the `staging/` prefix to `light-processing`.
- Check with `make verify-events` (routing, payload, prefix filter, redrive config, retry then DLQ). `make verify` runs S3 and event checks.

## Database migrations (POC-004)

Plain SQL files in `db/migrations/` are applied in name order by the one-shot `migrate` service on every `make up` (also `make migrate`). Forward-only: to change the schema add a new numbered file; editing an applied file makes the runner fail with a checksum error. `make reset` gives a clean database. `make psql` opens a shell, and `make verify-schema` checks the constraints (dedup, one publication per draft, immutable revisions, single-holder references, job idempotency).

Tables: `media_asset`, `media_rendition`, `canvas_draft`, `canvas_revision`, `media_reference`, `processing_job`, `publication`, `publication_asset`, `ai_generation`, `outbox_event`, plus `schema_migrations`.

## Step Functions smoke test (POC-005)

`make smoke-sfn` creates a temporary state machine and checks `Wait`, `Parallel`, the SQS `sendMessage.waitForTaskToken` callback (success and failure with `Catch`) and the execution history, then deletes it. It also asserts the account is `000000000000`, so it cannot be talking to real AWS. These are the features the publish workflow (POC-025, 027, 028) relies on.

## Current state

POC-001 to 005 (M1 complete): all services start, buckets, queues and the database schema exist. Services start and report healthy. Canvas API and workers are stubs (`services/_stub`) that only answer `/healthz`.

## Notes

- LocalStack is pinned to `2026.10.2` (needs `LOCALSTACK_AUTH_TOKEN` in `.env`, never commit it). Scripts use the bundled `aws` CLI (always with an explicit `--endpoint-url`) because `awslocal` is deprecated, and the image has no `curl`.
- Presigned URLs must use `S3_PUBLIC_ENDPOINT`; container-to-container calls use `AWS_ENDPOINT_URL`.
