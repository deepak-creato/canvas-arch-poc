# Canvas Editor Media Platform — LocalStack POC

Local-only proof of concept for the Canvas Editor media lifecycle: upload, light processing, draft revisions, mock AI layouts, publish, and safe garbage collection. No AWS account, no managed AWS service: LocalStack plus containers.

- Scope, tickets, state machines: [Canvas_Editor_Media_Platform_POC_Plan.md](Canvas_Editor_Media_Platform_POC_Plan.md) (source of truth)
- How it is wired and where it deviates from the plan and from AWS: [docs/architecture.md](docs/architecture.md)
- API reference and request collection: [docs/api/README.md](docs/api/README.md), [docs/api/canvas-poc.http](docs/api/canvas-poc.http)
- When something breaks: [docs/runbook.md](docs/runbook.md)
- Which test proves which checklist line: [docs/validation-checklist.md](docs/validation-checklist.md)
- AI assistant context: [CLAUDE.md](CLAUDE.md)

Honest limits: the mock transcoder places a fixture, it does not transcode; the mock AI is deterministic; the canvas is uploaded by the client, not composed on the server; auth is an `X-Owner-Id` header. See the architecture file.

## Quick start (fresh clone)

Requires Docker with Compose 2.20 or newer, `make`, and for the demo script `curl` and `jq`. No AWS credentials; the `test`/`test` keys are fake. LocalStack 2026.x needs a LocalStack auth token (free account at https://app.localstack.cloud).

```bash
cp .env.example .env          # then set LOCALSTACK_AUTH_TOKEN in .env (never commit it)
make bootstrap                # preflight, build, start, health, infrastructure checks
make demo-run                 # the end-to-end demonstration against the running stack
make test                     # integration tests of every service (stack must be up)
```

`make demo` does the same from nothing: it first runs `make teardown`, which **deletes the stack's containers, volumes and data**, then bootstraps and runs the demonstration. Use it to prove the clean-environment case.

The demonstration (`infra/scripts/demo.sh`, API calls only) prints one PASS line per validation checklist item: upload mix, dedup, 20 saves without processing, 409 conflict, mock AI with cache, publish to LIVE with idempotency, discard and restore, and garbage collection that deletes only unreferenced media.

## Commands

| Command | What it does |
| --- | --- |
| `make bootstrap` | preflight, build and start, health report, `make verify` |
| `make teardown` | delete containers, volumes and network (`make reset` is an alias) |
| `make up` / `make down` | start (with wait) / stop without deleting data |
| `make preflight`, `make health`, `make verify` | pre-checks; one health report; S3, events, schema and Step Functions checks |
| `make test` | jest suites of canvas-api, light-worker, ai-worker, mock-transcoder and gc-worker (about 10 minutes; the worker-crash test waits out a lease) |
| `make verify-m2` | M2 exit demo (5 images + 1 video) |
| `make demo` / `make demo-run` | full demonstration with / without wiping first |
| `make gc-run [STEP=a,b]`, `make gc-jobs`, `make gc-dlq`, `make gc-redrive`, `make gc-reconcile` | garbage collection and recovery operations (see the runbook) |
| `make psql`, `make logs`, `make ps`, `make migrate` | helpers |

### Troubleshooting

- `preflight` says a port is in use: set the named `HOST_PORT_*` variable in `.env` to a free port.
- LocalStack exits with `License activation failed`: set `LOCALSTACK_AUTH_TOKEN` in `.env`.
- Strange state after an interrupted run: `make teardown && make bootstrap`.
- DB client on the host: connect to `127.0.0.1:5433`, not host `postgres` (that name only resolves inside Docker).
- More cases: [docs/runbook.md](docs/runbook.md).

## Services and endpoints (host)

All ports bind to `127.0.0.1` and can be changed in `.env`.

| Service | URL / address | Role |
| --- | --- | --- |
| `canvas-api` | `http://localhost:3000` | NestJS REST API, publish step runner |
| `mock-transcoder` | `http://localhost:3103` | places the fixture as the final video; `GET /jobs?asset_id=` |
| `gc-worker` | `http://localhost:3104` | garbage collection, reconciliation, job and DLQ operations |
| `light-worker`, `ai-worker` | internal (3101, 3102) | Sharp/FFmpeg processing; mock AI layouts |
| LocalStack | `http://localhost:4566` | S3, SQS, EventBridge, Step Functions |
| PostgreSQL | `localhost:5433` | user, password, db: `canvas` |
| Redis | `localhost:6380` | ephemeral only |

## Repository layout

`services/` (code, one folder per service plus `shared/`), `db/migrations/` (forward-only SQL), `infra/` (LocalStack init scripts, state machine, verification and demo scripts), `fixtures/` (redistributable test media; regenerate with `infra/scripts/gen-fixtures.sh`), `docs/` (plans per milestone, API, architecture, runbook).

## Infrastructure details

### S3 buckets (POC-002)

`media-ingest-poc`, `media-derived-poc`, `media-published-poc` are created on LocalStack start by `infra/localstack/init/01-buckets.sh` (idempotent; CORS on ingest and published). Check with `make verify-s3` (PUT, HEAD, GET, DELETE on each bucket).

### Queues and events (POC-003)

Created on LocalStack start by `infra/localstack/init/02-queues-events.sh` (idempotent):

- Queues: `light-processing`, `ai-requests`, `transcode-requests`, `publish-tasks`, each with a DLQ (`*-dlq`, `maxReceiveCount` 3).
- Uploads go under `staging/` in `media-ingest-poc`. S3 sends object events to the default EventBridge bus, and rule `ingest-staging-created` routes only the `staging/` prefix to `light-processing`.
- Check with `make verify-events` (routing, payload, prefix filter, redrive config, retry then DLQ). `make verify` runs S3 and event checks.

### Database migrations (POC-004)

Plain SQL files in `db/migrations/` are applied in name order by the one-shot `migrate` service on every `make up` (also `make migrate`). Forward-only: to change the schema add a new numbered file; editing an applied file makes the runner fail with a checksum error. `make reset` gives a clean database. `make psql` opens a shell, and `make verify-schema` checks the constraints (dedup, one publication per draft, immutable revisions, single-holder references, job idempotency).

Tables: `media_asset`, `media_rendition`, `canvas_draft`, `canvas_revision`, `media_reference`, `processing_job`, `publication`, `publication_asset`, `ai_generation`, `outbox_event`, plus `schema_migrations`.

### Step Functions smoke test (POC-005)

`make smoke-sfn` creates a temporary state machine and checks `Wait`, `Parallel`, the SQS `sendMessage.waitForTaskToken` callback (success and failure with `Catch`) and the execution history, then deletes it. It also asserts the account is `000000000000`, so it cannot be talking to real AWS. These are the features the publish workflow (POC-025, 027, 028) relies on.

## Status

POC-001 to POC-040 done. Milestone plans: `docs/plans/`. Sign-off gate: every line of the validation checklist passes (`make test`, `make demo`).

## Notes

- LocalStack is pinned to `2026.10.2` (needs `LOCALSTACK_AUTH_TOKEN` in `.env`, never commit it). Scripts use the bundled `aws` CLI (always with an explicit `--endpoint-url`) because `awslocal` is deprecated, and the image has no `curl`.
- Presigned URLs must use `S3_PUBLIC_ENDPOINT`; container-to-container calls use `AWS_ENDPOINT_URL`.
