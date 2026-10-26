# M4 — Mock AI layout service (POC-020 to POC-022)

## Context

M3 is done (drafts, immutable revisions, references). `ai_generation` and `outbox_event` tables exist (migration 0006); queue `ai-requests` and its DLQ exist (POC-003); `ai-worker` is still a stub. No real AI model: the mock returns deterministic, schema-valid canvas JSON.
Exit demo: request an AI layout twice for the same input; the second answer comes from cache, and no media job is created by either request.

## Decisions (stated, not asked; reverse any you dislike)

- **Generator (POC-020):** pure function `generateLayout(input)` in `services/shared/mock-layout.ts`. Input: ordered asset facts (`asset_id`, `kind`, `width`, `height`, optional `duration_seconds`), canvas size (default 1080x1080), `seed`, `model_version`. Output: `{ version: 1, canvas: {width, height}, elements: [...] }`, one `image`/`video` element per asset with `id`, `asset_id`, `x`, `y`, `width`, `height`, `z`, `fit`. A PRNG seeded from SHA-256 of `model_version|seed|asset ids` picks the arrangement (grid, stack, or hero+strip) and ordering; same input gives byte-identical output. Elements stay inside the canvas, keep aspect ratio.
- **Schema check:** `validateCanvas(doc, knownAssetIds)` in the same file returns a list of errors: wrong shape, out-of-bounds boxes, duplicate element ids, or any `asset_id` outside the known set. The generator output is always validated before it is stored. The generator cannot reference unknown assets because it only sees the asset list it is given, and the API only builds that list from the owner's `VALIDATED`, referenceable assets.
- **Request (POC-021):** `POST /v1/drafts/{id}/ai-layouts` body `{ asset_ids: uuid[1..20], canvas?: {width,height}, seed?: int, model_version? }`. Draft must be `ACTIVE` and owned. Assets are checked with the same rules as revision references (owner, `VALIDATED`, not `DELETING`/`DELETED`) but **no reference is created**: references come only when a result is accepted. The API snapshots the asset facts into `ai_generation.request`, so the worker never re-reads assets and the result is reproducible. Returns `202` with `generation_id`, `status`.
- **Queue:** after commit the API sends `{ generation_id }` to `ai-requests`. If the send fails the row is marked `FAILED` (`ENQUEUE_FAILED`) so the client is not left polling. The outbox table is not used for this POC (recorded in the decisions log).
- **Worker:** `services/ai-worker` (plain Node/TS, like light-worker). Claim: `UPDATE ... SET status='PROCESSING' WHERE id=$1 AND status='QUEUED'`; no row means another delivery owns it or it is finished, so ack. Success: `READY` + `result`. Permanent error (invalid input, generator failure): `FAILED` + `error`, ack. Transient error: back to `QUEUED`, leave the message for SQS redelivery; after `SQS_MAX_RECEIVE_COUNT` it lands in the DLQ. Test hook (`WORKER_TEST_HOOKS=true`): `request.test_fail = "permanent" | "transient_once"`.
- **Poll:** `GET /v1/ai-layouts/{genId}` is owner-scoped (404 otherwise). States `QUEUED -> PROCESSING -> READY | FAILED`. `result` only when `READY`.
- **Cache (POC-022):** `input_hash = sha256(canonical(asset facts in order + canvas))`, `cache_key = sha256(input_hash|model_version|seed)`. A new request with a `READY` row of the same owner and `cache_key` creates a new row already `READY`, with `result` copied and `cached_from_id` set, and sends no message. Response `200` with `cached: true`. Asset order is part of the key.
- **Accept:** `POST /v1/drafts/{id}/ai-layouts/{genId}/accept` body `{ base_revision }`. Generation must be `READY` and belong to that draft. It goes through the normal save path (draft lock, `REVISION_CONFLICT`, reference creation, retention recalculation) with `source = AI_GENERATION`, and sets `accepted_revision_no` in the same transaction. A second accept returns the same revision (`already_accepted: true`). A cached result referencing an asset that is meanwhile `DELETING`/`DELETED` fails with the usual `422`.
- **No media work:** none of this path touches `processing_job` or the `light-processing` queue; tests assert that.

## Ticket order

1. **POC-020** mock generator and validator in `services/shared`, unit tests in a new `services/ai-worker/test` (service scaffold: package.json, tsconfig, Dockerfile, compose build; worker loop comes in 021).
2. **POC-021** request/poll endpoints, ai-worker consumer, job lifecycle, failure injection.
3. **POC-022** cache lookup, accept flow, `DraftsService.save` gets a `source` and an in-transaction hook, exit-demo test.

One branch and commit per ticket. Tests in `services/canvas-api/test/ai.spec.ts` (integration, running stack) and `services/ai-worker/test`. CLAUDE.md status updated after POC-022.
