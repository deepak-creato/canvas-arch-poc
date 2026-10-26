import { config } from './config';

// Original upload key. The ingest rule routes only the staging prefix (POC-003).
export const originalKey = (ownerId: string, assetId: string) =>
  `${config.stagingPrefix}${ownerId}/${assetId}/source`;
