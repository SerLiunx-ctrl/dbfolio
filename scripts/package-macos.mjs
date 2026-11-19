import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
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
// 默认构建测试包；仅显式提供 Developer ID identity 后才使用真实签名和公证。
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-';
process.env.APPLE_SIGNING_IDENTITY = signingIdentity;
const developerId = signingIdentity !== '-';
const present = name => !!process.env[name]?.trim();
const certificateVariables = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'];
const appleIdVariables = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
const apiVariables = ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'];
let notarizationArguments = [];
if (developerId) {
  if (!signingIdentity.startsWith('Developer ID Application:')) {
    throw new Error('公开分发请使用完整的 Developer ID Application 证书名称作为 APPLE_SIGNING_IDENTITY。');
  }
  if (present('APPLE_CERTIFICATE') !== (process.env.APPLE_CERTIFICATE_PASSWORD !== undefined)) {
    throw new Error('CI 证书需同时配置 APPLE_CERTIFICATE 和 APPLE_CERTIFICATE_PASSWORD；本机已导入证书时可同时省略。');
  }
  // 与锁定版本 Tauri 的优先顺序保持一致，避免两套凭据选择不同的团队。
  if (appleIdVariables.some(present)) {
    if (!appleIdVariables.every(present)) throw new Error('Apple ID 公证需要 APPLE_ID、APPLE_PASSWORD（应用专用密码）和 APPLE_TEAM_ID。');
    notarizationArguments = ['--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID];
  } else {
    if (!apiVariables.every(present)) throw new Error('公证需要 Apple ID 完整凭据，或 APPLE_API_KEY、APPLE_API_ISSUER、APPLE_API_KEY_PATH 三项 API 凭据。');
    notarizationArguments = ['--key-id', process.env.APPLE_API_KEY, '--issuer', process.env.APPLE_API_ISSUER, '--key', process.env.APPLE_API_KEY_PATH];
  }
} else if ([...certificateVariables, ...appleIdVariables, ...apiVariables].some(present)) {
  throw new Error('已提供 Apple 签名或公证凭据，请显式配置 Developer ID Application 类型的 APPLE_SIGNING_IDENTITY；ad-hoc 测试构建不使用这些凭据。');
}
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
if (developerId) run('xcrun', ['stapler', 'validate', app]);

const output = path.join(root, 'release', version);
await mkdir(output, { recursive: true });
const prefix = `DBFolio_${version}_macos_${process.arch}`;
const dmgFiles = (await readdir(path.join(bundle, 'dmg'))).filter(name => name.endsWith('.dmg') && name.includes(version));
if (dmgFiles.length !== 1) throw new Error('未找到唯一的当前版本 DMG。');
const dmg = path.join(bundle, 'dmg', dmgFiles[0]);
if (developerId) {
  // Tauri CLI 2.11.4 会公证并 staple .app，但仅对 DMG 签名；最终 DMG 单独提交。
  run('codesign', ['--verify', '--strict', dmg]);
  // 不使用通用 run：execFileSync 的未捕获异常会打印参数，可能泄露应用专用密码。
  const submission = spawnSync('xcrun', ['notarytool', 'submit', dmg, '--wait', '--output-format', 'json', ...notarizationArguments], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
  });
  if (submission.error || submission.status !== 0) {
    throw new Error('最终 DMG 的 Apple 公证提交失败，请核对签名、公证凭据和网络；不会交付未完成公证的正式包。');
  }
  let receipt;
  try { receipt = JSON.parse(submission.stdout); }
  catch { throw new Error('Apple 公证返回了无效结果，无法确认最终 DMG 已获认可。'); }
  if (receipt.status !== 'Accepted') throw new Error('最终 DMG 未通过 Apple 公证，请在 Apple 公证记录中查看原因。');
  run('xcrun', ['stapler', 'staple', dmg]);
  run('xcrun', ['stapler', 'validate', dmg]);
}
await copyFile(dmg, path.join(output, `${prefix}_setup.dmg`));
// ditto 保留 .app 的执行权限、符号链接和签名元数据。
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(output, `${prefix}_app.zip`)]);
await writeFile(path.join(output, `${prefix}_README.txt`), `DBFolio ${version} — macOS ${process.arch} ${developerId ? 'Developer ID 签名包' : '构建测试包'}

DMG：打开后将完整 DBFolio.app 拖入 Applications。
ZIP：完整解压得到 DBFolio.app，勿单独移动 Contents/MacOS 中的程序或前端资源。
${developerId ? '此包已使用 Developer ID 签名，应用与最终 DMG 均通过 Apple 公证并验证附带票据。' : '此包使用 ad-hoc 测试签名，未经过 Apple Developer ID 签名和公证。\n确认下载来源与 SHA256 后，首次尝试打开如被拦截，可进入系统设置 → 隐私与安全性 → 仍要打开。'}
Apple Silicon（M 系列）使用 arm64 包；Intel Mac 使用 x64 包。
云端会检查编译、CPU 架构、签名结构、前端资源和启动 IPC；桌面交互仍需实机验收。
当前 macOS 在线更新尚未接入，升级请下载新包并替换整个 .app。
密码使用 macOS Keychain；Windows 配置和密码不会自动迁入此包。
`, 'utf8');
await writeFile(path.join(output, `${prefix}_build-info.json`), JSON.stringify({
  version, target, profile: 'release',
  commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  signing: developerId ? 'developer-id' : 'ad-hoc', notarized: developerId,
  appNotarizationTicketValidated: developerId, dmgNotarizationTicketValidated: developerId,
}, null, 2) + '\n');
const files = [`${prefix}_setup.dmg`, `${prefix}_app.zip`, `${prefix}_README.txt`, `${prefix}_build-info.json`];
const checksums = await Promise.all(files.map(async name =>
  `${createHash('sha256').update(await readFile(path.join(output, name))).digest('hex')}  ${name}`));
await writeFile(path.join(output, `${prefix}_SHA256SUMS.txt`), checksums.join('\n') + '\n');
console.log(`macOS 安装包、完整 .app ZIP 及 SHA256：${output}`);
