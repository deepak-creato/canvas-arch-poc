import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../../../shared/config';
import { planFinals } from '../../../shared/final-renditions';
import { log } from '../../../shared/log';
import { extractAssetIds } from '../../../shared/refs';
import { contentHash } from '../drafts/canonical';
import { PG_POOL, S3 } from '../tokens';
import { assetReadiness } from './asset-readiness';
import { StepError } from './errors';
import { markPublicationLive } from './mark-live';
import { transition } from './publication-state';

/** Message that Step Functions puts on the publish-tasks queue (see infra/stepfunctions/publish.asl.json). */
export interface StepMessage {
  step: string;
  publication_id: string;
  token: string;
  [k: string]: unknown;
}

/** Returned by a step that answers its task token later, from another place (the canvas upload). */
export const HOLD = Symbol('hold');

export interface PublicationContext {
  id: string;
  draft_id: string;
  owner_id: string;
  status: string;
  attempt: number;
  revision_id: string;
  revision_no: number;
  document: unknown;
  content_hash: string;
  test_fail_mode: string | null;
}

@Injectable()
export class PublishSteps {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  /** Runs one workflow step. Every step is safe to run twice. */
  async run(msg: StepMessage): Promise<unknown | typeof HOLD> {
    switch (msg.step) {
      case 'VALIDATE_SNAPSHOT':
        return this.validateSnapshot(msg);
      case 'PLAN_FINALS':
        return this.planFinals(msg);
      case 'MARK_FINALS_READY':
        return this.markFinalsReady(msg);
      case 'AWAIT_CANVAS':
        return this.awaitCanvas(msg);
      case 'WRITE_MANIFEST':
        return this.writeManifest(msg);
      case 'MARK_LIVE':
        return markPublicationLive(this.pool, msg.publication_id, msg.step);
      case 'FAIL_PUBLICATION':
        return this.failPublication(msg);
      default:
        throw new StepError('STEP_NOT_IMPLEMENTED', `workflow step ${msg.step} is not implemented`);
    }
  }

  async load(publicationId: string): Promise<PublicationContext> {
    const p = (
      await this.pool.query<PublicationContext>(
        `SELECT p.id, p.draft_id, p.owner_id, p.status, p.attempt, p.revision_id, p.test_fail_mode,
                r.revision_no, r.document, r.content_hash
           FROM publication p JOIN canvas_revision r ON r.id = p.revision_id
          WHERE p.id = $1`,
        [publicationId],
      )
    ).rows[0];
    if (!p) throw new StepError('PUBLICATION_NOT_FOUND', `publication ${publicationId} not found`);
    return p;
  }

  /** Active publication only: a LIVE or FAILED one must not be moved by a stale message. */
  private async loadActive(msg: StepMessage): Promise<PublicationContext> {
    const p = await this.load(msg.publication_id);
    if (p.status === 'LIVE' || p.status === 'FAILED') {
      throw new StepError('PUBLICATION_STATE', `publication is ${p.status}`);
    }
    return p;
  }

  /**
   * WAITING_FOR_ASSETS. The pinned revision must still be the snapshot that was requested, and every
   * asset it uses must be validated with draft renditions READY. Not ready yet returns ready=false
   * (the state machine waits and asks again); unusable or too slow fails the publication.
   */
  private async validateSnapshot(msg: StepMessage) {
    const p = await this.loadActive(msg);
    const ctx = { publication_id: p.id, draft_id: p.draft_id };
    await transition(this.pool, p.id, 'WAITING_FOR_ASSETS', msg.step);

    if (contentHash(p.document) !== p.content_hash) {
      throw new StepError('SNAPSHOT_MISMATCH', 'pinned revision content no longer matches its hash');
    }
    const assetIds = extractAssetIds(p.document);
    const iteration = Number(msg.iteration ?? 0);
    if (assetIds.length === 0) return { ready: true, iteration, asset_ids: [] };

    const assets = await assetReadiness(this.pool, assetIds);
    const byId = new Map(assets.map((a) => [a.id, a]));
    let pending = 0;
    for (const id of assetIds) {
      const a = byId.get(id);
      if (!a || a.owner_id !== p.owner_id || a.retention_status === 'DELETING' || a.retention_status === 'DELETED') {
        throw new StepError('ASSET_UNUSABLE', `asset ${id} is missing or deleted`);
      }
      if (a.status === 'REJECTED' || a.status === 'EXPIRED' || a.status === 'FAILED') {
        throw new StepError('ASSET_UNUSABLE', `asset ${id} is ${a.status}`);
      }
      if (a.status !== 'READY') pending++;
    }
    if (pending > 0) {
      if (iteration + 1 >= config.publishMaxAssetPolls) {
        throw new StepError('ASSETS_NOT_READY', `${pending} asset(s) still not ready after ${iteration + 1} checks`);
      }
      log('info', 'assets not ready, waiting', { ...ctx, pending, iteration });
      return { ready: false, iteration: iteration + 1, asset_ids: assetIds };
    }
    return { ready: true, iteration, asset_ids: assetIds };
  }

  /** TRANSCODING. Returns only the video finals that still have to be produced. */
  private async planFinals(msg: StepMessage) {
    const p = await this.loadActive(msg);
    await transition(this.pool, p.id, 'TRANSCODING', msg.step);
    const plan = await planFinals(this.pool, this.s3, extractAssetIds(p.document), { resetFailed: true, publicationId: p.id });
    const failMode = config.workerTestHooks && p.test_fail_mode ? p.test_fail_mode : 'none';
    log('info', 'final plan', { publication_id: p.id, to_produce: plan.missing.length, reused: plan.reused.length });
    return {
      missing: plan.missing.map((m) => ({ asset_id: m.asset_id, rendition_id: m.rendition_id, fail_mode: failMode })),
      reused: plan.reused.length,
    };
  }

  /** Every video final must be READY and its object present before the canvas gate opens. */
  private async markFinalsReady(msg: StepMessage) {
    const p = await this.loadActive(msg);
    const plan = await planFinals(this.pool, this.s3, extractAssetIds(p.document), { publicationId: p.id });
    if (plan.missing.length > 0 || plan.failed.length > 0) {
      const bad = [...plan.missing, ...plan.failed].map((m) => m.asset_id).join(',');
      throw new StepError('FINAL_NOT_READY', `final rendition not ready for asset(s) ${bad}`);
    }
    for (const f of plan.reused) {
      await this.s3.send(new HeadObjectCommand({ Bucket: f.bucket, Key: f.key }));
    }
    return { finals: plan.reused.map((f) => ({ asset_id: f.asset_id, rendition_id: f.rendition_id, key: f.key })) };
  }

  /**
   * The canvas gate. Stores the task token and opens AWAITING_CANVAS, then holds: the workflow resumes
   * when the client confirms its canvas upload (POST canvas-uploaded) and the API answers the token.
   * The token is stored before the status changes, so a client that sees AWAITING_CANVAS can always resume it.
   */
  private async awaitCanvas(msg: StepMessage) {
    const p = await this.loadActive(msg);
    // A redelivered message after the canvas was confirmed must not re-arm an answered token.
    const armed = await this.pool.query(
      `UPDATE publication SET task_token = $2
        WHERE id = $1 AND status IN ('REQUESTED', 'WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS')`,
      [p.id, msg.token],
    );
    if (armed.rowCount) {
      await transition(this.pool, p.id, 'AWAITING_CANVAS', msg.step);
      log('info', 'waiting for canvas upload', { publication_id: p.id, draft_id: p.draft_id });
    }
    return HOLD;
  }

  /**
   * FINALIZING. Writes publications/{id}/manifest.json: the frozen revision, the client's canvas object and
   * the final rendition map. Everything in it comes from the database and the pinned revision, so a retry
   * writes an equal object.
   */
  private async writeManifest(msg: StepMessage) {
    const p = await this.loadActive(msg);
    await transition(this.pool, p.id, 'FINALIZING', msg.step);

    const row = (
      await this.pool.query<{ render_bucket: string | null; render_key: string | null; canvas_content_type: string | null; created_at: Date }>(
        `SELECT render_bucket, render_key, canvas_content_type, created_at FROM publication WHERE id = $1`,
        [p.id],
      )
    ).rows[0];
    if (!row.render_key || !row.render_bucket) throw new StepError('CANVAS_MISSING', 'no canvas upload is recorded for this publication');
    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: row.render_bucket, Key: row.render_key }));
    } catch {
      throw new StepError('CANVAS_MISSING', `canvas object ${row.render_key} is missing`);
    }

    const assetIds = extractAssetIds(p.document);
    const assets = (
      await this.pool.query<{ id: string; kind: string; content_type: string; size_bytes: string | null; server_sha256: string | null; original_bucket: string; original_key: string }>(
        `SELECT id, kind, content_type, size_bytes, server_sha256, original_bucket, original_key FROM media_asset WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [assetIds],
      )
    ).rows;
    const finals = (
      await this.pool.query<{ id: string; asset_id: string; bucket: string; s3_key: string }>(
        `SELECT id, asset_id, bucket, s3_key FROM media_rendition
          WHERE asset_id = ANY($1::uuid[]) AND tier = 'FINAL' AND status = 'READY' ORDER BY asset_id`,
        [assetIds],
      )
    ).rows;
    const videos = assets.filter((a) => a.kind === 'VIDEO').length;
    if (finals.length !== videos) throw new StepError('FINAL_NOT_READY', `expected ${videos} final video(s), found ${finals.length} READY`);

    const manifest = {
      manifest_version: 1,
      publication_id: p.id,
      draft_id: p.draft_id,
      owner_id: p.owner_id,
      created_at: row.created_at.toISOString(),
      revision: { revision_no: p.revision_no, content_hash: p.content_hash, document: p.document },
      render: { bucket: row.render_bucket, key: row.render_key, content_type: row.canvas_content_type, bytes: head.ContentLength ?? null, etag: head.ETag ?? null },
      assets: assets.map((a) => ({
        asset_id: a.id,
        kind: a.kind,
        original: { bucket: a.original_bucket, key: a.original_key, content_type: a.content_type, size_bytes: a.size_bytes === null ? null : Number(a.size_bytes), sha256: a.server_sha256 },
      })),
      finals: Object.fromEntries(finals.map((f) => [f.asset_id, { rendition_id: f.id, bucket: f.bucket, key: f.s3_key }])),
    };
    const key = `publications/${p.id}/manifest.json`;
    await this.s3.send(new PutObjectCommand({ Bucket: config.bucketPublished, Key: key, Body: JSON.stringify(manifest, null, 2), ContentType: 'application/json' }));
    await this.pool.query(`UPDATE publication SET manifest_key = $2 WHERE id = $1`, [p.id, key]);
    log('info', 'manifest written', { publication_id: p.id, draft_id: p.draft_id, key });
    return { manifest_key: key };
  }

  /** Terminal failure: record it so the API, the client and the retry endpoint see it. */
  private async failPublication(msg: StepMessage) {
    const err = (msg.error ?? {}) as { Error?: string; Cause?: string };
    const reason = `${err.Error ?? 'UNKNOWN'}: ${String(err.Cause ?? '').slice(0, 400)}`;
    await transition(this.pool, msg.publication_id, 'FAILED', msg.step, { reason, detail: { error: err.Error ?? null } });
    log('error', 'publication failed', { publication_id: msg.publication_id, reason });
    return { failed: true };
  }
}
