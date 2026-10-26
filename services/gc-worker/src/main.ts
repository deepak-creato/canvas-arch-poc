import http from 'http';
import { config } from '../../shared/config';
import { createPool } from '../../shared/db';
import { log } from '../../shared/log';
import { inspectDlq, redriveDlq } from './dlq';
import { listProblemJobs } from './jobs';
import { defaultOptions } from './options';
import { runCycle } from './run';
import { createSqs } from '../../shared/sqs';

const pool = createPool();
const sqs = createSqs();

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const cycle = (only?: string) =>
  runCycle(pool, defaultOptions(), only).catch((e) => {
    log('error', 'gc cycle failed', { error: String(e) });
    return null;
  });

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, { status: 'ok', service: 'gc-worker' });
    if (url.pathname === '/run' && req.method === 'POST') {
      try {
        const out = await runCycle(pool, defaultOptions(), url.searchParams.get('step') ?? undefined);
        return out ? send(res, 200, out) : send(res, 409, { error: 'GC_ALREADY_RUNNING' });
      } catch (e) {
        return send(res, 400, { error: String(e) });
      }
    }
    try {
      // Operator endpoints (POC-035): diagnose, then recover.
      if (url.pathname === '/ops/jobs' && req.method === 'GET') {
        return send(res, 200, { jobs: await listProblemJobs(pool, { ...defaultOptions(), ownerId: url.searchParams.get('owner_id') ?? undefined }) });
      }
      if (url.pathname === '/ops/dlq' && req.method === 'GET') return send(res, 200, await inspectDlq(pool, sqs, { ownerId: url.searchParams.get('owner_id') ?? undefined }));
      if (url.pathname === '/ops/redrive' && req.method === 'POST') return send(res, 200, await redriveDlq(pool, sqs, { ownerId: url.searchParams.get('owner_id') ?? undefined }));
    } catch (e) {
      log('error', 'ops request failed', { path: url.pathname, error: String(e) });
      return send(res, 500, { error: 'INTERNAL' });
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  })
  .listen(Number(process.env.PORT ?? 3104), '0.0.0.0');

let timer: NodeJS.Timeout | undefined;
if (config.gcIntervalSeconds > 0) {
  log('info', 'gc schedule on', { interval_seconds: config.gcIntervalSeconds });
  timer = setInterval(() => void cycle(), config.gcIntervalSeconds * 1000);
} else {
  log('info', 'gc schedule off, run with POST /run');
}

async function shutdown() {
  log('info', 'shutting down');
  if (timer) clearInterval(timer);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
