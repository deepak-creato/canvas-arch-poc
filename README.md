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

## Current state

POC-001: all services start and report healthy. Canvas API and workers are stubs (`services/_stub`) that only answer `/healthz`.

## Notes

- LocalStack is pinned to `3.8.1`. Check licence/auth-token requirements before bumping (`LOCALSTACK_AUTH_TOKEN` in `.env`, never commit it).
- Presigned URLs must use `S3_PUBLIC_ENDPOINT`; container-to-container calls use `AWS_ENDPOINT_URL`.
