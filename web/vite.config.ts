import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// canvas-api, gc-worker and mock-transcoder have no CORS, so the dev server proxies them same-origin.
const target = (envPort: string | undefined, fallback: number) => `http://127.0.0.1:${envPort ?? fallback}`;
const strip = (prefix: string) => (path: string) => path.replace(new RegExp(`^${prefix}`), '');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: target(process.env.HOST_PORT_API, 3000), rewrite: strip('/api') },
      '/gc': { target: target(process.env.HOST_PORT_GC, 3104), rewrite: strip('/gc') },
      '/transcoder': { target: target(process.env.HOST_PORT_TRANSCODER, 3103), rewrite: strip('/transcoder') },
    },
  },
  test: { environment: 'node' },
});
