import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sha256Hex } from './hash';
import { ApiError, get } from './api';
import { hasPngSignature } from './renderCanvas';

afterEach(() => vi.unstubAllGlobals());

describe('sha256Hex', () => {
  it('hashes known input', async () => {
    const buf = new TextEncoder().encode('abc').buffer as ArrayBuffer;
    expect(await sha256Hex(buf)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('request', () => {
  it('parses API errors into ApiError', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'REVISION_CONFLICT', message: 'stale', head_revision: 3 }), { status: 409 }));
    const err = await get('/v1/drafts/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('REVISION_CONFLICT');
    expect(err.body.head_revision).toBe(3);
  });

  it('sends X-Owner-Id', async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    });
    await get('/v1/drafts');
    expect(headers['X-Owner-Id']).toBeTruthy();
  });
});

describe('hasPngSignature', () => {
  it('accepts the canvas fixture, rejects fake.png', () => {
    expect(hasPngSignature(new Uint8Array(readFileSync('public/fixtures/canvas-render.png')))).toBe(true);
    expect(hasPngSignature(new Uint8Array(readFileSync('public/fixtures/fake.png')))).toBe(false);
  });
});
