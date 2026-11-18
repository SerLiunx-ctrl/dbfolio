import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

if (process.platform !== 'darwin') throw new Error('macOS 打包需要在 macOS 上运行，可使用 GitHub Actions。');
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const targets = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const { values } = parseArgs({ options: { target: { type: 'string', default: targets[process.arch] } } });
const target = values.target;
if (!target || target !== targets[process.arch]) {
  throw new Error('请在对应架构的 Mac 上构建，以便执行打包后的资源和启动校验。');
}
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('版本号格式无效。');
function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}
run('npm', ['run', 'tauri', 'build', '--', '--features', 'custom-protocol', '--target', target, '--bundles', 'app,dmg', '--', '--locked']);
const bundle = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle');
const app = path.join(bundle, 'macos', 'DBFolio.app');
const executable = path.join(app, 'Contents', 'MacOS', 'dbfolio');
const expectedArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const architectures = execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/);
if (architectures.length !== 1 || architectures[0] !== expectedArch) throw new Error('安装包 CPU 架构与目标不符。');
// 运行实际分发二进制，检查编译时清单与 .app 中的全部前端文件。
run(executable, ['--verify-resources']);
run('codesign', ['--verify', '--deep', '--strict', app]);

const output = path.join(root, 'release', version);
await mkdir(output, { recursive: true });
const prefix = `DBFolio_${version}_macos_${process.arch}`;
const dmgFiles = (await readdir(path.join(bundle, 'dmg'))).filter(name => name.endsWith('.dmg') && name.includes(version));
if (dmgFiles.length !== 1) throw new Error('未找到唯一的当前版本 DMG。');
await copyFile(path.join(bundle, 'dmg', dmgFiles[0]), path.join(output, `${prefix}_setup.dmg`));
// ditto 保留 .app 的执行权限、符号链接和签名元数据。
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(output, `${prefix}_app.zip`)]);
await writeFile(path.join(output, `${prefix}_README.txt`), `DBFolio ${version} — macOS ${process.arch} 构建测试包

DMG：打开后将完整 DBFolio.app 拖入 Applications。
ZIP：完整解压得到 DBFolio.app，勿单独移动 Contents/MacOS 中的程序或前端资源。
此包使用 ad-hoc 测试签名，未经过 Apple Developer ID 签名和公证。
下载后可能被 Gatekeeper 拦截，请仅在确认来源后按系统提供的入口允许打开。
云端会检查编译、CPU 架构、签名结构、前端资源和启动 IPC；桌面交互仍需实机验收。
当前 macOS 在线更新尚未接入，升级请下载新包并替换整个 .app。
密码使用 macOS Keychain；Windows 配置和密码不会自动迁入此包。
`, 'utf8');
await writeFile(path.join(output, `${prefix}_build-info.json`), JSON.stringify({
  version, target, profile: 'release',
  commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  signing: 'ad-hoc', notarized: false,
}, null, 2) + '\n');
const files = [`${prefix}_setup.dmg`, `${prefix}_app.zip`, `${prefix}_README.txt`, `${prefix}_build-info.json`];
const checksums = await Promise.all(files.map(async name =>
  `${createHash('sha256').update(await readFile(path.join(output, name))).digest('hex')}  ${name}`));
await writeFile(path.join(output, `${prefix}_SHA256SUMS.txt`), checksums.join('\n') + '\n');
console.log(`macOS 安装包、完整 .app ZIP 及 SHA256：${output}`);
