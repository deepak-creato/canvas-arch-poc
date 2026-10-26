#!/bin/sh
# POC-004 check: tables exist and the key constraints hold. Runs in a transaction that is rolled back.
set -eu
cd "$(dirname "$0")/../.."

out=$(docker compose exec -T postgres psql -U canvas -d canvas -v ON_ERROR_STOP=1 -X -q <<'SQL' 2>&1
\set VERBOSITY terse
SET client_min_messages = notice;
BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['canvas_draft','canvas_revision','media_asset','media_rendition','media_reference',
                           'processing_job','publication','publication_asset','ai_generation','outbox_event','schema_migrations']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'missing table %', t; END IF;
  END LOOP;
  RAISE NOTICE 'OK   tables: all 11 present';
END $$;

-- fixtures
INSERT INTO media_asset (id, owner_id, kind, client_sha256, content_type, original_bucket, original_key)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'owner-a', 'IMAGE', repeat('a', 64), 'image/png', 'b', 'staging/o/a1');
INSERT INTO canvas_draft (id, owner_id) VALUES ('00000000-0000-0000-0000-0000000000d1', 'owner-a');
INSERT INTO canvas_draft (id, owner_id) VALUES ('00000000-0000-0000-0000-0000000000d2', 'owner-a');
INSERT INTO canvas_revision (id, draft_id, revision_no, document, content_hash, source)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 1, '{"v":1}', repeat('1', 64), 'INITIAL');

DO $$
BEGIN
  -- dedup: same owner + hash while live is rejected
  BEGIN
    INSERT INTO media_asset (owner_id, kind, client_sha256, content_type, original_bucket, original_key)
    VALUES ('owner-a', 'IMAGE', repeat('a', 64), 'image/png', 'b', 'staging/o/a2');
    RAISE EXCEPTION 'dup asset for same owner was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK   dedup: same owner and hash rejected';

  -- different owner accepted
  INSERT INTO media_asset (owner_id, kind, client_sha256, content_type, original_bucket, original_key)
  VALUES ('owner-b', 'IMAGE', repeat('a', 64), 'image/png', 'b', 'staging/o/b1');
  RAISE NOTICE 'OK   dedup: different owner accepted';

  -- a REJECTED asset does not block re-upload
  UPDATE media_asset SET upload_status = 'REJECTED' WHERE id = '00000000-0000-0000-0000-0000000000a1';
  INSERT INTO media_asset (owner_id, kind, client_sha256, content_type, original_bucket, original_key)
  VALUES ('owner-a', 'IMAGE', repeat('a', 64), 'image/png', 'b', 'staging/o/a3');
  RAISE NOTICE 'OK   dedup: REJECTED asset does not block re-upload';

  -- invalid state rejected by CHECK
  BEGIN
    UPDATE media_asset SET retention_status = 'BOGUS' WHERE owner_id = 'owner-b';
    RAISE EXCEPTION 'invalid retention_status accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'OK   state: invalid retention_status rejected';

  -- revisions: unique number, immutable document, pinned may change
  BEGIN
    INSERT INTO canvas_revision (draft_id, revision_no, document, content_hash, source)
    VALUES ('00000000-0000-0000-0000-0000000000d1', 1, '{}', repeat('2', 64), 'USER_SAVE');
    RAISE EXCEPTION 'duplicate revision_no accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK   revision: duplicate (draft_id, revision_no) rejected';

  BEGIN
    UPDATE canvas_revision SET document = '{"v":2}' WHERE id = '00000000-0000-0000-0000-0000000000e1';
    RAISE EXCEPTION 'revision document update accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'canvas_revision is immutable%' THEN RAISE; END IF;
  END;
  UPDATE canvas_revision SET pinned = true WHERE id = '00000000-0000-0000-0000-0000000000e1';
  RAISE NOTICE 'OK   revision: document immutable, pinned updatable';

  -- publication: one per draft, idempotency key unique per owner
  INSERT INTO publication (id, draft_id, revision_id, owner_id, idempotency_key)
  VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000e1', 'owner-a', 'key-1');
  BEGIN
    INSERT INTO publication (draft_id, revision_id, owner_id, idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'owner-a', 'key-2');
    RAISE EXCEPTION 'second publication for one draft accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK   publication: one per draft enforced';

  BEGIN
    INSERT INTO publication (draft_id, revision_id, owner_id, idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e1', 'owner-a', 'key-1');
    RAISE EXCEPTION 'repeated idempotency key accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK   publication: (owner_id, idempotency_key) unique';

  -- references: exactly one holder, no duplicates
  BEGIN
    INSERT INTO media_reference (asset_id) VALUES ('00000000-0000-0000-0000-0000000000a1');
    RAISE EXCEPTION 'reference without holder accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_reference (asset_id, revision_id, publication_id)
    VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000000f1');
    RAISE EXCEPTION 'reference with two holders accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'OK   reference: exactly one holder required';

  INSERT INTO media_reference (asset_id, revision_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1');
  BEGIN
    INSERT INTO media_reference (asset_id, revision_id)
    VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1');
    RAISE EXCEPTION 'duplicate reference accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK   reference: duplicate (asset, revision) rejected';

  -- jobs: idempotency key unique, status CHECK
  INSERT INTO processing_job (job_type, idempotency_key) VALUES ('LIGHT_PROCESS', 'job-1');
  BEGIN
    INSERT INTO processing_job (job_type, idempotency_key) VALUES ('LIGHT_PROCESS', 'job-1');
    RAISE EXCEPTION 'duplicate job idempotency key accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE processing_job SET status = 'BOGUS';
    RAISE EXCEPTION 'invalid job status accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'OK   job: idempotency key unique, status CHECK enforced';
END $$;

ROLLBACK;
SQL
) || { printf '%s\n' "$out"; echo "FAIL schema verification"; exit 1; }

printf '%s\n' "$out" | sed -n 's/^.*NOTICE:  //p'
