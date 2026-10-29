import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, PROTOCOL } from '../service/store.mjs';
import { ErpConnection, matchProfiles, UNGROUPED_SCOPE } from '../service/erp-connection.mjs';
import { createControlServer } from '../service/control.mjs';
import { Runtime } from '../service/runtime.mjs';
import { deliverOnce } from '../service/delivery.mjs';
const profile = { anchorId: '7601032374063105082', douyinId: 'test-dy', nickname: '本地测试' };
const anchor = { id: 'erp-test', unionAnchorId: profile.anchorId, douyinId: profile.douyinId, name: profile.nickname, dept: '运营', platformGuild: '测试公会' };
const row = { ...profile, date: '2026-10-26', followers: 100, waves: 123, liveSeconds: 3600, acu: 12.5 };
function upstream(anchors = [anchor], { tokenFailure = false, tokenFailureAt = Infinity, access = 'generalManager' } = {}) {
  const calls = []; let created = 0;
  return { calls, fetcher: async (url, options) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body); calls.push({ path, body, method: options.method });
    let result = {}, status = 200;
    if (path === '/api/login') result = { user: { level: access, dept: '运营' } };
    else if (path === '/api/bootstrap') result = { anchors };
    else if (path.endsWith('/tokens') && options.method === 'POST') {
      created++; const failure = tokenFailure || created === tokenFailureAt;
      status = failure ? 503 : 201; result = failure ? { error: 'busy' } : { id: 'test-token-' + created, token: 'tac_' + String(created).padStart(43, 't'), expiresAt: '2027-01-01T00:00:00Z' };
    }
    return new Response(JSON.stringify(result), { status, headers: path === '/api/login' ? { 'Set-Cookie': 'yes_session=unit-test-only; HttpOnly' } : {} });
  } };
}
async function temporary(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tac-connection-')), store = new Store(join(dataDir, 'collector.sqlite'));
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
  return { store, dataDir };
}
test('one-page setup waits for a complete scan, auto-detects agency and saves only scoped credentials', async t => {
  const env = await temporary(t), remote = upstream(); let configured;
  env.store.saveProfiles([profile]);
  const connection = new ErpConnection({ ...env, ...remote, onConnected: value => { configured = value; } });
  t.after(() => connection.close());
  assert.equal((await connection.connect({ phone: '13800000000', password: 'private-test-only' })).stage, 'waiting');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/bindings')).length, 0);
  env.store.completeProfiles([profile]); await connection.finish();
  assert.equal(connection.status().stage, 'connected'); assert.equal(connection.status().agency, anchor.platformGuild);
  assert.deepEqual(configured.targets[0].anchorIds, [profile.anchorId]);
  const persisted = await readFile(join(env.dataDir, 'erp-sync.json'), 'utf8');
  assert.ok(persisted.includes(configured.targets[0].token)); assert.ok(!persisted.includes('private-test-only')); assert.ok(!persisted.includes('yes_session'));
  assert.ok(!JSON.stringify(connection.status()).includes(configured.targets[0].token)); assert.equal(connection.cookie, null);
});
test('ambiguous identities are retained locally while unique bindings can sync without queue starvation', async t => {
  const env = await temporary(t), unknown = { ...profile, anchorId: '7601032374063105083', douyinId: 'unknown' };
  env.store.saveProfiles([unknown, profile]); env.store.completeProfiles([unknown, profile]);
  env.store.save([{ ...row, ...unknown }, row]);
  const remote = upstream(), connection = new ErpConnection({ ...env, ...remote });
  await connection.connect({ phone: '13800000000', password: 'private-test-only' });
  assert.equal(connection.status().matched, 1); assert.equal(connection.status().unmatched, 1);
  const credentials = JSON.parse(await readFile(join(env.dataDir, 'erp-sync.json'), 'utf8'));
  const result = await deliverOnce(env.store, { ...credentials, approved: true, endpoint: 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily', fetcher: async (_url, options) => {
    const records = JSON.parse(options.body).records; assert.deepEqual(records.map(value => value.anchorId), [profile.anchorId]);
    return new Response(JSON.stringify({ protocol: PROTOCOL, accepted: 1, unmatched: [] }));
  } });
  assert.equal(result.status, 'delivered'); assert.equal(env.store.status().queued, 1);
  assert.equal(JSON.parse(env.store.pending()[0].body).anchorId, unknown.anchorId);
  assert.equal((await readFile(join(env.dataDir, 'ERP待核对主播.json'), 'utf8')).includes(unknown.anchorId), true);
});
test('setup rejects roles, conflicting IDs and token failures without enabling synchronization', async t => {
  const env = await temporary(t); env.store.saveProfiles([profile]); env.store.completeProfiles([profile]);
  const denied = new ErpConnection({ ...env, ...upstream([anchor], { access: 'staff' }) });
  await assert.rejects(denied.connect({ phone: '13800000000', password: 'private-test-only' }), /总经理/); assert.equal(denied.cookie, null);
  const collision = matchProfiles([profile], [anchor, { ...anchor, id: 'duplicate' }]); assert.equal(collision.plan.length, 0);
  const conflict = matchProfiles([profile], [{ ...anchor, unionAnchorId: '7601032374063105099' }]); assert.equal(conflict.plan.length, 0);
  let enabled = false;
  const failed = new ErpConnection({ ...env, ...upstream([anchor], { tokenFailure: true }), onConnected: () => { enabled = true; } });
  assert.equal((await failed.connect({ phone: '13800000000', password: 'private-test-only' })).stage, 'error'); assert.equal(enabled, false); assert.equal(failed.cookie, null);
  await assert.rejects(readFile(join(env.dataDir, 'erp-sync.json')), { code: 'ENOENT' });
});
test('local control mutations require same origin and a per-process capability; secrets stay out of status', async t => {
  const env = await temporary(t); let logins = 0, connected;
  const runtime = { store: env.store, status: () => ({ version: '0.3.5-service' }), login: async () => { logins++; }, connection: { connect: async body => { connected = body; return { stage: 'connected' }; } } };
  const server = createControlServer(runtime, { port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base), html = await page.text(); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const key = html.match(/name="tac-action" content="([a-f0-9]+)"/)[1];
  const post = (headers = {}, body = {}) => fetch(base + '/api/platform-login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ Origin: 'https://example.com', 'X-Tac-Action': key })).status, 403);
  assert.equal((await post({ Origin: base, 'X-Tac-Action': key })).status, 200); assert.equal(logins, 1);
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { Origin: base, 'X-Tac-Action': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13800000000', password: 'private-test-only' }) })).status, 200);
  assert.equal(connected.agency, undefined); assert.equal((await fetch(base + '/status')).status, 200);
  assert.equal((await fetch(base + '/api/platform-login', { method: 'POST', headers: { Origin: base, 'X-Tac-Action': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ large: 'x'.repeat(9000) }) })).status, 413);
});

test('automatic identity mapping supports multiple guilds and blank guilds without changing ERP archives', () => {
  const profiles = [profile, { ...profile, anchorId: '7601032374063105083', douyinId: 'dy-b' },
    { ...profile, anchorId: '7601032374063105084', douyinId: 'dy-c' }];
  const anchors = profiles.map((value, index) => ({ ...anchor, id: 'erp-' + index, unionAnchorId: value.anchorId,
    douyinId: value.douyinId, platformGuild: ['甲公会', '乙公会', ''][index] }));
  const before = JSON.stringify(anchors), matched = matchProfiles(profiles, anchors);
  assert.deepEqual(matched.plan.map(value => value.agency), ['甲公会', '乙公会', UNGROUPED_SCOPE]);
  assert.equal(matched.unmatched.length, 0); assert.equal(JSON.stringify(anchors), before);
  const noGuilds = matchProfiles(profiles, anchors.map(value => ({ ...value, platformGuild: '' })));
  assert.equal(noGuilds.plan.length, 3); assert.deepEqual(noGuilds.agencies, [UNGROUPED_SCOPE]);
  const sameName = matchProfiles([{ ...profile, anchorId: '7601032374063105090', douyinId: 'no-such-id' }], anchors);
  assert.equal(sameName.plan.length, 0); assert.match(sameName.unmatched[0].reason, /尚无/);
  const duplicateProfile = matchProfiles([profile, { ...profile, anchorId: '7601032374063105089' }], [{ ...anchor, unionAnchorId: '' }]);
  assert.equal(duplicateProfile.plan.length, 0); assert.ok(duplicateProfile.unmatched.every(value => /同一个/.test(value.reason)));
});

test('automatic connection authorizes and delivers each exact match with its own scope', async t => {
  const env = await temporary(t), profiles = [profile, { ...profile, anchorId: '7601032374063105083', douyinId: 'dy-b' },
    { ...profile, anchorId: '7601032374063105084', douyinId: 'dy-c' }];
  const anchors = profiles.map((value, index) => ({ ...anchor, id: 'erp-' + index, unionAnchorId: value.anchorId,
    douyinId: value.douyinId, platformGuild: ['甲公会', '乙公会', ''][index] }));
  env.store.saveProfiles(profiles); env.store.completeProfiles(profiles); env.store.save(profiles.map(value => ({ ...row, ...value })));
  const remote = upstream(anchors), connection = new ErpConnection({ ...env, ...remote });
  assert.equal((await connection.connect({ phone: '13800000000', password: 'private-test-only' })).stage, 'connected');
  const saved = JSON.parse(await readFile(join(env.dataDir, 'erp-sync.json'), 'utf8'));
  assert.equal(saved.targets.length, 3); assert.equal(connection.status().matched, 3);
  assert.equal(remote.calls.filter(value => value.path.endsWith('/bindings')).length, 3);
  let nextTarget = 0, sent = 0;
  for (const target of saved.targets) {
    const delivered = await deliverOnce(env.store, { ...saved, approved: true, targetOffset: nextTarget,
      endpoint: 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily', fetcher: async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + target.token);
        assert.deepEqual(JSON.parse(options.body).records.map(value => value.anchorId), target.anchorIds); sent++;
        return new Response(JSON.stringify({ protocol: PROTOCOL, accepted: 1, unmatched: [] }));
      } });
    nextTarget = delivered.nextTarget; assert.equal(delivered.status, 'delivered');
  }
  assert.equal(sent, 3); assert.equal(env.store.status().queued, 0);
  const restored = new ErpConnection({ ...env, saved });
  assert.equal(restored.status().matched, 3); assert.equal(restored.status().groups, 3);
  assert.ok(!JSON.stringify(restored.status()).includes('tac_'));
});

test('failure after the first scope token rolls back new credentials and preserves prior authorization', async t => {
  const env = await temporary(t), other = { ...profile, anchorId: '7601032374063105083', douyinId: 'dy-b' };
  const profiles = [profile, other]; env.store.saveProfiles(profiles); env.store.completeProfiles(profiles);
  const first = new ErpConnection({ ...env, ...upstream() }); await first.connect({ phone: '13800000000', password: 'private-test-only' });
  const original = await readFile(join(env.dataDir, 'erp-sync.json'), 'utf8');
  const remote = upstream([anchor, { ...anchor, id: 'erp-other', unionAnchorId: other.anchorId, douyinId: other.douyinId, platformGuild: '' }], { tokenFailureAt: 2 });
  const failed = new ErpConnection({ ...env, ...remote });
  assert.equal((await failed.connect({ phone: '13800000000', password: 'private-test-only' })).stage, 'error');
  assert.equal(await readFile(join(env.dataDir, 'erp-sync.json'), 'utf8'), original);
  assert.equal(remote.calls.filter(value => value.method === 'DELETE' && value.path.endsWith('/tokens/test-token-1')).length, 1);
  assert.equal(failed.cookie, null);
});

test('zero identity matches produce a review report instead of asking for a guild', async t => {
  const env = await temporary(t); env.store.saveProfiles([profile]); env.store.completeProfiles([profile]);
  const remote = upstream([]), connection = new ErpConnection({ ...env, ...remote });
  const state = await connection.connect({ phone: '13800000000', password: 'private-test-only' });
  assert.equal(state.stage, 'error'); assert.equal(state.unmatched, 1); assert.match(state.message, /无需填写/);
  assert.equal(JSON.parse(await readFile(join(env.dataDir, 'ERP待核对主播.json'), 'utf8')).length, 1);
  assert.equal(remote.calls.filter(value => value.path.endsWith('/tokens')).length, 0);
});

test('runtime rotates scopes after failure with a combined fifty-record limit and legacy credentials still work', async t => {
  const env = await temporary(t); let clock = 1000000;
  const profiles = Array.from({ length: 120 }, (_, i) => ({ ...profile, anchorId: String(1234500000 + i), douyinId: 'dy-' + i }));
  env.store.save(profiles.map(value => ({ ...row, ...value })));
  const targets = [0, 1].map(index => ({ agency: 'guild-' + index, token: 'tac_' + String(index).repeat(43),
    anchorIds: profiles.slice(index * 60, (index + 1) * 60).map(value => value.anchorId) }));
  const calls = [], runtime = new Runtime({ ...env, source: { async close() {} }, config: { intervalSeconds: 600 }, saved: { enabled: true, targets }, clock: () => clock,
    fetcher: async (_url, options) => {
      const records = JSON.parse(options.body).records; calls.push({ token: options.headers.Authorization, records });
      return new Response(JSON.stringify(calls.length === 1 ? { error: 'busy' } : { protocol: PROTOCOL, accepted: records.length, unmatched: [] }), { status: calls.length === 1 ? 503 : 200 });
    } });
  t.after(() => runtime.close());
  await runtime.deliver(); assert.equal(runtime.delivery.status, 'retry'); assert.equal(calls.length, 1); assert.equal(calls[0].records.length, 50);
  await runtime.deliver(); assert.equal(calls.length, 1);
  clock += 30000; await runtime.deliver(); assert.equal(calls.length, 2); assert.equal(calls[1].records.length, 50);
  assert.equal(calls[1].token, 'Bearer ' + targets[1].token); assert.ok(calls[1].records.every(value => targets[1].anchorIds.includes(value.anchorId)));
  assert.equal(env.store.status().queued, 70);
  const legacy = new ErpConnection({ ...env, saved: { enabled: true, ...targets[0] } });
  assert.equal(legacy.status().matched, 60);
  const delivered = await deliverOnce(env.store, { approved: true, ...targets[1], endpoint: 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily',
    fetcher: async (_url, options) => new Response(JSON.stringify({ protocol: PROTOCOL, accepted: JSON.parse(options.body).records.length, unmatched: [] })) });
  assert.equal(delivered.count, 10);
  await assert.rejects(deliverOnce(env.store, { approved: true, targets: [{ token: targets[0].token }], endpoint: 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily' }), /授权范围无效/);
});
test('ten-minute collection never overlaps and waits ten minutes from the previous start', async t => {
  const env = await temporary(t); let clock = 1000000, release, opens = 0;
  const source = { async open() { opens++; await new Promise(resolve => { release = resolve; }); }, async close() {}, async collect(kind, date, receive) { if (kind === 'profiles') receive([profile]); else receive([{ ...row, date }]); } };
  const runtime = new Runtime({ ...env, source, config: { intervalSeconds: 600, lookbackDays: 1, includeToday: false }, clock: () => clock });
  const first = runtime.collect(), second = runtime.collect(); assert.equal(first, second); assert.equal(opens, 1);
  clock += 120000; release(); await first;
  assert.equal(Date.parse(runtime.status().nextRunAt), 1600000); assert.equal(runtime.status().collecting, false);
  await runtime.close();
});

test('runtime exposes only authorized pending counts while retaining all local records', async t => {
  const env = await temporary(t), unknown = { ...row, anchorId: '7601032374063105083' };
  env.store.save([row, unknown]);
  const token = 'tac_' + 'r'.repeat(43);
  const runtime = new Runtime({ ...env, source: { async close() {} }, config: { intervalSeconds: 600 },
    saved: { enabled: true, targets: [{ token, anchorIds: [row.anchorId] }] } });
  t.after(() => runtime.close());
  assert.equal(runtime.status().queued, 1);
  assert.equal(runtime.status().queue.unbound, 1);
  assert.equal(runtime.status().queue.total, 2);
  assert.ok(!JSON.stringify(runtime.status()).includes(token));
  runtime.deliveryConfig.approved = false;
  assert.equal(runtime.status().queued, 0);
  assert.equal(runtime.status().queue.paused, 1);
  assert.equal(env.store.records().length, 2);
});

test('an unavailable current day remains visible as an error until a successful collection', async t => {
  const env = await temporary(t); let unavailable = true;
  const today = globalThis.AnchorCore.shanghaiToday();
  const source = { async open() {}, async close() {}, async collect(kind, date, receive) {
    if (kind === 'profiles') return receive([profile]);
    if (date === today && unavailable) throw new Error('today report timed out');
    receive([{ ...row, date }]);
  } };
  const runtime = new Runtime({ ...env, source, config: { intervalSeconds: 600, lookbackDays: 1, includeToday: true } });
  t.after(() => runtime.close());
  await runtime.collect();
  assert.equal(runtime.status().lastRun.status, 'partial');
  assert.match(runtime.status().lastError, /今天数据暂时无法读取.*today report timed out/);
  assert.equal(runtime.status().platform.state, 'error');
  assert.equal(env.store.records().length, 1);
  unavailable = false; await runtime.collect();
  assert.equal(runtime.status().lastRun.status, 'completed');
  assert.equal(runtime.status().lastError, null);
});

test('unmatched download retains string identities and reasons without leaking local credentials', async t => {
  const env = await temporary(t);
  const runtime = new Runtime({ ...env, source: { async close() {} }, config: { intervalSeconds: 600 } });
  const server = createControlServer(runtime, { port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/exports/unmatched.json')).status, 404);
  const expected = { ...profile, reason: 'UID 或抖音号与 ERP 档案冲突' };
  await writeFile(join(env.dataDir, 'ERP待核对主播.json'), JSON.stringify([{ ...expected, token: 'secret-test-token' }]));
  const response = await fetch(base + '/exports/unmatched.json');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(await response.json(), [expected]);
  assert.equal((await fetch(base + '/exports/erp-sync.json')).status, 404);
});
