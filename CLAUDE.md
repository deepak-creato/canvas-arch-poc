# Canvas Editor Media Platform — POC

Local-only proof of concept for the Canvas Editor media lifecycle: upload, light processing, draft revisions, mock AI layouts, publish, and safe garbage collection. The full scope, ticket list and state machines are in `Canvas_Editor_Media_Platform_POC_Plan.md`. Treat that file as the source of truth. Per-ticket plans are in `docs/plans/`.

## Hard constraints

- No AWS account or AWS-managed service. Use LocalStack for S3, SQS, EventBridge and Step Functions. Use fake credentials (`test`/`test`).
- No AWS Elemental MediaConvert. The mock transcoder places a valid fixture at the requested output key. It does not transcode, and no code or doc may claim that it does.
- No real AI model. The mock AI returns deterministic, schema-valid canvas JSON.
- No server-side canvas composition. The client uploads the rendered canvas through a presigned URL.
- Bind published ports to `127.0.0.1` only.

## Stack

NestJS API, PostgreSQL, Redis, Sharp and FFmpeg workers, Docker Compose. Pin every image tag.

## Domain rules to preserve

- Postgres is the source of truth. Redis holds only ephemeral data.
- A canvas edit creates a JSON revision only. It never starts a media-processing job.
- Revisions are immutable. Restoring an old revision creates a new head revision.
- Saves require `base_revision`. A stale save returns `409 REVISION_CONFLICT`.
- Deduplication is by SHA-256 within one owner, never across owners.
- Jobs are idempotent: unique job keys, deterministic output keys, HEAD-before-work.
- One publication per draft. The published revision is frozen, and edits during or after publishing are rejected.
- GC deletes only after the grace period and a second zero-reference check inside a lock. New references to `DELETING` or `DELETED` assets are rejected.
- State transitions use the names in plan section 6 exactly.

## Working rules

- Follow the ticket IDs (POC-001 to POC-040). Name branches and commits with the ticket ID.
- Log with structured fields: `asset_id`, `job_id`, `draft_id`, `publication_id`, correlation ID.
- If a LocalStack feature is unavailable, keep the API, event payloads and state transitions identical, use a container-based equivalent, and record the deviation in the decisions log.
- Do not commit secrets, including `LOCALSTACK_AUTH_TOKEN`. Keep `.env` out of version control and maintain `.env.example`.
- Test data must be redistributable.

## Common commands

- `make bootstrap` — preflight, start, health, all verification (fresh-clone flow)
- `make teardown` — remove containers, volumes, network
- `make verify` / `make health` / `make preflight`
- `make up` — start the stack and wait for health
- `make down` — stop the stack
- `make logs`, `make ps`

## Layout

- `docker-compose.yml`, `.env.example`, `Makefile`
- `services/` — `canvas-api`, `light-worker`, `ai-worker`, `mock-transcoder`, `gc-worker`
- `infra/` — Postgres init, LocalStack bootstrap scripts
- `docs/plans/` — per-ticket implementation plans
- `docs/ai/` — AI-assistant context documents

## Status

POC-001 (compose stack, stub services), POC-002 (S3 buckets) and POC-003 (queues, DLQs, S3 to EventBridge to SQS on the `staging/` prefix) done. Check with `make verify`. Always pass an explicit `--endpoint-url` to `aws` in the LocalStack container. POC-004 (SQL migrations in `db/migrations/`, run by the `migrate` service; forward-only, never edit an applied file) done. POC-005 (`make bootstrap`/`teardown`/`preflight`/`health`/`smoke-sfn`) done: M1 complete. Step Functions task-token callbacks work on LocalStack 2026.10.2. Next ticket: POC-006 (`POST /v1/uploads`, M2).
