// 웹소설 리더용 암호화/복호화 모듈 (브라우저와 Node 18+ 양쪽에서 동작)
// 형식: JSON { format, v, kdf{PBKDF2/SHA-256}, cipher{AES-GCM}, compression, data }
// 평문은 UTF-8 로 정규화한 뒤 gzip 압축 → AES-256-GCM 암호화 → base64 로 저장한다.

export const FORMAT = 'web-novel-enc';
const ITERATIONS = 600000;

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// 텍스트 파일 바이트를 문자열로 변환. UTF-8 / UTF-16(BOM) / EUC-KR(CP949) 자동 판별.
export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncrypted(textOrBytes) {
  const head = typeof textOrBytes === 'string'
    ? textOrBytes.slice(0, 64)
    : new TextDecoder().decode(textOrBytes.subarray(0, 64));
  return head.trimStart().startsWith('{') && head.includes(FORMAT);
}

export async function encryptText(text, password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const packed = await pipeBytes(enc.encode(text), new CompressionStream('gzip'));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  return JSON.stringify({
    format: FORMAT,
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: bytesToB64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToB64(iv) },
    compression: 'gzip',
    data: bytesToB64(ct),
  });
}

export class WrongPasswordError extends Error {
  constructor() { super('비밀번호가 올바르지 않습니다.'); this.name = 'WrongPasswordError'; }
}

export async function decryptText(payload, password) {
  const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (obj.format !== FORMAT || obj.v !== 1) throw new Error('지원하지 않는 암호화 파일 형식입니다.');
  const key = await deriveKey(password, b64ToBytes(obj.kdf.salt), obj.kdf.iterations);
  let plain;
  try {
    plain = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(obj.cipher.iv) }, key, b64ToBytes(obj.data),
    ));
  } catch {
    throw new WrongPasswordError();
  }
  if (obj.compression === 'gzip') plain = await pipeBytes(plain, new DecompressionStream('gzip'));
  return new TextDecoder('utf-8').decode(plain);
}
