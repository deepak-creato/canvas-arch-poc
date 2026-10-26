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
