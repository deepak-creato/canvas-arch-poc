import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { addRevisionReferences, AssetReferenceError, extractAssetIds } from '../../../shared/refs';
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
  id: string;
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

export const revisionView = (r: Omit<RevisionRow, 'id'>) => ({
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
    assertDocumentSize(document);
    return this.inTx(async (client) => {
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
      await this.attachReferences(client, ownerId, rev);
      log('info', 'draft created', { draft_id: draft.id, owner_id: ownerId });
      return { ...draftView(draft), revision: revisionView(rev) };
    });
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

  /**
   * Saves `document` as the next immutable revision. The draft row is locked for the whole
   * transaction, so revision numbers are gapless and concurrent saves are serialized.
   * A document equal to the head (same canonical hash) adds no revision.
   */
  async save(ownerId: string, draftId: string, baseRevision: number, document: Record<string, unknown>) {
    assertDocumentSize(document);
    const hash = contentHash(document);
    return this.inTx(async (client) => {
      const draft = await this.lockOwned(client, ownerId, draftId);
      assertEditable(draft);
      if (baseRevision !== draft.head_revision_no) {
        throw new ConflictException({
          code: 'REVISION_CONFLICT',
          message: `base_revision ${baseRevision} is stale; head is ${draft.head_revision_no}`,
          head_revision: draft.head_revision_no,
        });
      }
      const head = (
        await client.query<RevisionRow>(`SELECT * FROM canvas_revision WHERE draft_id = $1 AND revision_no = $2`, [draft.id, draft.head_revision_no])
      ).rows[0];
      if (head.content_hash === hash) return { ...draftView(draft), unchanged: true, revision: revisionView(head) };

      const rev = await this.appendRevision(client, draft, document, hash, 'USER_SAVE', null);
      await this.attachReferences(client, ownerId, rev);
      log('info', 'revision saved', { draft_id: draft.id, revision_no: rev.revision_no, owner_id: ownerId });
      return { ...draftView({ ...draft, head_revision_no: rev.revision_no }), unchanged: false, revision: revisionView(rev) };
    });
  }

  /** Revision list without documents, newest first. */
  async revisions(ownerId: string, draftId: string) {
    const draft = await this.findOwned(ownerId, draftId);
    const rows = (
      await this.pool.query<RevisionRow>(
        `SELECT revision_no, content_hash, source, restored_from_revision_no, pinned, created_at
           FROM canvas_revision WHERE draft_id = $1 ORDER BY revision_no DESC`,
        [draft.id],
      )
    ).rows;
    return {
      draft_id: draft.id,
      head_revision: draft.head_revision_no,
      revisions: rows.map((r) => {
        const { document: _omit, ...v } = revisionView({ ...r, document: null });
        return v;
      }),
    };
  }

  /** Inserts revision head+1 and advances the draft. Caller holds the draft row lock. */
  private async appendRevision(client: PoolClient, draft: DraftRow, document: unknown, hash: string, source: string, restoredFrom: number | null) {
    const no = draft.head_revision_no + 1;
    const rev = (
      await client.query<RevisionRow>(
        `INSERT INTO canvas_revision (draft_id, revision_no, document, content_hash, source, restored_from_revision_no)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [draft.id, no, JSON.stringify(document), hash, source, restoredFrom],
      )
    ).rows[0];
    await client.query(`UPDATE canvas_draft SET head_revision_no = $2, last_activity_at = now() WHERE id = $1`, [draft.id, no]);
    return rev;
  }

  /** Writes the revision's media_reference rows; a bad reference aborts the whole transaction. */
  private async attachReferences(client: PoolClient, ownerId: string, rev: RevisionRow) {
    try {
      return await addRevisionReferences(client, ownerId, rev.id, extractAssetIds(rev.document));
    } catch (e) {
      if (e instanceof AssetReferenceError) {
        throw new UnprocessableEntityException({ code: e.code, message: e.message, asset_id: e.assetId });
      }
      throw e;
    }
  }

  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async lockOwned(client: PoolClient, ownerId: string, draftId: string): Promise<DraftRow> {
    const d = (await client.query<DraftRow>(`SELECT * FROM canvas_draft WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [draftId, ownerId])).rows[0];
    if (!d) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND', message: 'draft not found' });
    return d;
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

function assertDocumentSize(document: unknown) {
  if (Buffer.byteLength(JSON.stringify(document)) > config.maxDocumentBytes) {
    throw new BadRequestException({ code: 'DOCUMENT_TOO_LARGE', message: `document exceeds ${config.maxDocumentBytes} bytes` });
  }
}

/** Only ACTIVE drafts take edits. PUBLISHING and PUBLISHED are frozen (one publication per draft). */
function assertEditable(d: DraftRow) {
  if (d.status === 'ACTIVE') return;
  if (d.status === 'DISCARDED' || d.status === 'PURGED') {
    throw new ConflictException({ code: 'DRAFT_DISCARDED', message: `draft is ${d.status}` });
  }
  throw new ConflictException({ code: 'DRAFT_FROZEN', message: `draft is ${d.status} and cannot be edited` });
}
