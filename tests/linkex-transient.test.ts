import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientLinkexFailure, mayRetryLinkex } from '../src/shared/linkex-transient.ts';

test('速度制限とサーバー側の不調は一時的', () => {
  assert.equal(isTransientLinkexFailure({ error: 'x', status: 429 }), true);
  assert.equal(isTransientLinkexFailure({ error: 'x', status: 502 }), true);
});

test('応答が返ってこなかった（通信が切れた・時間切れ）は一時的', () => {
  assert.equal(isTransientLinkexFailure({ error: 'Network Error', status: null, detail: null }), true);
  assert.equal(isTransientLinkexFailure({ error: 'timeout of 30000ms exceeded' }), true);
});

test('Linkexが中身付きで返したエラーや 4xx は一時的ではない', () => {
  assert.equal(isTransientLinkexFailure({ error: 'disk full', status: null, detail: { code: 413300 } }), false);
  assert.equal(isTransientLinkexFailure({ error: 'Network Error', status: 400 }), false);
  assert.equal(isTransientLinkexFailure({ error: 'index_not_found' }), false);
});

test('保存などの POST は、断られたと分かる 429 のときだけ呼び直す', () => {
  assert.equal(mayRetryLinkex('get', { error: 'Network Error' }), true);
  assert.equal(mayRetryLinkex('post', { error: 'Network Error' }), false);
  assert.equal(mayRetryLinkex('post', { error: 'x', status: 503 }), false);
  assert.equal(mayRetryLinkex('post', { error: 'x', status: 429 }), true);
});
