CREATE TABLE canvas_draft (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PUBLISHING', 'PUBLISHED', 'DISCARDED', 'DORMANT', 'PURGED')),
  -- Revision number of the head snapshot. Not a foreign key: avoids a draft <-> revision cycle.
  head_revision_no integer NOT NULL DEFAULT 0 CHECK (head_revision_no >= 0),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  discarded_at     timestamptz,
  purge_after      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canvas_draft_owner_status ON canvas_draft (owner_id, status);
CREATE INDEX canvas_draft_purge ON canvas_draft (status, purge_after);

CREATE TRIGGER canvas_draft_updated_at BEFORE UPDATE ON canvas_draft
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE canvas_revision (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id                  uuid NOT NULL REFERENCES canvas_draft (id),
  revision_no               integer NOT NULL CHECK (revision_no >= 1),
  document                  jsonb NOT NULL,
  content_hash              char(64) NOT NULL,
  source                    text NOT NULL
    CHECK (source IN ('INITIAL', 'USER_SAVE', 'AI_GENERATION', 'RESTORE')),
  restored_from_revision_no integer,
  pinned                    boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, revision_no)
);

-- Snapshots are immutable. Only "pinned" may change; delete stays allowed for pruning.
CREATE FUNCTION canvas_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id THEN
    RAISE EXCEPTION 'canvas_revision is immutable (draft %, revision %)', OLD.draft_id, OLD.revision_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canvas_revision_immutable BEFORE UPDATE ON canvas_revision
  FOR EACH ROW EXECUTE FUNCTION canvas_revision_immutable();
