import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Source, ReportTracker } from '../service/source.mjs';

test('report tracker keeps intermediate date requests pending and exposes no signing parameters', () => {
  const tracker = new ReportTracker();
  const request = (begin, end, page = 1) => ({ url: () => `https://union.bytedance.com/ark/api/data/pugna_component/data/v2/union/data_center/anchor_list?beginDate=${begin}&endDate=${end}&page=${page}&size=10&msToken=secret` });
  const intermediate = request('2026-10-25', '2026-10-26'), target = request('2026-10-25', '2026-10-25');
  tracker.started(intermediate); tracker.started(target);
  tracker.finished(target, true);
  assert.equal(tracker.status().pending, 1);
  tracker.finished(intermediate, true);
  assert.deepEqual(tracker.status(), { pending: 0, completed: { beginDate: '2026-10-25', endDate: '2026-10-26', start: 1, ok: true } });
  assert.doesNotMatch(JSON.stringify(tracker.status()), /secret|msToken/);
  const failed = request('2026-10-25', '2026-10-25', 2);
  tracker.started(failed); tracker.finished(failed, false);
  assert.equal(tracker.status().completed.ok, false); assert.equal(tracker.status().completed.start, 11);
});

test('profile pagination deduplicates repeated UIDs while counting platform rows', async () => {
  const first = { anchorId: '1234567890123456789', nickname: 'first' };
  const second = { anchorId: '2234567890123456789', nickname: 'second' };
  const pages = [
    { start: 1, end: 2, total: 4, rowCount: 2, hasNext: true, rows: [first, second], unidentified: [] },
    { start: 3, end: 4, total: 4, rowCount: 2, hasNext: false, rows: [second, { anchorId: '3234567890123456789', nickname: 'third' }], unidentified: [] }
  ];
  const source = new Source({ profileDir: 'unused' });
  source.navigate = async () => {};
  source.page = { async evaluate(_callback, message) { return { data: pages.shift() }; } };
  const saved = [];
  const count = await source.collect('profiles', null, (rows, progress) => saved.push({ rows, progress }));

  assert.equal(count, 3);
  assert.deepEqual(saved.map(page => page.rows.map(row => row.anchorId)), [
    ['1234567890123456789', '2234567890123456789'],
    ['3234567890123456789']
  ]);
  assert.deepEqual(saved[1].progress, {
    kind: 'profiles', date: null, scanned: 4, total: 4, identified: 3, duplicates: 1,
    unidentified: 0, unidentifiedSample: []
  });
});

test('a stalled page reopens the collector and retries the same platform row once', async () => {
  const row = { anchorId: '1234567890123456789', nickname: 'first' };
  const source = new Source({ profileDir: 'unused', pageTimeoutMs: 10 });
  let calls = 0;
  source.navigate = async () => {};
  source.page = { async evaluate() { calls++; return new Promise(() => {}); } };
  source.open = async () => {
    source.page = { async evaluate(_callback, message) {
      calls++;
      assert.equal(message.expectedStart, 1);
      return { data: { start: 1, end: 1, total: 1, rowCount: 1, hasNext: false, rows: [row], unidentified: [] } };
    } };
  };
  const saved = [];
  const count = await source.collect('profiles', null, rows => saved.push(...rows));

  assert.equal(count, 1);
  assert.equal(calls, 2);
  assert.deepEqual(saved, [row]);
});

test('stopping during a watchdog restart delay never reopens the browser', async () => {
  const source = new Source({ profileDir: 'unused', pageTimeoutMs: 5 });
  source.navigate = async () => {};
  source.page = { evaluate: async () => new Promise(() => {}) };
  let opened = 0;
  source.open = async () => { opened++; };
  const task = source.collect('profiles', null, () => assert.fail('cancelled collection must not save'));
  const rejected = assert.rejects(task, error => error.code === 'SOURCE_CANCELLED');
  await new Promise(resolve => setTimeout(resolve, 50));
  await source.close();
  await rejected;
  assert.equal(opened, 0);
});

test('replaying many earlier pages gets a longer budget than a normal page', async () => {
  const source = new Source({ profileDir: 'unused', pageTimeoutMs: 5 });
  source.navigate = async () => {};
  const rows = Array.from({ length: 10 }, (_, i) => ({ anchorId: String(1234567890123456780n + BigInt(i)) }));
  let initialCalls = 0;
  source.page = { async evaluate() {
    if (initialCalls++ === 0) return { data: { start: 1, end: 10, total: 11, rowCount: 10, hasNext: true, rows } };
    return new Promise(() => {});
  } };
  source.open = async () => {
    source.page = { async evaluate(_callback, message) {
      assert.equal(message.expectedStart, 11);
      await new Promise(resolve => setTimeout(resolve, 25));
      return { data: { start: 11, end: 11, total: 11, rowCount: 1, hasNext: false, rows: [{ anchorId: '2234567890123456789' }] } };
    } };
  };
  assert.equal(await source.collect('profiles', null, () => {}), 11);
});

test('a whole repeated page is rejected before saving or completing the scan', async () => {
  const source = new Source({ profileDir: 'unused' });
  source.navigate = async () => {};
  const rows = [{ anchorId: '1234567890123456789' }, { anchorId: '2234567890123456789' }];
  let calls = 0, saved = 0;
  source.page = { async evaluate() {
    const start = calls++ === 0 ? 1 : 3;
    return { data: { start, end: start + 1, total: 4, rowCount: 2, hasNext: start === 1, rows } };
  } };
  await assert.rejects(source.collect('profiles', null, () => { saved++; }), error => error.code === 'SOURCE_PAGINATION_MISMATCH');
  assert.equal(saved, 1);
  assert.equal(source.scanProgress.scanned, 2);
});

test('a second watchdog failure ends the run instead of promising another restart', async () => {
  const source = new Source({ profileDir: 'unused', pageTimeoutMs: 5 });
  source.navigate = async () => {};
  source.page = { evaluate: async () => new Promise(() => {}) };
  let opened = 0;
  source.open = async () => { opened++; source.page = { evaluate: async () => new Promise(() => {}) }; };
  await assert.rejects(source.collect('profiles', null, () => assert.fail('stalled pages must not save')), error => {
    assert.equal(error.code, 'SOURCE_STALLED');
    assert.match(error.message, /本轮停止并保留/);
    assert.doesNotMatch(error.message, /将重开/);
    return true;
  });
  assert.equal(opened, 1); assert.equal(source.page, null);
});
