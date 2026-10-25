#!/usr/bin/env node
// novels/ 폴더를 훑어서 리더가 읽는 목록 파일(novels/index.json)을 만든다.
// 사용법: node tools/build-index.mjs
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const novelsDir = join(root, 'novels');
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(full));
    else if (/\.(txt|enc)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

const files = [];
for (const full of await walk(novelsDir)) {
  const path = relative(root, full).split(sep).join('/');
  const folder = relative(novelsDir, dirname(full)).split(sep).join('/');
  const name = basename(full);
  files.push({
    path,
    folder,
    name,
    title: name.replace(/\.enc$/i, '').replace(/\.txt$/i, ''),
    size: (await stat(full)).size,
    encrypted: /\.enc$/i.test(name),
  });
}
files.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name));

await writeFile(join(novelsDir, 'index.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
console.log(`novels/index.json: ${files.length}개 파일`);
