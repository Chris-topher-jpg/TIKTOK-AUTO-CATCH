const byId = id => document.getElementById(id);
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '暂无';
let submitting = false, forceForm = false;
let rangeDirty = false, rangeSubmitting = false, collectionToday;
const dateOffset = (value, offset) => new Date(Date.parse(`${value}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const rangeLabel = (start, end) => start === end ? `${start}（单日）` : `${start} 至 ${end}`;
async function action(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tac-Action': document.querySelector('meta[name=tac-action]').content }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
function render(status) {
  const collection = status.collection;
  if (collection) {
    collectionToday = collection.today;
    for (const id of ['collection-start', 'collection-end']) byId(id).max = collection.today;
    if (!rangeDirty && !rangeSubmitting) { byId('collection-start').value = collection.start; byId('collection-end').value = collection.end; }
    byId('collection-current').textContent = `${collection.mode === 'auto' ? '自动日期（每天滚动）' : '指定日期（已保存）'}：${rangeLabel(collection.start, collection.end)}，共 ${collection.days} 天。`;
    const progress = collection.progress;
    let progressText = collection.pending ? `已排队。${collection.running ? `当前仍在采集 ${rangeLabel(collection.running.start, collection.running.end)}；` : ''}结束后自动执行新日期。` : '';
    if (!collection.pending && status.collecting) progressText = progress?.kind === 'daily'
      ? `正在采集 ${progress.date}（第 ${progress.dayIndex}/${progress.days} 天），已扫描 ${progress.scanned}${progress.total == null ? '' : `/${progress.total}`} 条。`
      : '正在读取主播身份和粉丝数，随后逐日读取音浪、时长和 ACU。';
    if (!progressText) progressText = status.lastError ? '上次采集中断，已保存的数据保留。可重新采集当前区间。' : '日期设置已保存，后台将按此设置自动采集。';
    byId('collection-progress').textContent = progressText;
    const data = collection.data;
    byId('collection-data-count').textContent = `当前区间已保存 ${data.records} 条记录，覆盖 ${data.days}/${collection.days} 天`;
    byId('collection-quality').textContent = data.records
      ? `已保存记录中：ACU 缺失 ${data.missingAcu} 条，音浪缺失 ${data.missingWaves} 条，直播时长缺失 ${data.missingDuration} 条；其他身份或精度待核对 ${data.review} 条。${data.capturedAt ? `最近采集 ${time(data.capturedAt)}。` : ''}`
      : '当前区间尚无记录，采集后将在此显示 ACU、音浪和时长的完整情况。';
    const query = new URLSearchParams({ start: collection.start, end: collection.end });
    byId('range-csv').href = '/exports/daily.csv?' + query;
    byId('range-json').href = '/exports/daily.json?' + query;
    for (const id of ['collect-range', 'collection-auto']) byId(id).disabled = rangeSubmitting;
  }
  const sync = status.sync, linked = sync.enabled && sync.stage !== 'error', waiting = ['connecting', 'waiting'].includes(sync.stage);
  const scan = status.profileProgress || status.profileScan;
  byId('profiles').textContent = status.profileScan?.identified ?? scan?.identified ?? status.profiles; byId('records').textContent = status.records; byId('queued').textContent = status.queued;
  byId('delivered').textContent = time(status.lastDelivery?.created_at);
  const queue = status.queue;
  const queueParts = queue ? [`已匹配待发送 ${queue.pending} 条`, `未匹配保留 ${queue.unbound} 条`] : [];
  if (queue?.paused) queueParts.push(`未启用发送 ${queue.paused} 条`);
  if (queue?.archived) queueParts.push(`过期快照 ${queue.archived} 条`);
  if (queue?.retrying) queueParts.push(`其中重试 ${queue.retrying} 条`);
  byId('queue-note').textContent = queueParts.length ? `${queueParts.join('，')}。待发送包含退避等待中的记录；未匹配数据不计入待发送。` : '';
  byId('unmatched-export').hidden = !sync.unmatched;
  byId('headline').textContent = status.platform.state === 'login' ? '请在浏览器中登录抖音平台' : status.lastError ? '采集需要处理' : linked ? '自动同步已开启' : waiting ? '正在准备自动同步' : '连接 ERP，开启自动同步';
  const scanned = scan?.scanned ?? scan?.count;
  const platformTotal = scan?.total ?? scan?.platformTotal;
  const progressText = scan ? `平台列表 ${scanned}${platformTotal == null ? '' : `/${platformTotal}`} 条，已识别 ${scan.identified ?? scan.count} 位，无法识别 ${scan.unidentified} 条，重复 UID ${scan.duplicates ?? 0} 条。` : '';
  byId('summary').textContent = status.collecting ? `${progressText || '正在读取平台主播列表…'} 关闭此页面也会继续。` : `每 10 分钟自动读取一次，数据变化后分批同步。关闭此页面也会继续。${progressText ? ` ${progressText}` : ''}`;
  byId('platform-status').textContent = status.platform.state === 'login' ? '已打开登录窗口。登录成功后会自动开始采集，无需再按回车。' : status.collecting ? (progressText || `正在读取，已识别 ${status.profiles} 位主播。`) : status.profiles ? `上次识别 ${status.profiles} 位主播，登录过期时点击下方按钮。` : '点击登录，在弹出的浏览器中登录平台。';
  byId('scan-details').hidden = !scan;
  if (scan) {
    byId('scan-summary').textContent = status.profileProgress ? '本轮平台扫描进度' : '最近一次完整扫描';
    const samples = scan.unidentifiedSample?.map(row => `平台第 ${row.platformRow ?? row.row} 条${row.nickname ? `：${row.nickname}` : ''}（${row.reason}）`).join('\n') || '';
    byId('scan-note').textContent = `${progressText}${samples ? `\n${samples}` : ''}`;
  }
  byId('platform-login').disabled = ['opening', 'login'].includes(status.platform.state);
  byId('erp-status').textContent = sync.message || (linked ? '已连接，之后打开即可自动同步。' : '首次连接后，以后打开就会自动同步。');
  byId('connect-form').hidden = (linked || waiting) && !forceForm;
  byId('reconnect').hidden = !(linked || waiting);
  byId('connect').disabled = submitting || waiting;
  const issue = status.lastError || (status.delivery?.status === 'retry' || status.delivery?.status === 'error' ? status.delivery.reason : null) || (sync.stage === 'error' ? sync.message : null);
  byId('issue').hidden = !issue; byId('issue').textContent = issue || '';
  let detail = null; try { detail = JSON.parse(status.lastRun?.detail || 'null'); } catch {}
  const diagnostic = detail?.diagnostic;
  byId('error-details').hidden = !diagnostic;
  if (diagnostic) {
    const lines = [];
    if (diagnostic.pagination) lines.push(`平台显示：${diagnostic.pagination}`);
    if (diagnostic.expectedStart != null) lines.push(`本轮期望从第 ${diagnostic.expectedStart} 条继续。`);
    if (diagnostic.row != null) lines.push(`中断于本页第 ${diagnostic.row} 行${diagnostic.nickname ? `：${diagnostic.nickname}` : ''}。`);
    if (diagnostic.platformTotal != null) lines.push(`平台总数 ${diagnostic.platformTotal}，当时已扫描 ${diagnostic.scanned ?? diagnostic.identifiedBeforePage ?? 0} 条。`);
    if (diagnostic.reason) lines.push(diagnostic.reason);
    byId('error-note').textContent = lines.join('\n') || '请下载核对记录查看安全诊断。';
  }
  const last = status.lastRun?.ended_at;
  byId('timing').textContent = (last ? `上一轮读取结束：${time(last)}。` : '首次完整读取可能需要几分钟。') + (status.nextRunAt ? `下一轮：${time(status.nextRunAt)}。` : status.collecting ? '正在采集…' : '') + (sync.unmatched ? ` ${sync.unmatched} 位主播未匹配，保留本机待核对。` : '');
}
async function refresh() {
  try { const response = await fetch('/status'); if (!response.ok) throw new Error(); render(await response.json()); }
  catch { byId('headline').textContent = '服务未连接'; byId('summary').textContent = '请双击“打开自动同步”，页面会自动恢复连接。'; }
}
byId('platform-login').addEventListener('click', async () => {
  byId('platform-login').disabled = true;
  try { await action('/api/platform-login'); } catch (error) { byId('connect-message').textContent = error.message; }
  await refresh();
});
byId('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); if (submitting) return; submitting = true; byId('connect').disabled = true;
  const password = byId('password').value; byId('password').value = '';
  byId('connect-message').textContent = '正在连接，请稍候…';
  try {
    const result = await action('/api/connect', { phone: byId('phone').value, password });
    forceForm = false; byId('connect-message').textContent = result.message || '连接成功';
  } catch (error) { byId('connect-message').textContent = error.message; }
  finally { submitting = false; await refresh(); }
});
byId('reconnect').addEventListener('click', () => { forceForm = true; byId('connect-form').hidden = false; byId('phone').focus(); });
for (const id of ['collection-start', 'collection-end']) byId(id).addEventListener('input', () => {
  rangeDirty = true; byId('collection-message').textContent = '日期已修改，点击“按所选日期采集”后生效。';
});
for (const [id, startOffset, endOffset] of [['date-today', 0, 0], ['date-yesterday', -1, -1], ['date-week', -6, 0]]) byId(id).addEventListener('click', () => {
  if (!collectionToday) return;
  byId('collection-start').value = dateOffset(collectionToday, startOffset); byId('collection-end').value = dateOffset(collectionToday, endOffset);
  rangeDirty = true; byId('collection-message').textContent = '日期已修改，点击“按所选日期采集”后生效。';
});
async function saveRange(value) {
  if (rangeSubmitting) return;
  rangeSubmitting = true; byId('collect-range').disabled = true; byId('collection-auto').disabled = true;
  try {
    const result = await action('/api/collection', value);
    rangeDirty = false; byId('collection-message').textContent = result.message;
  } catch (error) { byId('collection-message').textContent = error.message; }
  finally { rangeSubmitting = false; await refresh(); }
}
byId('collection-form').addEventListener('submit', event => {
  event.preventDefault();
  void saveRange({ mode: 'custom', start: byId('collection-start').value, end: byId('collection-end').value });
});
byId('collection-auto').addEventListener('click', () => { void saveRange({ mode: 'auto' }); });
byId('stop').addEventListener('click', async () => {
  byId('stop').disabled = true;
  try { await action('/api/stop'); byId('headline').textContent = '服务正在停止'; byId('summary').textContent = '记录已保留，下次双击“打开自动同步”即可恢复。'; }
  catch (error) { byId('connect-message').textContent = error.message; byId('stop').disabled = false; }
});
void refresh(); setInterval(() => { void refresh(); }, 3000);
