(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const PAGE_SIZE = 20;
  const previewMode = new URLSearchParams(location.search).has('preview');
  const hasExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  let state = { rows: [], profiles: [], job: null, settings: null, syncState: null, qualityCount: 0 };
  let page = 1;
  let previewRows = [];
  let settingsDirty = false;
  let refreshSequence = 0;
  let stateReady = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value));
  function seconds(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const total = Math.max(0, Math.round(Number(value)));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), rest = total % 60;
    return [hours ? `${hours}小时` : '', minutes ? `${minutes}分钟` : '', rest || (!hours && !minutes) ? `${rest}秒` : ''].join('') || '0秒';
  }
  function showMessage(message, tone = 'info') {
    const box = $('#message');
    box.textContent = message;
    box.className = `notice ${tone}`;
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => { box.classList.add('hidden'); }, 7000);
  }
  async function send(type, extra = {}) {
    if (!hasExtension) throw new Error('当前页面是预览模式，请在浏览器扩展中打开仪表盘。');
    if (!['STATE', 'DIAGNOSTIC'].includes(type) && (!stateReady || state.backgroundVersion !== AnchorCore.VERSION)) throw new Error('仪表盘与扩展后台版本未同步，请在扩展管理页点击“重新加载”后重新打开插件');
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response) throw new Error('扩展后台没有响应，请重新加载扩展。');
    if (response.error) throw new Error(response.error);
    return response.data;
  }
  function today() { return AnchorCore.shanghaiToday(); }
  function yesterday() { return new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10); }
  function setInitialDates() {
    const end = yesterday();
    $('#start').value = end;
    $('#end').value = end;
    $('#start').max = end;
    $('#end').max = end;
  }
  function rowQuality(row) {
    return AnchorCore.needsReview(row);
  }
  function rowStatus(row) {
    const issues = [];
    if (row.profileMissing) issues.push('缺少主播档案');
    if (row.identityMissing?.length) issues.push(`缺少${row.identityMissing.map(key => ({ douyinId: '抖音号', nickname: '昵称' }[key] || key)).join('、')}`);
    if (row.followers == null) issues.push('缺少粉丝数');
    if (row.missing?.length) issues.push(`缺少${row.missing.map(key => ({ waves: '音浪', liveSeconds: '直播时长', acu: 'ACU' }[key] || key)).join('、')}`);
    if (row.approximate?.length) issues.push(`近似值：${row.approximate.join('、')}`);
    if (row.followersApproximate) issues.push('粉丝数为近似值');
    return issues.length ? `<span class="warning" title="${escapeHtml(issues.join('；'))}">需核对</span>` : '<span class="good">完整</span>';
  }
  function visibleRows() {
    const query = $('#search').value.trim().toLocaleLowerCase();
    const rows = previewMode ? previewRows : state.rows;
    return rows.filter(row => !query || [row.nickname, row.douyinId, row.anchorId].some(value => String(value ?? '').toLocaleLowerCase().includes(query)));
  }
  function renderRows() {
    const rows = visibleRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const current = rows.slice(start, start + PAGE_SIZE);
    $('#rows').innerHTML = current.map(row => {
      const followerText = row.followers == null ? '—' : row.followersApproximate && row.followersRaw ? `≈${escapeHtml(row.followersRaw)}` : number(row.followers);
      const wavesApprox = row.approximate?.includes('waves');
      const acuApprox = row.approximate?.includes('acu');
      return `<tr>
        <td><strong>${escapeHtml(row.nickname || '—')}</strong><span class="sub">抖音号 ${escapeHtml(row.douyinId || '—')}</span></td>
        <td class="id">${escapeHtml(row.anchorId || '—')}</td><td>${escapeHtml(row.date || '—')}</td>
        <td class="numeric">${followerText}</td><td class="numeric waves">${wavesApprox ? '≈' : ''}${number(row.waves)}</td>
        <td class="numeric">${seconds(row.liveSeconds)}</td><td class="numeric">${acuApprox ? '≈' : ''}${number(row.acu)}</td><td>${rowStatus(row)}</td>
      </tr>`;
    }).join('');
    $('#empty').classList.toggle('hidden', current.length > 0);
    $('#table').classList.toggle('hidden', current.length === 0);
    $('#row-badge').textContent = `${rows.length.toLocaleString('zh-CN')} 条`;
    $('#page-label').textContent = rows.length ? `显示 ${start + 1}–${Math.min(start + current.length, rows.length)} 条 / 共 ${rows.length.toLocaleString('zh-CN')} 条` : '共 0 条记录';
    $('#page-number').textContent = `${page} / ${totalPages}`;
    $('#prev').disabled = page <= 1;
    $('#next').disabled = page >= totalPages;
    const dates = [...new Set(rows.map(row => row.date).filter(Boolean))].sort();
    $('#range-label').textContent = dates.length ? `${dates[0]}${dates.length > 1 ? ` 至 ${dates.at(-1)}` : ''}` : '暂无采集数据';
    $('#profile-count').textContent = number(previewMode ? new Set(rows.map(row => row.anchorId)).size : state.profiles.length);
    $('#daily-count').textContent = number(rows.length);
    const quality = previewMode ? rows.filter(rowQuality).length : state.qualityCount;
    $('#quality-count').textContent = number(quality);
    $('#data-note').textContent = quality ? `共 ${quality} 条记录需要核对；缺失数据留空，近似值会明确标注。` : '先预览，再同步。缺失值保留为空，不以 0 代替。';
  }
  function renderJob() {
    const job = state.job;
    const status = { running: '正在采集', paused: '已暂停', error: '采集异常', completed: '采集完成' }[job?.status] || '尚未开始';
    $('#job-status').textContent = status;
    $('#job-status').className = `badge ${job?.status || ''}`;
    $('#start-button').classList.toggle('hidden', Boolean(job && job.status === 'running'));
    $('#start-button').disabled = Boolean(job && job.status === 'running');
    $('#pause-button').classList.toggle('hidden', job?.status !== 'running');
    $('#resume-button').classList.toggle('hidden', !['paused', 'error'].includes(job?.status));
    $('#diagnostic-button').classList.toggle('hidden', !(job && (job.status === 'error' || job.diagnostic)));
    $('#start').disabled = $('#end').disabled = job?.status === 'running';
    let progress = 0, text = '选择日期范围，即可开始采集';
    if (job) {
      const units = Math.max(1, (job.days?.length || 1) + 1);
      const fraction = job.expectedTotal ? Math.min(1, Math.max(0, ((job.expectedStart || 1) - 1) / job.expectedTotal)) : 0;
      if (job.status === 'completed') progress = 100;
      else if (job.phase === 'profiles') progress = fraction / units * 100;
      else progress = (1 + (job.dayIndex || 0) + fraction) / units * 100;
      if (job.phase === 'profiles') {
        text = `主播档案 · ${number(job.profileCount)} / ${number(job.expectedTotal)} 条`;
      } else {
        const range = job.lastPage && job.lastPage.total ? `${job.lastPage.start}–${job.lastPage.end} / ${job.lastPage.total}` : `第 ${job.expectedStart || 1} 条起`;
        text = `每日数据 · ${job.days?.[job.dayIndex] || job.end} · ${range} · ${Math.min((job.dayIndex || 0) + 1, job.days?.length || 1)} / ${job.days?.length || 1} 天`;
      }
      if (job.revalidation) text = `保留已存数据，重新核对分页 · ${text}`;
      if (job.status === 'paused') text = `已暂停 · ${text}`;
      if (job.status === 'error') text = `采集遇到问题 · ${job.error || text}`;
      if (job.status === 'completed') text = `完成 · ${job.start} 至 ${job.end}`;
      if (job.status === 'running' && !job.lastPage) text = `准备${job.phase === 'profiles' ? '采集主播档案' : `采集 ${job.days?.[job.dayIndex] || ''}`}…`;
    }
    $('#progress-fill').style.width = `${Math.max(0, Math.min(100, progress))}%`;
    $('#progress-label').textContent = text;
    $('#yesterday').disabled = $('#week').disabled = job?.status === 'running';
  }
  function renderConnection() {
    if (!AnchorCore.ERP_ENABLED) {
      $('#erp-status').textContent = '暂未接入';
      $('#erp-detail').textContent = '先交付采集插件 · 不修改 ERP';
      for (const id of ['endpoint', 'auto-sync', 'save-settings', 'sync-button']) $(`#${id}`).disabled = true;
      $('#sync-button').title = 'ERP 接收接口未部署，本版本不会发送 ERP 请求';
      return;
    }
    const settings = state.settings;
    const syncState = state.syncState;
    if (!settingsDirty) {
      $('#endpoint').value = settings?.endpoint || '';
      $('#auto-sync').checked = Boolean(settings?.autoSync);
    }
    if (syncState?.status === 'completed') {
      $('#erp-status').textContent = '已同步';
      $('#erp-detail').textContent = `已接收 ${number(syncState.accepted)} 条`;
    } else if (syncState?.status === 'partial') {
      $('#erp-status').textContent = '部分接收';
      $('#erp-detail').textContent = `成功 ${number(syncState.accepted)} 条，未匹配 ${number(syncState.unmatched)} 条`;
    } else if (syncState?.status === 'running') {
      $('#erp-status').textContent = '正在同步';
      $('#erp-detail').textContent = `批次 ${syncState.batch} / ${syncState.batches} · ${number(syncState.accepted)} 条`;
    } else if (syncState?.status === 'error') {
      $('#erp-status').textContent = '同步失败';
      $('#erp-detail').textContent = syncState.error || '请检查接口配置';
    } else if (settings?.endpoint) {
      $('#erp-status').textContent = '接口已验证';
      $('#erp-detail').textContent = new URL(settings.endpoint).host;
    } else {
      $('#erp-status').textContent = '未接入';
      $('#erp-detail').textContent = '等待已批准的接收接口';
    }
    const quality = previewMode ? previewRows.filter(rowQuality).length : state.qualityCount;
    $('#sync-button').disabled = previewMode || !settings?.endpoint || state.job?.status !== 'completed' || !state.rows.length || quality > 0 || ['running'].includes(syncState?.status);
    $('#sync-button').title = quality ? '请先核对缺失或近似数据' : '';
  }
  function render() {
    renderRows(); renderJob(); renderConnection();
    if (hasExtension && !previewMode && (!stateReady || state.backgroundVersion !== AnchorCore.VERSION)) {
      for (const id of ['start-button', 'pause-button', 'resume-button', 'clear']) $(`#${id}`).disabled = true;
      $('.version').textContent = `v${AnchorCore.VERSION} / 后台${stateReady ? state.backgroundVersion || '待更新' : '连接中'}`;
      if (stateReady) $('#progress-label').textContent = '扩展后台版本未同步，请在扩展管理页重新加载插件后重新打开仪表盘。已有数据保留。';
    } else if (hasExtension && !previewMode) {
      for (const id of ['pause-button', 'resume-button', 'clear']) $(`#${id}`).disabled = false;
      $('.version').textContent = `v${AnchorCore.VERSION} / CHROME & EDGE`;
    }
    if (previewMode) $('#preview-banner').classList.remove('hidden');
    if (!hasExtension) {
      $('#start-button').disabled = $('#pause-button').disabled = $('#resume-button').disabled = true;
      $('#save-settings').disabled = $('#sync-button').disabled = $('#clear').disabled = true;
      $('#progress-label').textContent = '预览模式 · 安装扩展后即可启动采集';
      $('#erp-status').textContent = '暂未接入';
      $('#erp-detail').textContent = '采集交付版 · 不访问 ERP';
    }
  }
  async function refresh() {
    if (!hasExtension || previewMode) return;
    const sequence = ++refreshSequence;
    try { const next = await send('STATE'); if (sequence === refreshSequence) { state = next; stateReady = true; render(); } }
    catch (error) { showMessage(error.message, 'error'); }
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportRows(kind) {
    const rows = visibleRows();
    if (!rows.length) { showMessage('当前没有可导出的记录。', 'error'); return; }
    const range = previewMode ? 'preview' : state.job ? `${state.job.start}_${state.job.end}` : 'export';
    if (kind === 'csv') download(`主播每日数据_${range}.csv`, AnchorCore.csv(rows), 'text/csv;charset=utf-8');
    else download(`主播每日数据_${range}.json`, JSON.stringify(rows, null, 2), 'application/json;charset=utf-8');
    showMessage(`已导出 ${rows.length} 条记录。`, 'success');
  }
  function loadPreview() {
    const date = yesterday();
    const base = [
      ['7239051842071132180', 'douyin_zhou', '周周不加糖', 18300, '1.83万', 23560, 842],
      ['6842109231105227613', 'mumu_live', '木木的直播间', 5270, '5,270', 14905, 316],
      ['5983311702640189521', 'xiaoxiao88', '小小同学', 82000, '8.2万', 0, 0],
      ['7995018263448092540', 'a_feng_2026', '阿峰', 0, '0', 10800, 127],
      ['6319473209581267712', 'niniao777', '妮鸟', 1230000, '123万', 28350, 1902]
    ];
    previewRows = base.map(([anchorId, douyinId, nickname, followers, followersRaw, liveSeconds, acu], index) => ({
      anchorId, douyinId, nickname, followers, followersRaw, date, waves: [12880, 0, null, 4600, 982300][index], liveSeconds, acu,
      approximate: [], missing: index === 2 ? ['waves'] : [], profileMissing: false,
      followersApproximate: ['1.83万', '8.2万', '123万'].includes(followersRaw),
      raw: { waves: String([12880, 0, '', 4600, 982300][index]), liveDuration: `${Math.floor(liveSeconds / 3600)}小时`, acu: String(acu) }
    }));
    state = { ...state, rows: previewRows, profiles: previewRows, job: { status: 'completed', start: date, end: date }, qualityCount: previewRows.filter(rowQuality).length };
  }
  async function start() {
    try {
      const startDate = $('#start').value, endDate = $('#end').value;
      AnchorCore.days(startDate, endDate);
      if ((state.rows.length || state.profiles.length) && !confirm('开始新任务会替换浏览器中当前这批采集数据，是否继续？')) return;
      await send('START', { start: startDate, end: endDate });
      showMessage('任务已启动。采集标签页会在后台逐页读取。', 'success');
      await refresh();
    } catch (error) { showMessage(error.message, 'error'); }
  }
  async function command(type, successText) {
    try { await send(type); showMessage(successText, 'success'); await refresh(); }
    catch (error) { showMessage(error.message, 'error'); }
  }
  async function saveSettings() {
    try {
      const url = AnchorCore.endpoint($('#endpoint').value);
      if (!hasExtension) throw new Error('预览模式不能保存 ERP 接口。');
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) throw new Error('尚未授予访问 ERP 接收接口的权限。');
      await send('SAVE_SETTINGS', { settings: { endpoint: url.href, autoSync: $('#auto-sync').checked } });
      settingsDirty = false;
      showMessage('ERP 接收接口验证通过，设置已保存。', 'success');
      await refresh();
    } catch (error) { showMessage(error.message, 'error'); }
  }
  function init() {
    $('.version').textContent = `v${AnchorCore.VERSION} / CHROME & EDGE`;
    setInitialDates();
    if (previewMode) loadPreview();
    render();
    $('#start-button').addEventListener('click', start);
    $('#pause-button').addEventListener('click', () => command('PAUSE', '任务已暂停。'));
    $('#resume-button').addEventListener('click', () => command('RESUME', '任务已继续。'));
    $('#diagnostic-button').addEventListener('click', async () => {
      const job = state.job;
      if (!job) return;
      const fallback = {
        source: 'dashboard',
        status: job.status,
        phase: job.phase,
        range: { start: job.start, end: job.end },
        date: job.days?.[job.dayIndex] || null,
        expectedStart: job.expectedStart,
        expectedTotal: job.expectedTotal,
        lastPage: job.lastPage || null,
        profileCount: state.profiles.length,
        dailyCount: job.dailyCount || 0,
        message: String(job.error || '').slice(0, 400)
      };
      const button = $('#diagnostic-button');
      button.disabled = true;
      try {
        let details;
        try { details = await send('DIAGNOSTIC'); }
        catch (error) {
          details = { source: 'dashboard', backgroundDiagnosticError: error.message, task: fallback, failure: job.diagnostic || null, live: { available: false, reason: '后台诊断不可用，请重新加载扩展后继续' } };
        }
        download(`采集诊断_v${AnchorCore.VERSION}.json`, JSON.stringify({ version: AnchorCore.VERSION, exportedAt: new Date().toISOString(), diagnostic: details }, null, 2), 'application/json;charset=utf-8');
        showMessage(details.live?.source === 'collector' ? '已导出任务与当前表格现场诊断，不含登录凭据。' : '已导出任务诊断；当前页面尚无新版现场信息，请重新加载扩展并继续采集。', 'info');
      } finally { button.disabled = false; }
    });
    $('#yesterday').addEventListener('click', () => { $('#start').value = $('#end').value = yesterday(); });
    $('#week').addEventListener('click', () => {
      const end = yesterday();
      $('#end').value = end;
      $('#start').value = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
    });
    $('#search').addEventListener('input', () => { page = 1; renderRows(); });
    $('#prev').addEventListener('click', () => { page--; renderRows(); });
    $('#next').addEventListener('click', () => { page++; renderRows(); });
    $('#export-csv').addEventListener('click', () => exportRows('csv'));
    $('#export-json').addEventListener('click', () => exportRows('json'));
    $('#save-settings').addEventListener('click', saveSettings);
    $('#endpoint').addEventListener('input', () => { settingsDirty = true; });
    $('#auto-sync').addEventListener('change', () => { settingsDirty = true; });
    $('#sync-button').addEventListener('click', () => command('SYNC', '同步任务已完成。'));
    $('#clear').addEventListener('click', () => {
      if (!confirm('清除本地保存的主播采集记录和当前任务？')) return;
      void command('CLEAR', '本地采集数据已清除。');
    });
    if (hasExtension && !previewMode) {
      void refresh();
      setInterval(refresh, 2500);
      chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.job || changes.settings || changes.syncState)) void refresh(); });
    }
  }
  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
