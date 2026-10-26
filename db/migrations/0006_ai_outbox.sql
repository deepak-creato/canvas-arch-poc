CREATE TABLE ai_generation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id             uuid NOT NULL REFERENCES canvas_draft (id),
  owner_id             text NOT NULL,
  status               text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PROCESSING', 'READY', 'FAILED')),
  input_hash           char(64) NOT NULL,
  model_version        text NOT NULL,
  seed                 integer NOT NULL DEFAULT 0,
  -- hash of input_hash + model_version + seed; lookup key for cached results
  cache_key            char(64) NOT NULL,
  request              jsonb NOT NULL,
  result               jsonb,
  error                text,
  cached_from_id       uuid REFERENCES ai_generation (id),
  accepted_revision_no integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_generation_cache ON ai_generation (cache_key) WHERE status = 'READY';
CREATE INDEX ai_generation_draft ON ai_generation (draft_id, created_at);

CREATE TRIGGER ai_generation_updated_at BEFORE UPDATE ON ai_generation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE outbox_event (
  id             bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts       integer NOT NULL DEFAULT 0,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_event_unpublished ON outbox_event (id) WHERE published_at IS NULL;
