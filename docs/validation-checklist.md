# Validation checklist (plan section 8) and the evidence for each line

Run everything with `make test` (stack up). `make demo` runs the same story from a clean environment (POC-039).

| Checklist line | Proven by |
| --- | --- |
| Upload mix: 5 images + 1 video validated, draft renditions READY, zero final jobs | `canvas-api/test/lifecycle.spec.ts` step 1; `make verify-m2` |
| Owner-scoped dedup | `lifecycle.spec.ts` step 2; `uploads.spec.ts`; `faults.spec.ts` (concurrent uploads) |
| Edit without processing (20 saves, no new jobs) | `lifecycle.spec.ts` step 3 |
| Optimistic concurrency (409) | `lifecycle.spec.ts` step 3; `drafts.spec.ts`; `faults.spec.ts` (parallel saves) |
| Mock AI: known assets, cached repeat, accepted revision | `lifecycle.spec.ts` step 4; `ai.spec.ts` |
| Publish: finals, canvas upload, manifest, LIVE | `lifecycle.spec.ts` step 6; `publish-live.spec.ts` |
| Publish idempotency | `lifecycle.spec.ts` step 6; `publish.spec.ts`; `faults.spec.ts` (parallel publish) |
| Mock failures: transient retried, permanent fails, READY outputs reused | `retry.spec.ts`; `mock-transcoder/test` |
| Cross-draft reuse | `lifecycle.spec.ts` steps 5 and 7; `gc-worker/test/exit-demo.spec.ts` |
| Discard and restore within grace | `lifecycle.spec.ts` step 5; `drafts.spec.ts` |
| GC correctness | `lifecycle.spec.ts` step 7; `gc-worker/test/sweep.spec.ts`, `exit-demo.spec.ts` |
| GC / worker races | `gc-worker/test/protect.spec.ts`; `faults.spec.ts` (invariants) |
| Missed events | `gc-worker/test/reconcile.spec.ts` |
| Clean environment | `make demo` (POC-039) |
