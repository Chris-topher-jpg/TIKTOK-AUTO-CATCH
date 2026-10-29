import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
dom.window.eval(source);
const core = dom.window.AnchorCore;

test('numeric values normalize exact values and label rounded platform values', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(core.numeric('12,345'))), { value: 12345, approximate: false, raw: '12,345' });
  assert.deepEqual(JSON.parse(JSON.stringify(core.numeric('8.2万'))), { value: 82000, approximate: true, raw: '8.2万' });
  assert.equal(core.numeric('—').value, null);
  assert.equal(core.numeric('1.2w').value, null);
});

test('durations support Chinese units and clock format, and reject invalid clocks', () => {
  assert.equal(core.seconds('2小时3分钟4秒'), 7384);
  assert.equal(core.seconds('01:02:03'), 3723);
  assert.equal(core.seconds('0'), 0);
  assert.equal(core.seconds('1:70:00'), null);
  assert.equal(core.seconds(''), null);
});

test('date ranges are inclusive and capped at 31 days before Shanghai today', () => {
  assert.deepEqual(Array.from(core.days('2024-02-28', '2024-03-01', '2024-03-10')), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.throws(() => core.days('2024-02-30', '2024-03-01', '2024-03-10'), /日期无效/);
  assert.throws(() => core.days('2024-03-02', '2024-03-01', '2024-03-10'), /开始日期/);
  assert.throws(() => core.days('2024-03-10', '2024-03-10', '2024-03-10'), /不支持今日/);
  assert.throws(() => core.days('2024-01-01', '2024-02-01', '2024-03-10'), /最多采集 31 天/);
});

test('snapshot parses主播 identity, metrics, quality flags, and pagination', () => {
  const page = new JSDOM(`
    <table><thead><tr><th>主播信息</th><th>粉丝指数</th><th>总音浪</th><th>开播总时长</th><th>acu</th></tr></thead>
      <tbody><tr>
        <td><div class="standard-components-anchor-info-v2">
          <span class="standard-components-anchor-info-v2-nickname">测试主播</span>
          <span class="standard-components-anchor-info-v2-info-item"><span class="standard-components-anchor-info-v2-info-item-text">123456789012345</span></span>
          <span class="standard-components-anchor-info-v2-info-item"><i class="semi2-icon-tiktok_logo"></i><span class="standard-components-anchor-info-v2-info-item-text">douyin_test</span></span>
        </div></td><td>1.2万</td><td>9,000</td><td>2小时3分钟</td><td>—</td>
      </tr></tbody>
    </table>
    <div class="standard-components-pagination-page-info">显示第 1 条 - 第 1 条，共 1 条</div>
    <button class="semi2-page-next" disabled>下一页</button>`, { runScripts: 'outside-only' });
  const result = core.snapshot(page.window.document, 'daily', '2026-10-25');
  assert.equal(result.total, 1);
  assert.equal(result.hasNext, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])), {
    anchorId: '123456789012345', douyinId: 'douyin_test', nickname: '测试主播', date: '2026-10-25',
    waves: 9000, liveSeconds: 7380, acu: null, approximate: [], missing: ['acu'],
    raw: { waves: '9,000', liveDuration: '2小时3分钟', acu: '—' }, exactRaw: { waves: '9,000', acu: null }, capturedAt: result.rows[0].capturedAt
  });
});

test('CSV escapes spreadsheet formula prefixes and quotes', () => {
  const csv = core.csv([{ date: '2026-10-25', nickname: '=HYPERLINK("x")', anchorId: '123' }]);
  assert.match(csv, /'=HYPERLINK\(""x""\)/);
  assert.ok(csv.startsWith('\uFEFF'));
});

test('ERP endpoint only accepts the configured ERP origin or local demo API paths', () => {
  assert.equal(core.endpoint('https://erp.yeshuyu.com/api/import').pathname, '/api/import');
  assert.equal(core.endpoint('http://127.0.0.1:8000/api/import').hostname, '127.0.0.1');
  for (const url of [
    'https://erp.yeshuyu.com/#dashboard',
    'https://erp.yeshuyu.com.evil.example/api/import',
    'http://erp.yeshuyu.com/api/import',
    'https://erp.yeshuyu.com/import',
    'https://user:pass@erp.yeshuyu.com/api/import'
  ]) assert.throws(() => core.endpoint(url));
});

test('merge joins daily rows by主播 ID and marks profiles that are absent', () => {
  const merged = core.merge([{ anchorId: '1', followers: 500 }], [
    { anchorId: '1', date: '2026-10-25', waves: 5 }, { anchorId: '2', date: '2026-10-25', waves: 9 }
  ]);
  assert.equal(merged[0].followers, 500);
  assert.equal(merged[0].profileMissing, false);
  assert.equal(merged[1].followers, null);
  assert.equal(merged[1].profileMissing, true);
});

test('quality checks include missing followers, approximate profiles and missing daily metrics', () => {
  assert.equal(core.needsReview({ followers: 0, waves: 0, acu: 0 }), false);
  assert.equal(core.needsReview({ followers: null }), true);
  assert.equal(core.needsReview({ followers: 12000, followersApproximate: true }), true);
  assert.equal(core.needsReview({ followers: 10, missing: ['acu'] }), true);
  assert.equal(core.needsReview({ followers: 10, approximate: ['waves'] }), true);
});

const identityCell = content => new JSDOM(`<table><tr><td>${content}</td></tr></table>`).window.document.querySelector('td');
const item = (value, icon = '') => `<div class="standard-components-anchor-info-v2-info-item">${icon}<span class="standard-components-anchor-info-v2-info-item-text">${value}</span></div>`;
const nickname = '<span class="standard-components-anchor-info-v2-nickname">兼容性测试主播</span>';

test('a short final page uses the total even when the platform displays a full page boundary', () => {
  const row = index => `<tr><td><div class="standard-components-anchor-info-v2">${nickname}${item(`UID：${7654559237235295200n + BigInt(index)}`)}${item(`抖音号：test_${index}`)}</div></td><td>42</td></tr>`;
  const dom = new JSDOM(`<table><thead><tr><th>主播信息</th><th>粉丝数</th></tr></thead><tbody>${Array.from({ length: 9 }, (_, i) => row(i)).join('')}</tbody></table><div class="page-info">显示第421条-第430条，共429条</div><button class="semi2-page-next" disabled>Next</button>`);
  try {
    const result = core.snapshot(dom.window.document, 'profiles');
    assert.equal(result.start, 421); assert.equal(result.end, 429);
    assert.equal(result.displayedEnd, 430); assert.equal(result.rowCount, 9);
    assert.equal(result.hasNext, false);
    dom.window.document.querySelector('button').disabled = false;
    assert.throws(() => core.snapshot(dom.window.document, 'profiles'), /分页数量不一致/);
    dom.window.document.querySelector('button').disabled = true;
    dom.window.document.querySelector('tbody tr').remove();
    assert.throws(() => core.snapshot(dom.window.document, 'profiles'), /分页数量不一致/);
    dom.window.document.querySelector('.page-info').textContent = '显示第430条-第439条，共429条';
    assert.throws(() => core.snapshot(dom.window.document, 'profiles'), /分页数量不一致/);
  } finally { dom.window.close(); }
});

test('identity accepts fullwidth UID labels and SVG sprite account icons without swapping IDs', () => {
  const cell = identityCell(nickname + item('30706174460', '<svg><use xlink:href="#semi-icons-tiktok_logo"></use></svg>') + item('30706174460', '<svg><use href="#semi-icons-vigo_logo"></use></svg>') + item('UID：7654559237235295269'));
  const row = core.identity(cell);
  assert.equal(row.anchorId, '7654559237235295269');
  assert.equal(row.douyinId, '30706174460');
});

test('identity recognizes accessible Chinese labels and a unique bare UID', () => {
  const cell = identityCell(nickname + item('douyin_a', '<span role="img" aria-label="抖音"></span>') + item('vigo_a', '<span role="img" aria-label="西瓜"></span>') + item('7654559237235295269'));
  assert.equal(core.identity(cell).anchorId, '7654559237235295269');
  assert.equal(core.identity(cell).douyinId, 'douyin_a');
});

test('known UID with absent account or nickname remains a reviewable record', () => {
  const cell = identityCell(item('主播ID：7654559237235295269') + item('抖音号：未授权'));
  const row = core.identity(cell);
  assert.equal(row.anchorId, '7654559237235295269'); assert.equal(row.douyinId, null); assert.equal(row.nickname, null);
  assert.deepEqual(Array.from(row.identityMissing), ['douyinId', 'nickname']);
  assert.equal(core.needsReview({ ...row, followers: 100 }), true);
});

test('identity refuses to guess a UID from unlabelled numeric account lines', () => {
  const cell = identityCell(nickname + item('30706174460') + item('7654559237235295269'));
  assert.throws(() => core.identity(cell), error => error.code === 'ANCHOR_IDENTITY_UNREADABLE' && error.diagnostic.items.length === 2);
});

test('identity rejects conflicting explicit UIDs and ignores unrelated unlabelled badges', () => {
  const bad = identityCell(nickname + item('UID：7654559237235295269') + item('UID：7654559237235295270'));
  assert.throws(() => core.identity(bad), /多个 UID 候选/);
  const good = identityCell(nickname + item('徽章') + item('test_dy', '<i class="semi2-icon-tiktok_logo"></i>') + item('7654559237235295269'));
  assert.equal(core.identity(good).anchorId, '7654559237235295269');
});

test('text extraction falls back when innerText is empty but scoped DOM text is present', () => {
  const cell = identityCell(nickname + item('UID：7654559237235295269') + item('抖音号：test_dy'));
  for (const span of cell.querySelectorAll('span')) Object.defineProperty(span, 'innerText', { value: '' });
  assert.equal(core.identity(cell).anchorId, '7654559237235295269');
  assert.equal(core.identity(cell).douyinId, 'test_dy');
});

test('merging fills a missing account from the same UID profile and clears resolved flags', () => {
  const merged = core.merge([{ anchorId: '7654559237235295269', douyinId: 'test_dy', nickname: '测试主播', followers: 42 }], [{ anchorId: '7654559237235295269', douyinId: null, nickname: null, identityMissing: ['douyinId', 'nickname'] }]);
  assert.equal(merged[0].douyinId, 'test_dy'); assert.equal(merged[0].nickname, '测试主播'); assert.equal(merged[0].identityMissing, undefined);
});
