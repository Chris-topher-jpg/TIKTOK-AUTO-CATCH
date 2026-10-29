import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { archiveCsv, dailyCsv } from './exports.mjs';
import { rangeDates } from './runner.mjs';
const templates = await Promise.all(['panel.html', 'panel.js', 'panel.css'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));

export function createControlServer(runtime, { port = 17865, readOnly = false, onStop } = {}) {
  const actionKey = randomBytes(32).toString('hex');
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const requestPort = port || req.socket.localPort;
    if (![ `127.0.0.1:${requestPort}`, `localhost:${requestPort}` ].includes(req.headers.host)) return json(res, 403, { error: '请通过本机地址打开' });
    const url = new URL(req.url, 'http://' + req.headers.host), route = url.pathname;
    try {
      if (req.method === 'POST') {
        const supplied = req.headers['x-tac-action'];
        const validKey = typeof supplied === 'string' && Buffer.byteLength(supplied) === actionKey.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(actionKey));
        if (readOnly) return json(res, 405, { error: '当前为只读模式' });
        if (req.headers.origin !== 'http://' + req.headers.host || !validKey || req.headers['content-type'] !== 'application/json') return json(res, 403, { error: '请从本机控制页面操作' });
        if (!['/api/connect', '/api/platform-login', '/api/collection', ...(onStop ? ['/api/stop'] : [])].includes(route)) return json(res, 404, { error: '操作不存在' });
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length; if (size > 8192) return json(res, 413, { error: '输入过长' });
          chunks.push(chunk);
        }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: '输入格式无效' }); }
        if (route === '/api/platform-login') { await runtime.login(); return json(res, 200, { ok: true }); }
        if (route === '/api/collection') return json(res, 200, runtime.selectCollection(body));
        if (route === '/api/stop') { json(res, 200, { ok: true }); setImmediate(onStop); return; }
        return json(res, 200, await runtime.connection.connect(body));
      }
      if (req.method !== 'GET') return json(res, 405, { error: '操作不支持' });
      if (route === '/status') return json(res, 200, runtime.status());
      if (route.startsWith('/exports/')) {
        let range;
        if (url.searchParams.has('start') || url.searchParams.has('end')) {
          range = { start: url.searchParams.get('start'), end: url.searchParams.get('end') };
          rangeDates(range.start, range.end);
        }
        if (route === '/exports/unmatched.json') {
          let rows;
          try { rows = JSON.parse(await readFile(resolve(runtime.connection.dataDir, 'ERP待核对主播.json'), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: '连接 ERP 后生成待核对名单' }); throw error; }
          const report = rows.map(({ anchorId, douyinId, nickname, reason }) => ({ anchorId, douyinId, nickname, reason }));
          res.setHeader('Content-Disposition', 'attachment; filename=unmatched.json');
          return json(res, 200, report);
        }
        const contents = { '/exports/daily.json': () => JSON.stringify(runtime.store.export(range), null, 2),
          '/exports/profiles.csv': () => archiveCsv(runtime.store.profiles()), '/exports/daily.csv': () => dailyCsv(runtime.store.records(range)) };
        if (!contents[route]) return json(res, 404, { error: '文件不存在' });
        res.setHeader('Content-Type', route.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=' + route.split('/').at(-1)); res.end(contents[route]()); return;
      }
      const index = ['/', '/panel.js', '/panel.css'].indexOf(route);
      if (index < 0) return json(res, 404, { error: '页面不存在' });
      res.setHeader('Content-Type', ['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8'][index]);
      res.end(index === 0 ? templates[0].replace('__ACTION_KEY__', actionKey) : templates[index]);
    } catch (error) { json(res, 400, { error: error.message || '操作失败，请重试' }); }
  });
}
