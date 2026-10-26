import { config } from './config';

// Original upload key. The ingest rule routes only the staging prefix (POC-003).
export const originalKey = (ownerId: string, assetId: string) =>
  `${config.stagingPrefix}${ownerId}/${assetId}/source`;

// Draft-tier rendition key. Fully determined by asset, kind, recipe version and params,
// so a retry or duplicate message always targets the same object.
export const renditionKey = (assetId: string, kind: string, recipeVersion: number, paramsHash: string, ext: string) =>
  `derived/${assetId}/${kind}/v${recipeVersion}/${paramsHash}.${ext}`;

// Final-tier rendition recipe. The mock transcoder does not transcode; it places a fixture at this key.
export const FINAL_VIDEO = { kind: 'final_video', version: 1, paramsHash: 'mock-h264-720p', ext: 'mp4' };

// Fully determined by asset and recipe, so every publication of the same asset targets one object.
export const finalVideoKey = (assetId: string) =>
  `final/${assetId}/video/v${FINAL_VIDEO.version}/${FINAL_VIDEO.paramsHash}.${FINAL_VIDEO.ext}`;

export const transcodeJobKey = (assetId: string) => `transcode:${assetId}:final:v${FINAL_VIDEO.version}`;
