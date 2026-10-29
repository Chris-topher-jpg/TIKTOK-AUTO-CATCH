import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const [core, collector] = await Promise.all(['core.js', 'collector.js'].map(file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
const identity = id => `<div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">测试${id}</span><div class="standard-components-anchor-info-v2-info-item"><span class="standard-components-anchor-info-v2-info-item-text">${id}</span></div><div class="standard-components-anchor-info-v2-info-item"><i aria-label="tiktok_logo"></i><span class="standard-components-anchor-info-v2-info-item-text">dy_${id}</span></div></div>`;
function harness(html) {
  const dom = new JSDOM(html, { url: html.includes('指标配置') ? 'https://union.bytedance.com/open/portal/data/data' : 'https://union.bytedance.com/open/portal/anchor/list', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, realNow = Date.now, origin = realNow();
  w.Date.now = () => origin + (realNow() - origin) * 100;
  const timer = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => timer(fn, Math.max(1, ms / 100));
  w.Element.prototype.getClientRects = function () { return this.isConnected && !this.hidden ? [{}] : []; };
  let listener;
  w.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
  w.eval(core); w.eval(collector);
  return { dom, w, doc: w.document, collect: message => new Promise(resolve => listener({ type: 'COLLECT_PAGE', ...message }, {}, resolve)) };
}

test('stable profile order waits for delayed identity replacement and is not reset on later reads', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th><th><div role="button" aria-label="Current sort order is none">入会时间</div></th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td><td>2026-10-26</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button><div class="semi2-page-switch"><div role="combobox">1 条/页</div></div>`);
  let clicks = 0, replaced = false;
  h.doc.querySelector('[role="button"]').onclick = event => {
    clicks++;
    event.currentTarget.setAttribute('aria-label', 'Current sort order is ascending');
    h.w.setTimeout(() => {
      h.doc.querySelector('tbody td').innerHTML = identity('2234567890123456789'); replaced = true;
    }, 7000);
  };
  try {
    const message = { kind: 'profiles', expectedStart: 1, stableProfiles: true, profilePageSize: 1 };
    const first = await h.collect(message);
    assert.equal(first.error, undefined, first.error);
    assert.equal(replaced, true); assert.equal(first.data.rows[0].anchorId, '2234567890123456789');
    assert.equal((await h.collect(message)).error, undefined);
    assert.equal(clicks, 1);
  } finally { h.dom.window.close(); }
});

test('profile page-size change waits for the expanded rows rather than only the control label', async () => {
  const first = identity('1234567890123456789'), second = identity('2234567890123456789');
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th><th><div role="button" aria-label="Current sort order is ascending">入会时间</div></th></tr></thead><tbody><tr><td>${first}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共3条</div><button class="semi2-page-next">Next</button><div class="semi2-page-switch"><div role="combobox">1 条/页</div></div><div role="option">2 条/页</div>`);
  h.doc.querySelector('[role="option"]').onclick = () => {
    h.doc.querySelector('[role="combobox"]').textContent = '2 条/页';
    h.w.setTimeout(() => {
      h.doc.querySelector('tbody').innerHTML = `<tr><td>${first}</td><td>42</td></tr><tr><td>${second}</td><td>99</td></tr>`;
      h.doc.querySelector('.page-info').textContent = '显示第1条-第2条，共3条';
    }, 7000);
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1, stableProfiles: true, profilePageSize: 2 });
    assert.equal(result.error, undefined, result.error); assert.equal(result.data.rowCount, 2);
    assert.deepEqual(Array.from(result.data.rows, row => row.anchorId), ['1234567890123456789', '2234567890123456789']);
  } finally { h.dom.window.close(); }
});

test('a missing stable-order control cannot silently claim a complete profile scan', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1, stableProfiles: true });
    assert.match(result.error, /未找到入会时间排序控件/); assert.equal(result.data, undefined);
  } finally { h.dom.window.close(); }
});

test('profile collector reads exact linked tooltip, advances pages and resumes at the checkpoint', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝指数</th></tr></thead><tbody></tbody></table><span class="standard-components-pagination-page-info"></span><button class="semi2-page-next">Next</button>`);
  let page = 1;
  const render = () => {
    h.doc.querySelector('tbody').innerHTML = `<tr><td>${identity(page === 1 ? '1234567890123456789' : '2234567890123456789')}</td><td><span data-popupid="fans-tip">1.2万</span></td></tr>`;
    h.doc.querySelector('.standard-components-pagination-page-info').textContent = `显示第${page}条-第${page}条，共2条`;
    h.doc.querySelector('button').disabled = page === 2;
    h.doc.querySelector('[data-popupid]').addEventListener('mouseover', () => {
      const tip = h.doc.createElement('div'); tip.id = 'fans-tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = String(12895 + page); h.doc.body.append(tip);
    });
    h.doc.querySelector('[data-popupid]').addEventListener('mouseout', () => h.doc.getElementById('fans-tip')?.remove());
  };
  render(); h.doc.querySelector('button').onclick = () => { page++; render(); };
  try {
    const stale = await h.collect({ kind: 'profiles', expectedStart: 1, documentAfter: Date.now() + 60000 });
    assert.equal(stale.retry, true);
    const wrongPage = await h.collect({ kind: 'daily', date: '2026-10-23', expectedStart: 1 });
    assert.equal(wrongPage.retry, true);
    const first = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(first.error, undefined);
    assert.equal(first.data.rows[0].followers, 12896);
    assert.equal(first.data.rows[0].followersRaw, '1.2万');
    assert.equal(first.data.rows[0].followersApproximate, false);
    const next = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(next.error, undefined); assert.equal(next.data.start, 2); assert.equal(next.data.hasNext, false);
    assert.equal(next.data.rows[0].anchorId, '2234567890123456789');
    const repeat = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(repeat.data.rows[0].followers, 12897);
  } finally { h.dom.window.close(); }
});

test('daily collector selects independent acu, applies one day and resolves legacy exact tooltip', async () => {
  const h = harness(`<input placeholder="开始日期" value="2026-10-25"><input placeholder="结束日期" value="2026-10-25"><button>指标配置</button><table><thead><tr><th>主播信息</th><th>总音浪</th><th>开播总时长</th><th>feed_acu</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td><div><span>1.11万</span></div></td><td>1小时49分钟1秒</td><td>999</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><li class="semi-page-next semi-page-item-disabled"></li>`);
  const { doc } = h;
  doc.querySelector('button').onclick = () => {
    const dialog = doc.createElement('div');
    dialog.innerHTML = ['总音浪', '开播总时长', 'acu'].map(name => `<span class="semi2-checkbox"><input type="checkbox" ${name === 'acu' ? '' : 'checked'}><span>${name}</span></span>`).join('') + '<button>取消</button><button>确定</button>';
    doc.body.append(dialog);
    for (const span of dialog.querySelectorAll('.semi2-checkbox')) span.onclick = e => { if (e.target.tagName !== 'INPUT') span.querySelector('input').checked = !span.querySelector('input').checked; };
    [...dialog.querySelectorAll('button')].find(e => e.textContent === '确定').onclick = () => {
      assert.equal(dialog.querySelectorAll('input')[2].checked, true);
      doc.querySelector('thead tr').insertAdjacentHTML('beforeend', '<th>acu</th>');
      doc.querySelector('tbody tr').insertAdjacentHTML('beforeend', '<td>21.5</td>'); dialog.remove();
    };
  };
  let prematureClicks = 0;
  doc.querySelector('input').onclick = () => {
    h.w.setTimeout(() => {
      const calendar = doc.createElement('div'); calendar.innerHTML = '<div role="gridcell" aria-label="2026-10-23" aria-disabled="false">23</div>'; doc.body.append(calendar);
      let awaitingEnd = false, pending = false;
      calendar.onclick = () => {
        if (pending) { prematureClicks++; return; }
        pending = true;
        h.w.setTimeout(() => {
          if (!awaitingEnd) {
            doc.querySelector('input[placeholder="开始日期"]').value = '2026-10-23'; awaitingEnd = true; pending = false;
          } else {
            doc.querySelector('input[placeholder="结束日期"]').value = '2026-10-23'; calendar.remove();
          }
        }, 500);
      };
    }, 700);
  };
  const span = doc.querySelector('tbody tr').cells[1].querySelector('span');
  span.onmouseover = () => { const tip = doc.createElement('div'); tip.className = 'semi-tooltip-wrapper'; tip.textContent = '11107'; doc.body.append(tip); };
  span.onmouseout = () => doc.querySelector('.semi-tooltip-wrapper')?.remove();
  try {
    const result = await h.collect({ kind: 'daily', date: '2026-10-23', expectedStart: 1 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(prematureClicks, 0);
    const row = result.data.rows[0];
    assert.equal(row.date, '2026-10-23'); assert.equal(row.waves, 11107); assert.equal(row.acu, 21.5); assert.equal(row.liveSeconds, 6541);
    assert.equal(row.raw.waves, '1.11万'); assert.equal(row.exactRaw.waves, '11107'); assert.equal(row.approximate.length, 0);
    assert.equal(doc.querySelector('input[placeholder="结束日期"]').value, '2026-10-23');
  } finally { h.dom.window.close(); }
});

test('daily service waits for the requested date response even when date labels already match', async () => {
  const h = harness(`<input placeholder="开始日期" value="2026-10-25"><input placeholder="结束日期" value="2026-10-25"><button>指标配置</button><table><thead><tr><th>主播信息</th><th>总音浪</th><th>开播总时长</th><th>acu</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>99</td><td>1小时</td><td>2</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
  let report = { pending: 0, completed: { beginDate: '2026-10-26', endDate: '2026-10-26', start: 1, ok: true } };
  h.w.__tacServiceReportState = async () => report;
  h.w.setTimeout(() => { report = { pending: 1, completed: report.completed }; }, 1000);
  h.w.setTimeout(() => {
    h.doc.querySelector('tbody tr').cells[1].textContent = '11';
    report = { pending: 0, completed: { beginDate: '2026-10-25', endDate: '2026-10-25', start: 1, ok: true } };
  }, 8000);
  try {
    const result = await h.collect({ kind: 'daily', date: '2026-10-25', expectedStart: 1 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.data.rows[0].waves, 11);
  } finally { h.dom.window.close(); }
});

test('missing exact tooltip preserves approximation and a stuck page fails safely', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>1.2万</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button><div role="tooltip">98765</div>`);
  try {
    const first = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(first.error, undefined, JSON.stringify(first));
    assert.equal(first.data.rows[0].followersApproximate, true); assert.equal(first.data.rows[0].followers, 12000);
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.match(result.error, /翻页后主播行未能稳定更新/); assert.equal(result.data, undefined);
  } finally { h.dom.window.close(); }
});

test('collector keeps a valid UID row with absent Douyin account and reports field quality', async () => {
  const h = harness('<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td><div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">已离会主播</span><div class="standard-components-anchor-info-v2-info-item"><span class="standard-components-anchor-info-v2-info-item-text">UID：7654559237235295269</span></div></div></td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>');
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(result.error, undefined); assert.equal(result.data.rows.length, 1);
    assert.equal(result.data.rows[0].douyinId, null); assert.equal(result.data.rows[0].identityMissing[0], 'douyinId');
    assert.equal(result.data.rows[0].anchorId, '7654559237235295269');
  } finally { h.dom.window.close(); }
});

test('a deleted account without UID is counted but never assigned a guessed identity', async () => {
  const deleted = '<div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">账号已注销</span><div class="standard-components-anchor-info-v2-info-item"><i aria-label="tiktok_logo"></i><span class="standard-components-anchor-info-v2-info-item-text">账号已注销</span></div></div>';
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr><tr><td>${deleted}</td><td>0</td></tr></tbody></table><div class="page-info">显示第1条-第2条，共2条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.data.rowCount, 2); assert.equal(result.data.rows.length, 1);
    assert.equal(result.data.rows[0].anchorId, '1234567890123456789');
    assert.deepEqual(Array.from(result.data.unidentified, row => ({ ...row })), [{ row: 2, nickname: '账号已注销', reason: '账号已注销，平台未提供 UID' }]);
  } finally { h.dom.window.close(); }
});

test('conflicting UID candidates still stop with row diagnostics instead of guessing', async () => {
  const h = harness('<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td><div class="standard-components-anchor-info-v2"><span class="standard-components-anchor-info-v2-nickname">测试主播</span><div class="standard-components-anchor-info-v2-info-item">UID：12345</div><div class="standard-components-anchor-info-v2-info-item">主播ID：67890</div></div></td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>');
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.match(result.error, /当前页第 1 行/); assert.doesNotMatch(result.error, /登录或网络/);
    assert.equal(result.diagnostic.row, 1); assert.equal(result.diagnostic.missing[0], 'anchorId');
    assert.equal(result.diagnostic.identityIssue, 'multiple'); assert.deepEqual(Array.from(result.diagnostic.uidCandidates), ['12345', '67890']);
    assert.equal(result.data, undefined);
  } finally { h.dom.window.close(); }
});

test('unrelated page spinner does not block a stable anchor table', async () => {
  const h = harness(`<div class="semi-spin-spinning">Other page widget</div><table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(result.error, undefined);
    assert.equal(result.data.rows[0].followers, 42);
  } finally { h.dom.window.close(); }
});

test('a table-local spinner blocks stale reads and returns a general diagnostic', async () => {
  const h = harness(`<div class="semi-table"><div class="semi-spin-spinning">Loading</div><table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table></div><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.match(result.error, /未检测到登录后的主播表格/);
    assert.equal(result.diagnostic.tableFound, true);
    assert.equal(result.diagnostic.rowCount, 1);
    assert.equal(result.diagnostic.loading.tableRegionCount, 1);
    assert.equal(result.data, undefined);
  } finally { h.dom.window.close(); }
});

test('a hidden loading indicator does not block a populated table', async () => {
  const h = harness(`<div class="semi-table"><div style="opacity:0"><div class="semi-spin-spinning" aria-busy="true">Loading</div></div><table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table></div><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 1 });
    assert.equal(result.error, undefined);
    assert.equal(result.data.rows[0].followers, 42);
  } finally { h.dom.window.close(); }
});

test('pagination moving before rows load cannot be accepted as the next page', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button>`);
  let rowsChanged = false;
  h.doc.querySelector('button').onclick = () => {
    h.doc.querySelector('.page-info').textContent = '显示第2条-第2条，共2条';
    h.doc.querySelector('button').disabled = true;
    h.w.setTimeout(() => {
      h.doc.querySelector('tbody td').innerHTML = identity('2234567890123456789');
      rowsChanged = true;
    }, 7000);
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(rowsChanged, true);
    assert.equal(result.data.rows[0].anchorId, '2234567890123456789');
  } finally { h.dom.window.close(); }
});

test('a cross-page UID repeat is accepted only after the new page content replaces the old rows', async () => {
  const firstId = '1234567890123456789', secondId = '2234567890123456789';
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity(firstId)}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共3条</div><button class="semi2-page-next">Next</button>`);
  h.doc.querySelector('button').onclick = () => {
    h.doc.querySelector('.page-info').textContent = '显示第2条-第3条，共3条';
    h.doc.querySelector('button').disabled = true;
    h.w.setTimeout(() => {
      h.doc.querySelector('tbody').innerHTML = `<tr><td>${identity(firstId)}</td><td>43</td></tr><tr><td>${identity(secondId)}</td><td>99</td></tr>`;
    }, 500);
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.data.start, 2); assert.equal(result.data.end, 3);
    assert.deepEqual(Array.from(result.data.rows, row => row.anchorId), [firstId, secondId]);
  } finally { h.dom.window.close(); }
});

test('a metric update on stale identities cannot advance the page checkpoint', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button>`);
  h.doc.querySelector('button').onclick = () => {
    h.doc.querySelector('.page-info').textContent = '显示第2条-第2条，共2条';
    h.doc.querySelector('button').disabled = true;
    h.doc.querySelector('tbody tr').cells[1].textContent = '43';
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.data, undefined);
    assert.match(result.error, /翻页后主播行未能稳定更新/);
    assert.ok(result.diagnostic.wait.staleRowPolls > 0);
  } finally { h.dom.window.close(); }
});

test('a delayed background timer checks a stable new page before declaring a timeout', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button>`);
  const clock = h.w.Date.now, timer = h.w.setTimeout;
  let clicked = false, suspension = 0;
  h.w.Date.now = () => clock() + suspension;
  h.w.setTimeout = (fn, ms) => timer(() => {
    if (clicked && !suspension) suspension = 30000;
    fn();
  }, ms);
  h.doc.querySelector('button').onclick = () => {
    clicked = true;
    h.doc.querySelector('tbody td').innerHTML = identity('2234567890123456789');
    h.doc.querySelector('.page-info').textContent = '显示第2条-第2条，共2条';
    h.doc.querySelector('button').disabled = true;
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.data.rows[0].anchorId, '2234567890123456789');
    const { diagnostic } = await h.collect({ type: 'COLLECTOR_DIAGNOSTIC' });
    assert.equal(diagnostic.timing.delayedWakeups, 1);
    assert.ok(diagnostic.timing.elapsedMs >= 30000);
  } finally { h.dom.window.close(); }
});

test('a DOM update wakes table checks while the polling timer is delayed', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button>`);
  const clock = h.w.Date.now, timer = h.w.setTimeout;
  let clicked = false, suspension = 0;
  h.w.Date.now = () => clock() + suspension;
  h.w.setTimeout = (fn, ms) => !clicked ? timer(fn, ms) : timer(() => { suspension += 30000; fn(); }, 3000);
  h.doc.querySelector('button').onclick = () => {
    clicked = true;
    h.doc.querySelector('.page-info').textContent = '显示第2条-第2条，共2条';
    h.doc.querySelector('button').disabled = true;
    setTimeout(() => { h.doc.querySelector('tbody td').innerHTML = identity('2234567890123456789'); }, 5);
  };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.data.rows[0].anchorId, '2234567890123456789');
    const { diagnostic } = await h.collect({ type: 'COLLECTOR_DIAGNOSTIC' });
    assert.ok(diagnostic.timing.mutationWakeups >= 1);
    assert.ok(diagnostic.timing.delayedWakeups >= 1);
  } finally { h.dom.window.close(); }
});

test('timer delays on a stuck page remain an error and identify foreground recovery', async () => {
  const h = harness(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>42</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共2条</div><button class="semi2-page-next">Next</button>`);
  const clock = h.w.Date.now, timer = h.w.setTimeout;
  let clicked = false, suspension = 0;
  h.w.Date.now = () => clock() + suspension;
  h.w.setTimeout = (fn, ms) => timer(() => { if (clicked) suspension += 30000; fn(); }, ms);
  h.doc.querySelector('button').onclick = () => { clicked = true; };
  try {
    const result = await h.collect({ kind: 'profiles', expectedStart: 2 });
    assert.equal(result.data, undefined);
    assert.equal(result.code, 'PAGE_TIMER_THROTTLED');
    assert.match(result.error, /后台响应延迟/);
    assert.ok(result.diagnostic.timing.maxWakeGapMs >= 30000);
  } finally { h.dom.window.close(); }
});

test('live diagnostics identify the adapter without collecting or advancing pages', async () => {
  const h = harness('<div class="semi-table" aria-busy="true"><table><thead><tr><th>主播信息</th></tr></thead><tbody></tbody></table></div>');
  try {
    const info = await h.collect({ type: 'COLLECTOR_INFO' });
    assert.equal(info.collectorVersion, h.w.AnchorCore.VERSION);
    const result = await h.collect({ type: 'COLLECTOR_DIAGNOSTIC' });
    assert.equal(result.diagnostic.source, 'collector');
    assert.equal(result.diagnostic.tableFound, true);
    assert.equal(result.diagnostic.loading.tableRegionCount, 1);
    assert.equal(result.diagnostic.rowCount, 0);
    assert.equal(result.data, undefined);
  } finally { h.dom.window.close(); }
});

test('daily ACU aliases read the independent column and preserve missing values instead of feed_acu', async () => {
  for (const heading of ['ACU', '平均在线人数', '平均在线人数（ACU）']) {
    const h = harness(`<input placeholder="开始日期" value="2026-10-23"><input placeholder="结束日期" value="2026-10-23"><button>指标配置</button><table><thead><tr><th>主播信息</th><th>总音浪</th><th>开播总时长</th><th>feed_acu</th><th>${heading}</th></tr></thead><tbody><tr><td>${identity('1234567890123456789')}</td><td>123</td><td>1小时</td><td>999</td><td>18.5</td></tr></tbody></table><div class="page-info">显示第1条-第1条，共1条</div><button class="semi2-page-next" disabled>Next</button>`);
    try {
      const first = await h.collect({ kind: 'daily', date: '2026-10-23', expectedStart: 1 });
      assert.equal(first.error, undefined); assert.equal(first.data.rows[0].acu, 18.5);
      h.doc.querySelector('tbody tr').cells[4].textContent = '—';
      const missing = await h.collect({ kind: 'daily', date: '2026-10-23', expectedStart: 1 });
      assert.equal(missing.data.rows[0].acu, null); assert.ok(missing.data.rows[0].missing.includes('acu'));
      assert.equal(h.w.AnchorCore.metricColumn(['feed_acu', '人气峰值'], 'acu'), -1);
    } finally { h.dom.window.close(); }
  }
});
