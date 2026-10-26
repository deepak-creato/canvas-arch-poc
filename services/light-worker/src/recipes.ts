// Draft-tier image recipes. Bump `version` when output changes, so new rows and keys are used.
export interface ImageRecipe {
  kind: 'thumbnail' | 'preview';
  version: number;
  width: number;
  height: number;
  quality: number;
}

export const IMAGE_RECIPES: ImageRecipe[] = [
  { kind: 'thumbnail', version: 1, width: 320, height: 320, quality: 75 },
  { kind: 'preview', version: 1, width: 1280, height: 1280, quality: 80 },
];

export const paramsHash = (r: ImageRecipe) => `inside-${r.width}x${r.height}-q${r.quality}`;
export const IMAGE_DERIVE_VERSION = 1;
export const imageDeriveKey = (assetId: string) => `derive:${assetId}:image:v${IMAGE_DERIVE_VERSION}`;

// Draft-tier video recipes (POC-011).
export const VIDEO_DERIVE_VERSION = 1;
export const videoDeriveKey = (assetId: string) => `derive:${assetId}:video:v${VIDEO_DERIVE_VERSION}`;

export const POSTER = { version: 1, maxWidth: 640, quality: 3 };
export const PROXY = { version: 1, maxWidth: 640, crf: 30, preset: 'veryfast', audioKbps: 64 };
export const SPRITE = {
  version: 1,
  frameWidth: 160,
  columns: 5,
  rows: 5, // frames per sheet = columns * rows
  maxFrames: 50,
  minIntervalSeconds: 1,
  quality: 5,
};

/** Frame layout derived only from the duration and dimensions, so it is stable across retries. */
export function spritePlan(durationSeconds: number, width: number, height: number) {
  const interval = Math.max(SPRITE.minIntervalSeconds, durationSeconds / SPRITE.maxFrames);
  const frameCount = Math.min(SPRITE.maxFrames, Math.max(1, Math.ceil(durationSeconds / interval)));
  const frameHeight = Math.max(2, Math.round((SPRITE.frameWidth * height) / width / 2) * 2);
  const perSheet = SPRITE.columns * SPRITE.rows;
  return { interval, frameCount, frameHeight, sheets: Math.ceil(frameCount / perSheet), perSheet };
}
