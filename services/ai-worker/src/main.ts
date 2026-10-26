import http from 'http';
import { log } from '../../shared/log';

const server = http
  .createServer((req, res) => {
    const ok = req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'ok', service: 'ai-worker' } : { error: 'NOT_FOUND' }));
  })
  .listen(Number(process.env.PORT ?? 3102), '0.0.0.0');

async function shutdown() {
  log('info', 'shutting down');
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
