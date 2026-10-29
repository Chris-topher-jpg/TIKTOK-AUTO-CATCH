import http from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Set(['dashboard.html', 'dashboard.css', 'dashboard-state.css', 'core.js', 'dashboard.js']);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'dashboard.html';
  if (!files.has(name)) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(new URL(`../extension/${name}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)], 'Cache-Control': 'no-store' }).end(bytes);
  } catch { res.writeHead(500).end(); }
}).listen(9876, '127.0.0.1', () => console.log('Preview only: http://127.0.0.1:9876/dashboard.html?preview'));
