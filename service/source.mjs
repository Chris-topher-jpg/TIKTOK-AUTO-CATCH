import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const profileUrl = 'https://union.bytedance.com/open/portal/anchor/list?appId=3000&audio_query_period=4&searchType=anchor&subTab=Default&tab=All';
const dailyUrl = 'https://union.bytedance.com/open/portal/data/data?appId=3000';
// Observe only report requests made by the platform UI. Do not store query
// signatures, cookies or response bodies, and never send extra API requests.
export class ReportTracker {
  constructor() { this.pending = new Map(); this.completed = null; }
  started(request) {
    const url = new URL(request.url());
    if (url.origin !== 'https://union.bytedance.com' || url.pathname !== '/ark/api/data/pugna_component/data/v2/union/data_center/anchor_list') return;
    const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('size'));
    this.pending.set(request, { beginDate: url.searchParams.get('beginDate'), endDate: url.searchParams.get('endDate'),
      start: Number.isInteger(page) && page > 0 && Number.isInteger(size) && size > 0 ? (page - 1) * size + 1 : null });
  }
  finished(request, ok) {
    const metadata = this.pending.get(request);
    if (!metadata) return;
    this.pending.delete(request);
    this.completed = { ...metadata, ok };
  }
  status() { return { pending: this.pending.size, completed: this.completed }; }
}
export class Source {
  constructor({ profileDir, channel = 'msedge', pageTimeoutMs = 120000 }) { this.profileDir = profileDir; this.channel = channel; this.pageTimeoutMs = pageTimeoutMs; this.generation = 0; }
  async open({ login = false } = {}) {
    if (this.context) throw new Error('采集浏览器已打开，不允许重复运行');
    const generation = this.generation;
    const context = await chromium.launchPersistentContext(this.profileDir, { channel: this.channel, headless: !login, viewport: { width: 1500, height: 1000 },
      args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
    if (generation !== this.generation) { await context.close(); throw Object.assign(new Error('采集已中断，保留已读取记录'), { code: 'SOURCE_CANCELLED' }); }
    this.context = context;
    this.context.setDefaultTimeout(30000);
    if (login) {
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.goto(profileUrl, { waitUntil: 'domcontentloaded' }); return;
    }
    await this.context.exposeBinding('__tacServiceDelay', async (_source, ms) => {
      if (!Number.isFinite(ms) || ms < 1 || ms > 1500) return { ok: false };
      await delay(ms); return { ok: true, clock: 'independent-service' };
    });
    this.reportTracker = new ReportTracker();
    const trackers = new WeakMap();
    this.context.on('request', request => {
      try { if (request.frame().page() !== this.page) return; } catch { return; }
      const tracker = this.reportTracker;
      tracker.started(request); trackers.set(request, tracker);
    });
    this.context.on('requestfinished', request => { trackers.get(request)?.finished(request, request.failure() == null); });
    this.context.on('requestfailed', request => { trackers.get(request)?.finished(request, false); });
    this.context.on('response', response => { if (!response.ok()) trackers.get(response.request())?.finished(response.request(), false); });
    await this.context.exposeBinding('__tacServiceReportState', source => source.page === this.page ? this.reportTracker.status() : null);
    const [core, collector] = await Promise.all(['core.js', 'collector.js'].map(file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
    const bridge = `globalThis.chrome = { runtime: { sendMessage: message => globalThis.__tacServiceDelay(message.ms), onMessage: { addListener(listener) { globalThis.__tacServiceCollect = message => new Promise(resolve => listener(message, {}, resolve)); } } } };`;
    await this.context.addInitScript({ content: `${bridge}\n${core}\n${collector}` });
    this.page = this.context.pages()[0] || await this.context.newPage();
  }
  async navigate(kind) {
    if (!this.context || this.page?.isClosed()) { await this.close({ cancel: false }); await this.open(); }
    this.reportTracker = new ReportTracker();
    await this.page.goto(kind === 'profiles' ? profileUrl : dailyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const url = new URL(this.page.url());
    if (url.origin !== 'https://union.bytedance.com' || !url.pathname.startsWith('/open/portal/')) throw Object.assign(new Error('平台需要登录或人工验证，请运行首次登录后重启后台服务'), { code: 'SOURCE_AUTH' });
    const expectedPath = kind === 'profiles' ? '/open/portal/anchor/list' : '/open/portal/data/data';
    if (url.pathname !== expectedPath) throw new Error('平台跳转到其他页面，请检查当前账号的数据权限');
  }
  async isLoggedIn() {
    if (!this.page || this.page.isClosed()) return false;
    const url = new URL(this.page.url());
    if (url.origin !== 'https://union.bytedance.com' || url.pathname !== '/open/portal/anchor/list') return false;
    return this.page.locator('.standard-components-anchor-info-v2').first().isVisible();
  }
  async collect(kind, date, onPage, onProgress) {
    const generation = this.generation;
    const ensureActive = () => {
      if (generation !== this.generation) throw Object.assign(new Error('采集已中断，保留已读取记录'), { code: 'SOURCE_CANCELLED' });
    };
    await this.navigate(kind);
    ensureActive();
    let expectedStart = 1, expectedTotal = null, pageSize = 10, replay = false;
    const seen = new Set(); this.scanProgress = null;
    for (let count = 0; count < 10000; count++) {
      let page;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          ensureActive();
          let timeout;
          // A reloaded browser must walk from page 1 back to the checkpoint.
          // Normal pages keep the short watchdog; replay gets a bounded budget
          // based on how many previously read pages it must traverse.
          const timeoutMs = this.pageTimeoutMs + (replay ? Math.min(1800000, Math.ceil((expectedStart - 1) / pageSize) * 10000) : 0);
          const watchdog = new Promise((_, reject) => { timeout = setTimeout(() => {
            reject(Object.assign(new Error(`独立采集浏览器超过 ${Math.round(timeoutMs / 1000)} 秒未返回第 ${expectedStart} 条所在页${attempt ? '，本轮停止并保留已读取记录' : '，将重开同一分页重试一次'}`), {
              code: 'SOURCE_STALLED', diagnostic: { kind, expectedStart, ...this.scanProgress }
            }));
          }, timeoutMs); });
          let result;
          try { result = await Promise.race([this.page.evaluate(message => globalThis.__tacServiceCollect(message), { type: 'COLLECT_PAGE', kind, date, expectedStart, stableProfiles: kind === 'profiles', profilePageSize: 50 }), watchdog]); }
          finally { clearTimeout(timeout); }
          ensureActive();
          if (result.error || result.retry || !result.data) throw Object.assign(new Error(result.error || '采集适配器暂未就绪'), { code: result.code, diagnostic: result.diagnostic });
          page = result.data;
          const ids = page.rows.map(row => row.anchorId);
          const rowCount = page.rowCount ?? ids.length;
          const duplicateWithinPage = ids.filter((id, index) => ids.indexOf(id) !== index);
          const duplicateAcrossPages = ids.filter(id => seen.has(id));
          const mismatch = page.start !== expectedStart || page.end - page.start + 1 !== rowCount || (expectedTotal != null && expectedTotal !== page.total) || duplicateWithinPage.length || (kind !== 'profiles' && duplicateAcrossPages.length) || (ids.length > 1 && duplicateAcrossPages.length === ids.length);
          if (mismatch) {
            const diagnostic = { kind, expectedStart, actualStart: page.start, pageEnd: page.end, pageRows: rowCount,
              identifiedOnPage: ids.length, platformTotal: page.total, previousTotal: expectedTotal,
              identifiedBeforePage: seen.size, duplicateUidSample: [...duplicateWithinPage, ...duplicateAcrossPages].slice(0, 8) };
            throw Object.assign(new Error(`分页校验失败：预期第 ${expectedStart} 条，页面显示第 ${page.start}-${page.end} 条，共 ${page.total} 条；已识别 ${seen.size} 位主播。`),
              { code: 'SOURCE_PAGINATION_MISMATCH', diagnostic });
          }
          if (kind === 'daily' && page.rows.some(row => row.date !== date)) throw new Error('业务日期不一致，停止本轮');
          page.progress = { kind, date, scanned: page.end, total: page.total, identified: new Set([...seen, ...ids]).size,
            duplicates: (this.scanProgress?.duplicates || 0) + duplicateAcrossPages.length,
            unidentified: (this.scanProgress?.unidentified || 0) + (page.unidentified?.length || 0),
            unidentifiedSample: [...(this.scanProgress?.unidentifiedSample || []), ...(page.unidentified || []).map(row => ({ platformRow: page.start + row.row - 1, ...row }))].slice(0, 12) };
          this.scanProgress = page.progress;
          pageSize = Math.max(pageSize, rowCount);
          replay = false;
          break;
        } catch (error) {
          ensureActive();
          if (error.code === 'SOURCE_STALLED') {
            await this.close({ cancel: false });
            if (attempt) throw error;
            await delay(1000);
            ensureActive();
            await this.open();
            ensureActive();
            await this.navigate(kind);
            replay = true;
            continue;
          }
          if (attempt || ['SOURCE_AUTH', 'ANCHOR_IDENTITY_UNREADABLE'].includes(error.code)) throw error;
          await delay(1000); ensureActive(); await this.navigate(kind); replay = true;
        }
      }
      ensureActive();
      const rowsToSave = kind === 'profiles' ? page.rows.filter(row => !seen.has(row.anchorId)) : page.rows;
      await onPage(rowsToSave, page.progress);
      onProgress?.(page.progress);
      for (const row of page.rows) seen.add(row.anchorId);
      expectedTotal = page.total;
      if (!page.hasNext) {
        if (page.end !== expectedTotal || this.scanProgress.scanned !== expectedTotal)
          throw Object.assign(new Error(`分页提前结束：平台共 ${expectedTotal} 条，本轮只扫描 ${this.scanProgress.scanned} 条。`),
            { code: 'SOURCE_PAGINATION_INCOMPLETE', diagnostic: { ...this.scanProgress, platformTotal: expectedTotal } });
        const identified = seen.size;
        this.scanProgress = null;
        return identified;
      }
      expectedStart = page.end + 1;
      await delay(1000);
    }
    throw new Error('分页超过安全上限，已保留已采集记录');
  }
  async close({ cancel = true } = {}) { if (cancel) this.generation++; const context = this.context; this.context = null; this.page = null; if (context) await context.close().catch(() => {}); }
}
