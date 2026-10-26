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
- `make verify` / `make health` / `make preflight` / `make verify-m2` / `make test`
- `make demo` (wipes volumes, bootstraps, runs the demonstration) / `make demo-run`
- `make up` — start the stack and wait for health
- `make down` — stop the stack
- `make logs`, `make ps`
- `make ui-install` / `make ui` / `make ui-test` — browser test UI in `web/` at `127.0.0.1:5173`

## Layout

- `docker-compose.yml`, `.env.example`, `Makefile`
- `services/` — `canvas-api`, `light-worker`, `ai-worker`, `mock-transcoder`, `gc-worker`
- `infra/` — Postgres init, LocalStack bootstrap scripts
- `docs/plans/` — per-ticket implementation plans
- `docs/api/`, `docs/architecture.md`, `docs/runbook.md`, `docs/validation-checklist.md` — handoff docs
- `docs/ai/` — AI-assistant context documents
- `web/` — Vite + React test UI (POC-041); dev-server proxy instead of API CORS, host-run, not in Compose

## Status

POC-001 (compose stack, stub services), POC-002 (S3 buckets) and POC-003 (queues, DLQs, S3 to EventBridge to SQS on the `staging/` prefix) done. Check with `make verify`. Always pass an explicit `--endpoint-url` to `aws` in the LocalStack container. POC-004 (SQL migrations in `db/migrations/`, run by the `migrate` service; forward-only, never edit an applied file) done. POC-005 (`make bootstrap`/`teardown`/`preflight`/`health`/`smoke-sfn`) done: M1 complete. Step Functions task-token callbacks work on LocalStack 2026.10.2. POC-006 (`POST /v1/uploads`, NestJS `canvas-api`, shared code in `services/shared/`, `make test`) done. Owner comes from the `X-Owner-Id` header. POC-007 (`POST /v1/uploads/{id}/complete`: HEAD check, `PENDING_UPLOAD → UPLOADED`, idempotent `validate:{asset_id}` job) done. POC-008 (light-worker consumes `light-processing`; the S3 event or the API `complete` call, whichever comes first, confirms the upload via `services/shared/confirm-upload.ts`; the validate job is created but not yet run) done. POC-009 (light-worker validates: streams the object, recomputes SHA-256, sniffs magic bytes, probes with Sharp/ffprobe + full ffmpeg decode; `UPLOADED → VALIDATED` or `REJECTED` with `reject_reason` `FILE_TOO_LARGE|HASH_MISMATCH|TYPE_MISMATCH|CORRUPT_FILE|SIZE_MISMATCH|CONTENT_TYPE_MISMATCH`; fixtures in `fixtures/`, regenerate with `infra/scripts/gen-fixtures.sh`) done. POC-010 (after `VALIDATED`, light-worker writes draft-tier `thumbnail` (320px) and `preview` (1280px) WebP renditions with Sharp to `derived/{asset_id}/{kind}/v1/{params}.webp`, job `derive:{asset_id}:image:v1`, HEAD-before-work) done. Worker tests run serially (they share one queue). POC-011 (video: `poster` jpg, `proxy` 640px h264 mp4, `sprite` jpg sheets of 5x5 frames, `sprite_manifest` `sprite.json` with per-frame time/x/y; shared loop in `services/light-worker/src/derive-common.ts`, job `derive:{asset_id}:video:v1`) done. POC-012 (job claim with lease + heartbeat, attempts, exponential backoff via SQS visibility, `FAILED_PERMANENT` -> message reaches the DLQ; test failure injection through job payload `fail_mode` when `WORKER_TEST_HOOKS=true`; `services/shared/job-repo.ts`) done. POC-013 (`GET /v1/assets/{id}`: owner-scoped, `processing_status` roll-up `PENDING|PROCESSING|READY|FAILED|REJECTED|EXPIRED`, presigned URLs for READY renditions) done: M2 complete, `make verify-m2` runs the exit demo (5 images + 1 video, no final tier). POC-014 to POC-019 (M3, `services/canvas-api/src/drafts/`, plan in `docs/plans/M3_plan.md`): draft create/get/list, immutable revisions with canonical content hash (unchanged save adds nothing), required `base_revision` (`409 REVISION_CONFLICT`, draft row lock), `asset_id` references per revision in the save transaction (`services/shared/refs.ts`, 422 for bad assets), `recalcRetention` for `ref_count`/`retention_status`/`orphaned_at`, revision restore as a new head, soft discard/restore of drafts. Tests in `test/drafts.spec.ts` (M3 exit demo included) done: M3 complete. POC-020 (`services/shared/mock-layout.ts`: deterministic `generateLayout`, `validateCanvas`; ai-worker scaffold), POC-021 (`POST /v1/drafts/{id}/ai-layouts` -> `ai_generation` row + `ai-requests` message; ai-worker `QUEUED -> PROCESSING -> READY|FAILED`; `GET /v1/ai-layouts/{id}`; test hook `test_fail` when `WORKER_TEST_HOOKS=true`), POC-022 (cache by owner + `cache_key` = input hash + model version + seed, hit returns `200` `cached: true` with no queue message; `POST /v1/drafts/{id}/ai-layouts/{genId}/accept` saves an `AI_GENERATION` revision through the normal save path) done; plan in `docs/plans/M4_plan.md`. Tests: `canvas-api/test/ai.spec.ts`, `ai-worker/test`. M4 complete. POC-023 to POC-030 (M5, plan in `docs/plans/M5_plan.md`) done: `mock-transcoder` (queue `transcode-requests`, places `fixtures/sample.mp4`, no transcoding; `GET :3103/jobs?asset_id=`), `services/shared/final-renditions.ts` (video-only FINAL rows, key `final/{asset_id}/video/v1/...`, READY reuse), publish state machine `infra/stepfunctions/publish.asl.json` (created by `infra/localstack/init/03-publish-state-machine.sh`; no Lambda, every step is an SQS task-token message answered by the step runner in `canvas-api/src/publish/`), `POST /v1/drafts/{id}/publications` (`Idempotency-Key`, `{revision}`), `GET /v1/publications/{id}`, `POST .../canvas-upload`, `POST .../canvas-uploaded`, `POST .../retry`, `GET /v1/drafts/{id}/status`, `publication_transition` trace table (migration 0007), atomic `LIVE` in `publish/mark-live.ts`. Tests: `canvas-api/test/{finals,workflow,publish,canvas-gate,canvas-uploaded,publish-live,retry}.spec.ts`, `mock-transcoder/test`. M5 complete. POC-031 to POC-036 (M6, plan in `docs/plans/M6_plan.md`) done: `services/gc-worker` (steps are functions in `src/`, one cycle under a Postgres advisory lock via `POST :3104/run[?step=a,b]` / `make gc-run`; `GC_INTERVAL_SECONDS=0` = no timer; all graces are `GC_*_SECONDS` config). `expire.ts` (PENDING_UPLOAD -> EXPIRED, UNATTACHED -> ORPHANED), `prune.ts` (purge DISCARDED drafts to PURGED, prune old unpinned revisions), `sweep.ts` (ORPHANED -> DELETING under row lock with second reference check and active-job check, delete original + all derived/final objects, then DELETED tombstone; migration 0008; light-worker acks events for DELETING/DELETED), `jobs.ts` + `dlq.ts` (lease reaper, requeue by synthetic S3 event, `make gc-jobs/gc-dlq/gc-redrive`), `reconcile.ts` (missed upload events, DB/storage drift, stray objects: reported, deleted only with `GC_DELETE_STRAYS=true`; `make gc-reconcile`). Tests: `gc-worker/test/*.spec.ts` (seeded rows use keys outside `staging/` so S3 events do not wake the light-worker; `exit-demo.spec.ts` is the M6 exit demo). POC-037 to POC-040 (M7, plan in `docs/plans/M7_plan.md`) done: `canvas-api/test/lifecycle.spec.ts` (whole lifecycle, uses gc-worker functions for cleanup), `faults.spec.ts` (duplicates, concurrency, worker crash via `docker compose kill light-worker`, invariants), `docs/validation-checklist.md` (checklist line -> test), `make demo` (teardown + bootstrap + `infra/scripts/demo.sh`, wipes volumes) / `make demo-run`, docs: `README.md`, `docs/api/`, `docs/architecture.md`, `docs/runbook.md`. M7 complete: all 40 tickets done.
