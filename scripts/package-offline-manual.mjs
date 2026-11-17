import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// 两种发行包共用 dist；保持源文档目录结构，让离线读者可以逐级打开附件。
const root = await realpath(path.resolve(import.meta.dirname, '..'));
const destination = path.join(root, 'dist', 'manual');
const attachments = new Set([
  'README.md', 'README.en.md', 'AGENTS.md', 'LICENSE', 'updates/README.md',
  'scripts/docker/message-queues.compose.yaml', 'scripts/docker/message-queues.env.example',
  'src-tauri/vendor/sqlx-mysql/DBFOLIO-PATCH.md',
]);
const files = new Set(['docs/design.md']);
for (const relative of files) {
  const source = await realpath(path.resolve(root, relative));
  const canonical = path.relative(root, source).split(path.sep).join('/');
  if (canonical !== relative || !(canonical.startsWith('docs/') || attachments.has(canonical))) {
    throw new Error(`不支持的离线文档附件路径：${relative}`);
  }
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  if (!relative.endsWith('.md')) continue;
  const content = await readFile(source, 'utf8');
  for (const [, href] of content.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    files.add(path.posix.join(path.posix.dirname(relative), href));
  }
}
console.log(`已打包离线设计文档及附件（${files.size} 个文件）`);
