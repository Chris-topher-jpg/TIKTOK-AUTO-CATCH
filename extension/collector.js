(() => {
  if (globalThis.__tacCollectorInstalled) return;
  globalThis.__tacCollectorInstalled = true;
  const C = globalThis.AnchorCore;
  let busy = false, operation = {};
  // The extension worker supplies the clock. Hidden page timers are not used
  // for collection when the worker supports this protocol.
  const sleep = async ms => {
    if (chrome.runtime.sendMessage) {
      const response = await chrome.runtime.sendMessage({ type: 'COLLECTOR_WAIT', ms });
      if (!response?.ok) throw new Error('后台计时服务未响应，请重新加载扩展后继续');
      return;
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  };
  const visible = element => {
    if (!element?.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const loadingState = () => {
    const table = C.table(document);
    const region = table?.closest('.semi-table, .semi2-table, [class*="table-container"], [class*="table-wrapper"]')
      || (table?.parentElement === document.body ? table : table?.parentElement) || table;
    const global = [...document.querySelectorAll('[class*="spin-spinning"], [aria-busy="true"]')].filter(visible);
    const local = region ? [
      ...(region.matches('[aria-busy="true"], [class*="spin-spinning"]') ? [region] : []),
      ...region.querySelectorAll('[class*="spin-spinning"], [aria-busy="true"]')
    ].filter(visible) : [];
    return { busy: local.length > 0, local, global };
  };
  function diagnostic(stage = operation.stage, extra = {}) {
    const table = C.table(document);
    const loading = loadingState();
    const pagination = document.querySelector('.standard-components-pagination-page-info, [class*="pagination-page-info"], [class*="page-info"]');
    const classes = elements => elements.slice(0, 8).map(element => String(element.getAttribute('class') || '').slice(0, 180));
    return {
      source: 'collector',
      version: C.VERSION,
      observedAt: new Date().toISOString(),
      stage,
      kind: operation.kind || null,
      date: operation.date || null,
      expectedStart: operation.expectedStart ?? null,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      tableFound: Boolean(table),
      tableClass: String(table?.getAttribute('class') || '').slice(0, 180),
      headers: [...table?.querySelectorAll('thead th') || []].slice(0, 16).map(C.text),
      rowCount: table?.querySelectorAll('tbody tr').length || 0,
      pagination: C.text(pagination).slice(0, 160),
      loading: { tableRegionCount: loading.local.length, tableRegionClasses: classes(loading.local), pageCount: loading.global.length, pageClasses: classes(loading.global) },
      wait: operation.wait || null,
      timing: operation.timing || null,
      report: operation.report || null,
      clock: chrome.runtime.sendMessage ? 'extension-worker' : 'page-fallback',
      ...extra
    };
  }
  function waitForChange(ms) {
    return new Promise(resolve => {
      const started = Date.now();
      let settled = false;
      const finish = reason => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve({ reason, elapsedMs: Math.max(0, Date.now() - started), requestedMs: ms });
      };
      // Network-driven DOM updates still notify observers in a background tab,
      // where short setTimeout calls can be deferred by tens of seconds.
      const observer = new MutationObserver(() => finish('mutation'));
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      sleep(ms).then(() => finish('timer'), () => finish('clock-error'));
    });
  }
  async function until(read, message, timeout = 22000) {
    const started = Date.now(), deadline = started + timeout;
    const timing = operation.timing = { timeoutMs: timeout, elapsedMs: 0, polls: 0, mutationWakeups: 0, timerWakeups: 0, delayedWakeups: 0, maxWakeGapMs: 0 };
    let last;
    while (true) {
      timing.polls++;
      timing.elapsedMs = Math.max(0, Date.now() - started);
      // Always inspect the DOM after waking, even if a throttled timer passed
      // the deadline. A previously observed new page may now be stable.
      try { const value = await read(); if (value) return value; } catch (error) { last = error; }
      if (Date.now() >= deadline) break;
      const wake = await waitForChange(Math.min(200, Math.max(1, deadline - Date.now())));
      if (wake.reason === 'clock-error') throw Object.assign(new Error('后台计时服务已断开，已保留断点，请重启采集服务或重新加载扩展'), { code: 'CLOCK_UNAVAILABLE', diagnostic: diagnostic(message) });
      timing[wake.reason === 'mutation' ? 'mutationWakeups' : 'timerWakeups']++;
      timing.maxWakeGapMs = Math.max(timing.maxWakeGapMs, wake.elapsedMs);
      if (wake.elapsedMs > wake.requestedMs + 5000) timing.delayedWakeups++;
    }
    if (last?.code === 'ANCHOR_IDENTITY_UNREADABLE') {
      last.diagnostic = { ...diagnostic(message), ...last.diagnostic };
      throw last;
    }
    const delayed = timing.delayedWakeups > 0;
    const error = new Error(`${message}${last ? `：${last.message}` : ''}${delayed ? '；后台响应延迟，已保留记录等待恢复' : ''}`);
    error.code = delayed ? 'PAGE_TIMER_THROTTLED' : 'TABLE_WAIT_TIMEOUT';
    error.diagnostic = diagnostic(message, { timeoutMs: timeout, lastErrorName: last?.name || null, lastErrorCode: last?.code || null });
    throw error;
  }
  const button = name => [...document.querySelectorAll('button')].find(e => visible(e) && C.text(e) === name);
  async function ensureProfileLayout(pageSize) {
    operation.stage = 'set stable profile order';
    const heading = [...C.table(document).querySelectorAll('thead th')].find(e => C.text(e) === '入会时间');
    const sorter = heading?.querySelector('[role="button"][aria-label]');
    if (!sorter) throw new Error('未找到入会时间排序控件，无法保证名单分页稳定，请更新适配器');
    if (!/ascending/i.test(sorter.getAttribute('aria-label'))) {
      const before = await stable('profiles');
      for (let attempts = 0; attempts < 3 && !/ascending/i.test(sorter.getAttribute('aria-label')); attempts++) {
        const oldOrder = sorter.getAttribute('aria-label');
        sorter.click();
        await until(() => sorter.getAttribute('aria-label') !== oldOrder, '入会时间排序未响应');
      }
      await until(() => {
        if (loadingState().busy || !/ascending/i.test(sorter.getAttribute('aria-label'))) return false;
        const value = C.snapshot(document, 'profiles');
        return (!before.hasNext || value.fingerprint !== before.fingerprint) && value.start === 1;
      }, '入会时间排序后主播行未更新');
      await stable('profiles');
    }
    const sizeControl = document.querySelector('.semi2-page-switch [role="combobox"], .semi-page-switch [role="combobox"]');
    if (!sizeControl) throw new Error('未找到每页条数控件，无法设置完整名单采集');
    if (new RegExp(`^${pageSize}\\s*条/页$`).test(C.text(sizeControl))) return;
    operation.stage = 'set profile page size';
    sizeControl.click();
    const option = await until(() => [...document.querySelectorAll('[role="option"]')].find(e => visible(e) && new RegExp(`^${pageSize}\\s*条/页$`).test(C.text(e))), '未找到每页条数选项');
    option.click();
    await until(() => {
      if (loadingState().busy) return false;
      const value = C.snapshot(document, 'profiles');
      return value.start === 1 && value.rowCount === Math.min(pageSize, value.total);
    }, '每页条数设置后主播行未更新');
  }
  async function stable(kind, date, after = null) {
    operation.stage = `stabilize ${kind} table`;
    let previous = '', since = Date.now();
    // Metric updates alone must never make old identities pass as a new page.
    const identities = page => JSON.stringify({ ids: page.rows.map(row => row.anchorId), unidentified: page.unidentified || [] });
    const previousRows = after && identities(after);
    const stats = operation.wait = { polls: 0, loadingPolls: 0, parseErrors: 0, signatureChanges: 0, staleRowPolls: 0, observedStart: null };
    return until(async () => {
      stats.polls++;
      if (loadingState().busy) { stats.loadingPolls++; since = Date.now(); return false; }
      // The service observes the UI's real report requests. Date input labels
      // commit before their data arrives, and intermediate ranges also fetch.
      const report = kind === 'daily' && globalThis.__tacServiceReportState ? await globalThis.__tacServiceReportState() : null;
      if (report) {
        operation.report = report;
        if (report.pending || !report.completed?.ok || report.completed.beginDate !== date || report.completed.endDate !== date) {
          since = Date.now(); return false;
        }
      }
      let value;
      try { value = C.snapshot(document, kind, date); }
      catch (error) { stats.parseErrors++; since = Date.now(); throw error; }
      stats.observedStart = value.start;
      if (report && report.completed.start !== value.start) { since = Date.now(); return false; }
      const currentRows = after && identities(value);
      if (after && (value.start !== after.end + 1 || currentRows === previousRows)) {
        stats.staleRowPolls++;
        since = Date.now();
        return false;
      }
      const signature = JSON.stringify(value.rows.map(({ capturedAt, ...row }) => row)) + value.fingerprint;
      if (signature !== previous) { stats.signatureChanges++; previous = signature; since = Date.now(); return false; }
      return Date.now() - since >= 1200 && value;
    }, after ? '翻页后主播行未能稳定更新，已保留断点' : '主播表格未能稳定加载，已保留断点');
  }
  async function ensureColumns() {
    const keys = ['waves', 'liveSeconds', 'acu'], names = { waves: '总音浪', liveSeconds: '开播总时长', acu: 'ACU' };
    const configured = () => keys.every(key => C.metricColumn([...C.table(document)?.querySelectorAll('thead th') || []].map(C.text), key) >= 0);
    if (configured()) return;
    const config = button('指标配置');
    if (!config) throw new Error('未找到指标配置入口');
    config.click();
    await until(() => button('确定'), '未打开指标配置');
    for (const key of keys) {
      const container = element => element.closest('.semi2-checkbox, .semi-checkbox') || element.parentElement?.parentElement?.parentElement;
      const input = [...document.querySelectorAll('input[type="checkbox"]')]
        .find(element => C.metricColumn([C.text(container(element))], key) === 0);
      const checkbox = input && container(input);
      if (!input || !checkbox) { button('取消')?.click(); throw new Error(`无法识别指标“${names[key]}”的复选框`); }
      if (!input.checked) checkbox.click();
      if (!input.checked) { button('取消')?.click(); throw new Error(`平台未启用指标“${names[key]}”，请检查账号权限`); }
    }
    button('确定').click();
    await until(() => !button('取消') && configured(), 'ACU、音浪或时长列未生效');
  }
  async function selectDay(date) {
    const start = document.querySelector('input[placeholder="开始日期"]'), end = document.querySelector('input[placeholder="结束日期"]');
    if (!start || !end) throw new Error('日期控件已变化，请更新适配器');
    if (start.value === date && end.value === date) return;
    operation.stage = `select report date ${date}`;
    const cells = () => [...document.querySelectorAll('[role="gridcell"][aria-label]')].filter(visible);
    start.click();
    // Semi renders its popup asynchronously. Hidden calendar controls can exist
    // before the opening animation finishes and must not drive navigation.
    await until(() => cells().length, '日期日历未打开');
    // Navigate the calendar using its public controls rather than changing React internals.
    const targetMonth = date.slice(0, 7);
    for (let attempt = 0; attempt < 120; attempt++) {
      const cell = cells().find(e => e.getAttribute('aria-label') === date);
      if (cell && cell.getAttribute('aria-disabled') !== 'true' && !cell.classList.contains('semi2-datepicker-day-disabled')) {
        cell.click();
        // Two synchronous clicks are both handled as the start of a range.
        // Yield to React before selecting the end, even when start was already
        // the requested day, then confirm the public input has committed.
        await sleep(100);
        const second = await until(() => start.value === date && cells().find(e => e.getAttribute('aria-label') === date), '无法选择结束日期');
        if (second.getAttribute('aria-disabled') === 'true' || second.classList.contains('semi2-datepicker-day-disabled')) throw new Error('平台不允许选择该日期');
        second.click();
        await until(() => start.value === date && end.value === date && !cells().length, '日期范围未应用');
        await sleep(1500);
        return;
      }
      const months = [...document.querySelectorAll('button')].filter(visible).map(e => C.text(e)).filter(t => /^\d{4}年\s*\d{1,2}月$/.test(t));
      const parsedMonths = months.map(value => value.match(/(\d{4})年\s*(\d{1,2})月/)).filter(Boolean)
        .map(parts => `${parts[1]}-${parts[2].padStart(2, '0')}`).sort();
      if (!parsedMonths.length) throw new Error('日历月份结构已变化');
      if (cell) {
        const [year, month] = date.split('-').map(Number);
        const cellMonth = `${year}-${String(month).padStart(2, '0')}`;
        if (parsedMonths.includes(cellMonth)) throw new Error('平台不允许选择该日期');
      }
      const direction = targetMonth < parsedMonths[0] ? 'Previous month' : 'Next month';
      const control = [...document.querySelectorAll(`button[aria-label="${direction}"]`)].find(visible);
      if (!control || control.disabled) throw new Error('无法切换日历月份');
      const before = cells().map(e => e.getAttribute('aria-label')).join(',');
      control.click();
      await until(() => cells().length && cells().map(e => e.getAttribute('aria-label')).join(',') !== before, '切换月份后日历未更新');
    }
    throw new Error('日期超出日历支持的查找范围');
  }
  async function nextPage(kind, date, previous) {
    operation.stage = `wait for ${kind} page ${previous.end + 1}`;
    const next = document.querySelector('.semi-page-next, .semi2-page-next, button[aria-label="Next"]');
    if (!next || !previous.hasNext) throw new Error('没有下一页');
    for (const cell of C.table(document)?.querySelectorAll('[data-tac-exact]') || []) cell.removeAttribute('data-tac-exact');
    next.click();
    return stable(kind, date, previous);
  }
  async function exactMetrics(kind) {
    operation.stage = `read exact ${kind} metrics`;
    const table = C.table(document);
    const headers = [...table.querySelectorAll('thead th')].map(e => C.text(e).toLowerCase());
    const indexes = (kind === 'profiles' ? ['followers'] : ['waves', 'acu']).map(key => C.metricColumn(headers, key)).filter(i => i >= 0);
    const tooltipSelector = '[role="tooltip"], .semi-tooltip-wrapper, .semi2-tooltip-wrapper';
    for (const row of table.querySelectorAll('tbody tr')) for (const index of indexes) {
      const cell = row.cells[index];
      cell?.removeAttribute('data-tac-exact');
      if (!C.numeric(C.text(cell)).approximate) continue;
      // Profiles use linked Semi2 tooltips; daily reports use unlinked legacy tooltips.
      const trigger = cell.querySelector('[data-popupid]') || cell.querySelector('span') || cell;
      const before = new Map([...document.querySelectorAll(tooltipSelector)].filter(visible).map(e => [e, C.text(e)]));
      const id = trigger.getAttribute('data-popupid') || trigger.getAttribute('aria-describedby');
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      try {
        await until(() => {
          const linked = id && document.getElementById(id);
          // A legacy tooltip must be newly shown or changed for this trigger.
          const candidates = linked ? [linked] : [...document.querySelectorAll(tooltipSelector)].filter(e => !before.has(e) || before.get(e) !== C.text(e));
          const exact = candidates.filter(visible).map(C.text).map(C.numeric).filter(n => n.value != null && !n.approximate);
          if (new Set(exact.map(n => n.value)).size !== 1) return false;
          cell.setAttribute('data-tac-exact', exact[0].raw);
          return true;
        }, '平台没有精确数值提示', 1200);
      } catch (error) {
        // Keep the approximate flag when the platform provides no exact value.
      }
      finally {
        trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        await sleep(100);
      }
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'COLLECTOR_INFO') { reply({ collectorVersion: C.VERSION }); return; }
    if (message?.type === 'COLLECTOR_DIAGNOSTIC') {
      reply({ collectorVersion: C.VERSION, diagnostic: diagnostic(busy ? operation.stage : 'read current table without collecting') });
      return;
    }
    if (message?.type !== 'COLLECT_PAGE') return;
    if (busy) { reply({ collectorVersion: C.VERSION, error: '页面正在采集，请稍后重试', diagnostic: diagnostic() }); return; }
    busy = true;
    (async () => {
      const { kind, date, expectedStart } = message;
      operation = { kind, date, expectedStart, stage: 'check collection page' };
      const expectedPath = kind === 'profiles' ? '/open/portal/anchor/list' : '/open/portal/data/data';
      if (location.pathname !== expectedPath) return { retry: true };
      if (message.documentAfter && performance.timeOrigin < message.documentAfter) return { retry: true };
      operation.stage = 'wait for the collection table';
      await until(() => C.table(document) && !loadingState().busy, '未检测到登录后的主播表格');
      if (kind === 'profiles' && message.stableProfiles) await ensureProfileLayout(message.profilePageSize || 50);
      if (kind === 'daily') { await ensureColumns(); await selectDay(date); }
      let page = await stable(kind, date);
      if (page.start > expectedStart) throw new Error('采集页面被手动翻动，请从头重新采集');
      while (page.start < expectedStart) page = await nextPage(kind, date, page);
      if (page.start !== expectedStart) throw new Error('分页位置与断点不一致');
      await exactMetrics(kind);
      if (kind === 'daily') {
        const inputs = [...document.querySelectorAll('input[placeholder="开始日期"],input[placeholder="结束日期"]')];
        if (inputs.length !== 2 || inputs.some(e => e.value !== date)) throw new Error('日期在采集中改变，已停止');
        if (globalThis.__tacServiceReportState) {
          const report = operation.report = await globalThis.__tacServiceReportState();
          if (!report || report.pending || !report.completed?.ok || report.completed.beginDate !== date || report.completed.endDate !== date || report.completed.start !== page.start)
            throw new Error('日数据请求在读取指标期间发生变化，已停止以避免误用旧日期或旧页数据');
        }
      }
      const result = C.snapshot(document, kind, date);
      if (result.fingerprint !== page.fingerprint) throw new Error('读取精确指标期间主播行发生变化，已保留断点');
      return result;
    })().then(data => { busy = false; reply(data?.retry ? { collectorVersion: C.VERSION, retry: true } : { collectorVersion: C.VERSION, data }); }, error => {
      const details = diagnostic(operation.stage);
      busy = false;
      reply({ collectorVersion: C.VERSION, code: error.code || null, error: error.message, diagnostic: { ...details, ...(error.diagnostic || {}) } });
    });
    return true;
  });
})();
