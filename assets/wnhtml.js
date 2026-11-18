// 단독 실행 HTML(읽기 전용 전자책) 만들기·읽기. 브라우저와 Node 18+ 양쪽에서 동작.
//
// 만들어진 HTML 은 assets/standalone.html 을 틀로 쓰고, 본문은 아래 형식으로 암호화해 넣는다.
//   <script id="wn-data" type="application/json">{ format, v, iter, salt, iv, key?, data }</script>
//   data = AES-256-GCM( gzip( JSON { title, files:[{title,text}], cover:{type,data}|null, protect } ) )
// - 비밀번호가 있으면 키는 PBKDF2-SHA256(60만 회)로 만든다. HTML 안에 키가 없으므로 비밀번호 없이는 못 연다.
// - 비밀번호 없이 만들면 무작위 키를 HTML 안(key)에 함께 넣는다. 열면 바로 읽히고, 편집기로 열면
//   암호문만 보인다. 다만 키가 파일 안에 있으므로 이는 '난독화' 수준이지 진짜 잠금은 아니다.
import { bytesToB64, b64ToBytes, pipeBytes, deriveKey, decodeText, imageTypeOf, WrongPasswordError } from './wncrypt.js';

export const HTML_FORMAT = 'web-novel-html';
const ITERATIONS = 600000;
const subtle = globalThis.crypto.subtle;
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const DATA_RE = /<script id="wn-data" type="application\/json">([\s\S]*?)<\/script>/;

export const isTextName = (name) => /\.txt$/i.test(name);
export const isCoverName = (name) => /^(cover|표지)\.(jpe?g|png|webp|gif|avif)$/i.test(name);
export const stripExt = (name) => name.replace(/\.[^./]+$/, '');

// 틀(standalone.html) 불러오기
export async function loadTemplate() {
  const url = new URL('./standalone.html', import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return readFile(url, 'utf8');
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTML 틀을 불러오지 못했습니다 (${res.status})`);
  return res.text();
}

// 폴더 안 파일들 → 책 한 권. entries: [{ path: '하위/1화.txt', bytes: Uint8Array }]
// .txt 는 경로 이름순(숫자 인식)으로 이어 붙이고, cover.* / 표지.* 이미지(가장 얕은 것)를 표지로 쓴다.
export function bookFromEntries(entries) {
  const texts = entries.filter((e) => isTextName(e.path))
    .sort((a, b) => collator.compare(a.path, b.path));
  const covers = entries.filter((e) => isCoverName(e.path.split('/').pop()))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  return {
    files: texts.map((e) => ({ title: stripExt(e.path.split('/').pop()), text: decodeText(e.bytes) })),
    cover: covers[0] ? { type: imageTypeOf(covers[0].path), bytes: covers[0].bytes } : null,
  };
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 단독 실행 HTML 문자열을 만든다. password 가 비어 있으면 암호 없이(바로 열림) 만든다.
export async function buildHtml(template, { title, files, cover = null, password = '', protect = true }) {
  if (!files.length) throw new Error('넣을 텍스트(.txt) 파일이 없습니다.');
  const book = {
    title,
    files: files.map((f) => ({ title: f.title, text: f.text.replace(/\r\n?/g, '\n') })),
    cover: cover ? { type: cover.type, data: bytesToB64(cover.bytes) } : null,
    protect,
  };
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const meta = { format: HTML_FORMAT, v: 1, iv: bytesToB64(iv) };
  let key;
  if (password) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(password, salt, ITERATIONS);
    Object.assign(meta, { iter: ITERATIONS, salt: bytesToB64(salt) });
  } else {
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
    key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    meta.key = bytesToB64(raw);
  }
  const packed = await pipeBytes(new TextEncoder().encode(JSON.stringify(book)), new CompressionStream('gzip'));
  meta.data = bytesToB64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, packed)));
  // 함수 형태로 치환해야 본문 속 '$&' 같은 문자열이 특수 패턴으로 해석되지 않는다
  return template
    .replace('<!--WN_TITLE-->', () => escapeHtml(title))
    .replace('<!--WN_TITLE-->', () => escapeHtml(title))
    .replace('/*WN_DATA*/', () => JSON.stringify(meta).replace(/</g, '\\u003c'));
}

// ---------- 읽기 (리더에서 novels/ 안의 .html 을 열 때) ----------
export function isStandaloneHtml(text) {
  return DATA_RE.test(text) && text.includes(HTML_FORMAT);
}
export function readMeta(html) {
  const m = html.match(DATA_RE);
  if (!m) throw new Error('이 도구로 만든 HTML 파일이 아닙니다.');
  const meta = JSON.parse(m[1]);
  if (meta.format !== HTML_FORMAT || meta.v !== 1) throw new Error('지원하지 않는 HTML 형식입니다.');
  return meta;
}
export const needsPassword = (meta) => !meta.key;

// 반환: { title, files:[{title,text}], cover:{type,data}|null, protect }
export async function openBook(meta, password = '') {
  const key = meta.key
    ? await subtle.importKey('raw', b64ToBytes(meta.key), 'AES-GCM', false, ['decrypt'])
    : await deriveKey(password, b64ToBytes(meta.salt), meta.iter);
  let plain;
  try {
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(meta.iv) }, key, b64ToBytes(meta.data)));
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(new TextDecoder().decode(await pipeBytes(plain, new DecompressionStream('gzip'))));
}
