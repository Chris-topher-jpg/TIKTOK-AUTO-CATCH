import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

const [core, background] = await Promise.all(['core.js', 'background.js'].map(file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
const version = core.match(/const VERSION = '([^']+)'/)[1];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) { for (let i = 0; i < 500; i++) { if (read()) return; await delay(2); } throw new Error('background test timed out'); }
function harness(sendPage) {
  const saved = {}, stores = { profiles: new Map(), daily: new Map() }, tabs = new Map();
  let listener, fetchCount = 0, nextTab = 0;
  const calls = [], navigations = [], reloads = [], clone = value => structuredClone(value);
  const chrome = {
    runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}`, onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} } },
    action: { onClicked: { addListener() {} } }, alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: {
      async get(keys) { return clone(Object.fromEntries(keys.filter(key => key in saved).map(key => [key, saved[key]]))); },
      async set(values) { Object.assign(saved, clone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; }
    } },
    tabs: {
      async create({ url }) { const tab = { id: ++nextTab, url }; tabs.set(tab.id, tab); return clone(tab); },
      async get(id) { if (!tabs.has(id)) throw new Error('tab closed'); return clone(tabs.get(id)); },
      async update(id, change) { navigations.push({ id, ...clone(change) }); Object.assign(tabs.get(id), change); return clone(tabs.get(id)); },
      async reload(id) { reloads.push(id); },
      async sendMessage(id, message) {
        if (message.type === 'COLLECTOR_INFO') return { collectorVersion: tabs.get(id)?.collectorVersion || version };
        if (message.type === 'COLLECTOR_DIAGNOSTIC') return tabs.has(id) ? { collectorVersion: version, diagnostic: { source: 'collector', version, tableFound: true, rowCount: 1 } } : undefined;
        calls.push(clone(message));
        return { collectorVersion: version, ...await sendPage(message, calls.length) };
      }
    }
  };
  const context = vm.createContext({ chrome, URL, Intl, crypto: webcrypto, AbortSignal, structuredClone, TextEncoder,
    setTimeout: fn => setTimeout(fn, 1),
    fetch: () => { fetchCount++; throw new Error('ERP must stay disabled'); },
    async putRows(kind, run, rows) { for (const row of rows) stores[kind].set(`${run}:${row.anchorId}:${row.date || ''}`, clone(row)); },
    async getRows(kind, run) { return [...stores[kind]].filter(([key]) => key.startsWith(`${run}:`)).map(([, value]) => clone(value)); },
    async clearData() { for (const store of Object.values(stores)) store.clear(); }
  });
  vm.runInContext(core, context);
  vm.runInContext(background.split(String.fromCharCode(10)).filter(line => !line.startsWith('import ')).join(String.fromCharCode(10)), context);
  const send = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/dashboard.html' }, resolve));
  return { saved, stores, tabs, calls, navigations, reloads, send, fetchCount: () => fetchCount };
}
const profile = { anchorId: '1234567890123456789', douyinId: 'dy_1', nickname: '测试主播', followers: 1234, capturedAt: '2026-10-26T00:00:00Z' };
const daily = date => ({ anchorId: profile.anchorId, douyinId: profile.douyinId, nickname: profile.nickname, date, waves: 10, liveSeconds: 3600, acu: 2, missing: [], approximate: [] });
const page = (rows, start = 1, total = rows.length) => ({ data: { rows, start, end: start + rows.length - 1, total, hasNext: start + rows.length - 1 < total } });

test('background collects an inclusive range, retains former anchors and never calls ERP', async () => {
  const h = harness(message => message.kind === 'profiles' ? page([profile]) : page([daily(message.date), { ...daily(message.date), anchorId: '2234567890123456789', douyinId: 'former_member' }]));
  assert.equal((await h.send({ type: 'START', start: '2026-10-23', end: '2026-10-24' })).error, undefined);
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error); assert.equal(h.stores.daily.size, 4);
  const state = (await h.send({ type: 'STATE' })).data;
  assert.equal(state.rows.length, 4); assert.equal(state.qualityCount, 2);
  assert.equal(state.rows.find(row => row.douyinId === 'former_member').followers, null);
  assert.match((await h.send({ type: 'SYNC' })).error, /暂不接入 ERP/);
  assert.match((await h.send({ type: 'SAVE_SETTINGS', settings: { endpoint: 'https://erp.yeshuyu.com/api/import' } })).error, /暂未启用/);
  assert.equal(h.fetchCount(), 0);
});

test('pause saves a completed page and resume recreates a closed collection tab', async () => {
  let release;
  const h = harness((message, count) => count === 1 ? new Promise(resolve => { release = () => resolve(page([profile], 1, 2)); }) : message.kind === 'profiles'
    ? page([{ ...profile, anchorId: '2234567890123456789' }], 2, 2) : page([daily(message.date), { ...daily(message.date), anchorId: '2234567890123456789' }]));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' }); await until(() => Boolean(release));
  await h.send({ type: 'PAUSE' }); release(); await until(() => h.saved.job?.expectedStart === 2);
  assert.equal(h.saved.job.status, 'paused'); assert.equal(h.stores.profiles.size, 1);
  h.tabs.clear(); await delay(10);
  assert.equal((await h.send({ type: 'RESUME' })).error, undefined);
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error);
  assert.equal(h.tabs.size, 1); assert.equal(h.stores.profiles.size, 2); assert.equal(h.stores.daily.size, 2);
  assert.equal(h.calls[1].expectedStart, 2);
});

test('login redirect reports a recoverable authentication error', async () => {
  const h = harness(() => page([profile]));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  h.tabs.get(h.saved.job.tabId).url = 'https://union.bytedance.com/open/login?redirect=/open/portal/anchor/list';
  await until(() => h.saved.job?.status === 'error');
  assert.match(h.saved.job.error, /登录状态失效/);
});

test('resume refreshes the same collection URL to pick up an updated content adapter', async () => {
  let release;
  const h = harness((message, count) => count === 1 ? new Promise(resolve => { release = () => resolve(page([profile], 1, 2)); }) : message.kind === 'profiles' ? page([{ ...profile, anchorId: '2234567890123456789' }], 2, 2) : page([daily(message.date)]));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' }); await until(() => Boolean(release));
  await h.send({ type: 'PAUSE' }); release(); await until(() => h.saved.job?.expectedStart === 2); await delay(10);
  const id = h.saved.job.tabId, url = h.tabs.get(id).url;
  assert.equal((await h.send({ type: 'RESUME' })).error, undefined);
  assert.equal(h.navigations[0].id, id); assert.equal(h.navigations[0].url, url);
  await until(() => h.saved.job?.status === 'completed');
});

test('a row diagnostic from the collector is retained in the failed task state', async () => {
  const h = harness(() => ({ error: '当前页第 1 行：无法确认主播 UID', diagnostic: { row: 1, missing: ['anchorId'], items: [{ type: '', text: '12345' }] } }));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' }); await until(() => h.saved.job?.status === 'error');
  assert.equal(h.saved.job.diagnostic.row, 1); assert.equal(h.saved.job.diagnostic.missing[0], 'anchorId');
});

test('a generic collection error receives checkpoint diagnostics', async () => {
  const h = harness(() => ({ error: '表格未能稳定加载，请检查登录或网络' }));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' }); await until(() => h.saved.job?.status === 'error');
  assert.equal(h.saved.job.diagnostic.source, 'background');
  assert.equal(h.saved.job.diagnostic.phase, 'profiles');
  assert.equal(h.saved.job.diagnostic.expectedStart, 1);
  assert.equal(h.saved.job.diagnostic.profileCount, 0);
  assert.match(h.saved.job.diagnostic.message, /表格未能稳定加载/);
});

test('a timeout reloads once and succeeds without skipping or deleting saved profiles', async () => {
  const h = harness((message, count) => count === 1
    ? { error: '表格加载超时', code: 'TABLE_WAIT_TIMEOUT', diagnostic: { source: 'collector', stage: 'wait for table' } }
    : message.kind === 'profiles' ? page([profile]) : page([daily(message.date)]));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.calls[0].expectedStart, 1);
  assert.equal(h.calls[1].expectedStart, 1);
  assert.equal(h.stores.profiles.size, 1);
  assert.equal(h.saved.job.lastRetry.code, 'TABLE_WAIT_TIMEOUT');
});

test('a repeated page fails before advancing or overwriting an existing profile', async () => {
  const h = harness(message => message.expectedStart === 1 ? page([profile], 1, 2) : page([{ ...profile, followers: 99999 }], 2, 2));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  await until(() => h.saved.job?.status === 'error');
  assert.match(h.saved.job.error, /已采集的主播 ID/);
  assert.equal(h.saved.job.expectedStart, 2);
  assert.equal(h.saved.job.seenAnchorIds.length, 1);
  assert.equal(h.stores.profiles.size, 1);
  assert.equal([...h.stores.profiles.values()][0].followers, 1234);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.saved.job.diagnostic.repeatedCount, 1);
});

test('timer throttling retries the same checkpoint once in the foreground', async () => {
  const other = { ...profile, anchorId: '2234567890123456789' };
  let attempts = 0;
  const h = harness(message => {
    if (message.kind === 'daily') return page([daily(message.date), { ...daily(message.date), anchorId: other.anchorId }]);
    if (message.expectedStart === 1) return page([profile], 1, 2);
    if (!attempts++) return { error: '采集页面计时明显延迟', code: 'PAGE_TIMER_THROTTLED', diagnostic: { timing: { delayedWakeups: 1, maxWakeGapMs: 60000 } } };
    return page([other], 2, 2);
  });
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.navigations.filter(change => change.active === true).length, 1);
  assert.equal(h.calls[1].expectedStart, 2);
  assert.equal(h.calls[2].expectedStart, 2);
  assert.equal(h.stores.profiles.size, 2);
  assert.equal(h.saved.job.lastRetry.foreground, true);
  assert.equal(h.saved.job.lastRetry.code, 'PAGE_TIMER_THROTTLED');
});

test('repeated timer delays stop after one foreground retry without clearing records', async () => {
  const h = harness(message => message.expectedStart === 1 ? page([profile], 1, 2)
    : { error: '采集页面计时明显延迟', code: 'PAGE_TIMER_THROTTLED' });
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  await until(() => h.saved.job?.status === 'error');
  assert.equal(h.saved.job.expectedStart, 2);
  assert.equal(h.saved.job.seenAnchorIds.length, 1);
  assert.equal(h.stores.profiles.size, 1);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.navigations.filter(change => change.active === true).length, 1);
  assert.equal(h.calls.length, 3);
});

test('resume recognizes sparse hidden-page checks from a 0.1.3 report', async () => {
  const other = { ...profile, anchorId: '2234567890123456789' };
  const h = harness(message => message.kind === 'profiles' ? page([other], 2, 2)
    : page([daily(message.date), { ...daily(message.date), anchorId: other.anchorId }]));
  h.saved.job = {
    id: 'old', status: 'error', phase: 'profiles', start: '2026-10-24', end: '2026-10-24', days: ['2026-10-24'], dayIndex: 0,
    expectedStart: 2, expectedTotal: 2, tabId: 10, profileCount: 1, dailyCount: 0, checkpointVersion: 1, seenAnchorIds: [profile.anchorId],
    diagnostic: { version: '0.1.3', visibilityState: 'hidden', timeoutMs: 22000, wait: { polls: 5, parseErrors: 0, loadingPolls: 0, signatureChanges: 1 } }
  };
  h.tabs.set(10, { id: 10, url: 'https://union.bytedance.com/open/portal/anchor/list' });
  h.stores.profiles.set(`old:${profile.anchorId}:`, profile);
  assert.equal((await h.send({ type: 'RESUME' })).error, undefined);
  assert.equal(h.navigations[0].active, true);
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error);
  assert.equal(h.calls[0].expectedStart, 2);
  assert.equal(h.stores.profiles.size, 2);
});

test('an old inconsistent checkpoint revalidates from page one and retains stored rows', async () => {
  const other = { ...profile, anchorId: '2234567890123456789' };
  let h, observedRetained = false;
  h = harness(message => {
    if (message.kind === 'profiles' && message.expectedStart === 1) {
      observedRetained = h.stores.profiles.size === 1;
      return page([profile], 1, 2);
    }
    return message.kind === 'profiles' ? page([other], 2, 2) : page([daily(message.date), { ...daily(message.date), anchorId: other.anchorId }]);
  });
  h.saved.job = { id: 'old', status: 'error', phase: 'profiles', start: '2026-10-24', end: '2026-10-24', days: ['2026-10-24'], dayIndex: 0, expectedStart: 3, expectedTotal: 3, tabId: 10, profileCount: 2, dailyCount: 0 };
  h.tabs.set(10, { id: 10, url: 'https://union.bytedance.com/open/portal/anchor/list' });
  h.stores.profiles.set(`old:${profile.anchorId}:`, profile);
  assert.equal((await h.send({ type: 'RESUME' })).error, undefined);
  await until(() => ['completed', 'error'].includes(h.saved.job?.status));
  assert.equal(h.saved.job.status, 'completed', h.saved.job.error);
  assert.equal(observedRetained, true);
  assert.equal(h.calls[0].expectedStart, 1);
  assert.equal(h.stores.profiles.size, 2);
});

test('diagnostics read the current adapter and label old failures without rewriting the task', async () => {
  const h = harness(() => page([profile]));
  h.saved.job = { id: 'old', status: 'error', phase: 'profiles', start: '2026-10-24', end: '2026-10-24', days: ['2026-10-24'], dayIndex: 0, expectedStart: 221, expectedTotal: 427, tabId: 10, profileCount: 220, dailyCount: 0, error: '表格未能稳定加载' };
  h.tabs.set(10, { id: 10, url: 'https://union.bytedance.com/open/portal/anchor/list' });
  h.stores.profiles.set(`old:${profile.anchorId}:`, profile);
  const before = structuredClone(h.saved.job);
  const report = (await h.send({ type: 'DIAGNOSTIC' })).data;
  assert.equal(report.source, 'background');
  assert.equal(report.backgroundVersion, version);
  assert.equal(report.live.source, 'collector');
  assert.equal(report.live.collectorVersion, version);
  assert.equal(report.savedCounts.profiles, 1);
  assert.match(report.failureNote, /可能来自更新前/);
  assert.deepEqual(h.saved.job, before);
  assert.equal(h.calls.length, 0);
});

test('a stale adapter is refreshed then rejected before any collection writes', async () => {
  const h = harness(() => page([profile]));
  await h.send({ type: 'START', start: '2026-10-24', end: '2026-10-24' });
  h.tabs.get(h.saved.job.tabId).collectorVersion = '0.1.1';
  await until(() => h.saved.job?.status === 'error');
  assert.match(h.saved.job.error, /适配器版本未更新/);
  assert.equal(h.saved.job.diagnostic.collectorVersion, '0.1.1');
  assert.equal(h.stores.profiles.size, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reloads.length, 1);
});
