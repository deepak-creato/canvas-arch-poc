-- GC bookkeeping (POC-033). DELETED rows stay as tombstones; DELETING rows are retried until the objects are gone.
ALTER TABLE media_asset
  ADD COLUMN deleted_at      timestamptz,
  ADD COLUMN delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  ADD COLUMN delete_error    text;

CREATE INDEX media_asset_deleting ON media_asset (updated_at) WHERE retention_status = 'DELETING';
