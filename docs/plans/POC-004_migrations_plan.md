# POC-004 — PostgreSQL migrations: plan

## Context

POC-004 (Milestone M1, P0): create the database schema for drafts, revisions, assets, renditions, references, processing jobs, publications, AI generation and the outbox. Acceptance: the schema initializes on a clean database, with unique constraints and indexes.

Already in place: Postgres 16.4 in compose (`canvas` database, host port 5433, `pgdata` volume), an empty `infra/postgres/init/` mount, and the state machines and table list in section 6 of the POC plan. No NestJS code exists yet (services are stubs), so the migration mechanism must not depend on the API project.

## Decisions

- **Plain SQL migrations plus a small `psql` runner.** No ORM or Node dependency, works before the API exists, and the same files are used by tests and by the API later. Files live in `db/migrations/NNNN_name.sql`. Forward-only: the POC resets with `make reset` instead of down-migrations.
- **Runner as a one-shot compose service `migrate`** (image `postgres:16.4-alpine`, mounts `./db/migrations` and `infra/db/migrate.sh`). It runs after Postgres is healthy. API and workers wait for it with `condition: service_completed_successfully`, so no service starts against an empty schema.
- **Text columns with `CHECK` constraints instead of Postgres enums.** The state names match section 6 of the POC plan exactly, and constraints are easier to change than enum types.
- **UUID primary keys** with the built-in `gen_random_uuid()` (no extension needed on 16). `timestamptz` for all times.
- **One publication per draft** is enforced in the database: `UNIQUE (draft_id)` on `publication`. A failed publication is retried on the same row (POC-030), never a second row.
- **Draft to head revision uses `head_revision_no`, not a foreign key,** to avoid a circular reference between `canvas_draft` and `canvas_revision`.
- **References are deleted when released** (GC re-checks counts against live rows); `media_asset.ref_count` is a cached value recalculated in POC-018.

## Schema

All tables have `created_at`, and mutable ones have `updated_at` kept by a shared `set_updated_at()` trigger.

| Table | Key columns | Constraints and indexes |
| --- | --- | --- |
| `media_asset` | `owner_id`, `kind` (IMAGE, VIDEO), `client_sha256`, `server_sha256`, `content_type`, `size_bytes`, `original_bucket`, `original_key`, `metadata` jsonb, `upload_status`, `reject_reason`, `retention_status`, `ref_count`, `orphaned_at`, `upload_expires_at` | Owner-scoped dedup: partial unique index on `(owner_id, client_sha256)` where `upload_status` is `PENDING_UPLOAD`, `UPLOADED` or `VALIDATED` and `retention_status` is not `DELETING` or `DELETED`. Unique `(original_bucket, original_key)`. `CHECK ref_count >= 0`. Indexes `(retention_status, orphaned_at)` for GC and `(upload_status, upload_expires_at)` for expiry. |
| `media_rendition` | `asset_id` fk, `kind`, `tier` (DRAFT, FINAL), `recipe_version`, `params_hash` (default empty, for clip ranges), `bucket`, `s3_key`, `status`, `error`, `metadata` jsonb | Unique `(asset_id, kind, recipe_version, params_hash)` (idempotent outputs), unique `(bucket, s3_key)`. Index on `(asset_id, status)`. |
| `canvas_draft` | `owner_id`, `status`, `head_revision_no`, `last_activity_at`, `discarded_at`, `purge_after` | Index `(owner_id, status)` and `(status, purge_after)`. |
| `canvas_revision` | `draft_id` fk, `revision_no`, `document` jsonb, `content_hash`, `source` (INITIAL, USER_SAVE, AI_GENERATION, RESTORE), `restored_from_revision_no`, `pinned` | Unique `(draft_id, revision_no)`. Trigger rejects any update that changes `document`, `content_hash` or `revision_no` (immutable snapshots; only `pinned` may change). Delete stays allowed for pruning (POC-032). |
| `publication` | `draft_id` fk, `revision_id` fk, `owner_id`, `status`, `idempotency_key`, `execution_arn`, `render_bucket`, `render_key`, `manifest_key`, `failure_reason`, `live_at` | **Unique `(draft_id)`**, unique `(owner_id, idempotency_key)`. |
| `publication_asset` | `publication_id` fk, `asset_id` fk, `rendition_id` fk, `role` | Primary key `(publication_id, asset_id, rendition_id)`. |
| `media_reference` | `asset_id` fk, `revision_id` fk or `publication_id` fk | `CHECK num_nonnulls(revision_id, publication_id) = 1`. Partial unique `(asset_id, revision_id)` and `(asset_id, publication_id)`. Indexes on `asset_id`, `revision_id`, `publication_id`. Cascade on revision or publication delete. |
| `processing_job` | `job_type`, `idempotency_key`, `asset_id` fk, `publication_id` fk (nullable), `payload` jsonb, `status`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, `available_at`, `last_error`, `completed_at` | Unique `(idempotency_key)`. Indexes `(status, lease_expires_at)` and `(asset_id)`. |
| `ai_generation` | `draft_id` fk, `owner_id`, `status`, `input_hash`, `model_version`, `seed`, `cache_key`, `request` jsonb, `result` jsonb, `error`, `cached_from_id` self fk, `accepted_revision_no` | Index on `cache_key` where `status = 'READY'` (cache lookup) and on `(draft_id, created_at)`. |
| `outbox_event` | `id` bigserial, `aggregate_type`, `aggregate_id`, `event_type`, `payload` jsonb, `published_at`, `attempts` | Partial index on `(id)` where `published_at IS NULL`. |

Status columns carry `CHECK` lists taken from the POC plan section 6: upload, rendition, retention, publication and draft states, plus job states `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `FAILED_PERMANENT` and AI states `QUEUED`, `PROCESSING`, `READY`, `FAILED`.

## Files

1. `db/migrations/` (new), applied in this order:
   - `0001_helpers.sql`: `set_updated_at()` function.
   - `0002_media.sql`: `media_asset`, `media_rendition`.
   - `0003_drafts.sql`: `canvas_draft`, `canvas_revision`, immutability trigger.
   - `0004_publications.sql`: `publication`, `publication_asset`.
   - `0005_references_jobs.sql`: `media_reference`, `processing_job`.
   - `0006_ai_outbox.sql`: `ai_generation`, `outbox_event`.
2. `infra/db/migrate.sh` (new): connects with `DATABASE_URL`, takes `pg_advisory_lock`, creates `schema_migrations(version, checksum, applied_at)`, applies each unapplied file inside one transaction with `ON_ERROR_STOP`, and records its checksum. If an applied file's checksum changed it stops with an error, so edited history is caught.
3. `docker-compose.yml` (edit): add the `migrate` service (restart `no`, `depends_on` postgres healthy, same `DATABASE_URL`). Add `migrate: service_completed_successfully` to the shared `x-app` dependencies.
4. `infra/scripts/verify-schema.sh` (new): runs `psql` inside the postgres container; see Verification.
5. `Makefile` (edit): add `migrate` (re-run the runner), `psql` (open a shell on the `canvas` database) and `verify-schema`. Add `verify-schema` to `make verify`.
6. `README.md`, `CLAUDE.md` (edit): migration workflow (add a new numbered file, never edit an applied one), table overview, status moves to "POC-004 done, next POC-005".
7. `docs/plans/POC-004_migrations_plan.md` (new): copy of this plan.

## Risks

- `docker compose up --wait` and a one-shot service that exits: recent Compose accepts exit code 0, but this must be confirmed here (Compose 5.5.1). Fallback: keep the runner as `make migrate` and have `make up` call it after `--wait`.
- The partial unique index for dedup must treat `REJECTED` and `EXPIRED` assets as not blocking a re-upload. Covered by a check.
- `client_sha256` is untrusted until POC-009 recomputes `server_sha256`. The plan lets dedup use the client hash at reservation time, so the column is separate from the server hash.
- Schema may need small changes as M2 to M5 find gaps. Add new numbered migrations after this ticket, never edit applied ones.

## Verification

1. `make reset && make up`: the `migrate` container exits 0 and all services become healthy.
2. `docker compose exec postgres psql -U canvas -d canvas -c '\dt'` lists the ten tables plus `schema_migrations`.
3. `make migrate` a second time applies nothing and exits 0 (idempotent). Editing an applied file makes it fail with a checksum error (checked manually, then reverted).
4. `make verify-schema` runs inside a transaction that is rolled back, and checks that:
   - a second active asset with the same owner and hash is rejected, a different owner is accepted, and a `REJECTED` one does not block re-upload;
   - two publications for one draft are rejected, and a repeated `(owner_id, idempotency_key)` is rejected;
   - duplicate `(draft_id, revision_no)` is rejected, and updating a revision's `document` is rejected while changing `pinned` works;
   - a reference row with both or neither of `revision_id` and `publication_id` is rejected;
   - a duplicate `processing_job.idempotency_key` is rejected, and an invalid status value is rejected by its `CHECK`.
5. Connect with DBX at `127.0.0.1:5433` and confirm the tables are visible.

## Implementation notes (as built)

- The runner does not use `pg_advisory_lock`. It checks state with one `psql` call per file, then applies each file and its `schema_migrations` row in a single transaction. A concurrent second runner fails on the primary key and rolls back, so a migration cannot apply twice.
- `docker compose up --wait` accepts the one-shot `migrate` service (exit 0), so the fallback was not needed.
- `make verify-schema` checks 11 constraints; `make verify` now runs 22 checks in total (S3, events, schema).
