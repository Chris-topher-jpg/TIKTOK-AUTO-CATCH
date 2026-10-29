import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('扩展必须使用 Manifest V3');
if (manifest.permissions?.includes('<all_urls>') || manifest.host_permissions?.includes('<all_urls>')) throw new Error('扩展不得请求全站访问权限');
if (manifest.optional_host_permissions?.length || manifest.host_permissions?.some(origin => origin !== 'https://union.bytedance.com/*')) throw new Error('采集交付版不得包含 ERP 或其他站点访问权限');
if (!(await readFile(path.join(root, 'extension', 'core.js'), 'utf8')).includes('const ERP_ENABLED = false')) throw new Error('采集交付版必须关闭 ERP 发送');
for (const file of ['core.js', 'collector.js', 'background.js', 'database.js', 'dashboard.js', 'dashboard.html', 'dashboard.css', 'dashboard-state.css']) {
  await access(path.join(root, 'extension', file));
}
if (!manifest.content_scripts?.some(script => script.matches?.includes('https://union.bytedance.com/open/portal/*'))) {
  throw new Error('直播服务平台内容脚本匹配范围缺失');
}
for (const file of ['core.js', 'collector.js', 'background.js', 'database.js', 'dashboard.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'extension', file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file} 语法检查失败：${result.stderr || result.stdout}`);
}
console.log('静态检查通过：Manifest V3、权限范围、资源文件与 JavaScript 语法。');
for (const file of ['store.mjs', 'delivery.mjs', 'exports.mjs', 'source.mjs', 'runner.mjs', 'main.mjs', 'erp-setup.mjs', 'erp-connection.mjs', 'control.mjs', 'runtime.mjs', 'launch.mjs', 'panel.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'service', file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('后台服务语法错误：' + file + '：' + result.stderr);
}
console.log('独立后台服务语法检查通过；默认不访问 ERP。');
