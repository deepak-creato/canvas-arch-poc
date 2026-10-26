import { config } from './config';

// Original upload key. The ingest rule routes only the staging prefix (POC-003).
export const originalKey = (ownerId: string, assetId: string) =>
  `${config.stagingPrefix}${ownerId}/${assetId}/source`;

// Draft-tier rendition key. Fully determined by asset, kind, recipe version and params,
// so a retry or duplicate message always targets the same object.
export const renditionKey = (assetId: string, kind: string, recipeVersion: number, paramsHash: string, ext: string) =>
  `derived/${assetId}/${kind}/v${recipeVersion}/${paramsHash}.${ext}`;
