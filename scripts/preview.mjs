import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, core, dashboard] = await Promise.all([
  readFile(path.join(root, 'extension', 'dashboard.html'), 'utf8'),
  readFile(path.join(root, 'extension', 'core.js'), 'utf8'),
  readFile(path.join(root, 'extension', 'dashboard.js'), 'utf8')
]);
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(html, {
  url: `${pathToFileURL(path.join(root, 'extension', 'dashboard.html')).href}?preview`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole
});
try {
  dom.window.eval(core);
  dom.window.eval(dashboard);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelectorAll('#rows tr').length, 5, '演示表格应显示 5 位主播');
  assert.equal(dom.window.document.querySelector('#row-badge').textContent, '5 条');
  assert.ok(!dom.window.document.querySelector('#preview-banner').classList.contains('hidden'));
  assert.ok(dom.window.document.querySelector('#sync-button').disabled, '演示模式不能发送 ERP 数据');
  assert.ok(dom.window.document.querySelector('#endpoint').disabled, '采集交付版禁用 ERP 接口输入');
  assert.ok(dom.window.document.querySelector('#save-settings').disabled);
  const search = dom.window.document.querySelector('#search');
  search.value = 'mumu_live';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll('#rows tr').length, 1);
  assert.match(dom.window.document.querySelector('#rows').textContent, /木木的直播间/);
  let exported;
  dom.window.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {
    assert.match(this.download, /主播每日数据_preview.json/);
  };
  dom.window.document.querySelector('#export-json').click();
  const content = await new Promise(resolve => { const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported); });
  assert.equal(JSON.parse(content).length, 1);
  assert.equal(JSON.parse(content)[0].anchorId, '6842109231105227613');
  assert.deepEqual(errors, []);
  console.log('演示预览通过：5 条示例、搜索筛选、JSON 导出与长 ID 保真、ERP 禁用。');
} finally {
  dom.window.close();
}
