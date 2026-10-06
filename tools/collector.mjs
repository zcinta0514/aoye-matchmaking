// Local in-page data sink: browser page POSTs JSON here, we write it to disk.
// Avoids piping large blobs through the agent's context.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.argv[2] || new URL('../data', import.meta.url).pathname;
const PORT = Number(process.argv[3] || 8799);

mkdirSync(ROOT, { recursive: true });

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === 'GET') {
    const rel = decodeURIComponent((req.url || '/').replace(/^\/+/, '').split('?')[0]) || 'index.json';
    const src = join(ROOT, rel);
    if (!existsSync(src)) {
      res.writeHead(404, cors);
      return res.end('not found');
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(readFileSync(src));
  }
  if (req.method !== 'POST') {
    res.writeHead(405, cors);
    return res.end('POST only');
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const name = decodeURIComponent((req.url || '/').replace(/^\/+/, '')) || 'out.json';
      const dest = join(ROOT, name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
      console.log(`[collector] wrote ${body.length} bytes -> ${dest}`);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: body.length, path: dest }));
    } catch (e) {
      console.error('[collector] error', e);
      res.writeHead(500, cors);
      res.end(String(e));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector] listening on http://127.0.0.1:${PORT}/  root=${ROOT}`);
});
