# M3 — Drafts, revisions, and asset references (POC-014 to POC-019)

## Context

M2 is done: assets upload, validate and get draft-tier renditions. M3 adds editable canvas documents with immutable history, optimistic locking and reference tracking. Schema already exists (`canvas_draft`, `canvas_revision` with an immutability trigger, `media_reference`, `media_asset.ref_count/retention_status/orphaned_at`), so no new migration is planned.
Exit demo: edit the same draft 20 times, no new `processing_job` rows; restore an earlier revision and its media stays retained.

## Decisions (stated, not asked; reverse any you dislike)

- **Code:** `services/canvas-api/src/drafts/` (controller, service, DTOs). Reference and retention SQL in `services/shared/refs.ts` so the GC worker (M6) reuses the same recalculation.
- **Owner:** `X-Owner-Id` header, as in M2. Another owner's draft looks like a missing one (404 `DRAFT_NOT_FOUND`).
- **Document shape:** any JSON object. The API only requires an object (max size `MAX_DOCUMENT_BYTES`, default 2 MiB). Asset references are every string value under a key named `asset_id` at any depth. A new draft starts with `{ "elements": [] }` unless a document is given.
- **Content hash:** SHA-256 over canonical JSON (keys sorted recursively, arrays keep order). Same hash as head = unchanged = no new revision (`200`, `unchanged: true`, same `revision_no`).
- **Concurrency:** save runs in one transaction with `SELECT ... FOR UPDATE` on the draft row. `base_revision` must equal `head_revision_no`, else `409 REVISION_CONFLICT` with `head_revision` in the body. `base_revision` is required (`400` when missing). The unchanged check runs after the conflict check.
- **Editable states:** only `ACTIVE`. `PUBLISHING`, `PUBLISHED` -> `409 DRAFT_FROZEN`; `DISCARDED` -> `409 DRAFT_DISCARDED`. Applies to save and revision restore.
- **References (POC-017):** each new revision gets one `media_reference` row per distinct `asset_id`. Assets must exist, belong to the same owner, be `VALIDATED`, and not be `DELETING`/`DELETED`; otherwise `422 INVALID_ASSET_REFERENCE` / `ASSET_NOT_REFERENCEABLE` and nothing is written. Revisions are history, so references are kept for every revision, not just the head. This is what keeps media alive after a restore.
- **Retention recalculation (POC-018):** inside the same transaction, lock affected asset rows (`FOR UPDATE`, id order, avoids deadlocks), then set `ref_count = count(media_reference)`. `PUBLISHED` if any publication reference, `REFERENCED` if count > 0 and no publication, `ORPHANED` (with `orphaned_at = now()` only if not already set) if count = 0 and the asset was `REFERENCED`/`PUBLISHED`/`ORPHANED`. `UNATTACHED` stays if never referenced. `DELETING`/`DELETED` are never touched. Becoming referenced again clears `orphaned_at`.
- **Restore revision (POC-019):** copies the old document into a new head revision (`source=RESTORE`, `restored_from_revision_no`), creates references through the same path. Restoring a revision whose content equals head is a no-op (`unchanged: true`).
- **Discard/restore draft (POC-019):** `DELETE` sets `DISCARDED`, `discarded_at`, `purge_after = now + DRAFT_PURGE_GRACE_DAYS` (default 30). References stay until purge (M6), so discarded drafts still retain media. `POST /restore` returns to `ACTIVE`, clears both timestamps; `PURGED` -> `409 DRAFT_PURGED`. Discard is idempotent; only `ACTIVE` can be discarded (`PUBLISHING`/`PUBLISHED` -> `409 DRAFT_FROZEN`).
- **No media jobs:** none of these paths touches `processing_job` or SQS. Tests assert the job count is unchanged.

## Ticket order

1. **POC-014** `POST /v1/drafts`, `GET /v1/drafts/{id}`, `GET /v1/drafts` (owner-scoped, hides `DISCARDED` unless `?status=`). Create inserts draft + revision 1 (`INITIAL`).
2. **POC-015** `PUT /v1/drafts/{id}`: canonical hash, new revision on change, none on unchanged. `GET /v1/drafts/{id}/revisions`. `base_revision` accepted, not yet enforced.
3. **POC-016** Enforce `base_revision`, `409 REVISION_CONFLICT`, row lock, concurrent-save test (two parallel saves with same base: one wins).
4. **POC-017** Extract `asset_id`s, validate, insert `media_reference` in the save transaction. Also applies to create with a document.
5. **POC-018** `shared/refs.ts` recalculation, called from the save transaction.
6. **POC-019** Revision restore, draft discard and restore. M3 exit test (20 edits, restore, no jobs).

Each ticket: own branch, one commit, tests in `services/canvas-api/test/drafts.spec.ts` (integration against the running stack, like M2). The M3 exit demo is a test in `drafts.spec.ts` (run by `make test`); no separate verify script. CLAUDE.md status updated after POC-019.
