import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/shared/error-text.ts';

test('内部の印は、原因と対処がわかる文にする', () => {
  assert.match(describeError('tab_unresponsive'), /Linkexのタブが応答しません/);
  assert.match(describeError('no_response'), /再読み込み/);
});

test('印のあとの詳しい中身は、かっこで残す', () => {
  assert.match(describeError('no_result {"a":1}'), /返事がありませんでした.*（\{"a":1\}）$/);
});

test('知らないエラーはそのまま', () => {
  assert.equal(describeError('JD2に接続できません。…'), 'JD2に接続できません。…');
  assert.equal(describeError('timeout: 送り直していません'), 'timeout: 送り直していません');
});

test('拡張機能を読み込み直した後の古いページからの送信は、ページの読み込み直しを促す', () => {
  assert.match(describeError('Could not establish connection. Receiving end does not exist.'), /このページを読み込み直してください/);
});
