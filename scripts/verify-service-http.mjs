import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'tac-http-'));
const config = join(directory, 'config.json');
await writeFile(config, JSON.stringify({ port: 17866, dataDir: directory }));
const child = spawn(process.execPath, [fileURLToPath(new URL('../service/main.mjs', import.meta.url)), '--config', config, '--monitor-only'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const exited = once(child, 'exit');
try {
  await Promise.race([
    new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (output.includes('只读状态模式')) return resolve(); if (child.exitCode != null || Date.now() - started > 10000) return reject(new Error(output)); setTimeout(check, 50); }; check(); }),
    exited.then(() => { throw new Error('后台服务提前退出：' + output); })
  ]);
  const origin = 'http://127.0.0.1:17866';
  const result = await fetch(origin + '/status'); assert.equal(result.status, 200);
  const status = await result.json(); assert.equal(status.collecting, false); assert.equal(status.records, 0);
  assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  const bundle = await (await fetch(origin + '/exports/daily.json')).json();
  assert.equal(bundle.protocol, 'douyin-anchor-daily/v1'); assert.equal(bundle.readyRecords.length, 0);
  const csv = await (await fetch(origin + '/exports/profiles.csv')).text(); assert.match(csv, /主播ID/);
  assert.match(await (await fetch(origin)).text(), /主播自动同步/);
  console.log('本机服务验证通过：启动、状态、只读导出与拒绝写入；未启动采集或请求 ERP。');
} finally { child.kill(); await exited; await rm(directory, { recursive: true, force: true }); }
