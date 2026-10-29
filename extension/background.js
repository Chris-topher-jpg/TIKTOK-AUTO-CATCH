import './core.js';
import { putRows, getRows, clearData } from './database.js';
const C = globalThis.AnchorCore;
const PROFILES_URL = 'https://union.bytedance.com/open/portal/anchor/list?appId=3000&tab=All&subTab=Default';
const DAILY_URL = 'https://union.bytedance.com/open/portal/data/data?appId=3000';
let pumping = false, syncing = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = async () => (await chrome.storage.local.get(['job', 'settings', 'syncState']));
const saveJob = job => chrome.storage.local.set({ job: { ...job, updatedAt: new Date().toISOString() } });
const needsReview = C.needsReview;
const taskDiagnostic = (job, error) => ({
  version: C.VERSION,
  source: 'background',
  phase: job.phase,
  date: job.days?.[job.dayIndex] || null,
  range: { start: job.start, end: job.end },
  expectedStart: job.expectedStart,
  expectedTotal: job.expectedTotal,
  lastPage: job.lastPage || null,
  profileCount: job.profileCount || 0,
  dailyCount: job.dailyCount || 0,
  checkpointVersion: job.checkpointVersion || null,
  verifiedCount: job.seenAnchorIds?.length ?? null,
  backgroundVersion: C.VERSION,
  lastAttemptVersion: job.lastAttemptVersion || null,
  message: String(error?.message || '采集失败').slice(0, 400)
});
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (response.status === 401) throw new Error('请先在同一浏览器登录 ERP，再重试');
  if (response.status === 403) throw new Error('当前 ERP 账号无同步权限');
  if (response.status === 404) throw new Error('ERP 接收接口尚未部署；请先批准接入修改，首页网址不能作为接收接口');
  if (!response.ok) throw new Error(`ERP 返回 HTTP ${response.status}，同步未完成`);
  let data;
  try { data = await response.json(); } catch { throw new Error('ERP 未返回有效 JSON'); }
  return data;
}
async function checkConnection(settings) {
  const endpoint = C.endpoint(settings?.endpoint || '');
  if (!(await chrome.permissions.contains({ origins: [`${endpoint.origin}/*`] }))) throw new Error('请先点击“保存并验证接口”授权 ERP 站点');
  const data = await request(endpoint.href);
  if (data.protocol !== 'douyin-anchor-daily/v1') throw new Error('接口协议不匹配，不能把数据发送到此地址');
  return data;
}
async function dataset(job) {
  if (!job) return [];
  const [profiles, daily] = await Promise.all([getRows('profiles', job.id), getRows('daily', job.id)]);
  return C.merge(profiles, daily).sort((a, b) => b.date.localeCompare(a.date) || (b.waves ?? -1) - (a.waves ?? -1));
}
async function sync() {
  if (!C.ERP_ENABLED) throw new Error('按你的要求暂不接入 ERP，请先导出数据；本版本不会请求 ERP');
  if (syncing) throw new Error('ERP 同步正在进行');
  syncing = true;
  try {
    const { job, settings } = await state();
    if (job?.status !== 'completed') throw new Error('请先完成整批采集，再同步 ERP');
    await checkConnection(settings);
    const endpoint = C.endpoint(settings.endpoint);
    const records = await dataset(job);
    if (!records.length || records.some(needsReview)) throw new Error('存在缺失或近似的数据，请导出核对；为避免写入错误数据，ERP 同步已阻止');
    const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
    let accepted = 0, unmatched = [];
    const batches = Math.ceil(records.length / 100);
    for (let offset = 0; offset < records.length; offset += 100) {
      const rows = records.slice(offset, offset + 100);
      const body = { protocol: 'douyin-anchor-daily/v1', runId: job.id, range: { start: job.start, end: job.end }, records: rows };
      const result = await request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': await digest(body) }, body: JSON.stringify(body) });
      if (!Number.isInteger(result.accepted) || !Array.isArray(result.unmatched) || result.accepted + result.unmatched.length !== rows.length) throw new Error('ERP 返回数量不一致，请核对接收端；已接收批次可安全重试');
      accepted += result.accepted; unmatched.push(...result.unmatched);
      await chrome.storage.local.set({ syncState: { status: 'running', accepted, unmatched: unmatched.length, batch: offset / 100 + 1, batches, updatedAt: new Date().toISOString() } });
    }
    await chrome.storage.local.set({ syncState: { status: unmatched.length ? 'partial' : 'completed', accepted, unmatched: unmatched.length, unmatchedRecords: unmatched, updatedAt: new Date().toISOString() } });
  } catch (error) {
    const previous = (await state()).syncState;
    await chrome.storage.local.set({ syncState: { ...previous, status: 'error', error: error.message, updatedAt: new Date().toISOString() } });
    throw error;
  } finally { syncing = false; }
}
async function collectPage(job) {
  const url = job.phase === 'profiles' ? PROFILES_URL : DAILY_URL;
  const tab = await chrome.tabs.get(job.tabId);
  if (!tab.url) throw new Error('采集标签页没有地址，请点击“继续采集”重建标签页');
  let tabUrl;
  try { tabUrl = new URL(tab.url); } catch { throw new Error('采集标签页地址无效，请点击“继续采集”重建标签页'); }
  if (tabUrl.hostname !== 'union.bytedance.com') throw new Error('采集标签页被切换到其他网站，请在直播服务平台标签页登录后继续');
  if (!tabUrl.pathname.startsWith('/open/portal/')) throw new Error('直播服务平台登录状态失效，请在采集标签页完成登录后再点击“继续采集”');
  const correctPath = new URL(url).pathname;
  if (new URL(tab.url).pathname !== correctPath) await chrome.tabs.update(job.tabId, { url });
  let error, refreshed = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const loaded = await chrome.tabs.get(job.tabId);
      if (loaded.status === 'loading' || new URL(loaded.url).pathname !== correctPath) { await sleep(500); continue; }
      const info = await chrome.tabs.sendMessage(job.tabId, { type: 'COLLECTOR_INFO' }).catch(() => null);
      if (info?.collectorVersion !== C.VERSION) {
        if (!refreshed) {
          refreshed = true;
          job.documentAfter = Date.now();
          await chrome.tabs.reload(job.tabId);
          await sleep(500);
          continue;
        }
        throw Object.assign(new Error('采集页面适配器版本未更新，请在扩展管理页重新加载插件后继续'), {
          fromCollector: true,
          diagnostic: { source: 'background', stage: 'collector version check', backgroundVersion: C.VERSION, collectorVersion: info?.collectorVersion || null }
        });
      }
      const result = await chrome.tabs.sendMessage(job.tabId, { type: 'COLLECT_PAGE', kind: job.phase, date: job.days[job.dayIndex], expectedStart: job.expectedStart, documentAfter: job.documentAfter });
      if (result?.retry) { await sleep(500); continue; }
      if (result?.collectorVersion !== C.VERSION) throw Object.assign(new Error('采集页面响应版本不一致，已停止并保留数据'), { fromCollector: true });
      if (result.error) throw Object.assign(new Error(result.error), { fromCollector: true, code: result.code, diagnostic: result.diagnostic || null });
      return result.data;
    } catch (caught) {
      error = caught;
      if (caught.fromCollector) throw caught;
      await sleep(500);
    }
  }
  throw new Error(`无法连接采集页面，请确认登录并重新加载标签页：${error?.message || ''}`);
}
async function ensureCheckpoint(job) {
  if (job.checkpointVersion === 1 && Array.isArray(job.seenAnchorIds) && new Set(job.seenAnchorIds).size === job.seenAnchorIds.length && job.seenAnchorIds.length === job.expectedStart - 1) return;
  const saved = await getRows(job.phase, job.id);
  const date = job.days[job.dayIndex];
  const current = job.phase === 'profiles' ? saved : saved.filter(row => row.date === date);
  job.revalidation = { reason: '旧断点缺少逐页身份校验或数量不一致，保留已有记录并重新核对当前阶段', previousStart: job.expectedStart, savedCount: current.length };
  job.expectedStart = 1;
  job.expectedTotal = null;
  job.lastPage = null;
  job.checkpointVersion = 1;
  job.seenAnchorIds = [];
  if (job.phase === 'profiles') job.profileCount = current.length;
  job.documentAfter = Date.now();
  await chrome.tabs.update(job.tabId, { url: job.phase === 'profiles' ? PROFILES_URL : DAILY_URL });
  const latest = (await state()).job;
  if (latest?.id === job.id) { job.status = latest.status; await saveJob(job); }
}
function verifyPage(job, page) {
  if (job.expectedTotal != null && page.total !== job.expectedTotal) throw new Error('平台主播总数在采集中变化，请重新核对当前批次');
  if (page.start !== job.expectedStart || page.end - page.start + 1 !== page.rows.length) throw new Error('分页断点或行数不匹配');
  const seen = new Set(job.seenAnchorIds);
  const ids = page.rows.map(row => row.anchorId);
  const repeated = ids.filter(id => seen.has(id));
  if (repeated.length || new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('新页含有已采集的主播 ID，已阻止重复页并保留断点'), {
      code: 'PAGE_REPEATED',
      diagnostic: { source: 'background', stage: 'verify page identity', expectedStart: job.expectedStart, repeatedCount: repeated.length, verifiedCount: seen.size, incomingPage: { start: page.start, end: page.end, total: page.total } }
    });
  }
  if (job.phase === 'daily' && page.rows.some(row => row.date !== job.days[job.dayIndex])) throw new Error('报表日期与当前任务不一致');
  return ids;
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const { job } = await state();
      if (job?.status !== 'running') break;
      try {
        await ensureCheckpoint(job);
        if (job.status !== 'running') break;
        job.lastAttemptVersion = C.VERSION;
        let page, ids;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            page = await collectPage(job);
            ids = verifyPage(job, page);
            break;
          } catch (error) {
            const latest = (await state()).job;
            if (attempt || !['TABLE_WAIT_TIMEOUT', 'PAGE_REPEATED', 'PAGE_TIMER_THROTTLED'].includes(error.code) || latest?.id !== job.id || latest.status !== 'running') throw error;
            const foreground = error.code === 'PAGE_TIMER_THROTTLED';
            job.lastRetry = { at: new Date().toISOString(), code: error.code, foreground, diagnostic: error.diagnostic || taskDiagnostic(job, error) };
            const current = (await state()).job;
            if (current?.id !== job.id || current.status !== 'running') throw error;
            await saveJob({ ...current, lastRetry: job.lastRetry, lastAttemptVersion: C.VERSION });
            job.documentAfter = Date.now();
            if (foreground) await chrome.tabs.update(job.tabId, { active: true });
            await chrome.tabs.reload(job.tabId);
            await sleep(1000);
          }
        }
        const checkpoint = (await state()).job;
        if (checkpoint?.id !== job.id || !['running', 'paused'].includes(checkpoint.status)) break;
        await putRows(job.phase, job.id, page.rows);
        job.seenAnchorIds.push(...ids);
        job.expectedTotal = page.total;
        job.lastPage = { start: page.start, end: page.end, total: page.total };
        job.error = '';
        job.diagnostic = null;
        if (job.phase === 'profiles') job.profileCount = page.end;
        else job.dailyCount = job.dayIndex * page.total + page.end;
        if (page.hasNext) job.expectedStart = page.end + 1;
        else {
          const saved = await getRows(job.phase, job.id);
          const current = job.phase === 'profiles' ? saved : saved.filter(row => row.date === job.days[job.dayIndex]);
          if (current.length !== page.total) throw new Error('本地保存数量与平台总数不符，请重采');
          // Historical reports can include former members absent from today's roster.
          // Keep their daily metrics; merge() flags missing current profile/followers.
          if (job.phase === 'profiles') job.phase = 'daily';
          else job.dayIndex++;
          job.expectedStart = 1; job.expectedTotal = null;
          job.seenAnchorIds = [];
          job.revalidation = null;
          // Reload between dates: restores page 1, removes transient column tooltips and filters.
          if (job.dayIndex < job.days.length) {
            job.documentAfter = Date.now();
            await chrome.tabs.update(job.tabId, { url: DAILY_URL });
          }
          else { job.status = 'completed'; job.completedAt = new Date().toISOString(); }
        }
        const latest = (await state()).job;
        if (latest?.id !== job.id) break;
        if (latest.status === 'paused' && job.status !== 'completed') job.status = 'paused';
        await saveJob(job);
        if (job.status === 'completed') {
          if (C.ERP_ENABLED && (await state()).settings?.autoSync) await sync().catch(() => {});
          break;
        }
        await sleep(1000);
      } catch (error) {
        const current = (await state()).job;
        if (current?.id === job.id && current.status === 'running') {
          const failed = { ...current, lastAttemptVersion: C.VERSION };
          await saveJob({ ...failed, status: 'error', error: error.message, diagnostic: { ...taskDiagnostic(failed, error), ...(error.diagnostic || {}), task: taskDiagnostic(failed, error) } });
        }
        break;
      }
    }
  } finally { pumping = false; }
}
async function handle(message) {
  if (message.type === 'DIAGNOSTIC') {
    const { job } = await state();
    if (!job) throw new Error('没有可导出诊断的任务');
    const [profiles, daily] = await Promise.all([getRows('profiles', job.id), getRows('daily', job.id)]);
    let live;
    try {
      const response = await chrome.tabs.sendMessage(job.tabId, { type: 'COLLECTOR_DIAGNOSTIC' });
      live = response?.diagnostic ? { ...response.diagnostic, collectorVersion: response.collectorVersion } : { available: false, reason: '当前标签页没有支持现场诊断的适配器，请重新加载插件并继续采集' };
    } catch { live = { available: false, reason: '当前采集标签页已关闭或未加载适配器' }; }
    return {
      source: 'background',
      backgroundVersion: C.VERSION,
      exportedAt: new Date().toISOString(),
      task: { ...taskDiagnostic(job, new Error(job.error || '')), status: job.status, updatedAt: job.updatedAt || null, revalidation: job.revalidation || null },
      savedCounts: { profiles: profiles.length, daily: daily.length },
      failure: job.diagnostic || null,
      failureNote: job.diagnostic ? null : '此错误没有保存采集器现场信息，可能来自更新前的任务；页面版本号不能证明旧错误已重新运行',
      live,
      lastRetry: job.lastRetry || null
    };
  }
  if (message.type === 'STATE') {
    const value = await state();
    const rows = await dataset(value.job);
    const profiles = value.job ? await getRows('profiles', value.job.id) : [];
    return { ...value, backgroundVersion: C.VERSION, rows, profiles, qualityCount: rows.filter(needsReview).length };
  }
  if (message.type === 'START') {
    const old = (await state()).job;
    if (old?.status === 'running' || pumping || syncing) throw new Error('已有任务正在运行');
    const range = C.days(message.start, message.end);
    // Only retain one run; no hidden history of business data.
    await clearData();
    const tab = await chrome.tabs.create({ url: PROFILES_URL, active: false });
    await saveJob({ id: crypto.randomUUID(), start: message.start, end: message.end, days: range, dayIndex: 0, phase: 'profiles', expectedStart: 1, expectedTotal: null, tabId: tab.id, status: 'running', profileCount: 0, dailyCount: 0, checkpointVersion: 1, seenAnchorIds: [] });
    await chrome.storage.local.remove('syncState');
    void pump(); return { ok: true };
  }
  if (message.type === 'PAUSE') {
    const { job } = await state(); if (job?.status === 'running') await saveJob({ ...job, status: 'paused' }); return { ok: true };
  }
  if (message.type === 'RESUME') {
    const { job } = await state();
    if (!job || !['paused', 'error'].includes(job.status)) throw new Error('没有可继续的任务');
    if (pumping) throw new Error('上一页仍在结束，请稍后重试继续');
    const expectedUrl = job.phase === 'profiles' ? PROFILES_URL : DAILY_URL;
    const failure = job.diagnostic;
    // Older diagnostics have no wake-gap measurement. Sparse checks over a
    // whole timeout in a hidden document are enough to prefer a visible retry.
    const sparseHiddenChecks = failure?.visibilityState === 'hidden' && failure.timeoutMs >= 22000
      && failure.wait?.polls > 0 && failure.wait.polls < failure.timeoutMs / 1000;
    const foreground = failure?.timing?.delayedWakeups > 0 || sparseHiddenChecks;
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (!tab.url || new URL(tab.url).hostname !== 'union.bytedance.com') throw new Error('recreate-collection-tab');
      // Reload our collection page even at the same URL so an extension update
      // cannot leave the task talking to an old adapter in an already-open tab.
      job.documentAfter = Date.now();
      await chrome.tabs.update(job.tabId, { url: expectedUrl, ...(foreground ? { active: true } : {}) });
    }
    catch {
      job.documentAfter = Date.now();
      const tab = await chrome.tabs.create({ url: expectedUrl, active: foreground });
      job.tabId = tab.id;
    }
    await saveJob({ ...job, status: 'running', error: '' }); void pump(); return { ok: true };
  }
  if (message.type === 'SAVE_SETTINGS') {
    if (!C.ERP_ENABLED) throw new Error('ERP 接入暂未启用，需另行批准接收端改动');
    const url = C.endpoint(message.settings.endpoint);
    const settings = { endpoint: url.href, autoSync: Boolean(message.settings.autoSync) };
    await checkConnection(settings);
    await chrome.storage.local.set({ settings }); return { ok: true };
  }
  if (message.type === 'SYNC') { await sync(); return { ok: true }; }
  if (message.type === 'CLEAR') {
    if (pumping || syncing || (await state()).job?.status === 'running') throw new Error('请先暂停并等待当前页完成，再清除');
    await clearData(); await chrome.storage.local.remove(['job', 'syncState']); return { ok: true };
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'COLLECTOR_WAIT') {
    if (sender.id !== chrome.runtime.id || sender.tab?.id == null) return;
    let url; try { url = new URL(sender.url); } catch { return; }
    if (url.origin !== 'https://union.bytedance.com' || !url.pathname.startsWith('/open/portal/')) return;
    const ms = message.ms;
    if (!Number.isFinite(ms) || ms < 1 || ms > 1500) { reply({ ok: false }); return; }
    state().then(async ({ job }) => {
      if (job?.tabId !== sender.tab.id || !['running', 'paused'].includes(job.status)) { reply({ ok: false }); return; }
      await sleep(ms); reply({ ok: true, clock: 'extension-worker' });
    }).catch(() => reply({ ok: false }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('dashboard.html'))) return;
  handle(message).then(data => reply({ data })).catch(error => reply({ error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); });
chrome.alarms.create('collection-watchdog', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'collection-watchdog') void pump(); });
chrome.runtime.onStartup.addListener(() => { void pump(); });
