import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = {};
async function collect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(dist, fullPath).split(path.sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`前端资源不能是符号链接：${relative}`);
    if (entry.isDirectory()) await collect(fullPath);
    else if (relative !== 'web-manifest.json') {
      const data = await readFile(fullPath);
      files[relative] = createHash('sha256').update(data).digest('hex');
    }
  }
}
await collect(dist);
if (!files['index.html']) throw new Error('前端构建缺少 index.html');
await writeFile(path.join(dist, 'web-manifest.json'), JSON.stringify({ version, files }, null, 2) + '\n');
console.log(`已生成 DBFolio ${version} 前端资源清单（${Object.keys(files).length} 个文件）`);
