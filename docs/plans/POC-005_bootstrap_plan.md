# POC-005 — Bootstrap/teardown, env config, health checks, Step Functions smoke test: plan

## Context

POC-005 (Milestone M1, P0) finishes M1. Task: add bootstrap and teardown commands, environment config, health checks and a Step Functions compatibility smoke test. Acceptance: a fresh clone can start the services and verify working connectivity without using AWS credentials. The M1 exit demo is "run one command to start all services and show a test S3-created event arriving on SQS".

Already in place: `make up/down/reset/ps/logs/migrate/psql`, `make verify` (S3, events, schema), `.env.example`, the compose stack with health checks on every container, and LocalStack `2026.10.2` with `SERVICES` set to `s3,sqs,events,stepfunctions,sts`. Gaps this ticket closes:

- No single command takes a fresh clone from nothing to verified.
- No preflight: a missing Docker, a busy host port or an empty `LOCALSTACK_AUTH_TOKEN` fails late and unclearly (the 2026 image uses a licence activated by that token).
- No overall health report across containers, LocalStack services, Postgres, Redis and the API.
- Step Functions is untested. POC-025, 027 and 028 depend on waits, fan-out, retries and the task-token callback, which the POC plan says to smoke-test in M1 and to document fallbacks for.

## Decisions

- **Commands (all in `Makefile`, logic in `infra/scripts/`):**
  - `make bootstrap`: preflight, `.env` creation, `docker compose up -d --build --wait`, `make health`, `make verify`, `make smoke-sfn`, then a summary with endpoints. This is the M1 exit demo command.
  - `make teardown`: `docker compose down -v --remove-orphans` (containers, volumes and network). `make reset` stays as an alias. `make down` still only stops.
  - `make preflight`, `make health`, `make smoke-sfn`: runnable on their own.
- **The Step Functions smoke test creates and deletes its own temporary state machine and queue.** The real publish workflow is POC-025. The smoke test only proves the features it will need.
- **The smoke test covers four features:** `Wait`, `Parallel` fan-out, the SQS `sendMessage.waitForTaskToken` callback (success path and failure path with `Catch`), and execution history (traceable transitions). Lambda is not used (not part of the design).
- **No AWS credentials:** every script uses the fake `test`/`test` keys and an explicit local endpoint, and the smoke test asserts the account is `000000000000` so it can never be talking to real AWS.
- **Preflight treats an empty `LOCALSTACK_AUTH_TOKEN` as an error only if the image cannot start without it.** Implementation step 1 tries it (see Risks) and decides between an error and a warning. The token is never printed.

## Files

1. `infra/scripts/preflight.sh` (new):
   - Docker present, Compose v2 (version at least 2.20 for `--wait` with one-shot services), daemon reachable.
   - Required variables present in `.env` (list kept in one array), and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are the fake values.
   - `LOCALSTACK_AUTH_TOKEN` handling per the decision above, with the link to get a token in the message.
   - Host ports from `.env` (4566, 5433, 6380, 3000, 3103) free, or already owned by this compose project. On a clash print which variable to change.
   - Exit non-zero with all problems listed, not just the first.
2. `infra/scripts/health.sh` (new): one table with `OK` or `FAIL` for each compose service (running and healthy), the four LocalStack services, `select 1` on Postgres, `PONG` from Redis, `GET /healthz` on the API and mock transcoder, the three buckets, the four queues, and the migration count in `schema_migrations`. Exit non-zero if anything fails.
3. `infra/stepfunctions/smoke.asl.json` (new): state machine `Wait` (1s) -> `Parallel` (two `Pass` branches) -> `Task` `arn:aws:states:::sqs:sendMessage.waitForTaskToken` (body carries `$$.Task.Token`, `TimeoutSeconds` 30) with a `Catch` for `States.ALL` that ends in a `Pass` named `Caught`.
4. `infra/scripts/smoke-sfn.sh` (new), run inside the LocalStack container like the other verify scripts:
   - Create a temporary queue and the state machine (a placeholder role ARN, since IAM is not enabled).
   - **Execution A (success):** start it, read the token from the queue, call `send-task-success`, expect `SUCCEEDED` and no `Caught` state in the history.
   - **Execution B (failure path):** start it, call `send-task-failure`, expect `SUCCEEDED` through `Caught`.
   - **Trace:** `get-execution-history` for A lists `Wait`, `Parallel` and `Task` state entries in order.
   - Assert `sts get-caller-identity` returns account `000000000000`.
   - Delete the state machine and queue on exit.
   - If the callback integration is unsupported, print `FAIL` with the exact error, and also print the documented fallback: the API starts a container-based orchestrator (a worker that polls and calls back through the same `/v1/publications/{id}/canvas-uploaded` contract), recorded as a deviation.
5. `Makefile` (edit): add `bootstrap`, `teardown`, `preflight`, `health`, `smoke-sfn`. Make `reset` call `teardown`. Add `smoke-sfn` to `make verify`.
6. `.env.example` (edit): group variables with comments, mark which are required, and state that the AWS keys are fake.
7. `README.md` (edit): replace the quick start with the fresh-clone flow (`cp .env.example .env`, set the LocalStack token, `make bootstrap`), a command table, and a short troubleshooting list (busy port, missing token, `make teardown` for a clean slate, DBX must use `127.0.0.1:5433`).
8. `CLAUDE.md` (edit): update commands and status ("M1 complete; next POC-006").
9. `docs/plans/POC-005_bootstrap_plan.md` (new): copy of this plan, plus the Step Functions findings once known.

## Risks

- **LocalStack needs a token to start** on this image (or only a warning shows). Unknown until tested. Step 1 of implementation runs the stack with an empty token, in a throwaway project, and records the result.
- **`waitForTaskToken` with SQS may behave differently** from AWS in this LocalStack version, which is the exact risk the plan calls out. The smoke test is built to give a clear pass or fail plus a fallback, not to assume.
- **Port checks race with other software** on the host. Preflight warns and names the variable, and does not try to kill anything.
- A fresh-clone test while the current stack runs would clash on ports. Teardown first.

## Verification

1. `make teardown && make bootstrap`: exits 0, prints the health table (all `OK`), `make verify` results (all `OK`), the Step Functions result and the endpoint summary. The S3-created event arriving on `light-processing` is shown in that output (M1 exit demo).
2. `make smoke-sfn` leaves no state machine or temporary queue behind (`list-state-machines` and `list-queues` checked).
3. Break each preflight rule once and confirm a clear message: busy port (start a listener on 4566), missing `.env` variable, empty token.
4. Fresh clone: copy the repo without `.env`, `node_modules` or volumes into the scratchpad, run `make bootstrap` there, and confirm it passes. Then `make teardown` there.
5. Confirm no `~/.aws` files are read and no real AWS endpoint is contacted (the smoke script's account assertion, plus `docker compose logs` free of `amazonaws.com` requests).

## Implementation notes (as built)

- LocalStack `2026.10.2` exits with code 55 ("License activation failed") when `LOCALSTACK_AUTH_TOKEN` is empty, so preflight treats an empty token as an error.
- Step Functions on this LocalStack version supports `Wait`, `Parallel`, the SQS `sendMessage.waitForTaskToken` integration (success and failure via `send-task-success` / `send-task-failure`), `Catch`, and execution history. No deviation is needed for POC-025 to 028. Lambda and IAM were not used.
- The state machine accepts a placeholder role ARN, since IAM is not enabled.
- `aws` inside the LocalStack container needs explicit fake credentials, region and `--endpoint-url` in every script (see POC-003 notes).
