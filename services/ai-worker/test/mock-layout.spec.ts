import { randomUUID } from 'crypto';
import { AssetFacts, generateLayout, LayoutInput, validateCanvas } from '../../shared/mock-layout';

const asset = (kind: 'IMAGE' | 'VIDEO' = 'IMAGE', width = 1280, height = 720): AssetFacts => ({ asset_id: randomUUID(), kind, width, height });
const input = (assets: AssetFacts[], seed = 0): LayoutInput => ({ assets, canvas: { width: 1080, height: 1080 }, seed, model_version: 'mock-layout-v1' });

describe('mock layout generator (POC-020)', () => {
  it('is deterministic for the same input', () => {
    const assets = [asset(), asset('VIDEO'), asset('IMAGE', 600, 900)];
    expect(JSON.stringify(generateLayout(input(assets)))).toBe(JSON.stringify(generateLayout(input(assets))));
  });

  it('changes with the seed and the model version', () => {
    const assets = Array.from({ length: 5 }, () => asset());
    const seen = new Set(Array.from({ length: 12 }, (_, s) => JSON.stringify(generateLayout(input(assets, s)))));
    expect(seen.size).toBeGreaterThan(1);
    expect(JSON.stringify(generateLayout({ ...input(assets), model_version: 'other' }))).not.toBe(JSON.stringify(generateLayout(input(assets))));
  });

  it.each([1, 2, 3, 4, 7, 20])('is schema-valid and covers each of %i assets exactly once', (n) => {
    const assets = Array.from({ length: n }, (_, i) => asset(i % 3 === 2 ? 'VIDEO' : 'IMAGE', 400 + i * 97, 300 + i * 53));
    for (let seed = 0; seed < 6; seed++) {
      const doc = generateLayout(input(assets, seed));
      expect(validateCanvas(doc, assets.map((a) => a.asset_id))).toEqual([]);
      expect(doc.elements.map((e) => e.asset_id).sort()).toEqual(assets.map((a) => a.asset_id).sort());
      for (const e of doc.elements) {
        const src = assets.find((a) => a.asset_id === e.asset_id)!;
        expect(e.type).toBe(src.kind === 'VIDEO' ? 'video' : 'image');
        // aspect ratio kept within rounding
        expect(Math.abs(e.width / e.height - src.width / src.height)).toBeLessThan(0.1 + 2 / Math.min(e.width, e.height));
      }
    }
  });

  it('only references the assets it was given', () => {
    const given = [asset(), asset()];
    const doc = generateLayout(input(given));
    const known = new Set(given.map((a) => a.asset_id));
    expect(doc.elements.every((e) => known.has(e.asset_id))).toBe(true);
  });

  it('refuses an empty asset list', () => {
    expect(() => generateLayout(input([]))).toThrow();
  });
});

describe('validateCanvas', () => {
  const a = asset();
  const good = () => generateLayout(input([a]));

  it('flags unknown assets', () => {
    expect(validateCanvas(good(), [randomUUID()]).join()).toMatch(/not a known asset/);
  });

  it('flags shape problems', () => {
    expect(validateCanvas([], [])).toEqual(['document must be an object']);
    const d: any = good();
    d.elements[0].x = -1;
    d.elements.push({ ...d.elements[0], x: 0 });
    d.version = 2;
    const msg = validateCanvas(d, [a.asset_id]).join('|');
    expect(msg).toMatch(/version must be 1/);
    expect(msg).toMatch(/outside the canvas/);
    expect(msg).toMatch(/duplicated/);
  });
});
