import { runCycle, selectedDates, validateSelection } from './runner.mjs';
import { deliverOnce } from './delivery.mjs';
import { ErpConnection } from './erp-connection.mjs';

export class Runtime {
  constructor({ store, source, config, dataDir, saved = {}, fetcher, clock = Date.now }) {
    Object.assign(this, { store, source, config, clock });
    this.selection = store.collectionSelection() || (config.start || config.end ? { mode: 'custom', start: config.start, end: config.end } : { mode: 'auto' });
    this.deliveryConfig = { endpoint: config.endpoint || 'https://erp.yeshuyu.com/api/integrations/douyin-anchor-daily',
      token: process.env.TAC_ERP_TOKEN || saved.token, targets: process.env.TAC_ERP_TOKEN ? undefined : saved.targets,
      approved: process.env.TAC_ERP_APPROVED === 'yes' || saved.enabled === true, anchorIds: saved.anchorIds, ...(fetcher ? { fetcher } : {}) };
    this.connection = new ErpConnection({ store, dataDir, saved, fetcher, onConnected: value => {
      Object.assign(this.deliveryConfig, { approved: true, targets: value.targets, token: undefined, anchorIds: undefined });
      this.deliveryCursor = 0;
      void this.deliver();
    } });
    this.failures = 0; this.mode = 'running'; this.nextRunAt = null;
  }
  status() {
    const persisted = this.store.status();
    const anchorIds = this.deliveryConfig.targets?.flatMap(target => target.anchorIds || []) ?? this.deliveryConfig.anchorIds;
    const queue = this.store.queueStatus({ at: this.clock(), anchorIds, enabled: this.deliveryConfig.approved });
    const collection = this.collectionInfo();
    return { version: '0.5.0-service', pid: process.pid, ...persisted, queued: queue.pending, localQueued: persisted.queued, queue, collecting: Boolean(this.collectTask), nextRunAt: this.nextRunAt,
      lastError: this.lastError || null, failures: this.failures, delivery: this.delivery || null,
      platform: { state: this.loginOpen ? 'login' : this.loginRequested ? 'opening' : this.lastError ? 'error' : 'ready' },
      sync: { ...this.connection.status(), enabled: this.deliveryConfig.approved },
      config: { intervalSeconds: this.config.intervalSeconds, lookbackDays: this.config.lookbackDays },
      collection: { ...collection, pending: Boolean(this.collectionRequested), running: this.runningCollection || null,
        progress: this.collectionProgress || null, data: this.store.collectionSummary(collection) },
      boundary: '每10分钟优先读取当日累计快照，历史日汇总每6小时复核；上一轮未结束不重复运行，ERP可见页面每30秒刷新。' };
  }
  collectionConfig(today = globalThis.AnchorCore.shanghaiToday()) {
    const { start, end, ...automatic } = this.config;
    return this.selection.mode === 'custom' ? { ...automatic, start: this.selection.start, end: this.selection.end, includeToday: this.selection.end === today } : automatic;
  }
  collectionInfo() {
    const today = globalThis.AnchorCore.shanghaiToday(), config = this.collectionConfig(today);
    const dates = [...selectedDates(config, today), ...(config.includeToday ? [today] : [])];
    return { ...this.selection, start: dates[0], end: dates.at(-1), days: dates.length, today, maxDays: 31,
      sourceUrl: 'https://union.bytedance.com/open/portal/data/data?appId=3000' };
  }
  selectCollection(value) {
    if (this.stopping) throw new Error('服务正在停止，请重新打开后设置日期');
    const selection = validateSelection(value);
    this.store.saveCollectionSelection(selection); this.selection = selection;
    const pending = Boolean(this.collectTask || this.loginRequested || this.loginOpen);
    this.collectionRequested = true;
    if (!pending) void this.collect();
    return { ok: true, pending, message: pending ? '日期已保存，当前采集或登录结束后自动采集所选区间。' : '日期已保存，正在采集所选区间。' };
  }
  start() { void this.collect(); void this.deliver(); }
  collect() {
    if (this.stopping || this.loginRequested || this.loginOpen || this.collectTask) return this.collectTask;
    clearTimeout(this.cycleTimer); this.nextRunAt = null;
    const started = this.clock();
    const config = { ...this.collectionConfig(), forceHistory: Boolean(this.collectionRequested) };
    this.collectionRequested = false; this.runningCollection = this.collectionInfo(); this.collectionProgress = null;
    this.collectTask = (async () => {
      try {
        await this.source.open();
        if (this.stopping || this.loginRequested) return;
        const result = await runCycle(this.store, this.source, { ...config,
          onProgress: progress => { this.collectionProgress = progress; }, onProfiles: () => { void this.connection.finish(); } });
        this.failures = 0;
        this.lastError = result.today === 'unavailable' ? `今天数据暂时无法读取：${result.todayReason}` : null;
      } catch (error) {
        if (!this.loginRequested && !this.stopping) { this.failures++; this.lastError = error.message; }
      } finally { await this.source.close(); }
    })().finally(() => {
      this.collectTask = null; this.runningCollection = null;
      if (this.stopping || this.loginRequested || this.loginOpen) return;
      // Start at ten-minute boundaries measured from this run. Long scans never
      // overlap and get a short breathing interval before the next run.
      const interval = this.failures ? Math.min(1800000, Math.max(this.config.intervalSeconds * 1000, 60000 * 2 ** Math.min(this.failures, 5))) : this.config.intervalSeconds * 1000;
      const wait = this.collectionRequested ? 0 : Math.max(30000, interval - (this.clock() - started));
      this.nextRunAt = new Date(this.clock() + wait).toISOString();
      this.cycleTimer = setTimeout(() => { void this.collect(); }, wait); this.cycleTimer.unref?.();
      void this.connection.finish();
    });
    return this.collectTask;
  }
  async deliver() {
    if (this.stopping || this.deliveryTask) return;
    clearTimeout(this.deliveryTimer);
    if (this.lastAttempt != null && this.clock() - this.lastAttempt < 30000) {
      this.deliveryTimer = setTimeout(() => { void this.deliver(); }, 30000 - (this.clock() - this.lastAttempt)); this.deliveryTimer.unref?.(); return;
    }
    this.lastAttempt = this.clock();
    this.deliveryTask = deliverOnce(this.store, { ...this.deliveryConfig, targetOffset: this.deliveryCursor || 0 });
    try { this.delivery = await this.deliveryTask; if (this.delivery.nextTarget != null) this.deliveryCursor = this.delivery.nextTarget; }
    catch (error) { this.delivery = { status: 'error', reason: error.message }; }
    finally {
      this.deliveryTask = null;
      if (!this.stopping) { this.deliveryTimer = setTimeout(() => { void this.deliver(); }, 30000); this.deliveryTimer.unref?.(); }
    }
  }
  async login() {
    if (this.stopping || this.loginRequested || this.loginOpen) return;
    this.loginRequested = true; clearTimeout(this.cycleTimer); this.nextRunAt = null;
    try {
      await this.source.close(); await this.collectTask;
      await this.source.open({ login: true }); this.loginOpen = true; this.lastError = null;
      this.loginTimer = setInterval(() => { void this.checkLogin(); }, 2000); this.loginTimer.unref?.();
    } catch (error) { this.lastError = error.message; throw error; }
    finally { this.loginRequested = false; }
  }
  async checkLogin() {
    if (this.checkingLogin || !this.loginOpen || this.stopping) return;
    this.checkingLogin = true;
    try {
      if (this.source.page?.isClosed()) {
        clearInterval(this.loginTimer); await this.source.close(); this.loginOpen = false;
        this.lastError = '平台登录窗口已关闭；需要登录时点击“登录平台”。'; return;
      }
      if (!await this.source.isLoggedIn()) return;
      clearInterval(this.loginTimer); await this.source.close(); this.loginOpen = false; this.failures = 0;
      void this.collect();
    } catch { /* A navigation during interactive login is expected. */ }
    finally { this.checkingLogin = false; }
  }
  async close() {
    this.stopping = true; clearTimeout(this.cycleTimer); clearTimeout(this.deliveryTimer); clearInterval(this.loginTimer);
    await this.source.close(); await this.collectTask; await this.deliveryTask;
    // A connection operation may still be finishing its small binding requests.
    while (this.connection.busy) await new Promise(resolve => setTimeout(resolve, 50));
    await this.connection.close();
  }
}
