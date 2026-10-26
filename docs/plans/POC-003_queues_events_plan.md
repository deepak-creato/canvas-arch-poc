# POC-003 — Queues, DLQs and S3 → EventBridge → SQS: plan

## Context

POC-003 (Milestone M1, P0): provision the `light-processing` and `ai-requests` SQS queues with dead-letter queues, and prove that an object uploaded under the staging prefix of the ingest bucket reaches `light-processing` through EventBridge. Retry and DLQ behaviour must be smoke-tested.

Already in place: POC-001 (compose stack, LocalStack `2026.10.2`, fake credentials, account `000000000000`) and POC-002 (buckets created by `infra/localstack/init/01-buckets.sh`, checked by `infra/scripts/verify-s3.sh`). Scripts use the bundled `aws` CLI with `AWS_ENDPOINT_URL=http://localhost:4566` because `awslocal` is deprecated and the image has no `curl`.

The plan (section 2) routes `ObjectCreated` through the default EventBridge bus to the SQS queue. The task also says "staging prefix", but the plan never defines it. The only key shape in the plan is `originals/owner/hash/source.mp4` in the mock transcoder contract. This ticket decides: uploads land under `staging/` in the ingest bucket, and only that prefix is routed. POC-006 will presign keys of the form `staging/{owner}/{asset_id}/source`.

## Resources to create

| Resource | Name | Settings |
| --- | --- | --- |
| Queue | `light-processing` | visibility timeout 120s, redrive to `light-processing-dlq`, `maxReceiveCount` 3 |
| Queue | `light-processing-dlq` | retention 14 days |
| Queue | `ai-requests` | visibility timeout 60s, redrive to `ai-requests-dlq`, `maxReceiveCount` 3 |
| Queue | `ai-requests-dlq` | retention 14 days |
| Bucket notification | `media-ingest-poc` | `EventBridgeConfiguration: {}` (sends all object events to the default bus) |
| Rule | `ingest-staging-created` on the default bus | pattern: source `aws.s3`, detail-type `Object Created`, bucket `media-ingest-poc`, object key prefix `staging/` |
| Rule target | `light-processing` queue | event delivered as-is |
| Queue policy | on `light-processing` | allow `events.amazonaws.com` to `sqs:SendMessage` from the rule ARN (not enforced by LocalStack, kept for AWS parity) |

Separate DLQs per queue match "related DLQs" in the ticket. The architecture diagram draws one shared DLQ; this is a deliberate simplification to record in the decisions log.

## Files

1. `infra/localstack/init/02-queues-events.sh` (new, executable). Runs after `01-buckets.sh` in lexical order.
   - Same header as `01-buckets.sh` (`set -eu`, exported local endpoint and fake credentials).
   - Create each DLQ first, read its ARN, then create the main queue with a `RedrivePolicy`. Create only when missing, and always `set-queue-attributes` so a re-run converges.
   - Apply the bucket notification, then `put-rule`, `put-targets` and `set-queue-attributes` for the policy.
   - Print one line per resource and a final `queues and events ready`.
2. `.env.example` and `.env` (edit): add `QUEUE_LIGHT_PROCESSING`, `QUEUE_LIGHT_PROCESSING_DLQ`, `QUEUE_AI_REQUESTS`, `QUEUE_AI_REQUESTS_DLQ` (names), `SQS_MAX_RECEIVE_COUNT=3`, `UPLOAD_STAGING_PREFIX=staging/`. Do not touch `LOCALSTACK_AUTH_TOKEN` in `.env`.
3. `docker-compose.yml` (edit): pass the queue and prefix variables to the localstack service, and add queue name and URL variables to the shared `x-app-env` block (URL form `http://localstack:4566/000000000000/<name>`) so POC-008 and POC-021 workers can use them.
4. `infra/scripts/verify-events.sh` (new, executable), run inside the localstack container like `verify-s3.sh`:
   - Wait for the rule and queues with a retry loop (up to 30s).
   - **Positive:** put an object at `staging/verify/<random>`, poll `light-processing` (long poll, up to 15s), assert the message body has detail-type `Object Created`, the ingest bucket and the exact key. Delete the message and object.
   - **Negative:** put an object at `other/verify/<random>`, wait 5s, assert the queue is empty.
   - **Config:** assert both main queues have a `RedrivePolicy` pointing at their DLQ with `maxReceiveCount` 3.
   - **Retry and DLQ behaviour:** create a temporary queue pair with the same redrive settings, send one message, receive it three times with visibility 1s and no delete (retry), then confirm it lands in the temp DLQ. Delete the temp queues. A temporary pair is used so the check keeps working once real workers consume `light-processing`.
   - Exit non-zero on any failure and print one `OK` or `FAIL` line per check.
5. `Makefile` (edit): add `verify-events` target. Add a `verify` target that runs `verify-s3` then `verify-events`.
6. `README.md` and `CLAUDE.md` (edit): list the queues and the `staging/` prefix rule, add `make verify-events`, and move the status line to "POC-003 done, next POC-004 (migrations)".
7. `docs/plans/POC-003_queues_events_plan.md` (new): a copy of this plan, so it lives with the repo like the POC-001 plan.

## Decisions

- Init hook again, for the same reasons as POC-002: automatic on every fresh start, no extra container, and idempotent.
- Rule filters on the `staging/` prefix so later outputs written into the ingest bucket (for example validated originals) do not loop back into the queue.
- The queue receives the raw EventBridge event. POC-008 will parse `detail.bucket.name` and `detail.object.key`, and POC-012 will make processing idempotent against duplicate events.
- `ai-requests` has no event source. The API sends to it directly in M4. Only its queue and DLQ are created here.

## Risks and fallback

- S3 → EventBridge on this LocalStack version is not yet confirmed. The plan itself says to verify this in M1. If the rule never fires, fall back to a direct S3 → SQS notification on the same prefix, keep the same payload fields the worker reads, and record the deviation in the decisions log and README.
- Prefix matching inside EventBridge patterns (`{"prefix": "staging/"}`) depends on LocalStack's matcher. Confirmed by the negative check.
- The init hook can still be running when compose reports healthy. Verification retries, as in POC-002.
- Presigned `PUT` with the browser CORS rules from POC-002 should raise the same `ObjectCreated` event as `put-object`. Re-check with a presigned URL in POC-006.

## Verification

1. `make reset && make up`, then `docker compose logs localstack | grep "queues and events ready"`.
2. `make verify-events` prints OK for the positive, negative, redrive-config and DLQ checks and exits 0.
3. `make verify` runs both scripts successfully.
4. `docker compose restart localstack`, then `make verify` again to prove the hook is safe to run twice.
5. Manual: upload through the host with `aws --endpoint-url http://localhost:4566 s3 cp file s3://media-ingest-poc/staging/demo/x` and read the message with `aws sqs receive-message` (this is the M1 exit demo).

## Implementation notes (as built)

- aws-cli 1.x in the LocalStack image ignores `AWS_ENDPOINT_URL` for SQS and sent the request to `queue.amazonaws.com`, which failed with `InvalidClientTokenId`. All scripts now define `aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }`, and Python helpers pass `--endpoint-url` explicitly.
- `sts` was added to `SERVICES` so `sts get-caller-identity` works (account `000000000000`).
- Verified with `make verify` (10 checks), after a clean reset and after a container restart.
