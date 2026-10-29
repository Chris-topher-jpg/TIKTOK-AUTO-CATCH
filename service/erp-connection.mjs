import { writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = 'https://erp.yeshuyu.com', path = '/api/integrations/douyin-anchor-daily';
const manager = user => user?.level === 'generalManager' || user?.level === 'head' && user?.dept === '运营';

// An integration scope for exact matches whose ERP archive has no guild yet.
// This labels only the integration tables; it never sets platformGuild.
export const UNGROUPED_SCOPE = 'douyin-auto-sync';
export function syncTargets(saved) {
  return Array.isArray(saved.targets) ? saved.targets : saved.token ? [saved] : [];
}
export function matchProfiles(profiles, anchors) {
  // Game suffixes and nicknames can change; only UID and Douyin account
  // identify the existing ERP archive. Names never gate an identity match.
  const candidates = profiles.map(profile => {
    const matches = anchors.filter(anchor => anchor.unionAnchorId === profile.anchorId || profile.douyinId && anchor.douyinId === profile.douyinId);
    const anchor = matches.length === 1 ? matches[0] : null;
    return { profile, anchor, matches: matches.length };
  });
  const plan = [], unmatched = [];
  for (const { profile, anchor, matches } of candidates) {
    let reason;
    if (!profile.douyinId) reason = '平台未提供完整抖音号';
    else if (matches > 1) reason = '多个 ERP 档案命中相同 UID 或抖音号';
    else if (!anchor) reason = 'ERP 尚无相同 UID 或抖音号的档案';
    else if (anchor.douyinId !== profile.douyinId || anchor.unionAnchorId && anchor.unionAnchorId !== profile.anchorId) reason = 'UID 或抖音号与 ERP 档案冲突';
    else if (anchor.businessLine === 'club' || anchor.dept && anchor.dept !== '运营') reason = '档案不在运营接入范围';
    else if (candidates.filter(item => item.anchor?.id === anchor.id).length > 1) reason = '多个平台 UID 命中同一个 ERP 档案';
    const agency = anchor?.platformGuild || UNGROUPED_SCOPE;
    if (!reason && (typeof agency !== 'string' || agency.trim() !== agency || agency.length > 120)) reason = 'ERP 档案的公会登记格式异常';
    if (reason) unmatched.push({ anchorId: profile.anchorId, douyinId: profile.douyinId, nickname: profile.nickname, reason });
    else plan.push({ agency, anchorId: profile.anchorId, erpAnchorId: anchor.id, douyinId: profile.douyinId });
  }
  const agencies = [...new Set(plan.map(binding => binding.agency))];
  return { agency: agencies.length === 1 ? agencies[0] : null, agencies, plan, unmatched };
}

// ERP passwords exist only during this login request. Only the revocable,
// agency-scoped machine token is persisted; browser code never receives it.
export class ErpConnection {
  constructor({ store, dataDir, saved = {}, fetcher = fetch, onConnected = () => {} }) {
    Object.assign(this, { store, dataDir, fetcher, onConnected });
    const targets = syncTargets(saved);
    this.state = { stage: saved.enabled ? 'connected' : 'disconnected', agency: saved.agency || null,
      groups: targets.length, expiresAt: saved.expiresAt || null,
      matched: targets.length ? targets.reduce((sum, target) => sum + (target.anchorIds?.length || 0), 0) : null, unmatched: saved.unmatchedCount || 0 };
  }
  status() { return { ...this.state }; }
  async request(route, body, method = body ? 'POST' : 'GET') {
    const response = await this.fetcher(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'ERP 登录或授权已失效，请使用当前有效账号重新连接。' : `ERP ${response.status}：${result.error || '连接失败，请稍后重试'}`);
    if (route === '/api/login') this.cookie = response.headers.getSetCookie().find(value => value.startsWith('yes_session='))?.split(';')[0];
    return result;
  }
  async connect({ phone, password }) {
    if (this.busy || this.cookie) throw new Error('正在连接 ERP，请稍候。');
    if (typeof phone !== 'string' || !/^\d{11}$/.test(phone.trim()) || typeof password !== 'string' || !password || password.length > 512)
      throw new Error('请填写有效的 ERP 手机号和密码。');
    this.busy = true;
    this.state = { stage: 'connecting', message: '正在验证 ERP 账号…' };
    try {
      const login = await this.request('/api/login', { phone: phone.trim(), password });
      if (!this.cookie || !manager(login.user)) throw new Error('请使用 ERP 总经理或运营负责人账号。');
      this.deadline = Date.now() + 20 * 60000;
      this.state = { stage: 'waiting', message: 'ERP 授权成功，主播名单读取完整后自动绑定并开启同步。' };
    } catch (error) {
      this.state = { stage: 'error', message: error.message }; await this.logout(); throw error;
    } finally { this.busy = false; }
    await this.finish();
    return this.status();
  }
  async finish() {
    if (this.busy || !this.cookie) return;
    if (Date.now() > this.deadline) { this.state = { stage: 'error', message: '首次连接等待已超时，请重新输入 ERP 账号。' }; await this.logout(); return; }
    if (!this.store.profileScan()) return;
    this.busy = true;
    const targets = [];
    const temporary = resolve(this.dataDir, 'erp-sync.pending.json');
    try {
      this.state = { stage: 'connecting', message: '正在核对并绑定已有主播…' };
      const workspace = await this.request('/api/bootstrap');
      if (!Array.isArray(workspace.anchors)) throw new Error('ERP 未返回授权主播档案。');
      const { agency, agencies, plan, unmatched } = matchProfiles(this.store.profiles(), workspace.anchors);
      await writeFile(resolve(this.dataDir, 'ERP待核对主播.json'), JSON.stringify(unmatched, null, 2), { mode: 0o600 });
      this.state = { ...this.state, matched: plan.length, unmatched: unmatched.length };
      if (!plan.length) throw new Error('ERP 暂无可按 UID 和抖音号准确匹配的主播，已保留本机待核对。无需填写公会名称，请核对 ERP 是否已有对应主播档案。');
      for (const binding of plan) await this.request(path + '/bindings', binding);
      for (const scope of agencies) {
        const credentials = await this.request(path + '/tokens', { agency: scope, name: '主播自动同步', expiresInDays: 90 });
        targets.push({ agency: scope, token: credentials.token, tokenId: credentials.id, expiresAt: credentials.expiresAt,
          anchorIds: plan.filter(binding => binding.agency === scope).map(binding => binding.anchorId) });
        if (typeof credentials.token !== 'string' || credentials.token.length < 24 || !credentials.id || !Number.isFinite(Date.parse(credentials.expiresAt)))
          throw new Error('ERP 未返回有效的专用同步授权，请重新连接。');
      }
      const saved = { enabled: true, agency, targets, expiresAt: targets.map(target => target.expiresAt).sort()[0], unmatchedCount: unmatched.length };
      await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
      await rename(temporary, resolve(this.dataDir, 'erp-sync.json'));
      this.onConnected(saved);
      this.state = { stage: 'connected', agency, groups: targets.length, expiresAt: saved.expiresAt, matched: plan.length, unmatched: unmatched.length,
        message: unmatched.length ? `已连接，${plan.length} 位主播自动同步；${unmatched.length} 位未匹配，保留本机待核对。` : '已连接，之后打开即可自动同步。' };
    } catch (error) {
      for (const target of targets) if (target.tokenId) await this.request(path + '/tokens/' + target.tokenId, undefined, 'DELETE').catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      this.state = { ...this.state, stage: 'error', message: error.message };
    } finally { await this.logout(); this.busy = false; }
  }
  async logout() { if (this.cookie) await this.request('/api/logout', {}, 'POST').catch(() => {}); this.cookie = null; }
  async close() { await this.logout(); }
}
