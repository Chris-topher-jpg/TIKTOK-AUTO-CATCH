import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, normalizeRecord, batchKey, PROTOCOL, SNAPSHOT_PROTOCOL } from '../service/store.mjs';
import { deliverOnce } from '../service/delivery.mjs';
import { archiveCsv } from '../service/exports.mjs';
import { runCycle, selectedDates } from '../service/runner.mjs';
const record = { anchorId: '7601032374063105082', douyinId: 'dy_123', nickname: '样本', date: '2026-10-26', followers: 10, waves: 0, liveSeconds: 0, acu: 0, approximate: [], missing: [] };
const delivery = { approved: true, endpoint: 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily', token: 'test-token-for-local-unit-tests-only' };

test('queue counts separate authorized retries, unbound rows and expired snapshots without dropping data', () => {
  const store = new Store(':memory:'), at = Date.parse('2026-10-28T02:00:00Z');
  try {
    store.save([record, { ...record, anchorId: '7601032374063105083' },
      { ...record, date: '2026-10-28', provisional: true },
      { ...record, date: '2026-10-27', provisional: true }]);
    const ids = [record.anchorId];
    store.fail(store.pending(at, 50, ids), 'temporary ERP outage', at);
    assert.equal(store.pending(at, 50, ids).length, 0);
    assert.deepEqual({ ...store.queueStatus({ at, anchorIds: ids, enabled: true }) },
      { total: 4, pending: 2, unbound: 1, paused: 0, archived: 1, retrying: 1 });
    assert.deepEqual({ ...store.queueStatus({ at, anchorIds: ids }) },
      { total: 4, pending: 0, unbound: 1, paused: 2, archived: 1, retrying: 0 });
    assert.equal(store.queueStatus({ at, anchorIds: [], enabled: true }).unbound, 3);
    assert.equal(store.queueStatus({ at, enabled: true }).pending, 3);
    assert.equal(store.status().queued, 4);
  } finally { store.close(); }
});

test('complete current snapshots have their own protocol, refresh unchanged values and expire from queue after midnight', async () => {
  const store = new Store(':memory:');
  const today = globalThis.AnchorCore.shanghaiToday(), row = {...record,date:today,provisional:true,capturedAt:new Date().toISOString()};
  try {
    store.save([record,row]); assert.equal(store.pending().length,1); assert.equal(store.pending(Date.now(),50,undefined,true).length,1);
    assert.equal(store.status().snapshots,1); assert.equal(store.status().needsReview,0);
    assert.equal(store.export().snapshotRecords.length,1); assert.equal(store.export().reviewRecords.length,0);
    const fetcher = async (_url, options) => {
      const body=JSON.parse(options.body); assert.equal(body.protocol,SNAPSHOT_PROTOCOL); assert.equal(body.records[0].ready,false);
      return {ok:true,json:async()=>({protocol:body.protocol,accepted:body.records.length,unmatched:[]})};
    };
    assert.equal((await deliverOnce(store,{...delivery,fetcher})).count,1);
    assert.equal(store.pending().length,1); assert.equal(store.pending(Date.now(),50,undefined,true).length,0);
    store.save([{...row,capturedAt:new Date(Date.parse(row.capturedAt)+1000).toISOString()}]);
    assert.equal(store.pending(Date.now(),50,undefined,true).length,1);
    store.save([{...row,waves:null,missing:['waves']}]);
    assert.equal(store.pending(Date.now(),50,undefined,true).length,0);
    assert.equal(store.status().needsReview,1); assert.equal(store.export().reviewRecords.length,1);
    store.save([row]); store.expireSnapshots('2099-01-01');
    assert.equal(store.pending().length,1); assert.equal(store.records().length,2);
  } finally {store.close();}
});

test('today collection precedes historical refresh, with six-hour checkpoint and historical failures retried', async () => {
  const store=new Store(':memory:'), calls=[];
  let fail=false;
  const source={async collect(kind,date,callback){calls.push([kind,date]);if(fail&&kind==='daily'&&date===record.date)throw Error('retry history');callback([{...record,date:date||record.date}]);}};
  const config={includeToday:true,start:record.date,end:record.date};
  try {
    await runCycle(store,source,config);
    assert.deepEqual(calls.map(x=>x[1]),[null,globalThis.AnchorCore.shanghaiToday(),record.date]);
    calls.length=0;await runCycle(store,source,config);assert.equal(calls.length,2);
    store.db.prepare("UPDATE state SET body=? WHERE key='historyCheckpoint'").run(JSON.stringify({dates:[record.date],completedAt:'2020-01-01T00:00:00Z'}));
    fail=true;await assert.rejects(runCycle(store,source,config),/retry history/);
    assert.equal(store.historyCheckpoint().completedAt,'2020-01-01T00:00:00Z');
    fail=false;calls.length=0;await runCycle(store,source,config);assert.equal(calls.length,3);
  } finally {store.close();}
});

test('persistent queue deduplicates unchanged data but retains revisions and long IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tac-store-'));
  const path = join(dir, 'data.sqlite'); let store = new Store(path);
  try {
    assert.equal(store.save([record]), 1);
    assert.equal(store.save([{ ...record, capturedAt: new Date().toISOString() }]), 0);
    assert.equal(store.status().queued, 1); assert.equal(store.status().revisions, 1);
    store.close(); store = new Store(path);
    assert.equal(store.records()[0].anchorId, record.anchorId);
    assert.equal(store.records()[0].waves, 0);
    assert.equal(store.save([{ ...record, waves: 5 }]), 1);
    assert.equal(store.status().records, 1); assert.equal(store.status().revisions, 2);
    assert.equal(store.pending().length, 1); assert.equal(JSON.parse(store.pending()[0].body).waves, 5);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('missing and approximate observations are kept for review and never sent as zero', () => {
  const store = new Store(':memory:');
  try {
    store.save([record]);
    store.save([{ ...record, waves: null, missing: ['waves'] }]);
    assert.equal(store.pending().length, 0); assert.equal(store.records()[0].waves, null);
    assert.equal(store.export().reviewRecords.length, 1);
    store.save([{ ...record, followersApproximate: true }]);
    assert.equal(store.pending().length, 0);
    store.save([{ ...record, provisional: true }]);
    assert.equal(store.pending().length, 0); assert.equal(store.records()[0].provisional, true);
    assert.throws(() => normalizeRecord({ ...record, anchorId: Number(record.anchorId) }), /字符串/);
    assert.throws(() => normalizeRecord({ ...record, acu: '0' }), /数值/);
    assert.throws(() => normalizeRecord({ ...record, date: '2026-02-30' }), /日期/);
  } finally { store.close(); }
});

test('an acknowledgement cannot delete a newer observation queued during delivery', () => {
  const store = new Store(':memory:');
  try {
    store.save([record]); const oldBatch = store.pending();
    store.save([{ ...record, waves: 30 }]);
    store.delivered(oldBatch, batchKey(oldBatch));
    assert.equal(store.pending().length, 1); assert.equal(JSON.parse(store.pending()[0].body).waves, 30);
  } finally { store.close(); }
});

test('a later observation returning to old values gets a new batch key while retries retain theirs', () => {
  const store = new Store(':memory:');
  try {
    store.save([{ ...record, capturedAt: '2026-10-27T00:00:00Z' }]);
    const first = store.pending(), firstKey = batchKey(first); store.delivered(first, firstKey);
    store.save([{ ...record, waves: 50, capturedAt: '2026-10-27T00:01:00Z' }]);
    store.save([{ ...record, capturedAt: '2026-10-27T00:02:00Z' }]);
    assert.notEqual(batchKey(store.pending()), firstKey);
    const batch = store.pending(), key = batchKey(batch); store.fail(batch, 'offline');
    assert.equal(batchKey(store.pending(Date.now() + 60000)), key);
  } finally { store.close(); }
});

test('ERP sends nothing until approved and retries without dropping queued rows', async () => {
  const store = new Store(':memory:'); let calls = 0;
  try {
    store.save([record]);
    const disabled = await deliverOnce(store, { fetcher: () => { calls++; } });
    assert.equal(disabled.status, 'disabled'); assert.equal(calls, 0);
    const original = store.pending()[0];
    const result = await deliverOnce(store, { ...delivery, fetcher: async () => { throw new Error('offline'); } });
    assert.equal(result.status, 'retry'); assert.equal(store.status().queued, 1);
    assert.equal(store.pending().length, 0); // Exponential retry deadline, no busy loop.
    const retried = store.pending(Date.now() + 60000)[0];
    assert.equal(retried.attempts, 1); assert.equal(retried.body, original.body);
    assert.equal(batchKey([retried]), batchKey([original]));
    assert.throws(() => normalizeRecord({ ...record, liveSeconds: 0.3 }), /整数/);
  } finally { store.close(); }
});

test('delivery caps batches at fifty and requires full acknowledgement', async () => {
  const store = new Store(':memory:');
  try {
    store.save(Array.from({ length: 110 }, (_, i) => ({ ...record, anchorId: String(1234500000 + i) })));
    const result = await deliverOnce(store, { ...delivery, fetcher: async (_url, options) => {
      const data = JSON.parse(options.body); assert.equal(data.records.length, 50);
      assert.equal(options.redirect, 'error'); assert.ok(options.headers['Idempotency-Key']);
      return { ok: true, json: async () => ({ protocol: PROTOCOL, accepted: 50, unmatched: [] }) };
    } });
    assert.equal(result.count, 50); assert.equal(store.status().queued, 60);
    const partial = await deliverOnce(store, { ...delivery, fetcher: async () => ({ ok: true, json: async () => ({ protocol: PROTOCOL, accepted: 49, unmatched: ['unknown'] }) }) });
    assert.equal(partial.status, 'retry'); assert.equal(store.status().queued, 60);
  } finally { store.close(); }
});

test('unsupported same-day data is explicit while completed historical rows remain', async () => {
  const store = new Store(':memory:'); const called = [];
  const source = { async collect(kind, date, callback) {
    called.push([kind, date]);
    if (kind === 'profiles') return callback([{ ...record, capturedAt: '2026-10-27T00:00:00Z' }]);
    if (date !== record.date) throw new Error('平台不允许选择该日期');
    return callback([record]);
  } };
  try {
    const result = await runCycle(store, source, { start: record.date, end: record.date, includeToday: true });
    assert.equal(result.today, 'unavailable'); assert.equal(store.status().lastRun.status, 'partial');
    assert.equal(store.records().length, 1); assert.equal(store.status().queued, 1);
    assert.equal(store.profiles().length, 1); assert.equal(called.length, 3);
    assert.deepEqual(selectedDates({ lookbackDays: 2 }, '2026-10-27'), ['2026-10-25', '2026-10-26']);
  } finally { store.close(); }
});

test('profile scan counts platform rows, identifies safe UIDs, and records explicitly deleted accounts', async () => {
  const store = new Store(':memory:');
  const scan = { kind: 'profiles', scanned: 428, total: 428, identified: 426, duplicates: 1, unidentified: 1,
    unidentifiedSample: [{ platformRow: 213, row: 3, nickname: '账号已注销', reason: '账号已注销，平台未提供 UID' }] };
  const source = { async collect(kind, _date, callback) {
    if (kind === 'profiles') { callback([record], scan); return 1; }
    callback([], undefined); return 0;
  } };
  try {
    const result = await runCycle(store, source, { includeToday: false, start: record.date, end: record.date });
    assert.equal(result.platformRows, 428); assert.equal(result.profiles, 1); assert.equal(result.unidentified, 1);
    assert.deepEqual(store.profileScan(), { count: 1, platformTotal: 428, scanned: 428, identified: 426, unidentified: 1, duplicates: 1,
      unidentifiedSample: scan.unidentifiedSample, completedAt: store.profileScan().completedAt });
    assert.equal(store.profileProgress(), null);
  } finally { store.close(); }
});

test('archive export matches current ERP headings without inventing rounded followers', () => {
  const csv = archiveCsv([{ ...record, nickname: '=1+1', followersApproximate: true, followersRaw: '1.2万' }]);
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /主播ID/); assert.match(csv, /主播昵称/);
  assert.match(csv, /'=1\+1/); assert.match(csv, /近似，未导入数值/);
  assert.ok(csv.includes(record.anchorId)); assert.ok(!csv.includes('"10"'));
});
