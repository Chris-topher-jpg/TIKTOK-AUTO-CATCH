import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../service/store.mjs';
const dir = await mkdtemp(join(tmpdir(), 'tac-bench-'));
const store = new Store(join(dir, 'data.sqlite'));
const timer = monitorEventLoopDelay({ resolution: 10 }); timer.enable();
const rows = Array.from({ length: 450 }, (_, i) => ({ anchorId: String(7601032374063105000n + BigInt(i)), date: '2026-10-26', douyinId: 'bench_' + i, nickname: '离线压测', followers: i, waves: i * 10, liveSeconds: 3600, acu: 100 }));
try {
  const durations = [], started = performance.now();
  for (let i = 0; i < rows.length; i += 10) { const start = performance.now(); store.save(rows.slice(i, i + 10)); durations.push(performance.now() - start); await setImmediate(); }
  const firstMs = performance.now() - started, again = performance.now(); let changed = 0;
  for (let i = 0; i < rows.length; i += 10) { changed += store.save(rows.slice(i, i + 10)); await setImmediate(); }
  durations.sort((a,b) => a-b);
  console.log(JSON.stringify({ scope: '仅本机独立采集库；不是 ERP 线上性能结果', rows: rows.length, batch: 10, firstPassMs: +firstMs.toFixed(2), unchangedPassMs: +(performance.now() - again).toFixed(2), unchangedAddedRevisions: changed, writeBatchP95Ms: +durations[Math.floor(durations.length * 0.95)].toFixed(2), writeBatchMaxMs: +Math.max(...durations).toFixed(2), eventLoopP95Ms: +(timer.percentile(95) / 1e6).toFixed(2), state: store.status() }, null, 2));
} finally { timer.disable(); store.close(); await rm(dir, { recursive: true, force: true }); }
