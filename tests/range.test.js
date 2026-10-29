import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../service/store.mjs';
import { Runtime } from '../service/runtime.mjs';
import { rangeDates, validateSelection } from '../service/runner.mjs';
import { matchProfiles } from '../service/erp-connection.mjs';
import { createControlServer } from '../service/control.mjs';

const today = globalThis.AnchorCore.shanghaiToday();
const offset = n => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const profile = { anchorId: '7601032374063105082', douyinId: 'range-test', nickname: '某某某（三角洲行动）', followers: 100 };
const row = { ...profile, waves: 123, liveSeconds: 3600, acu: 12.5 };
async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'tac-range-')), path = join(dir, 'collector.sqlite'), store = new Store(path);
  const calls = [];
  source ||= { async open() {}, async close() {}, async collect(kind, date, receive) {
    calls.push({ kind, date });
    await receive([kind === 'profiles' ? profile : { ...row, date }], { scanned: 1, total: 1, identified: 1 });
  } };
  const runtime = new Runtime({ store, source, config: { intervalSeconds: 600, lookbackDays: 2, includeToday: true }, dataDir: dir });
  t.after(async () => { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
  return { runtime, store, source, calls, path, dir };
}
test('nickname and game suffix differences do not prevent an exact UID/account binding', () => {
  const archive = { id: 'erp-range', unionAnchorId: profile.anchorId, douyinId: profile.douyinId, name: '某某某（三角洲测评）', dept: '运营' };
  const before = JSON.stringify(archive);
  assert.equal(matchProfiles([profile], [archive]).plan.length, 1);
  assert.equal(matchProfiles([profile], [{ ...archive, unionAnchorId: '' }]).plan.length, 1);
  assert.equal(JSON.stringify(archive), before);
  assert.equal(matchProfiles([profile], [{ ...archive, douyinId: 'another-account' }]).plan.length, 0);
  assert.equal(matchProfiles([profile], [{ ...archive, unionAnchorId: '7601032374063105000' }]).plan.length, 0);
});
test('inclusive ranges support a single day, today, leap days and 31 days, and reject unsafe dates', () => {
  assert.deepEqual(rangeDates(today, today), [today]);
  assert.deepEqual(rangeDates('2024-02-28', '2024-03-01', '2024-03-02'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(rangeDates(offset(-30), today).length, 31);
  for (const [start, end] of [[offset(-31), today], [today, offset(1)], [today, offset(-1)], ['2026-02-30', '2026-03-01'], [null, today]]) assert.throws(() => rangeDates(start, end));
  assert.deepEqual(validateSelection({ mode: 'auto', token: 'ignored' }), { mode: 'auto' });
});
test('custom single/multi-day collection persists seven fields and forces a manual same-range refresh', async t => {
  const { runtime, store, calls, path } = await fixture(t);
  const selection = { mode: 'custom', start: offset(-2), end: offset(-1) };
  runtime.selectCollection(selection); await runtime.collectTask;
  assert.deepEqual(calls.filter(c => c.kind === 'daily').map(c => c.date), [offset(-2), offset(-1)]);
  assert.deepEqual(store.records().map(r => [r.date, r.acu, r.waves, r.liveSeconds]), [[offset(-2), 12.5, 123, 3600], [offset(-1), 12.5, 123, 3600]]);
  const before = calls.length;
  runtime.selectCollection(selection); await runtime.collectTask;
  assert.equal(calls.length - before, 3); // Manual action bypasses six-hour history cache.
  const reopened = new Store(path);
  try { assert.deepEqual(reopened.collectionSelection(), selection); } finally { reopened.close(); }
  const restored = new Runtime({ store, source: runtime.source, config: runtime.config, dataDir: runtime.connection.dataDir });
  assert.equal(restored.status().collection.mode, 'custom'); assert.equal(restored.status().collection.start, selection.start); await restored.close();
  runtime.selectCollection({ mode: 'custom', start: today, end: today }); await runtime.collectTask;
  assert.equal(calls.at(-1).date, today);
  const snapshot = store.records({ start: today, end: today })[0];
  assert.equal(snapshot.provisional, true); assert.equal(snapshot.snapshotReady, true); assert.equal(snapshot.ready, false);
  assert.equal(store.records().length, 3); // Date changes retain prior daily history.
  assert.equal(runtime.status().collection.data.missingAcu, 0);
});
test('date changes queue behind the active run without overlap and the newest requested range wins', async t => {
  let release, opens = 0, active = 0, maximum = 0;
  const dates = [];
  const source = { async open() { opens++; maximum = Math.max(maximum, ++active); if (opens === 1) await new Promise(resolve => { release = resolve; }); },
    async close() { active = 0; }, async collect(kind, date, receive) { if (kind === 'daily') dates.push(date); await receive([kind === 'profiles' ? profile : { ...row, date }]); } };
  const { runtime, store } = await fixture(t, source);
  runtime.selectCollection({ mode: 'custom', start: offset(-3), end: offset(-3) }); const first = runtime.collectTask;
  assert.equal(runtime.selectCollection({ mode: 'custom', start: offset(-2), end: offset(-2) }).pending, true);
  runtime.selectCollection({ mode: 'custom', start: offset(-1), end: offset(-1) });
  assert.equal(runtime.status().collection.pending, true); assert.equal(opens, 1);
  release(); await first;
  for (let i = 0; i < 100 && opens < 2; i++) await delay(5);
  await runtime.collectTask;
  assert.equal(maximum, 1); assert.equal(opens, 2);
  assert.deepEqual(dates, [offset(-3), offset(-1)]);
  assert.equal(store.records().length, 2);
  const saved = store.collectionSelection();
  assert.throws(() => runtime.selectCollection({ mode: 'custom', start: today, end: offset(1) }), /未来/);
  assert.deepEqual(store.collectionSelection(), saved);
});
test('range HTTP mutation requires the local action key; exports and missing metrics follow the requested range', async t => {
  const { runtime, store } = await fixture(t);
  const server = createControlServer(runtime, { port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const html = await (await fetch(base)).text(), key = html.match(/name="tac-action" content="([a-f0-9]+)"/)[1];
  const selection = { mode: 'custom', start: offset(-1), end: offset(-1) };
  const post = headers => fetch(base + '/api/collection', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(selection) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: base, 'X-Tac-Action': key })).status, 200); await runtime.collectTask;
  store.save([{ ...row, date: offset(-2), acu: null, missing: ['acu'] }]);
  const query = `?start=${offset(-1)}&end=${offset(-1)}`;
  const report = await (await fetch(base + '/exports/daily.json' + query)).json();
  assert.deepEqual(report.readyRecords.map(r => r.date), [offset(-1)]); assert.equal(report.reviewRecords.length, 0);
  const csv = await (await fetch(base + '/exports/daily.csv' + query)).text();
  assert.match(csv, /ACU/); assert.match(csv, /12\.5/); assert.ok(!csv.includes(offset(-2)));
  assert.equal((await fetch(base + '/exports/daily.json?start=' + today)).status, 400);
  const summary = store.collectionSummary({ start: offset(-2), end: offset(-2) });
  assert.equal(summary.missingAcu, 1); assert.equal(summary.missingWaves, 0); assert.equal(summary.review, 1);
});
