CREATE TABLE media_reference (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES media_asset (id),
  revision_id    uuid REFERENCES canvas_revision (id) ON DELETE CASCADE,
  publication_id uuid REFERENCES publication (id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(revision_id, publication_id) = 1)
);

CREATE UNIQUE INDEX media_reference_asset_revision
  ON media_reference (asset_id, revision_id) WHERE revision_id IS NOT NULL;
CREATE UNIQUE INDEX media_reference_asset_publication
  ON media_reference (asset_id, publication_id) WHERE publication_id IS NOT NULL;
CREATE INDEX media_reference_asset ON media_reference (asset_id);
CREATE INDEX media_reference_revision ON media_reference (revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX media_reference_publication ON media_reference (publication_id) WHERE publication_id IS NOT NULL;

CREATE TABLE processing_job (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type         text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  asset_id         uuid REFERENCES media_asset (id),
  publication_id   uuid REFERENCES publication (id),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'FAILED_PERMANENT')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  lease_owner      text,
  lease_expires_at timestamptz,
  available_at     timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX processing_job_status_lease ON processing_job (status, lease_expires_at);
CREATE INDEX processing_job_asset ON processing_job (asset_id);
CREATE INDEX processing_job_publication ON processing_job (publication_id) WHERE publication_id IS NOT NULL;

CREATE TRIGGER processing_job_updated_at BEFORE UPDATE ON processing_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
