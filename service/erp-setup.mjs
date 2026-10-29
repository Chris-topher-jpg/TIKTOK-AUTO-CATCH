import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.mjs';
import { ErpConnection } from './erp-connection.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const question = async prompt => {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(prompt)).trim(); } finally { input.close(); }
};
async function password() {
  if (!process.stdin.isTTY) throw new Error('请在本机终端交互输入密码，禁止从命令行参数传入');
  process.stdout.write('ERP 登录密码（输入不显示）：');
  process.stdin.setRawMode(true); process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const receive = data => {
        const text = data.toString('utf8');
        if (text.includes('\u0003')) { process.stdin.off('data', receive); reject(new Error('已取消')); return; }
        if (/[\r\n]/.test(text)) { process.stdin.off('data', receive); resolve(value); return; }
        if (text === '\u007f' || text === '\b') value = value.slice(0, -1);
        else if (!text.includes('\u001b')) value += text;
      };
      process.stdin.on('data', receive);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
}
let store, connection;
try {
  console.log('本工具将登录 ERP、按 UID/抖音号明确绑定已有档案，并创建专用同步令牌。不会修改主播档案或工资。请先停止后台服务。');
  let config = {};
  try { config = JSON.parse(await readFile(resolve(root, 'service.config.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dataDir = resolve(root, config.dataDir || 'localdata');
  await access(resolve(dataDir, 'collector.sqlite'));
  store = new Store(resolve(dataDir, 'collector.sqlite'));
  if (!store.profiles().length || !store.profileScan()) throw new Error('请先完成一轮完整的真实主播名单采集');
  const phone = await question('ERP 总经理或运营负责人登录手机号：');
  const secret = await password();
  connection = new ErpConnection({ store, dataDir });
  const state = await connection.connect({ phone, password: secret });
  if (state.stage !== 'connected') throw new Error(state.message || '连接未完成');
  console.log(`${state.message} 公会无需手填；专用令牌仅保存在本机，密码不保存。现在运行“打开自动同步”。`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await connection?.close(); store?.close();
}
