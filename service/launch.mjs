import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const flag = args.indexOf('--config');
if (flag >= 0 && !args[flag + 1]) throw new Error('--config 缺少路径');
let config = {};
try { config = JSON.parse(await readFile(resolve(root, flag < 0 ? 'service.config.json' : args[flag + 1]), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = config.port || 17865, url = 'http://127.0.0.1:' + port, dataDir = resolve(root, config.dataDir || 'localdata');
const healthy = async () => {
  try { const response = await fetch(url + '/status', { signal: AbortSignal.timeout(1000) }); const body = await response.json(); return response.ok && typeof body.version === 'string' && body.version.endsWith('-service'); }
  catch { return false; }
};
function openPage() {
  if (args.includes('--no-open')) return;
  const child = process.platform === 'win32' ? spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}
if (await healthy()) { openPage(); console.log('服务已在运行：' + url); process.exit(0); }
await mkdir(dataDir, { recursive: true });
const lock = resolve(dataDir, 'launch.lock'); let locked = false;
try {
  try { await mkdir(lock); locked = true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() - (await stat(lock)).mtimeMs > 120000) { await rm(lock, { recursive: true }); await mkdir(lock); locked = true; }
    else {
      for (let i = 0; i < 60; i++) { if (await healthy()) { openPage(); console.log('服务已在运行：' + url); process.exit(0); } await delay(500); }
      throw new Error('服务正在启动；稍后再次双击即可。');
    }
  }
  try { await import('playwright-core'); }
  catch {
    console.log('首次使用，正在自动安装运行依赖…');
    const install = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', 'npm ci --omit=dev --no-audit --no-fund'], { cwd: root, windowsHide: true, stdio: 'inherit' })
      : spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    if (install.status !== 0) throw new Error('依赖安装失败，请检查网络后重新打开。');
  }
  const log = openSync(resolve(dataDir, 'service.log'), 'a');
  const childArgs = [resolve(root, 'service/main.mjs'), '--auto', ...(flag >= 0 ? ['--config', resolve(root, args[flag + 1])] : []), ...(args.includes('--monitor-only') ? ['--monitor-only'] : [])];
  let child;
  try { child = spawn(process.execPath, childArgs, { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] }); }
  finally { closeSync(log); }
  let spawnError; child.on('error', error => { spawnError = error; }); child.unref();
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    if (await healthy()) { openPage(); console.log('自动同步已打开：' + url); process.exitCode = 0; break; }
    if (child.exitCode != null) throw new Error('服务未能启动，详情见 localdata/service.log。');
    await delay(500);
  }
  if (!await healthy()) throw new Error('启动超时，详情见 localdata/service.log。');
} finally { if (locked) await rm(lock, { recursive: true }).catch(() => {}); }
