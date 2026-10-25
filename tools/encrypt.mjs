#!/usr/bin/env node
// 텍스트 파일을 리더용 암호화 파일(.txt.enc)로 변환하거나, 반대로 복호화한다.
//   암호화: node tools/encrypt.mjs novels/작품/1권.txt [다른파일.txt ...]
//   복호화: node tools/encrypt.mjs --decrypt novels/작품/1권.txt.enc
// 비밀번호는 실행 중에 입력하거나 환경변수 WN_PASSWORD 로 넘길 수 있다.
// 원본 .txt 는 지우지 않는다. 저장소에는 .enc 파일만 올릴 것.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { encryptText, decryptText, decodeText } from '../assets/wncrypt.js';

const args = process.argv.slice(2);
const decrypt = args[0] === '--decrypt' || args[0] === '-d';
const inputs = decrypt ? args.slice(1) : args;
if (!inputs.length) {
  console.error('사용법: node tools/encrypt.mjs [--decrypt] <파일> [파일 ...]');
  process.exit(1);
}

let password = process.env.WN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('비밀번호: ');
  if (!decrypt && (await rl.question('비밀번호 확인: ')) !== password) {
    rl.close();
    console.error('비밀번호가 일치하지 않습니다.');
    process.exit(1);
  }
  rl.close();
}
if (!password) { console.error('비밀번호가 비어 있습니다.'); process.exit(1); }

for (const input of inputs) {
  if (decrypt) {
    const text = await decryptText(await readFile(input, 'utf8'), password);
    const out = input.replace(/\.enc$/i, '') + (input.toLowerCase().endsWith('.txt.enc') ? '' : '.txt');
    await writeFile(out, text);
    console.log(`복호화: ${input} → ${out}`);
  } else {
    const text = decodeText(new Uint8Array(await readFile(input)));
    const out = input + '.enc';
    await writeFile(out, await encryptText(text, password));
    console.log(`암호화: ${input} → ${out}`);
  }
}
