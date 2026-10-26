# API reference

Base URL `http://127.0.0.1:3000`. Every `/v1` call needs `X-Owner-Id: <any string>` (local stand-in for auth). Other owners' objects answer `404`. Errors are `{ "code": "...", "message": "..." }`. Try the calls in [canvas-poc.http](canvas-poc.http).

| Method and path | Purpose | Notable responses |
| --- | --- | --- |
| `POST /v1/uploads` | Reserve an upload: `{sha256, content_type, size_bytes, filename?}`. Returns `asset_id`, `upload_url`, `upload_headers`, `deduplicated`. | `400` bad hash/type/size; same owner and hash returns the existing asset |
| `POST /v1/uploads/{id}/complete` | Confirm the object exists (HEAD) and start validation. Idempotent; the S3 event does the same. | `409 OBJECT_NOT_FOUND`, `SIZE_MISMATCH`, `UPLOAD_EXPIRED` |
| `GET /v1/assets/{id}` | Upload and processing state, renditions with presigned URLs. `processing_status`: `PENDING PROCESSING READY FAILED REJECTED EXPIRED`. | `reject_reason` when `REJECTED` |
| `POST /v1/drafts` | Create a draft with revision 1. | `201` |
| `GET /v1/drafts`, `GET /v1/drafts/{id}` | List (hides discarded unless `?status=`), read head. | |
| `PUT /v1/drafts/{id}` | Save `{base_revision, document}` as the next revision. Unchanged content adds nothing. | `409 REVISION_CONFLICT`, `409 DRAFT_FROZEN`, `422 ASSET_NOT_FOUND / ASSET_NOT_READY / ASSET_NOT_REFERENCEABLE` |
| `GET /v1/drafts/{id}/revisions` | Revision list without documents. | |
| `POST /v1/drafts/{id}/revisions/{n}/restore` | Copy an old revision into a new head. | |
| `DELETE /v1/drafts/{id}`, `POST /v1/drafts/{id}/restore` | Soft discard / bring back within the purge grace. | `409 DRAFT_PURGED` |
| `POST /v1/drafts/{id}/ai-layouts` | Mock AI layout `{asset_ids, canvas?, seed?, model_version?}`. | `202` queued, `200 cached: true` |
| `GET /v1/ai-layouts/{id}`, `POST /v1/drafts/{id}/ai-layouts/{gen}/accept` | Poll; accept `{base_revision}` as an `AI_GENERATION` revision. | |
| `POST /v1/drafts/{id}/publications` | Publish exact `{revision}`; header `Idempotency-Key` required. | `202`; `200 idempotent_replay`; `409 IDEMPOTENCY_KEY_REUSED`, `PUBLICATION_EXISTS` |
| `GET /v1/publications/{id}` | Status, transitions, render/manifest/finals URLs when `LIVE`. | |
| `POST /v1/publications/{id}/canvas-upload` | `{content_type: image/png or video/mp4, size_bytes}`: presigned PUT for the rendered canvas. Only in `AWAITING_CANVAS`. | `409 PUBLICATION_STATE` |
| `POST /v1/publications/{id}/canvas-uploaded` | Verify the canvas object and resume the workflow. | `202` |
| `POST /v1/publications/{id}/retry` | New attempt on the same publication after `FAILED`. | |
| `GET /v1/drafts/{id}/status` | Asset and publication roll-up. | |

Test hooks, only when `WORKER_TEST_HOOKS=true`: `test_fail` on AI requests, `test_fail_mode` on publish (`permanent`, `transient:N`).

Operations (gc-worker, `127.0.0.1:3104`): `POST /run[?step=a,b]`, `GET /ops/jobs`, `GET /ops/dlq`, `POST /ops/redrive` (all accept `?owner_id=`). Mock transcoder (`:3103`): `GET /jobs?asset_id=`.
