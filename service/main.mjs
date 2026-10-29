import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.mjs';
import { Source } from './source.mjs';
import { selectedDates } from './runner.mjs';
import { archiveCsv, dailyCsv } from './exports.mjs';
import { Runtime } from './runtime.mjs';
import { createControlServer } from './control.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), flag = args.indexOf('--config');
if (flag >= 0 && !args[flag + 1]) throw new Error('--config 缺少路径');
const configFile = resolve(root, flag < 0 ? 'service.config.json' : args[flag + 1]);
let config = {};
try { config = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
config = { intervalSeconds: 600, lookbackDays: 2, includeToday: true, channel: 'msedge', port: 17865, ...config };
if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 60 || config.intervalSeconds > 86400) throw new Error('intervalSeconds 必须为 60–86400');
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('port 必须为 1024–65535');
selectedDates(config);
const dataDir = resolve(root, config.dataDir || 'localdata'); await mkdir(dataDir, { recursive: true });
const source = new Source({ profileDir: resolve(dataDir, 'browser'), channel: config.channel });
if (args.includes('--login')) {
  try {
    await source.open({ login: true });
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { await input.question('登录平台后按回车（也可直接使用“打开自动同步”，无需命令行）：'); } finally { input.close(); }
  } finally { await source.close(); }
  process.exit(0);
}
const store = new Store(resolve(dataDir, 'collector.sqlite'));
if (args.includes('--export')) {
  const directory = resolve(dataDir, 'exports'); await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(resolve(directory, '每日接入包-' + stamp + '.json'), JSON.stringify(store.export(), null, 2));
  await writeFile(resolve(directory, 'ERP主播档案-' + stamp + '.csv'), archiveCsv(store.profiles()));
  await writeFile(resolve(directory, '每日明细-' + stamp + '.csv'), dailyCsv(store.records()));
  console.log('已导出到 ' + directory); store.close(); process.exit(0);
}
let saved = {};
try { saved = JSON.parse(await readFile(resolve(dataDir, 'erp-sync.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtime = new Runtime({ store, source, config, dataDir, saved });
const server = createControlServer(runtime, { port: config.port, readOnly: args.includes('--monitor-only'), onStop: () => { void stop(); } });
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  server.close(); server.closeIdleConnections(); await runtime.close(); store.close();
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); }); }
catch (error) { await stop(); console.error(error.code === 'EADDRINUSE' ? '服务已在运行，请打开 http://127.0.0.1:' + config.port : error.message); process.exit(1); }
server.on('error', error => { console.error(error.message); void stop(); process.exitCode = 1; });
console.log('本机状态页：http://127.0.0.1:' + config.port + ' ；按 Ctrl+C 停止。');
if (args.includes('--once')) { await runtime.collect(); await stop(); if (runtime.lastError) process.exitCode = 1; }
else if (args.includes('--monitor-only')) console.log('只读状态模式：不启动浏览器、不请求平台或 ERP。');
else {
  let hasProfile = true; try { await access(resolve(dataDir, 'browser', 'Default')); } catch { hasProfile = false; }
  if (args.includes('--auto') && !hasProfile) { await runtime.login(); void runtime.deliver(); }
  else runtime.start();
}
