# Domain glossary and state machines (AI context)

Quick reference for AI assistants. The authoritative version is section 6 of `Canvas_Editor_Media_Platform_POC_Plan.md`. If the two differ, the plan wins.

## Glossary

| Term | Meaning |
| --- | --- |
| Asset | An uploaded original (image or video) plus its metadata, stored in `media_asset`. |
| Rendition | A derived output of an asset (thumbnail, preview, proxy, poster, sprite, final). Stored in `media_rendition` with a deterministic S3 key. |
| Draft | An editable canvas document owned by one user. |
| Revision | An immutable JSONB snapshot of a draft's canvas. |
| Reference | A row in `media_reference` linking a revision or publication to an asset. It decides whether an asset can be garbage-collected. |
| Publication | The frozen, published form of one exact revision, with a manifest. |
| Draft tier | Cheap outputs made at upload time (thumbnail, WebP preview, video proxy, poster, sprites). |
| Final tier | Outputs made only at publish time. Video finals come from the mock transcoder. |
| Orphan | An asset with zero references, waiting out its grace period before deletion. |

## State machines

| Object | States |
| --- | --- |
| Upload | `PENDING_UPLOAD` → `UPLOADED` → `VALIDATED`, or `REJECTED`; `EXPIRED` when abandoned |
| Rendition | `NOT_REQUESTED` → `QUEUED` → `PROCESSING` → `READY`, or `FAILED` / `FAILED_PERMANENT` |
| Retention | `UNATTACHED`, `REFERENCED`, `PUBLISHED`, `ORPHANED`, `DELETING`, `DELETED` |
| Publication | `REQUESTED` → `WAITING_FOR_ASSETS` → `TRANSCODING` → `AWAITING_CANVAS` → `FINALIZING` → `LIVE`; `FAILED` on error |
| Draft | `ACTIVE`, `PUBLISHING`, `PUBLISHED`, `DISCARDED`, optionally `DORMANT` / `PURGED` |

## Invariants

1. A canvas save never starts a media-processing job.
2. A revision is never modified after creation.
3. `PENDING_UPLOAD` moves to `UPLOADED` only after the object is verified with a HEAD request.
4. A published or referenced asset is never deleted.
5. A duplicate SQS message or duplicate callback must not create duplicate work.
6. A draft is published at most once.

## Milestone map

| Milestone | Tickets | Theme |
| --- | --- | --- |
| M1 | POC-001 to 005 | Environment and schema |
| M2 | POC-006 to 013 | Upload and light processing |
| M3 | POC-014 to 019 | Drafts, revisions, references |
| M4 | POC-020 to 022 | Mock AI layouts |
| M5 | POC-023 to 030 | Publish and mock transcode |
| M6 | POC-031 to 036 | GC and recovery |
| M7 | POC-037 to 040 | Tests, demo, handoff |
