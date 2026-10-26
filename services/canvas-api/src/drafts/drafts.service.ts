import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { PG_POOL } from '../tokens';
import { contentHash } from './canonical';

const STATUSES = ['ACTIVE', 'PUBLISHING', 'PUBLISHED', 'DISCARDED', 'DORMANT', 'PURGED'];

interface DraftRow {
  id: string;
  status: string;
  head_revision_no: number;
  last_activity_at: Date;
  discarded_at: Date | null;
  purge_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RevisionRow {
  revision_no: number;
  document: unknown;
  content_hash: string;
  source: string;
  restored_from_revision_no: number | null;
  pinned: boolean;
  created_at: Date;
}

export const draftView = (d: DraftRow) => ({
  draft_id: d.id,
  status: d.status,
  head_revision: d.head_revision_no,
  last_activity_at: d.last_activity_at.toISOString(),
  discarded_at: d.discarded_at?.toISOString() ?? null,
  purge_after: d.purge_after?.toISOString() ?? null,
  created_at: d.created_at.toISOString(),
  updated_at: d.updated_at.toISOString(),
});

export const revisionView = (r: RevisionRow) => ({
  revision_no: r.revision_no,
  document: r.document,
  content_hash: r.content_hash,
  source: r.source,
  restored_from_revision: r.restored_from_revision_no,
  pinned: r.pinned,
  created_at: r.created_at.toISOString(),
});

@Injectable()
export class DraftsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(ownerId: string, document: Record<string, unknown>) {
    const size = Buffer.byteLength(JSON.stringify(document));
    if (size > config.maxDocumentBytes) {
      throw new BadRequestException({ code: 'DOCUMENT_TOO_LARGE', message: `document exceeds ${config.maxDocumentBytes} bytes` });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const draft = (
        await client.query<DraftRow>(
          `INSERT INTO canvas_draft (owner_id, head_revision_no) VALUES ($1, 1) RETURNING *`,
          [ownerId],
        )
      ).rows[0];
      const rev = (
        await client.query<RevisionRow>(
          `INSERT INTO canvas_revision (draft_id, revision_no, document, content_hash, source)
           VALUES ($1, 1, $2, $3, 'INITIAL') RETURNING *`,
          [draft.id, JSON.stringify(document), contentHash(document)],
        )
      ).rows[0];
      await client.query('COMMIT');
      log('info', 'draft created', { draft_id: draft.id, owner_id: ownerId });
      return { ...draftView(draft), revision: revisionView(rev) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async get(ownerId: string, draftId: string) {
    const draft = await this.findOwned(ownerId, draftId);
    const rev = (
      await this.pool.query<RevisionRow>(
        `SELECT * FROM canvas_revision WHERE draft_id = $1 AND revision_no = $2`,
        [draft.id, draft.head_revision_no],
      )
    ).rows[0];
    return { ...draftView(draft), revision: revisionView(rev) };
  }

  /** Newest activity first. DISCARDED drafts are hidden unless asked for with ?status=. */
  async list(ownerId: string, status?: string) {
    if (status && !STATUSES.includes(status)) {
      throw new BadRequestException({ code: 'INVALID_STATUS', message: `status must be one of ${STATUSES.join(', ')}` });
    }
    const rows = (
      await this.pool.query<DraftRow>(
        `SELECT * FROM canvas_draft
          WHERE owner_id = $1 AND ($2::text IS NULL AND status NOT IN ('DISCARDED', 'PURGED') OR status = $2)
          ORDER BY last_activity_at DESC, id`,
        [ownerId, status ?? null],
      )
    ).rows;
    return { drafts: rows.map(draftView) };
  }

  async findOwned(ownerId: string, draftId: string): Promise<DraftRow> {
    const d = (
      await this.pool.query<DraftRow>(`SELECT * FROM canvas_draft WHERE id = $1 AND owner_id = $2`, [draftId, ownerId])
    ).rows[0];
    // Another owner's draft looks the same as a missing one.
    if (!d) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND', message: 'draft not found' });
    return d;
  }
}
