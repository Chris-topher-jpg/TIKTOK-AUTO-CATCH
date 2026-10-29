import '../extension/core.js';
export function archiveCsv(profiles) {
  const columns = ['主播ID', '抖音号', '主播昵称', '粉丝数', '粉丝原文', '粉丝精度', '采集时间'];
  const quote = value => String.fromCharCode(34) + String(value ?? '').replace(/^[=+@\-\t\r]/, value => String.fromCharCode(39) + value).replaceAll(String.fromCharCode(34), String.fromCharCode(34, 34)) + String.fromCharCode(34);
  const rows = profiles.map(row => [row.anchorId, row.douyinId, row.nickname, row.followersApproximate ? null : row.followers, row.followersRaw, row.followersApproximate ? '近似，未导入数值' : row.followers == null ? '缺失' : '精确', row.capturedAt]);
  return '\uFEFF' + [columns, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
}
export const dailyCsv = records => globalThis.AnchorCore.csv(records);
