import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectType, fileKind, hasKnownExtension, nameWithDetectedType } from '../src/shared/media-type.ts';

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};

test('先頭のバイトから種類を見分ける', () => {
  assert.equal(detectType(bytes([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(detectType(bytes([0x89], 'PNG\r\n')), 'png');
  assert.equal(detectType(bytes('GIF89a')), 'gif');
  assert.equal(detectType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'webp');
  assert.equal(detectType(bytes([0, 0, 0, 0x18], 'ftypisom')), 'mp4');
  assert.equal(detectType(bytes([0, 0, 0, 0x14], 'ftypqt  ')), 'mov');
  assert.equal(detectType(bytes([0, 0, 0, 0x1c], 'ftypheic')), 'heic');
  assert.equal(detectType(bytes([0x1a, 0x45, 0xdf, 0xa3], 'B\x82\x84webm')), 'webm');
  assert.equal(detectType(bytes([0x1a, 0x45, 0xdf, 0xa3], 'B\x82\x88matroska')), 'mkv');
  assert.equal(detectType(bytes('%PDF-1.7')), 'pdf');
  assert.equal(detectType(bytes('<html><body>')), null);
  assert.equal(detectType(bytes('ab')), null);
});

test('MPEG-TS は 188 バイトごとの同期バイトで見分ける', () => {
  const b = new Uint8Array(400);
  b[0] = b[188] = b[376] = 0x47;
  assert.equal(detectType(b), 'ts');
});

test('拡張子が無い・見慣れない名前にだけ付け足す', () => {
  const mp4 = bytes([0, 0, 0, 0x18], 'ftypisom');
  assert.equal(nameWithDetectedType('clip', mp4), 'clip.mp4');
  assert.equal(nameWithDetectedType('video.2024', mp4), 'video.2024.mp4');
  assert.equal(nameWithDetectedType('clip (2)', mp4), 'clip (2).mp4');
  // 知っている拡張子は、中身と違っていても変えない
  assert.equal(nameWithDetectedType('pic.png', mp4), null);
  assert.equal(nameWithDetectedType('clip.MP4', mp4), null);
  // 判定できなければ付けない
  assert.equal(nameWithDetectedType('mystery', bytes('<html>')), null);
});

test('知っている拡張子かどうか', () => {
  assert.equal(hasKnownExtension('a.jpeg'), true);
  assert.equal(hasKnownExtension('a.ZIP'), true);
  assert.equal(hasKnownExtension('a'), false);
  assert.equal(hasKnownExtension('.hidden'), false);
  assert.equal(hasKnownExtension('a.2024'), false);
});

test('名前の拡張子から大まかな種類を決める', () => {
  assert.equal(fileKind('a.MP4'), 'video');
  assert.equal(fileKind('a.jpeg'), 'image');
  assert.equal(fileKind('a.flac'), 'audio');
  assert.equal(fileKind('a.7z'), 'archive');
  assert.equal(fileKind('a'), 'other');
  assert.equal(fileKind('a.txt'), 'other');
});
