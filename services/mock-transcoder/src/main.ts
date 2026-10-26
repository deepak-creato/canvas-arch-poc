import http from 'http';
import { createPool } from '../../shared/db';
import { log } from '../../shared/log';
import { createS3 } from '../../shared/s3';
import { createSfn } from '../../shared/sfn';
import { createSqs } from '../../shared/sqs';
import { Consumer } from './consumer';
import { mockState } from './handler';

const pool = createPool();
const consumer = new Consumer(pool, createS3(), createSfn(), createSqs());

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, { status: 'ok', service: 'mock-transcoder' });
    // Mock job status for an asset: QUEUED | RUNNING | COMPLETE | ERROR
    if (url.pathname === '/jobs') {
      const assetId = url.searchParams.get('asset_id') ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(assetId)) return send(res, 400, { error: 'ASSET_ID_REQUIRED' });
      try {
        const j = (
          await pool.query(
            `SELECT status, attempts, last_error FROM processing_job WHERE asset_id = $1 AND job_type = 'final-transcode'`,
            [assetId],
          )
        ).rows[0];
        if (!j) return send(res, 404, { error: 'JOB_NOT_FOUND' });
        return send(res, 200, { asset_id: assetId, state: mockState(j.status), attempts: j.attempts, error: j.last_error });
      } catch (e) {
        log('error', 'job lookup failed', { asset_id: assetId, error: String(e) });
        return send(res, 500, { error: 'INTERNAL' });
      }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  })
  .listen(Number(process.env.PORT ?? 3103), '0.0.0.0');

consumer.start();

async function shutdown() {
  log('info', 'shutting down');
  server.close();
  await consumer.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
