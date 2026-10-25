#!/usr/bin/env node
// 텍스트 파일·표지 이미지를 리더용 암호화 파일(.enc)로 변환하거나, 반대로 복호화한다.
//   암호화: node tools/encrypt.mjs novels/작품/1권.txt [cover.jpg ...]
//   복호화: node tools/encrypt.mjs --decrypt novels/작품/1권.txt.enc
// 비밀번호는 실행 중에 입력하거나 환경변수 WN_PASSWORD 로 넘길 수 있다.
// 원본 .txt 는 지우지 않는다. 저장소에는 .enc 파일만 올릴 것.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { encryptText, encryptBytes, decryptBytes, decodeText, imageTypeOf } from '../assets/wncrypt.js';

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
    const { bytes } = await decryptBytes(await readFile(input, 'utf8'), password);
    const name = input.replace(/\.enc$/i, '');
    const out = name !== input && /\.\w+$/.test(name.split('/').pop()) ? name : name + '.txt';
    await writeFile(out, bytes);
    console.log(`복호화: ${input} → ${out}`);
  } else {
    const type = imageTypeOf(input);
    const data = type
      ? await encryptBytes(new Uint8Array(await readFile(input)), password, { type, compress: false })
      : await encryptText(decodeText(new Uint8Array(await readFile(input))), password);
    const out = input + '.enc';
    await writeFile(out, data);
    console.log(`암호화: ${input} → ${out}`);
  }
}
