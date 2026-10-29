import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../service/store.mjs';
import { deliverOnce } from '../service/delivery.mjs';
import { ErpConnection, UNGROUPED_SCOPE } from '../service/erp-connection.mjs';
const erp = process.argv[2];
if (!erp) throw new Error('请传入 ERP 接收端源码目录，仅使用临时测试数据库');
const { createApp } = await import(pathToFileURL(resolve(erp, 'server/app.js')));
const { testSession } = await import(pathToFileURL(resolve(erp, 'tests/helpers/session.js')));
const directory = await mkdtemp(join(tmpdir(), 'tac-erp-e2e-'));
const app = createApp({ dbPath: join(directory, 'erp.sqlite'), douyinAnchorIngest: { minIntervalMs: 0 } });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port, path = '/api/integrations/douyin-anchor-daily';
const cookies = {}; testSession(app.locals.store, cookies, 'general-manager');
let store = new Store(join(directory, 'collector.sqlite'));
const manage = async (suffix, body, method = 'POST') => {
  const response = await fetch(base + path + suffix, { method, headers: { 'Content-Type': 'application/json', Cookie: cookies['general-manager'] }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
};
try {
  const record = { anchorId: '7601032374063105082', douyinId: 'e2e-test-only', nickname: '本地联调测试',
    date: new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    capturedAt: new Date(Date.now() - 60000).toISOString(), followers: 100, waves: 123, liveSeconds: 3600, acu: 12.5 };
  app.locals.store.put('anchors', { id: 'e2e-only', dept: '运营', platformGuild: '本地联调测试', douyinId: record.douyinId, unionAnchorId: record.anchorId });
  await manage('/bindings', { agency: '本地联调测试', anchorId: record.anchorId, erpAnchorId: 'e2e-only', douyinId: record.douyinId });
  const auth = await manage('/tokens', { agency: '本地联调测试', name: 'local-e2e' });
  let lastRequest;
  const delivery = { approved: true, endpoint: 'https://erp.yeshuyu.com' + path, token: auth.token,
    fetcher: async (url, options) => {
      assert.equal(url, 'https://erp.yeshuyu.com' + path); lastRequest = options;
      return fetch(base + path, options); // Local test server only, never the production URL.
    } };
  store.save([record]); store.close(); store = new Store(join(directory, 'collector.sqlite'));
  assert.equal(store.status().queued, 1);
  assert.equal((await deliverOnce(store, delivery)).status, 'delivered');
  assert.equal(store.status().queued, 0);
  const duplicate = await fetch(base + path, lastRequest); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).replayed, true);
  const change = { ...record, waves: 456, capturedAt: new Date(Date.parse(record.capturedAt) + 1000).toISOString() };
  store.save([change]); assert.equal((await deliverOnce(store, delivery)).status, 'delivered');
  store.save([{ ...record, capturedAt: new Date(Date.parse(record.capturedAt) + 2000).toISOString() }]);
  assert.equal((await deliverOnce(store, delivery)).status, 'delivered');
  const result = await manage(`?agency=${encodeURIComponent('本地联调测试')}&start=${record.date}&end=${record.date}`, undefined, 'GET');
  assert.equal(result.records.length, 1); assert.equal(result.records[0].anchorId, record.anchorId); assert.equal(result.records[0].waves, 123);
  await manage('/tokens/' + auth.id, undefined, 'DELETE');
  store.save([{ ...change, waves: 789, capturedAt: new Date().toISOString() }]);
  const revoked = await deliverOnce(store, delivery); assert.equal(revoked.status, 'retry'); assert.match(revoked.reason, /401/);
  assert.equal(store.status().queued, 1);

  // Exercise the new no-guild-input path against the unchanged ERP server.
  // Only fixture login is replaced with a test session; bootstrap, bindings,
  // scoped tokens, batch validation, database writes and queries use real HTTP.
  const profiles = [0, 1, 2].map(index => ({ anchorId: String(123450000000 + index), douyinId: 'auto-fixture-' + index, nickname: '自动匹配测试' }));
  const guilds = ['本地公会甲', '本地公会乙', ''];
  const archives = profiles.map((profile, index) => ({ id: 'auto-fixture-' + index, dept: '运营', platformGuild: guilds[index], douyinId: profile.douyinId, unionAnchorId: profile.anchorId }));
  for (const archive of archives) app.locals.store.put('anchors', archive);
  const before = JSON.stringify(archives.map(archive => app.locals.store.get('anchors', archive.id)));
  store.saveProfiles(profiles); store.completeProfiles(profiles);
  store.save(profiles.map(profile => ({ ...record, ...profile })));
  const connection = new ErpConnection({ store, dataDir: directory, fetcher: async (url, options) => {
    const target = new URL(url); assert.equal(target.origin, 'https://erp.yeshuyu.com');
    if (target.pathname === '/api/login') {
      const loginCookies = {}; testSession(app.locals.store, loginCookies, 'general-manager');
      return new Response(JSON.stringify({ user: { level: 'generalManager' } }), { headers: { 'Set-Cookie': loginCookies['general-manager'] + '; HttpOnly' } });
    }
    return fetch(base + target.pathname + target.search, options);
  } });
  const state = await connection.connect({ phone: '13800000000', password: 'local-fixture-only' });
  assert.equal(state.stage, 'connected', state.message); assert.equal(state.matched, 3); assert.equal(state.groups, 3);
  const saved = JSON.parse(await readFile(join(directory, 'erp-sync.json'), 'utf8'));
  assert.deepEqual(saved.targets.map(target => target.agency), [...guilds.slice(0, 2), UNGROUPED_SCOPE]);
  let offset = 0;
  for (const target of saved.targets) {
    const receipt = await deliverOnce(store, { ...saved, approved: true, targetOffset: offset,
      endpoint: 'https://erp.yeshuyu.com' + path, fetcher: (_url, options) => fetch(base + path, options) });
    assert.equal(receipt.status, 'delivered', receipt.reason); assert.equal(receipt.count, 1); offset = receipt.nextTarget;
    const query = await manage(`?agency=${encodeURIComponent(target.agency)}&start=${record.date}&end=${record.date}`, undefined, 'GET');
    assert.deepEqual(query.records.map(value => value.anchorId), target.anchorIds);
  }
  assert.equal(store.status().queued, 1); // The revoked legacy fixture stays queued.
  assert.equal(JSON.stringify(archives.map(archive => app.locals.store.get('anchors', archive.id))), before);
  await connection.close();
  console.log('PASS 采集库重启恢复 → 真实 HTTP 鉴权/绑定 → 自动发送 → 接收查询 → 重复回执 → A/B/A 版本 → 撤销后保留队列；全部为本地临时数据库。');
  console.log('PASS 无需手填公会 → UID/抖音号匹配 → 两个已登记公会及空公会分组授权 → 各组逐日数据入库查询 → 原主播档案逐字不变；使用未修改的 ERP 接收端和临时数据库，未访问生产。');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.locals.store.close(); store.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
