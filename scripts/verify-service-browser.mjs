import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Source } from '../service/source.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const directory = await mkdtemp(join(tmpdir(), 'tac-headless-'));
const source = new Source({ profileDir: directory });
let includeDeletedProfile = false;
const identity = id => '<div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">离线测试</span><div class="standard-components-anchor-info-v2-info-item">UID：' + id + '</div><div class="standard-components-anchor-info-v2-info-item"><i aria-label=tiktok_logo></i><span class="standard-components-anchor-info-v2-info-item-text">dy_' + id + '</span></div></div>';
try {
  await source.open();
  await source.context.route('**/*', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/data_center/anchor_list')) {
      await delay(4500);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (!route.request().isNavigationRequest()) return route.abort();
    const daily = route.request().url().includes('/data/data');
    const headers = daily ? '<th>总音浪</th><th>开播总时长</th><th>acu</th>' : '<th>粉丝数</th>';
    const metrics = daily ? '<td>0</td><td>1小时</td><td>2</td>' : '<td>42</td>';
    const controls = daily ? '<input placeholder="开始日期" value="2026-10-26"><input placeholder="结束日期" value="2026-10-26">' : '<div class=semi2-page-switch><div role=combobox>50 条/页</div></div>';
    const stableHeader = daily ? '' : '<th><div role=button aria-label="Current sort order is ascending">入会时间</div></th>';
    const dead = '<div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">账号已注销</span><div class="standard-components-anchor-info-v2-info-item"><i aria-label="tiktok_logo"></i><span class="standard-components-anchor-info-v2-info-item-text">账号已注销</span></div></div>';
    if (!daily && includeDeletedProfile) {
      const html = '<!doctype html><html lang=zh-CN><meta charset=utf-8>' + controls + '<table><thead><tr><th>主播信息</th><th>粉丝数</th>' + stableHeader + '</tr></thead><tbody><tr><td>' + identity('7601032374063105082') + '</td><td>42</td></tr><tr><td>' + dead + '</td><td>0</td></tr><tr><td>' + identity('7601032374063105083') + '</td><td>42</td></tr></tbody></table><div class=page-info>显示第1条-第3条，共3条</div><button class="semi2-page-next semi-page-item-disabled" disabled>Next</button></html>';
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    const reportScript = 'const load=async page=>{await fetch("/ark/api/data/pugna_component/data/v2/union/data_center/anchor_list?beginDate=2026-10-26&endDate=2026-10-26&page="+page+"&size=1");document.querySelector("tbody tr").cells[1].textContent="0";if(page===2){document.querySelector("tbody td").innerHTML=' + JSON.stringify(identity('7601032374063105083')) + ';document.querySelector("button").disabled=true}};document.querySelector("tbody tr").cells[1].textContent="99";void load(1);document.querySelector("button").onclick=()=>{document.querySelector(".page-info").textContent="显示第2条-第2条，共2条";void load(2)};';
    const profileScript = 'document.querySelector("button").onclick=()=>{document.querySelector("tbody td").innerHTML=' + JSON.stringify(identity('7601032374063105083')) + ';document.querySelector(".page-info").textContent="显示第2条-第2条，共2条";document.querySelector("button").disabled=true}';
    const html = '<!doctype html><html lang=zh-CN><meta charset=utf-8>' + controls + '<table><thead><tr><th>主播信息</th>' + headers + stableHeader + '</tr></thead><tbody><tr><td>' + identity('7601032374063105082') + '</td>' + metrics + '</tr></tbody></table><div class=page-info>显示第1条-第1条，共2条</div><button class=semi2-page-next>Next</button><script>window.setTimeout=()=>{throw Error("页面计时器已禁用")};' + (daily ? reportScript : profileScript) + '</script></html>';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  const profiles = [], daily = [];
  assert.equal(await source.collect('profiles', null, rows => profiles.push(...rows)), 2);
  assert.equal(await source.collect('daily', '2026-10-26', rows => daily.push(...rows)), 2);
  assert.equal(profiles.length, 2); assert.equal(daily.length, 2); assert.equal(daily[0].waves, 0);
  assert.notEqual(daily[0].anchorId, daily[1].anchorId);
  assert.equal(daily[0].liveSeconds, 3600); assert.equal(daily[0].acu, 2);
  includeDeletedProfile = true;
  let profileProgress; const identifiable = [];
  assert.equal(await source.collect('profiles', null, (rows, progress) => { identifiable.push(...rows); profileProgress = progress; }), 2);
  assert.equal(profileProgress.scanned, 3); assert.equal(profileProgress.total, 3);
  assert.equal(profileProgress.identified, 2); assert.equal(profileProgress.unidentified, 1);
  assert.equal(profileProgress.unidentifiedSample[0].nickname, '账号已注销');
  assert.deepEqual(identifiable.map(row => row.anchorId), ['7601032374063105082', '7601032374063105083']);
  console.log('真实 Edge 无界面验证通过：禁用页面计时器仍完成分页，日请求延迟4.5秒时等待目标日期和页码的响应、不接受旧指标；扫描 3 条含 1 条注销无 UID 的列表，报告 3/3 已扫描、2 位已识别、1 条待核对。全程仅使用离线夹具。');
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
