# M5 — Publish and mock transcode (POC-023 to POC-030)

## Context

M1 to M4 are done. Tables `publication`, `publication_asset`, `processing_job`, `media_reference` exist (0004, 0005). Step Functions task-token callbacks over SQS work on LocalStack 2026.10.2 (`make smoke-sfn`). The `mock-transcoder` service is still a stub.
Exit demo: publish an exact revision with video assets; mock finals are produced once, the client uploads the rendered canvas, a manifest is written and the publication goes `LIVE`. A second publish with the same key returns the same publication; a different key is rejected. After a mock failure a retry reuses finals that are already `READY`.

## Decisions (stated, not asked; reverse any you dislike)

- **No Lambda.** LocalStack runs `s3,sqs,events,stepfunctions,sts` only. Every workflow step is an `sqs:sendMessage.waitForTaskToken` task, as in the smoke test. Two consumers answer with `SendTaskSuccess` / `SendTaskFailure`:
  - `publish-tasks` queue: step runner, lives in `canvas-api` (`src/publish/`). It owns all DB writes of the workflow. Message: `{ step, publication_id, token, ... }`.
  - `transcode-requests` queue: `mock-transcoder` service. Message: `{ publication_id, asset_id, token }`.
  Both queues get a DLQ and the standard `maxReceiveCount` (init script `02-queues-events.sh`).
- **State machine** `canvas-publish`, definition in `infra/stepfunctions/publish.asl.json`, created or updated by the LocalStack init script (queue URLs substituted). Execution name = `{publication_id}-a{attempt}`, so a repeated start is idempotent. Steps, each also written to a `publication_transition` row (traceability beyond the Step Functions history):
  1. `ValidateSnapshot` (`WAITING_FOR_ASSETS`): all assets of the pinned revision are owned, `VALIDATED`, not `DELETING`/`DELETED`, and draft-tier renditions `READY`. Not yet ready returns `{ready:false}`; a `Choice` + `Wait` loops (bounded by `MaxAssetWaitIterations`), then fails `ASSETS_NOT_READY`. Rejected or failed assets fail at once `ASSET_UNUSABLE`.
  2. `PlanFinals` (`TRANSCODING`): POC-024. Returns only the video assets whose final rendition is not `READY`.
  3. `Transcode`: `Map` over those assets, task-token message to `transcode-requests`, `Retry` on `States.Timeout`, `Catch` to `FailPublication`.
  4. `MarkFinalsReady`: verifies each final object exists (HEAD), rows `READY`, status `AWAITING_CANVAS`.
  5. `AwaitCanvas`: task token stored on the publication row; the step runner does not answer. `POST canvas-uploaded` answers it. `TimeoutSeconds` from config (`PUBLISH_CANVAS_TIMEOUT_SECONDS`, default 900), `Catch` to `FailPublication`.
  6. `WriteManifest` (`FINALIZING`): `publications/{id}/manifest.json` in the published bucket.
  7. `MarkLive`: single transaction (POC-029).
  8. `FailPublication`: status `FAILED` + `failure_reason`, then the execution ends `FAILED` so Step Functions shows the truth.
- **Final tier scope.** Only videos get a final rendition (`kind = 'final_video'`, tier `FINAL`, `recipe_version` 1, key `final/{asset_id}/video/v1/{params}.mp4` in the derived bucket). Images are published from their original; no final job. `publication_asset` holds the final video renditions only.
- **Mock transcoder contract (POC-023).** Job = `processing_job` row, type `final-transcode`, key `transcode:{asset_id}:final:v1`. Mock states map onto it: `QUEUED`, `RUNNING`, `COMPLETE` (= `SUCCEEDED`), `ERROR` (= `FAILED`/`FAILED_PERMANENT`). Worker: claim with lease + heartbeat (`job-repo.ts`), simulated latency (`MOCK_TRANSCODE_LATENCY_MS`, default 1500), HEAD output, else copy `fixtures/sample.mp4` to the output key (volume mount `./fixtures:/fixtures:ro`; it does not transcode, and no doc may say it does). Result goes to Step Functions via the token in the message. Transient error: message stays, SQS redelivers, job backoff. Permanent error or attempts used up: `SendTaskFailure` `TranscodeFailed`, ack. Test hook `fail_mode` in the job payload (same as light-worker) when `WORKER_TEST_HOOKS=true`; set through `POST /v1/drafts/{id}/publications` body `test_fail_mode` only when hooks are on in the API.
- **Publish request (POC-026).** `POST /v1/drafts/{id}/publications`, header `Idempotency-Key` (required), body `{ revision }` (required, exact revision number). In one transaction with the draft row lock: draft must be `ACTIVE`; revision must exist; set draft `PUBLISHING`; pin the revision; insert `publication` `REQUESTED`. After commit, start the execution and store `execution_arn`. A failed start leaves `REQUESTED` and the same request retried starts it. Same owner + key + same revision returns the existing publication (`200`, `idempotent_replay: true`); same key with another revision `409 IDEMPOTENCY_KEY_REUSED`; other key while the draft has a publication `409 PUBLICATION_EXISTS` with the existing id. Edits are already rejected by `assertEditable` (`DRAFT_FROZEN`).
- **Canvas (POC-027/028).** `POST /v1/publications/{id}/canvas-upload` body `{ content_type: image/png | video/mp4 }` returns a fresh presigned PUT for `publications/{id}/canvas.{png|mp4}` in the published bucket; only valid in `AWAITING_CANVAS` (else `409 PUBLICATION_STATE`). `POST /v1/publications/{id}/canvas-uploaded`: HEAD the object (exists, size > 0 and under the limit, content type matches), store `render_key`, then atomically take the stored task token (`UPDATE ... SET task_token = NULL RETURNING`) and send `SendTaskSuccess`. A repeated call after that returns the current state.
- **Manifest (POC-028).** `{ publication_id, draft_id, owner_id, revision: {revision_no, content_hash, document}, render: {bucket,key,content_type,bytes,etag}, assets: [{asset_id, kind, original}], finals: {asset_id: {rendition_id, bucket, key}}, created_at }`. Key order is fixed so a retry rewrites an equal object.
- **Go live (POC-029).** One transaction: lock publication, draft and asset rows (asset ids sorted); reject `DELETING`/`DELETED`; insert `media_reference` with `publication_id` for every asset of the revision; `publication_asset` for finals; `recalcRetention` (assets become `PUBLISHED`); publication `LIVE` + `live_at`; draft `PUBLISHED`; revision `pinned`. Idempotent when already `LIVE`.
- **Failure and retry (POC-030).** Any step failure or timeout marks the publication `FAILED` with a reason. `POST /v1/publications/{id}/retry` (owner-scoped, body empty) is allowed from `FAILED`, or from a non-terminal state when Step Functions reports the execution `FAILED`/`TIMED_OUT`/`ABORTED`. It bumps `attempt`, resets `FAILED`/`FAILED_PERMANENT` final renditions and their jobs to `QUEUED`, keeps `READY` ones, and starts execution `{id}-a{attempt}` on the same publication row (never a second publication). `GET /v1/drafts/{id}/status` gives the asset + publication roll-up. A draft stays `PUBLISHING` while its publication is `FAILED` (retry is the way out); no un-freeze in the POC.
- **Migration 0007** (forward-only): `publication.task_token`, `publication.attempt`, `publication.canvas_content_type`, `publication.canvas_bytes`, table `publication_transition`.
- **Logging.** Every step logs `publication_id`, `asset_id`, `job_id`, correlation id.

## Ticket order

1. **POC-023** queues, mock-transcoder service, contract, tests (service tests with a fake token sender).
2. **POC-024** final rendition planning (`services/shared/final-renditions.ts`), reuse of `READY`, tests.
3. **POC-025** migration 0007, ASL, init script, step runner (`ValidateSnapshot`, `PlanFinals`, `MarkFinalsReady`, `FailPublication`), traceable transitions. Canvas/live steps are stubbed until 027 to 029.
4. **POC-026** publish endpoint, idempotency, snapshot pinning, `GET /v1/publications/{id}`.
5. **POC-027** `AwaitCanvas` gate + upload URL endpoint.
6. **POC-028** `canvas-uploaded` + `WriteManifest`.
7. **POC-029** `MarkLive` transaction.
8. **POC-030** retry, timeouts, draft status, M5 exit demo test.

One branch and commit per ticket. Tests: `services/canvas-api/test/publish.spec.ts` (integration, running stack), `services/mock-transcoder/test`. CLAUDE.md status updated at the end.
