import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery } from '../src/shared/files.ts';

const file = { name: 'Episode 01.MP4', folders: ['アニメ', 'Season1'] };

test('空の検索はすべて一致', () => {
  assert.equal(matchesQuery(file, ''), true);
  assert.equal(matchesQuery(file, '   '), true);
});

test('大文字小文字・全角半角を区別しない', () => {
  assert.equal(matchesQuery(file, 'mp4'), true);
  assert.equal(matchesQuery(file, 'ＥＰＩＳＯＤＥ'), true);
});

test('フォルダ名でも見つかる', () => {
  assert.equal(matchesQuery(file, 'season1'), true);
  assert.equal(matchesQuery(file, 'アニメ'), true);
});

test('空白で区切った語はすべて含まれていれば一致', () => {
  assert.equal(matchesQuery(file, 'アニメ 01'), true);
  assert.equal(matchesQuery(file, 'アニメ 02'), false);
  assert.equal(matchesQuery(file, 'アニメ　01'), true);
});
