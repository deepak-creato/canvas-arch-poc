// Placeholder service: answers /healthz until the real service replaces it.
const http = require('http');

const name = process.env.SERVICE_NAME || 'stub';
const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: name }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_IMPLEMENTED', service: name }));
  })
  .listen(port, '0.0.0.0', () => console.log(`${name} stub listening on ${port}`));

process.on('SIGTERM', () => process.exit(0));
