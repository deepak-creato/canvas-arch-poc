# Failure runbook

Everything is local. Start with `make ps`, `make health`, `make logs`. All service logs are JSON lines with `asset_id`, `job_id`, `draft_id`, `publication_id`, `correlation_id`; filter with `docker compose logs <service> | grep <id>`. `make psql` opens SQL.

## Quick map

| Symptom | Look at | Fix |
| --- | --- | --- |
| Stack will not start | `make preflight`; `docker compose logs localstack` | Set `LOCALSTACK_AUTH_TOKEN` in `.env`; free the port named in the message; `make teardown && make bootstrap` |
| Upload stays `PENDING_UPLOAD` | `select upload_status, created_at from media_asset where id='<id>'`; was the PUT done? | Call `POST /v1/uploads/{id}/complete`. If the event was lost: `make gc-reconcile` (confirms real objects, rejects mismatches) |
| Asset stuck `UPLOADED` / `PROCESSING` | `make gc-jobs` (failed and stuck jobs, last error) | Wait for lease expiry, then `make gc-run STEP=reapStuckJobs,requeueJobs`. `FAILED_PERMANENT`: see DLQ |
| Asset `REJECTED` | `reject_reason` on `GET /v1/assets/{id}`: `HASH_MISMATCH`, `TYPE_MISMATCH`, `CORRUPT_FILE`, `SIZE_MISMATCH`, `CONTENT_TYPE_MISMATCH`, `FILE_TOO_LARGE` | Not recoverable; upload a correct file |
| Messages in a DLQ | `make gc-dlq` shows each message with its asset and jobs | Fix the cause, then `make gc-redrive` (moves back, resets `FAILED_PERMANENT` jobs). Deleted assets' messages are dropped |
| Rendition missing in S3 though `READY` | `make gc-reconcile` reports `missing_renditions` | The step marks it `FAILED` and rebuilds draft renditions. Missing originals are reported only: re-upload |
| Publication `FAILED` | `GET /v1/publications/{id}`: `failure_reason`, `transitions` | `POST /v1/publications/{id}/retry` (reuses READY finals). Cause `ASSETS_NOT_READY` / `ASSET_UNUSABLE`: fix the asset first |
| Publication stuck in a state | `select status, execution_arn from publication where id='<id>'`; Step Functions history via the aws CLI in the localstack container | `retry` also recovers an execution that died without reporting. `AWAITING_CANVAS` waits for `canvas-uploaded` up to `PUBLISH_CANVAS_TIMEOUT_SECONDS` |
| Mock transcode result | `GET :3103/jobs?asset_id=<id>` | Inject failures with `test_fail_mode` (hooks on) |
| Save returns `409 REVISION_CONFLICT` | Reload the draft, reapply, save with the new `base_revision` | Expected behaviour |
| Save returns `422 ASSET_NOT_REFERENCEABLE` | The asset is `DELETING`/`DELETED` | Upload it again (same bytes create a new asset) |
| Asset was deleted unexpectedly | `select retention_status, orphaned_at, deleted_at from media_asset where id='<id>'`; grace settings `GC_*_SECONDS` | Deletion only happens after the orphan grace and a second zero-reference check. Raise the graces; `DELETED` is final |
| `DELETING` assets pile up | `select id, delete_attempts, delete_error from media_asset where retention_status='DELETING'` | Fix S3 access; each `make gc-run STEP=sweep` retries |
| Stray objects in S3 | `make gc-reconcile` lists `strays` | Set `GC_DELETE_STRAYS=true` to delete the old ones; unrecognised keys are never touched |
| Tests flaky after a crash | Queues may hold old messages | `make teardown && make up` |

## Useful commands

```bash
make gc-run                         # one full GC cycle
make gc-run STEP=sweep              # a single step; comma-separate several
make gc-jobs | jq .                 # failed / stuck jobs
make gc-dlq | jq .                  # DLQ contents with the owning asset and its jobs
make gc-redrive                     # DLQ back to the source queue
make gc-reconcile                   # missed events, drift, strays
docker compose exec -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 localstack aws --endpoint-url http://localhost:4566 sqs list-queues
docker compose exec -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 localstack aws --endpoint-url http://localhost:4566 stepfunctions list-executions --state-machine-arn arn:aws:states:us-east-1:000000000000:stateMachine:canvas-publish
```

Always pass `--endpoint-url` to `aws` inside the LocalStack container.

## Recovering a worker crash

Kill the worker (`docker compose kill light-worker`) mid-job and start it again: the job keeps `RUNNING` until its lease (60 to 120 s) expires, then SQS redelivers the message after the visibility timeout (120 s) and the job is claimed again. No manual step needed. To force it sooner use `make gc-run STEP=reapStuckJobs,requeueJobs` after the lease is over.

## Clean slate

`make teardown` deletes containers, volumes and the network. `make demo` does that first, then bootstraps and runs the end-to-end demonstration.
