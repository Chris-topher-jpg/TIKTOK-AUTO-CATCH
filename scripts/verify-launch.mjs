import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'tac-launch-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const config = join(directory, 'config.json'); await writeFile(config, JSON.stringify({ dataDir: directory, port }));
const launch = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../service/launch.mjs', import.meta.url)), '--config', config, '--monitor-only', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', text => { out += text; }); child.stderr.on('data', text => { out += text; });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(out)));
});
let pid;
try {
  const outputs = await Promise.all([launch(), launch()]);
  const get = async () => (await fetch('http://127.0.0.1:' + port + '/status')).json();
  const first = await get(); pid = first.pid;
  assert.equal(first.version, '0.3.1-service'); assert.equal(first.collecting, false); assert.equal(first.sync.enabled, false); assert.equal(first.profiles, 0);
  assert.equal(first.config.intervalSeconds, 600); assert.ok(pid && pid !== process.pid);
  await launch(); const second = await get(); assert.equal(second.pid, pid);
  assert.ok(outputs.every(value => value.includes('http://127.0.0.1:')));
  console.log('PASS concurrent and repeated launch reuse one detached service; launcher exits while service stays alive; 600-second default, zero platform/ERP requests in isolated monitor test.');
} finally {
  if (pid) { process.kill(pid); }
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
