import { batchKey, PROTOCOL, SNAPSHOT_PROTOCOL } from './store.mjs';
export function validateEndpoint(value) {
  const url = new URL(value);
  if (url.origin !== 'https://erp.yeshuyu.com' || url.pathname !== '/api/integrations/douyin-anchor-daily' || url.username || url.password || url.search || url.hash) throw new Error('只能使用已批准的 ERP 逐日接收接口');
  return url.href;
}
export async function deliverOnce(store, { endpoint, token, approved = false, anchorIds, targets, targetOffset = 0, fetcher = fetch } = {}) {
  if (!approved) return { status: 'disabled', reason: '尚未启用 ERP 同步，数据保存在本地队列' };
  validateEndpoint(endpoint);
  if (targets !== undefined) {
    if (!Array.isArray(targets) || !targets.length || targets.some(target => !Array.isArray(target.anchorIds))) throw new Error('同步授权范围无效，请重新连接 ERP');
    const seen = new Set();
    for (const target of targets) for (const id of target.anchorIds) {
      if (seen.has(id)) throw new Error('主播对应多个同步授权，请重新连接 ERP');
      seen.add(id);
    }
    // One small batch per tick for all scopes combined. Rotate after errors too,
    // so one unavailable guild cannot block the other exact identity matches.
    for (let offset = 0; offset < targets.length; offset++) {
      const index = ((targetOffset + offset) % targets.length + targets.length) % targets.length;
      const target = targets[index], snapshots = store.pending(Date.now(), 50, target.anchorIds, true);
      const batch = snapshots.length ? snapshots : store.pending(Date.now(), 50, target.anchorIds);
      if (!batch.length) continue;
      return { ...await deliverBatch(store, batch, { endpoint, token: target.token, fetcher }), nextTarget: (index + 1) % targets.length };
    }
    return { status: 'idle' };
  }
  const snapshots = store.pending(Date.now(), 50, anchorIds, true);
  const batch = snapshots.length ? snapshots : store.pending(Date.now(), 50, anchorIds);
  return deliverBatch(store, batch, { endpoint, token, fetcher });
}
async function deliverBatch(store, batch, { endpoint, token, fetcher }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('请在环境变量中配置专用 ERP 集成令牌');
  if (!batch.length) return { status: 'idle' };
  const key = batchKey(batch);
  const protocol = JSON.parse(batch[0].body).provisional ? SNAPSHOT_PROTOCOL : PROTOCOL;
  try {
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ protocol, records: batch.map(row => JSON.parse(row.body)) }) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const reason = [401, 403, 409, 429, 503].includes(response.status) && typeof failure.error === 'string' ? ': ' + failure.error.slice(0, 160) : '';
      throw new Error(`ERP HTTP ${response.status}${reason}`);
    }
    const result = await response.json();
    if (result.protocol !== protocol || result.accepted !== batch.length || !Array.isArray(result.unmatched) || result.unmatched.length) throw new Error('ERP 未完整确认批次，保留队列等待核对');
    store.delivered(batch, key); return { status: 'delivered', count: batch.length };
  } catch (error) { store.fail(batch, error.message); return { status: 'retry', reason: error.message }; }
}
