CREATE TABLE media_asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO')),
  client_sha256     char(64) NOT NULL,
  server_sha256     char(64),
  content_type      text NOT NULL,
  size_bytes        bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  original_bucket   text NOT NULL,
  original_key      text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  upload_status     text NOT NULL DEFAULT 'PENDING_UPLOAD'
    CHECK (upload_status IN ('PENDING_UPLOAD', 'UPLOADED', 'VALIDATED', 'REJECTED', 'EXPIRED')),
  reject_reason     text,
  retention_status  text NOT NULL DEFAULT 'UNATTACHED'
    CHECK (retention_status IN ('UNATTACHED', 'REFERENCED', 'PUBLISHED', 'ORPHANED', 'DELETING', 'DELETED')),
  ref_count         integer NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  orphaned_at       timestamptz,
  upload_expires_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (original_bucket, original_key)
);

-- Owner-scoped dedup: only live assets block a re-upload of the same bytes.
CREATE UNIQUE INDEX media_asset_owner_hash_active
  ON media_asset (owner_id, client_sha256)
  WHERE upload_status IN ('PENDING_UPLOAD', 'UPLOADED', 'VALIDATED')
    AND retention_status NOT IN ('DELETING', 'DELETED');

CREATE INDEX media_asset_gc ON media_asset (retention_status, orphaned_at);
CREATE INDEX media_asset_upload_expiry ON media_asset (upload_status, upload_expires_at);

CREATE TRIGGER media_asset_updated_at BEFORE UPDATE ON media_asset
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE media_rendition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES media_asset (id),
  kind           text NOT NULL,
  tier           text NOT NULL CHECK (tier IN ('DRAFT', 'FINAL')),
  recipe_version integer NOT NULL DEFAULT 1,
  params_hash    text NOT NULL DEFAULT '',
  bucket         text NOT NULL,
  s3_key         text NOT NULL,
  status         text NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (status IN ('NOT_REQUESTED', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'FAILED_PERMANENT')),
  error          text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, kind, recipe_version, params_hash),
  UNIQUE (bucket, s3_key)
);

CREATE INDEX media_rendition_asset_status ON media_rendition (asset_id, status);

CREATE TRIGGER media_rendition_updated_at BEFORE UPDATE ON media_rendition
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
