# M2 — Media ingestion and draft-tier processing (POC-006 to POC-013)

## Context

M1 is done: compose stack, buckets, queues, S3 -> EventBridge -> SQS on `staging/`, migrations (`media_asset`, `media_rendition`, `processing_job` exist), bootstrap. All services are still `services/_stub` (a `/healthz` placeholder, built by the `x-app` anchor in `docker-compose.yml`). M2 replaces `canvas-api` and `light-worker` stubs with real code.
Deliverable: presigned upload -> event -> worker -> `READY` renditions. Exit demo: 5 images + 1 video all usable, no final-tier transcode.

## Decisions (stated, not asked; reverse any you dislike)

- **Language/stack:** TypeScript, NestJS for `canvas-api` (per CLAUDE.md). `light-worker` is a plain Node/TS process (no Nest) with a tiny `/healthz`. Libraries: `pg`, `@aws-sdk/client-s3`, `@aws-sdk/client-sqs`, `@aws-sdk/s3-request-presigner`, `sharp`; `ffmpeg`/`ffprobe` from apt in the worker image. Pin image tags and package versions.
- **Shared code:** `services/shared/` (db pool, S3/SQS clients, logger with `asset_id/job_id/correlation_id`, key helpers, job repo). Each service Dockerfile builds with repo root context. Avoids copy-paste between API and worker.
- **Owner identity:** `X-Owner-Id` header (no auth in POC). Missing -> 400.
- **Keys:** original `staging/{owner}/{asset_id}/source` in ingest bucket (fixed in POC-003). Renditions in derived bucket: `derived/{asset_id}/{kind}/v{recipe_version}/{params_hash}.{ext}` (draft tier). One helper builds keys; `UNIQUE (bucket, s3_key)` backs determinism.
- **Dedup:** `POST /v1/uploads` takes `sha256`, `content_type`, `size_bytes`, `filename`. Lookup `(owner_id, client_sha256)` over live assets (the partial unique index `media_asset_owner_hash_active`). Hit with `VALIDATED` -> `deduplicated=true`, no URL. Hit with `PENDING_UPLOAD`/`UPLOADED` -> return same `asset_id` with fresh presigned URL (if still pending) — never a second row. Race: insert, catch unique violation, re-select.
- **Fake client hash:** the worker recomputes SHA-256; mismatch -> `REJECTED` with reason `HASH_MISMATCH`. Dedup trusts `client_sha256` only until validation, which is why only `VALIDATED` assets are reused as "done".
- **Limits** in env (`MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`, allowed MIME list: png/jpeg/webp, mp4). Enforced at reservation (declared size) and again in worker via HEAD/real bytes plus magic-byte sniff (not trusting content-type).
- **Event path (POC-008):** worker long-polls `light-processing`, parses EventBridge body (`detail.bucket.name`, `detail.object.key`), derives `asset_id` from key. API `complete` (POC-007) and S3 event both converge on one job via idempotency key `validate:{asset_id}` — whichever arrives first creates the job, the other is a no-op. Unknown key / unknown asset -> delete message and log (not retry forever).
- **Job model (POC-012):** `processing_job` rows with `idempotency_key` unique. Claim = single `UPDATE ... WHERE status IN ('QUEUED','FAILED') AND available_at<=now() OR lease expired ... RETURNING` with `lease_owner`, `lease_expires_at`, `attempts+1`. Lease extended by heartbeat on long FFmpeg runs. Retryable error -> `FAILED`, `available_at` backoff, message left to SQS redelivery (visibility 120s); attempts >= `max_attempts` -> `FAILED_PERMANENT` + message left to fall into DLQ (maxReceiveCount 3). Success -> `SUCCEEDED`, delete message. Duplicate message for `SUCCEEDED` job -> delete, no work. HEAD-before-work: if rendition object already exists at key, mark `READY` without re-encoding.
- **Pipeline per asset:** `validate` job (POC-009) -> on `VALIDATED`, enqueue idempotent `image-derive` or `video-derive` jobs by key `derive:{asset_id}:{kind}:v1`. Worker enqueues follow-ups to `light-processing` via its own internal message, or runs them inline in the same handler (recommended: inline, sequential, one SQS message per upload — simpler, fewer redelivery edge cases). Rendition rows created `QUEUED` up front, `PROCESSING` -> `READY`/`FAILED`.
- **Renditions:** image: `thumbnail` (320px, webp), `preview` (1280px, webp) via Sharp. Video: `poster` (jpg), `proxy` (low-res mp4, e.g. 640px h264 crf 30), `sprite` sheets + `sprite.json` (frame width/height, columns, per-frame timestamps) via FFmpeg. Metadata (dims, duration, codec) in `media_asset.metadata`.
- **No draft work here:** M2 does not touch drafts/references; "usable in drafts" = assets `VALIDATED` with all draft renditions `READY`.
- **Presign host:** sign with `S3_PUBLIC_ENDPOINT` (host-reachable) while server-side S3 calls use `AWS_ENDPOINT_URL`. Two clients. Path-style forced.
- **Expiry:** `upload_expires_at` set (e.g. 15 min). Marking `EXPIRED` belongs to GC (later); M2 only sets the column and rejects `complete` after expiry.

## Ticket order and files

1. **POC-006 `POST /v1/uploads`** — scaffold `services/canvas-api` (Nest, `src/uploads/*`, `src/db`), `services/shared/*`, replace stub in compose (`build` per service, keep `/healthz` on 3000), DTO validation, reservation insert, presign PUT with content-type + length constraint. Update `.env.example` (limits, expiry, `API_OWNER_HEADER` not needed). Tests: new -> 201 with URL; same owner+hash -> same `asset_id`/dedup; different owner -> distinct asset; concurrent double-POST -> one row.
2. **POC-007 `POST /v1/uploads/{id}/complete`** — owner check, expiry check, S3 `HEAD`; size/etag recorded; `PENDING_UPLOAD -> UPLOADED` only if object exists and size matches declared; else 409/422 and state unchanged. Idempotent on repeat. Creates `validate` job row (QUEUED) idempotently.
3. **POC-008 light-worker consumer** — `services/light-worker` (replace stub): SQS loop, EventBridge parse, job lookup/create, graceful shutdown, structured logs. Verify presigned PUT raises the event (open risk noted in POC-003 plan). Duplicate event test: send same message twice -> one job, one set of outputs.
4. **POC-009 validate** — stream object once: SHA-256 + size, magic-byte type sniff, Sharp metadata / ffprobe, limit checks. Success -> `VALIDATED`, `server_sha256`, `metadata`. Failure -> `REJECTED` + `reject_reason`, no derive. Fixtures: good PNG/JPEG/WebP, MP4, corrupt file, wrong-type file, lying-hash upload, oversize (generated, config-lowered limit).
5. **POC-010 image renditions** — Sharp thumbnail + preview, write to derived bucket at deterministic keys, rendition rows `READY`, HEAD-before-work.
6. **POC-011 video renditions** — FFmpeg poster, proxy, sprite sheets, `sprite.json`; temp dir cleanup; worker image installs ffmpeg; timeouts per spawn.
7. **POC-012 idempotency/leases/DLQ** — formalize the job repo built in 008–011 (claim, heartbeat, backoff, permanent failure); test mode env `WORKER_FAIL_MODE=transient|permanent` for deterministic failure tests; assert redelivery then DLQ with a poison message.
8. **POC-013 `GET /v1/assets/{id}`** — owner-scoped; aggregate `upload_status`, per-rendition status, overall `processing_status` (`PENDING|PROCESSING|READY|FAILED|REJECTED`), rendition URLs (presigned GET from derived bucket via public endpoint). 404 across owners.

Order is 006 -> 007 -> 008 -> 009 -> (010, 011) -> 012 -> 013; 012 logic is introduced minimally in 008 and hardened last.

## Cross-cutting

- Migrations: forward-only. Likely none needed. If a column is missing (e.g. `etag`), add `0007_*.sql`, never edit applied files.
- Per ticket: branch + commit named with ticket ID; plan copy in `docs/plans/POC-0NN_*.md`; update CLAUDE.md status line and README.
- Add `make verify-m2` (`infra/scripts/verify-m2.sh`) and a demo script: upload 5 images + 1 video, poll until ready, assert no final-tier rows/jobs. Add redistributable fixtures under `fixtures/` (generated or CC0; no real photos of unknown licence).
- Update decisions log (plan section 12) for: inline sequential derive, per-queue DLQs (already noted), presign dual endpoints.

## Verification (M2 exit)

1. `make bootstrap` green (existing checks still pass with real services).
2. `make verify-m2`: 5 images + 1 mp4 uploaded via presigned PUT + `complete`; all reach `VALIDATED` with `READY` renditions; objects exist at expected derived keys (HEAD); `sprite.json` parses.
3. Negatives: repeat upload same owner -> same asset; other owner -> new asset; corrupt file -> `REJECTED`; fake hash -> `REJECTED`; duplicate SQS message -> no duplicate job/outputs; forced transient failure -> retry then success; forced permanent failure -> `FAILED_PERMANENT` and message in DLQ.
4. `SELECT count(*) FROM media_rendition WHERE tier='FINAL'` = 0 and no transcode jobs.
5. Unit/integration tests per ticket run in CI-less local `make test`.

## Risks

- Presigned PUT may not emit the EventBridge event on LocalStack -> `complete` endpoint still creates the job, so the flow works either way; record deviation if so.
- FFmpeg in worker image increases build time/size; pin a Debian/Alpine base tag.
- Presigned URL host mismatch (container vs host) — covered by the dual-client decision.
