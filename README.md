# Canvas Editor Media Platform — LocalStack POC

Local-only POC. Scope and tickets: [Canvas_Editor_Media_Platform_POC_Plan.md](Canvas_Editor_Media_Platform_POC_Plan.md). AI context: [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
make up      # copies .env.example to .env if missing, builds, starts, waits for healthy
make ps
make down    # stop
make reset   # stop and delete volumes (clean state)
```

Requires Docker with Compose v2. No AWS account or credentials; the `test`/`test` keys are fake.

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

## Current state

POC-001/002: all services start and buckets exist. Services start and report healthy. Canvas API and workers are stubs (`services/_stub`) that only answer `/healthz`.

## Notes

- LocalStack is pinned to `2026.10.2` (needs `LOCALSTACK_AUTH_TOKEN` in `.env`, never commit it). Scripts use the bundled `aws` CLI because `awslocal` is deprecated, and the image has no `curl`.
- Presigned URLs must use `S3_PUBLIC_ENDPOINT`; container-to-container calls use `AWS_ENDPOINT_URL`.
