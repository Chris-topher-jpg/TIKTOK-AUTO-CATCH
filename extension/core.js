/* Shared by the isolated content script, dashboard and service worker. */
(() => {
  // The user requested collection delivery first; ERP changes are not approved.
  const ERP_ENABLED = false;
  const VERSION = '0.1.8';
  const clean = value => String(value ?? "").replace(/\u200b/g, "").trim();
  const text = element => clean(element?.innerText) || clean(element?.textContent);
  function numeric(value) {
    const raw = clean(value);
    const normalized = raw.replace(/[,，\s]/g, "");
    if (!normalized || /^(?:-|--|—|暂无|N\/A)$/i.test(normalized)) return { value: null, approximate: false, raw };
    const match = normalized.match(/^(\d+(?:\.\d+)?)(万|亿)?$/);
    return match ? { value: Number(match[1]) * (match[2] === "亿" ? 1e8 : match[2] === "万" ? 1e4 : 1), approximate: Boolean(match[2]), raw }
      : { value: null, approximate: false, raw };
  }
  function seconds(value) {
    const raw = clean(value).replace(/\s/g, "");
    if (!raw || /^(?:-|--|—)$/.test(raw)) return null;
    if (raw === "0") return 0;
    const match = raw.match(/^(?:(\d+(?:\.\d+)?)小时)?(?:(\d+(?:\.\d+)?)(?:分钟|分))?(?:(\d+(?:\.\d+)?)秒)?$/);
    if (match && match[0]) return Math.round(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
    const clock = raw.match(/^(\d+):(\d{2}):(\d{2})$/);
    return clock && +clock[2] < 60 && +clock[3] < 60 ? +clock[1] * 3600 + +clock[2] * 60 + +clock[3] : null;
  }
  function day(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("日期格式应为 YYYY-MM-DD");
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new Error("日期无效");
    return parsed;
  }
  const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  function days(start, end, today = shanghaiToday()) {
    const first = day(start), last = day(end);
    if (+first > +last) throw new Error("开始日期不能晚于结束日期");
    if (end >= today) throw new Error("平台不支持今日汇总，请选择昨日或更早的完整日期");
    const count = (+last - +first) / 86400000 + 1;
    if (count > 31) throw new Error("单次最多采集 31 天，请分批采集");
    return Array.from({ length: count }, (_, i) => new Date(+first + i * 86400000).toISOString().slice(0, 10));
  }
  function identity(cell) {
    const nickname = text(cell?.querySelector('.standard-components-anchor-info-v2-nickname, [class*="anchor-info"][class*="nickname"]'));
    const items = [...cell?.querySelectorAll('.standard-components-anchor-info-v2-info-item, [class$="anchor-info-info-item"]') || []];
    const label = /^(UID|主播\s*ID|主播编号|抖音号|抖音\s*ID|西瓜号|西瓜\s*ID)\s*[:：]?\s*/i;
    const fields = items.map(item => {
      const value = text(item.querySelector('.standard-components-anchor-info-v2-info-item-text, [class$="info-item-text"]') || item);
      // Account icons can use classes, accessible labels, images or SVG sprites.
      const markers = [item, ...item.querySelectorAll('span, i, svg, use, img, [role="img"]')]
        .map(e => [e.getAttribute('class'), e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt'), e.getAttribute('href'), e.getAttribute('xlink:href')].filter(Boolean).join(' ')).join(' ');
      const type = /^(?:抖音号|抖音\s*ID)/i.test(value) || /tiktok|douyin|aweme|抖音/i.test(markers) ? 'douyin'
        : /^(?:西瓜号|西瓜\s*ID)/i.test(value) || /vigo|xigua|西瓜/i.test(markers) ? 'xigua'
        : /^(?:UID|主播\s*ID|主播编号)\s*[:：]?/i.test(value) || /(?:^|[\s_/-])(?:uid|anchor[_-]?id)(?:$|[\s_/-])/i.test(markers) ? 'uid' : '';
      return { type, value: value.replace(label, '').trim(), raw: value, markers: markers.slice(0, 400) };
    });
    const unique = values => [...new Set(values.filter(Boolean))];
    const uidFields = fields.filter(f => f.type === 'uid');
    let uidValues = unique(uidFields.map(f => f.value).filter(v => /^\d{5,30}$/.test(v)));
    if (!uidFields.length) {
      // A bare numeric line is safe only when the platform account lines are
      // identified independently. Never assume the first number is a UID.
      const accountsKnown = fields.some(f => f.type === 'douyin' || f.type === 'xigua');
      if (accountsKnown) uidValues = unique(fields.filter(f => !f.type && /^\d{5,30}$/.test(f.value)).map(f => f.value));
    }
    if (uidValues.length !== 1) {
      const identityIssue = uidValues.length > 1 ? 'multiple' : 'missing';
      const error = new Error(`无法确认主播 UID（昵称：${nickname || '未显示'}；${identityIssue === 'multiple' ? '有多个 UID 候选' : '缺少可区分的 UID'}），已停止以避免串档`);
      error.code = 'ANCHOR_IDENTITY_UNREADABLE';
      error.diagnostic = { version: VERSION, missing: ['anchorId'], identityIssue, uidCandidates: uidValues, nickname,
        items: fields.map(({ type, raw, markers }) => ({ type, text: raw.slice(0, 180), markers })),
        structure: [...cell?.querySelectorAll('[class*="anchor-info"]') || []].slice(0, 25).map(e => e.getAttribute('class')) };
      throw error;
    }
    const dyValues = unique(fields.filter(f => f.type === 'douyin').map(f => f.value).filter(v => v && !/^(?:-|--|—|暂无|未授权|未设置|已注销)$/.test(v)));
    const douyinId = dyValues.length === 1 ? dyValues[0] : null;
    const result = { anchorId: uidValues[0], douyinId, nickname: nickname || null };
    const missing = [!douyinId && 'douyinId', !nickname && 'nickname'].filter(Boolean);
    if (missing.length) result.identityMissing = missing;
    return result;
  }
  function table(document) {
    return [...document.querySelectorAll('table')].find(e => text(e.querySelector('thead th')) === "主播信息");
  }
  function metricColumn(headers, key) {
    const names = { followers: ['粉丝指数', '粉丝数'], waves: ['总音浪'], liveSeconds: ['开播总时长'], acu: ['acu', '独立ACU', '平均在线人数', '平均在线人数ACU'] };
    const normalized = value => clean(value).replace(/[\s\u00a0()（）\[\]【】_-]/g, '').toLowerCase();
    return headers.findIndex(header => names[key]?.some(name => normalized(header) === normalized(name)));
  }
  function snapshot(document, kind, date = "") {
    const target = table(document);
    if (!target) throw new Error("未找到主播表格，请确认已登录直播服务平台");
    const headers = [...target.querySelectorAll('thead th')].map(text);
    const followerIndex = metricColumn(headers, 'followers'), waveIndex = metricColumn(headers, 'waves'), durationIndex = metricColumn(headers, 'liveSeconds'), acuIndex = metricColumn(headers, 'acu');
    if (kind === 'profiles' && followerIndex < 0) throw new Error("缺少粉丝列");
    if (kind === 'daily' && (waveIndex < 0 || durationIndex < 0 || acuIndex < 0)) throw new Error("请在指标配置中勾选 总音浪、开播总时长、acu（不能用 feed_acu 代替）");
    const rowElements = [...target.querySelectorAll('tbody tr')].filter(r => r.querySelector('.standard-components-anchor-info-v2'));
    const unidentified = [];
    const rows = rowElements.flatMap((row, index) => {
      const cells = [...row.querySelectorAll(':scope > td')];
      let base;
      try { base = identity(cells[0]); }
      catch (error) {
        const position = index + 1;
        error.message = `当前页第 ${position} 行：${error.message}`;
        if (error.diagnostic) error.diagnostic = { ...error.diagnostic, row: position, kind, date, headers };
        const deletedAccount = error.diagnostic?.items?.some(item => ['douyin', 'xigua'].includes(item.type) && /账号已注销|已注销/.test(item.text));
        if (error.code === 'ANCHOR_IDENTITY_UNREADABLE' && error.diagnostic?.identityIssue === 'missing' && deletedAccount) {
          unidentified.push({ row: position, nickname: error.diagnostic?.nickname || null, reason: '账号已注销，平台未提供 UID' });
          return [];
        }
        throw error;
      }
      const read = index => cells[index]?.getAttribute('data-tac-exact') || text(cells[index]);
      if (kind === 'profiles') {
        const metric = numeric(read(followerIndex));
        return [{ ...base, followers: metric.value, followersApproximate: metric.approximate, followersRaw: text(cells[followerIndex]), followersExactRaw: metric.value == null || metric.approximate ? null : metric.raw, capturedAt: new Date().toISOString() }];
      }
      const waves = numeric(read(waveIndex)), acu = numeric(read(acuIndex));
      const liveSeconds = seconds(read(durationIndex));
      return [{ ...base, date, waves: waves.value, liveSeconds, acu: acu.value, approximate: [waves.approximate && 'waves', acu.approximate && 'acu'].filter(Boolean),
        missing: [waves.value == null && 'waves', liveSeconds == null && 'liveSeconds', acu.value == null && 'acu'].filter(Boolean),
        raw: { waves: text(cells[waveIndex]), liveDuration: text(cells[durationIndex]), acu: text(cells[acuIndex]) },
        exactRaw: { waves: waves.value == null || waves.approximate ? null : waves.raw, acu: acu.value == null || acu.approximate ? null : acu.raw }, capturedAt: new Date().toISOString() }];
    });
    if (!rowElements.length) throw new Error("平台未返回主播行，已停止；不会用空数据覆盖 ERP");
    if (new Set(rows.map(r => r.anchorId)).size !== rows.length) throw new Error("当前页主播 ID 重复，已停止");
    const infoElement = document.querySelector('.standard-components-pagination-page-info, [class*="pagination-page-info"], [class*="page-info"]')
      || [...document.querySelectorAll('[class*="pagination"]')].find(element => /显示第.*共.*条/.test(text(element)));
    const info = text(infoElement);
    const match = info.match(/显示第\s*(\d+)\s*条\s*[-~至]\s*第?\s*(\d+)\s*条[，,]\s*共\s*(\d+)\s*条/);
    if (!match) throw new Error("未识别分页总数，无法保证完整采集");
    const start = +match[1], displayedEnd = +match[2], total = +match[3];
    // The platform keeps the full page boundary on its final, shorter page
    // (e.g. 421-430 of 429). Verify actual rows against the bounded range.
    const end = Math.min(displayedEnd, total);
    const next = document.querySelector('.semi-page-next, .semi2-page-next, button[aria-label="Next"]');
    if (!next) throw new Error("未识别下一页控件");
    const hasNext = !next.disabled && next.getAttribute('aria-disabled') !== 'true' && !/item-disabled/.test(next.className);
    if (start < 1 || start > total || displayedEnd < start || end - start + 1 !== rowElements.length || hasNext !== (end < total)) throw new Error("分页数量不一致，已停止以避免漏采");
    return { rows, rowCount: rowElements.length, unidentified, start, end, displayedEnd, total, hasNext, headers, fingerprint: `${start}:${end}:${rows.map(r => r.anchorId).join(',')}:${unidentified.map(row => `${row.row}:${row.nickname}`).join(',')}` };
  }
  function merge(profiles, daily) {
    const map = new Map(profiles.map(row => [row.anchorId, row]));
    return daily.map(row => {
      const profile = map.get(row.anchorId);
      const merged = { ...profile, ...row, profileMissing: !profile, followersMissing: profile?.followers == null, followers: profile?.followers ?? null, followersCapturedAt: profile?.capturedAt ?? null };
      merged.douyinId = row.douyinId || profile?.douyinId || null;
      merged.nickname = row.nickname || profile?.nickname || null;
      const missing = [!merged.douyinId && 'douyinId', !merged.nickname && 'nickname'].filter(Boolean);
      if (missing.length) merged.identityMissing = missing;
      else delete merged.identityMissing;
      return merged;
    });
  }
  const needsReview = row => Boolean(row.identityMissing?.length || row.missing?.length || row.approximate?.length || row.profileMissing || row.followers == null || row.followersApproximate);
  function csv(records) {
    const fields = [['date','日期'],['anchorId','主播ID'],['douyinId','抖音号'],['nickname','昵称'],['followers','粉丝数'],['followersRaw','粉丝数原文'],['followersExactRaw','粉丝精确提示'],['followersCapturedAt','粉丝采集时间'],['waves','每日音浪'],['liveSeconds','直播秒数'],['acu','ACU'],['identityMissing','缺失身份字段'],['followersApproximate','粉丝近似值'],['followersMissing','缺少粉丝数'],['approximate','近似指标'],['missing','缺失指标']];
    const quote = value => '"' + String(Array.isArray(value) ? value.join('|') : value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
    return '\uFEFF' + [fields.map(([, name]) => quote(name)).join(','), ...records.map(row => fields.map(([key]) => quote(row[key])).join(','))].join('\r\n');
  }
  function endpoint(value) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) throw new Error("接收接口不能包含账号、查询参数或锚点");
    if (url.origin !== 'https://erp.yeshuyu.com' && !(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:')) throw new Error("仅允许 erp.yeshuyu.com 的 HTTPS 接口或本机演示接口");
    if (!url.pathname.startsWith('/api/')) throw new Error("请输入 /api/ 开头的接收接口路径，不能填写 ERP 首页");
    return url;
  }
  globalThis.AnchorCore = Object.freeze({ VERSION, ERP_ENABLED, clean, text, numeric, seconds, days, day, shanghaiToday, identity, table, metricColumn, snapshot, merge, needsReview, csv, endpoint });
})();
