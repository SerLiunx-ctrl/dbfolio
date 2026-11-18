import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'darwin') throw new Error('此启动检查只在 macOS 执行。');
if (process.argv.length !== 3) throw new Error('需要提供 DBFolio.app 路径。');
const root = path.resolve(import.meta.dirname, '..');
const app = path.resolve(process.argv[2]);
const executable = path.join(app, 'Contents', 'MacOS', 'dbfolio');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const diagnostics = path.join(root, '.qa');
await mkdir(diagnostics, { recursive: true });
const output = await mkdtemp(path.join(diagnostics, 'startup-macos-'));
const profile = path.join(output, 'profile'); // 由应用创建新目录，禁止复用已有用户配置。
const child = spawn(executable, ['--startup-check', profile], {
  cwd: path.dirname(executable), stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', closed = false, spawnError;
child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
child.on('error', error => { spawnError = error; });
child.on('close', () => { closed = true; });
try {
  const deadline = Date.now() + 90000;
  let ready;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (closed) throw new Error(`应用在前端就绪前退出：${child.exitCode ?? child.signalCode}`);
    try { ready = JSON.parse(await readFile(path.join(profile, 'frontend-ready.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, '90 秒内未收到前端 IPC 就绪标记');
  assert.equal(ready.pid, child.pid, '前端就绪标记的进程不匹配');
  assert.equal(ready.version, version, '前端就绪标记的版本不匹配');
  await delay(2000);
  assert.equal(closed, false, '应用在前端就绪后意外退出');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({
    version, executable, frontendReady: true, isolatedProfile: profile,
    scope: '仅验证启动和 IPC，桌面交互仍需实机验收',
  }, null, 2));
  console.log(`macOS 正常启动、前端 IPC 就绪；诊断：${output}`);
} finally {
  if (!closed && child.pid) {
    child.kill('SIGTERM');
    for (let i = 0; i < 25 && !closed; i++) await delay(200);
    if (!closed) child.kill('SIGKILL'); // 仅结束本脚本创建的进程。
  }
  await writeFile(path.join(output, 'stdout.txt'), stdout);
  await writeFile(path.join(output, 'stderr.txt'), stderr);
}
