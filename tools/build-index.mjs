#!/usr/bin/env node
// novels/ 폴더를 훑어서 리더가 읽는 목록 파일(novels/index.json)을 만든다.
// 표지: 텍스트와 같은 이름의 이미지(1권.txt ↔ 1권.jpg)가 우선이고,
//       없으면 폴더의 cover.* / 표지.* 이미지를 쓴다. 이미지도 .enc 로 암호화할 수 있다.
// 사용법: node tools/build-index.mjs
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const novelsDir = join(root, 'novels');
const IMAGE = /\.(jpe?g|png|webp|gif|avif)(\.enc)?$/i;
const isText = (name) => /\.txt(\.enc)?$/i.test(name) || (/\.enc$/i.test(name) && !IMAGE.test(name));
const stem = (name) => name.replace(/\.enc$/i, '').replace(/\.[^.]+$/, '');
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(full));
    else if (isText(ent.name) || IMAGE.test(ent.name)) out.push(full);
  }
  return out;
}

const files = [];
const images = new Map(); // "폴더/이름(확장자 제외)" → 경로
const folderCovers = {};
const all = await walk(novelsDir);
for (const full of all) {
  const name = basename(full);
  if (!IMAGE.test(name)) continue;
  const path = relative(root, full).split(sep).join('/');
  const folder = relative(novelsDir, dirname(full)).split(sep).join('/');
  images.set(folder + '/' + stem(name), path);
  if (folder && /^(cover|표지)$/i.test(stem(name))) folderCovers[folder] = path;
}
for (const full of all) {
  const name = basename(full);
  if (!isText(name)) continue;
  const path = relative(root, full).split(sep).join('/');
  const folder = relative(novelsDir, dirname(full)).split(sep).join('/');
  files.push({
    path,
    folder,
    name,
    title: name.replace(/\.enc$/i, '').replace(/\.txt$/i, ''),
    size: (await stat(full)).size,
    encrypted: /\.enc$/i.test(name),
    cover: images.get(folder + '/' + stem(name)) || null,
  });
}
files.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name));

await writeFile(join(novelsDir, 'index.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), folderCovers, files }, null, 2) + '\n');
console.log(`novels/index.json: ${files.length}개 파일`);
