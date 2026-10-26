# M7 — Integration tests, demo and handoff (POC-037 to POC-040)

## Context

M1 to M6 are done and each milestone has its own specs. M7 adds the cross-cutting evidence: one lifecycle test, fault and race tests, a one-command demo from a clean environment, and the handoff documents. Plan section 8 (validation checklist) is the acceptance list.

## Decisions (stated, not asked; reverse any you dislike)

- **POC-037 lifecycle test** lives in `services/canvas-api/test/lifecycle.spec.ts` (it already has the API/SQL/S3 helpers). One owner walks the whole path: upload mix, dedup, 20 saves with zero new jobs, 409 conflict, AI generate/cache/accept, discard/restore, cross-draft reuse, publish to `LIVE`, discard, GC. Cleanup calls the gc-worker functions directly with every grace at 0 and `ownerId` scope (same approach as `gc-worker/test`). `docs/validation-checklist.md` maps each plan section 8 line to the spec that proves it.
- **POC-038 fault tests** in `services/canvas-api/test/faults.spec.ts`: concurrent identical uploads and duplicated S3 events (one job, one set of renditions), concurrent saves on one base (one winner, gapless revisions), concurrent publish with one key and with different keys, light-worker killed mid-job (`docker compose kill`) then restarted (lease expiry + SQS redelivery finish the job, no duplicate rows), mock transcode failure (transient retried, permanent fails, READY finals survive a retry; already covered by `retry.spec.ts`, referenced not repeated), GC racing save and restore (covered by `gc-worker/test/protect.spec.ts`, referenced). Final invariant query over the owner's data: no reference to a `DELETING`/`DELETED` asset, no `LIVE` publication with a missing reference, no duplicate jobs per idempotency key.
- **POC-039 demo**: `make demo` = `teardown` (drops volumes) -> `bootstrap` -> `infra/scripts/demo.sh`. The script is plain `curl` + `jq` against the public API like `verify-m2.sh`, prints PASS/FAIL per checklist line and exits non-zero on the first failure. Short GC graces come from `.env.example` values via `docker compose` env overrides in the script (`GC_*_SECONDS`), GC is triggered with `POST :3104/run`. Needs `LOCALSTACK_AUTH_TOKEN`, so `make demo` fails in preflight without it, same as `bootstrap`.
- **POC-040 docs**: README rewritten (stack, run, tests, layout, demo), `docs/api/canvas-poc.http` (plain `.http` file, works in VS Code REST Client / IntelliJ, no tool lock-in) and `docs/api/README.md` endpoint table, `docs/architecture.md` (flow diagrams in Mermaid, deviations from the plan: no Lambda in Step Functions, mock transcoder, SQS step runner, etc.), `docs/runbook.md` (symptom -> check -> fix, using `make gc-*` and SQL). Every command in the docs is run once before the commit.

## Ticket order

1. POC-037 lifecycle test + checklist map.
2. POC-038 fault tests.
3. POC-039 `make demo`.
4. POC-040 README, API collection, architecture, runbook; CLAUDE.md status.

One branch and commit per ticket.
