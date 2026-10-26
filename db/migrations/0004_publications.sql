CREATE TABLE publication (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES canvas_draft (id),
  revision_id     uuid NOT NULL REFERENCES canvas_revision (id),
  owner_id        text NOT NULL,
  status          text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED', 'WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS',
                      'FINALIZING', 'LIVE', 'FAILED')),
  idempotency_key text NOT NULL,
  execution_arn   text,
  render_bucket   text,
  render_key      text,
  manifest_key    text,
  failure_reason  text,
  live_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- POC policy: one publication per draft. A failed one is retried on the same row.
  UNIQUE (draft_id),
  UNIQUE (owner_id, idempotency_key)
);

CREATE TRIGGER publication_updated_at BEFORE UPDATE ON publication
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE publication_asset (
  publication_id uuid NOT NULL REFERENCES publication (id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL REFERENCES media_asset (id),
  rendition_id   uuid NOT NULL REFERENCES media_rendition (id),
  role           text NOT NULL DEFAULT 'FINAL',
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, asset_id, rendition_id)
);

CREATE INDEX publication_asset_asset ON publication_asset (asset_id);
