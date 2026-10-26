import { config } from '../../shared/config';

/**
 * Policy for one GC run. Defaults come from config; tests pass 0 or large values and an
 * `ownerId` scope so a run never touches rows that belong to other tests.
 */
export interface GcOptions {
  batchSize: number;
  uploadExpiryGraceSeconds: number;
  unattachedGraceSeconds: number;
  orphanGraceSeconds: number;
  /** A QUEUED/FAILED job untouched this long no longer protects its asset (lost message). */
  jobStaleSeconds: number;
  /** Newest N revisions of a draft are never pruned. */
  revisionKeepLast: number;
  /** Revisions younger than this are never pruned. */
  revisionMinAgeSeconds: number;
  /** Only rows of this owner are considered. Unset = all owners. */
  ownerId?: string;
}

export const defaultOptions = (over: Partial<GcOptions> = {}): GcOptions => ({
  batchSize: config.gcBatchSize,
  uploadExpiryGraceSeconds: config.gcUploadExpiryGraceSeconds,
  unattachedGraceSeconds: config.gcUnattachedGraceSeconds,
  orphanGraceSeconds: config.gcOrphanGraceSeconds,
  jobStaleSeconds: config.gcJobStaleSeconds,
  revisionKeepLast: config.gcRevisionKeepLast,
  revisionMinAgeSeconds: config.gcRevisionMinAgeSeconds,
  ...over,
});
