import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const [html, core, dashboard] = await Promise.all(['dashboard.html', 'core.js', 'dashboard.js'].map(async file => {
  const path = file === 'dashboard.html' ? '../extension/dashboard.html' : `../extension/${file}`;
  return readFile(new URL(path, import.meta.url), 'utf8');
}));

test('an existing error task without diagnostics exposes an exportable fallback', async () => {
  const state = {
    job: { status: 'error', phase: 'profiles', start: '2026-10-26', end: '2026-10-26', days: ['2026-10-26'], dayIndex: 0, expectedStart: 181, expectedTotal: 700, profileCount: 180, dailyCount: 0, error: '表格未能稳定加载，请检查登录或网络' },
    rows: [], profiles: Array.from({ length: 180 }, (_, i) => ({ anchorId: String(i + 1) })), settings: {}, syncState: null, qualityCount: 0
  };
  const dom = new JSDOM(html, { url: 'https://extension.test/dashboard.html', runScripts: 'outside-only', pretendToBeVisual: true });
  let exported, filename;
  const w = dom.window;
  w.chrome = {
    runtime: { id: 'test', async sendMessage(message) { return message.type === 'STATE' ? { data: state } : { error: '未知操作' }; } },
    storage: { onChanged: { addListener() {} } }
  };
  w.setInterval = () => 0;
  w.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  try {
    w.eval(core);
    w.eval(dashboard);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
    for (let attempt = 0; attempt < 30 && w.document.querySelector('#diagnostic-button').classList.contains('hidden'); attempt++) await new Promise(resolve => setTimeout(resolve, 1));

    const button = w.document.querySelector('#diagnostic-button');
    assert.equal(button.classList.contains('hidden'), false);
    button.click();
    for (let attempt = 0; attempt < 30 && !exported; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(filename, `采集诊断_v${w.AnchorCore.VERSION}.json`);
    const content = await new Promise(resolve => {
      const reader = new w.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(exported);
    });
    const result = JSON.parse(content);
    assert.equal(result.diagnostic.source, 'dashboard');
    assert.equal(result.diagnostic.task.expectedStart, 181);
    assert.equal(result.diagnostic.task.expectedTotal, 700);
    assert.equal(result.diagnostic.task.profileCount, 180);
    assert.equal(result.diagnostic.task.dailyCount, 0);
    assert.match(result.diagnostic.task.message, /表格未能稳定加载/);
    assert.equal(result.diagnostic.live.available, false);
  } finally { dom.window.close(); }
});

test('diagnostic export uses a fresh background report with separate failure and live evidence', async () => {
  const dom = new JSDOM(html, { url: 'https://extension.test/dashboard.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  let exported;
  w.chrome = {
    runtime: { id: 'test', async sendMessage(message) {
      calls.push(message.type);
      if (message.type === 'STATE') return { data: { backgroundVersion: w.AnchorCore.VERSION, job: { status: 'error', phase: 'profiles', expectedStart: 181 }, rows: [], profiles: [], qualityCount: 0 } };
      assert.equal(message.type, 'DIAGNOSTIC');
      return { data: { source: 'background', backgroundVersion: w.AnchorCore.VERSION, task: { expectedStart: 221 }, savedCounts: { profiles: 180, daily: 0 }, failure: null, live: { source: 'collector', collectorVersion: w.AnchorCore.VERSION, rowCount: 10 } } };
    } },
    storage: { onChanged: { addListener() {} } }
  };
  w.setInterval = () => 0;
  w.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  try {
    w.eval(core); w.eval(dashboard);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    w.document.querySelector('#diagnostic-button').click();
    for (let i = 0; i < 30 && !exported; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const content = await new Promise(resolve => {
      const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported);
    });
    const report = JSON.parse(content).diagnostic;
    assert.equal(report.task.expectedStart, 221);
    assert.equal(report.live.rowCount, 10);
    assert.equal(report.savedCounts.profiles, 180);
    assert.ok(calls.includes('DIAGNOSTIC'));
    assert.equal(w.document.querySelector('#diagnostic-button').disabled, false);
  } finally { w.close(); }
});

test('an outdated background cannot resume or replace data until versions agree', async () => {
  const dom = new JSDOM(html, { url: 'https://extension.test/dashboard.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let backgroundVersion = '0.1.2', onChanged;
  const mutations = [];
  w.chrome = {
    runtime: { id: 'test', async sendMessage(message) {
      if (message.type === 'STATE') return { data: { backgroundVersion, job: { status: 'error', phase: 'profiles', expectedStart: 221 }, rows: [], profiles: [], qualityCount: 0 } };
      mutations.push(message.type);
      return { data: { ok: true } };
    } },
    storage: { onChanged: { addListener(fn) { onChanged = fn; } } }
  };
  w.setInterval = () => 0;
  try {
    w.eval(core); w.eval(dashboard);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const id of ['start-button', 'resume-button', 'clear']) assert.equal(w.document.getElementById(id).disabled, true);
    assert.equal(w.document.querySelector('#diagnostic-button').disabled, false);
    w.document.querySelector('#resume-button').dispatchEvent(new w.Event('click'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(mutations, []);
    backgroundVersion = w.AnchorCore.VERSION;
    onChanged({ job: {} }, 'local');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(w.document.querySelector('#resume-button').disabled, false);
    w.document.querySelector('#resume-button').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(mutations, ['RESUME']);
  } finally { w.close(); }
});
