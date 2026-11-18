#!/usr/bin/env node
// 텍스트 파일·표지 이미지를 리더용 암호화 파일(.enc) 또는 단독 실행 HTML 로 만든다. 반대로 .enc 복호화도 한다.
//
//   node tools/encrypt.mjs 원고/1권.txt              → 원고/1권.txt.enc
//   node tools/encrypt.mjs 원고                      → 원고.enc/ (폴더 안 .txt·이미지를 같은 구조로 모두 암호화)
//   node tools/encrypt.mjs --html 원고/1권.txt       → 원고/1권.html (단독 실행 HTML)
//   node tools/encrypt.mjs --html 원고               → 원고.html (폴더의 .txt 전체를 한 권으로 묶은 HTML)
//   node tools/encrypt.mjs --decrypt 원고.enc        → 원고/ (이미 있으면 -o 로 다른 곳 지정)
//
// 비밀번호는 실행 중에 입력하거나 환경변수 WN_PASSWORD 로 넘긴다.
// --html 에서는 비밀번호를 비워 두면(또는 --no-password) 암호 없이 바로 열리는 HTML 을 만든다.
// 원본은 지우지 않는다. 저장소에는 .enc / .html 만 올릴 것.
import { readFile, writeFile, readdir, stat, mkdir, access } from 'node:fs/promises';
import { join, dirname, basename, relative, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { encryptText, encryptBytes, decryptBytes, decodeText, imageTypeOf } from '../assets/wncrypt.js';
import { loadTemplate, buildHtml, bookFromEntries, stripExt, isTextName } from '../assets/wnhtml.js';

const USAGE = `사용법: node tools/encrypt.mjs [옵션] <파일 또는 폴더> [...]

  (옵션 없음)        .enc 로 암호화. 폴더를 주면 <폴더>.enc/ 에 같은 구조로 일괄 생성
  -d, --decrypt      .enc 복호화. 폴더를 주면 안의 .enc 를 모두 복호화
  --html             단독 실행 HTML 로 생성 (브라우저로 열어 바로 읽음)
                       파일 → <파일이름>.html, 폴더 → <폴더>.html (안의 .txt 를 이름순으로 한 권에 묶음)
  --no-password      (--html) 비밀번호 없이 생성 — 열면 바로 읽힘, 소스는 암호문으로 보임
  --title <제목>     (--html) 책 제목 (기본: 파일·폴더 이름)
  --allow-copy       (--html) 본문 복사·인쇄 방지를 끔
  -o, --out <경로>   출력 경로 (입력이 하나일 때만)
  -f, --force        복호화할 때 이미 있는 파일을 덮어씀
  -h, --help         이 도움말`;

// ---------- 인자 ----------
const opts = { mode: 'enc', password: true, title: '', protect: true, out: '', force: false };
const inputs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-d' || a === '--decrypt') opts.mode = 'dec';
  else if (a === '--html') opts.mode = 'html';
  else if (a === '--no-password') opts.password = false;
  else if (a === '--allow-copy') opts.protect = false;
  else if (a === '--title') opts.title = argv[++i] ?? '';
  else if (a === '-o' || a === '--out') opts.out = argv[++i] ?? '';
  else if (a === '-f' || a === '--force') opts.force = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('-') && a !== '-') { console.error(`알 수 없는 옵션: ${a}\n\n${USAGE}`); process.exit(1); }
  else inputs.push(a.replace(/[\\/]+$/, '') || a);
}
if (!inputs.length) { console.error(USAGE); process.exit(1); }
if (opts.out && inputs.length > 1) { console.error('-o 는 입력이 하나일 때만 쓸 수 있습니다.'); process.exit(1); }
if (!opts.password && opts.mode !== 'html') { console.error('--no-password 는 --html 과 함께만 쓸 수 있습니다.'); process.exit(1); }

// ---------- 비밀번호 ----------
let password = opts.password ? process.env.WN_PASSWORD ?? null : '';
if (password == null) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const optional = opts.mode === 'html';
  password = await rl.question(optional ? '비밀번호 (비워 두면 암호 없이 생성): ' : '비밀번호: ');
  if (password && opts.mode !== 'dec' && (await rl.question('비밀번호 확인: ')) !== password) {
    rl.close();
    console.error('비밀번호가 일치하지 않습니다.');
    process.exit(1);
  }
  rl.close();
}
if (!password && opts.mode !== 'html') { console.error('비밀번호가 비어 있습니다.'); process.exit(1); }

// ---------- 유틸 ----------
const exists = (p) => access(p).then(() => true, () => false);
const isDir = async (p) => (await stat(p)).isDirectory();
const posix = (p) => p.split(sep).join('/');
async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue; // .DS_Store, .git 등
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}
async function put(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
let failed = 0;
const skipped = [];

// ---------- 암호화 (.enc) ----------
async function encryptFile(input, out) {
  const type = imageTypeOf(input);
  const bytes = new Uint8Array(await readFile(input));
  await put(out, type
    ? await encryptBytes(bytes, password, { type, compress: false })
    : await encryptText(decodeText(bytes), password));
}
async function encryptDir(dir, outDir) {
  let n = 0;
  for (const full of await walk(dir)) {
    const rel = relative(dir, full);
    if (/\.enc$/i.test(rel) || !(isTextName(rel) || imageTypeOf(rel))) { skipped.push(rel); continue; }
    await encryptFile(full, join(outDir, rel + '.enc'));
    n++;
  }
  console.log(`암호화: ${dir}/ → ${outDir}/ (${n}개 파일)`);
}

// ---------- 복호화 ----------
function decryptedName(path) {
  const name = path.replace(/\.enc$/i, '');
  return name !== path && /\.\w+$/.test(basename(name)) ? name : name + '.txt';
}
async function decryptFile(input, out) {
  if (!opts.force && await exists(out)) throw new Error(`${out} 이(가) 이미 있습니다. -o 로 다른 경로를 주거나 -f 로 덮어쓰세요.`);
  const { bytes } = await decryptBytes(await readFile(input, 'utf8'), password);
  await put(out, bytes);
}
async function decryptDir(dir, outDir) {
  let n = 0;
  for (const full of await walk(dir)) {
    const rel = relative(dir, full);
    if (!/\.enc$/i.test(rel)) { skipped.push(rel); continue; }
    await decryptFile(full, join(outDir, decryptedName(rel)));
    n++;
  }
  console.log(`복호화: ${dir}/ → ${outDir}/ (${n}개 파일)`);
}

// ---------- 단독 HTML ----------
let template;
async function makeHtml(input, out, dir) {
  template ??= await loadTemplate();
  let book;
  if (dir) {
    const entries = [];
    for (const full of await walk(input)) {
      const rel = posix(relative(input, full));
      if (isTextName(rel) || imageTypeOf(rel)) entries.push({ path: rel, bytes: new Uint8Array(await readFile(full)) });
      else skipped.push(rel);
    }
    book = bookFromEntries(entries);
  } else {
    if (!isTextName(input)) throw new Error('.txt 파일만 HTML 로 만들 수 있습니다.');
    book = { files: [{ title: stripExt(basename(input)), text: decodeText(new Uint8Array(await readFile(input))) }], cover: null };
  }
  const title = opts.title || stripExt(basename(input));
  await put(out, await buildHtml(template, { ...book, title, password, protect: opts.protect }));
  console.log(`HTML: ${input}${dir ? '/' : ''} → ${out} (${book.files.length}개 파일${book.cover ? ', 표지 포함' : ''}${password ? ', 🔒 비밀번호' : ', 암호 없음'})`);
}

// ---------- 실행 ----------
for (const input of inputs) {
  try {
    const dir = await isDir(input);
    if (opts.mode === 'html') {
      await makeHtml(input, opts.out || (dir ? input : stripExt(input)) + '.html', dir);
    } else if (opts.mode === 'dec') {
      if (dir) {
        const outDir = opts.out || (/\.enc$/i.test(input) ? input.replace(/\.enc$/i, '') : input + '.dec');
        await decryptDir(input, outDir);
      } else {
        const out = opts.out || decryptedName(input);
        await decryptFile(input, out);
        console.log(`복호화: ${input} → ${out}`);
      }
    } else if (dir) {
      await encryptDir(input, opts.out || input + '.enc');
    } else {
      const out = opts.out || input + '.enc';
      await encryptFile(input, out);
      console.log(`암호화: ${input} → ${out}`);
    }
  } catch (e) {
    failed++;
    console.error(`❌ ${input}: ${e.message}`);
  }
}
if (skipped.length) console.log(`건너뜀 (대상 아님 ${skipped.length}개): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ' …' : ''}`);
if (failed) process.exit(1);
