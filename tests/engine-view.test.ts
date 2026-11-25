import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineView } from '../src/shared/engine-view.ts';

const pending = [{ state: 'pending' }];

test('異常で止まったときは、手動の一時停止と区別して赤で全文を出す', () => {
  const v = engineView({ paused: true, status: 'stopped', message: '一時停止: JD2に接続できません。…確認してください' }, pending);
  assert.equal(v.pill, '止まりました');
  assert.equal(v.tone, 'error');
  assert.equal(v.wrap, true);
  assert.match(v.message, /確認してください$/);
});

test('異常で止まっても、JD2に渡した分が続くことを添える', () => {
  const v = engineView({ paused: true, status: 'stopped', message: '一時停止: ログイン切れ' }, [{ state: 'downloading' }]);
  assert.match(v.message, /JD2 に渡した 1件は最後まで続きます/);
});

test('手動の一時停止は灰色のまま', () => {
  const v = engineView({ paused: true, status: 'paused', message: '一時停止中' }, pending);
  assert.equal(v.pill, '一時停止中');
  assert.equal(v.tone, '');
  assert.equal(v.wrap, false);
});

test('指示役が止まったときは、動いている扱いにしない', () => {
  const v = engineView({ paused: false, status: 'crashed', message: '処理が止まりました: x' }, pending);
  assert.equal(v.tone, 'error');
  assert.match(v.message, /自動でやり直します/);
});

test('待機中かどうかは文言でなく status で決める', () => {
  assert.equal(engineView({ paused: false, status: 'waiting', message: 'ダウンロード中 3件' }, pending).tone, 'waiting');
  assert.equal(engineView({ paused: false, status: 'running', message: '容量の空き待ち' }, pending).tone, 'running');
});

test('全部終わったときは結果をそのまま見せる', () => {
  const v = engineView({ paused: true, status: 'finished', message: 'すべて終わりました' }, [{ state: 'done' }]);
  assert.equal(v.pill, '停止中');
  assert.equal(v.message, 'すべて終わりました');
});
