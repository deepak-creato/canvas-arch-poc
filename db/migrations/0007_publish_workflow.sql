-- M5 publish workflow support.
ALTER TABLE publication
  -- Step Functions task token of the AwaitCanvas step; cleared when the canvas upload answers it.
  ADD COLUMN task_token          text,
  -- Execution counter. A retry runs a new execution on the same publication row.
  ADD COLUMN attempt             integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ADD COLUMN canvas_content_type text,
  ADD COLUMN canvas_bytes        bigint,
  -- Local POC only: failure injection for the mock transcoder (honoured when WORKER_TEST_HOOKS=true).
  ADD COLUMN test_fail_mode      text;

-- Every status change of a publication, so a run can be traced without the Step Functions history.
CREATE TABLE publication_transition (
  id             bigserial PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES publication (id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  step           text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX publication_transition_pub ON publication_transition (publication_id, id);
