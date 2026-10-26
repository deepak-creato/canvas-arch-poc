import http from 'http';
import { createPool } from '../../shared/db';
import { log } from '../../shared/log';
import { createS3 } from '../../shared/s3';
import { createSqs } from '../../shared/sqs';
import { Consumer } from './consumer';

const pool = createPool();
const consumer = new Consumer(pool, createS3(), createSqs());

const server = http
  .createServer((req, res) => {
    const ok = req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'ok', service: 'light-worker' } : { error: 'NOT_FOUND' }));
  })
  .listen(Number(process.env.PORT ?? 3101), '0.0.0.0');

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
