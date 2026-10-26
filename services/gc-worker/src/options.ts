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
  /** PENDING_UPLOAD older than this is checked against S3 for a missed event. */
  reconcileAfterSeconds: number;
  /** Stray objects younger than this are left alone (an upload may be mid-flight). */
  strayGraceSeconds: number;
  /** Delete strays, not just report them. */
  deleteStrays: boolean;
  /** [bucket, prefix] pairs to scan for strays. Default: staging/, derived/ and final/. */
  strayPrefixes?: [string, string][];
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
  reconcileAfterSeconds: config.gcReconcileAfterSeconds,
  strayGraceSeconds: config.gcStrayGraceSeconds,
  deleteStrays: config.gcDeleteStrays,
  revisionKeepLast: config.gcRevisionKeepLast,
  revisionMinAgeSeconds: config.gcRevisionMinAgeSeconds,
  ...over,
});
