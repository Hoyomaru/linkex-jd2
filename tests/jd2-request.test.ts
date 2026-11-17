import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jd2ConnectionError, requestJd } from '../src/shared/jd2-request.ts';

// JD2 の Deprecated Api は、負荷に関係なく接続の2〜3割をいきなり切る（Connection was reset）。
// ときどき応答の途中で止まることもある。どちらも少し待って呼び直せば通る

const reset = () => Promise.reject(new TypeError('Failed to fetch'));
const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const noWait = async () => {};

function sequence(...steps: (() => Promise<Response>)[]) {
  let n = 0;
  const fetchFn = () => steps[Math.min(n++, steps.length - 1)]();
  return { fetchFn, calls: () => n };
}

test('3回続けて切られても、その後つながれば結果を返す', async () => {
  const s = sequence(reset, reset, reset, () => ok({ data: 42 }));
  const r = await requestJd('http://x', { fetchFn: s.fetchFn, sleep: noWait });
  assert.deepEqual(r.json, { data: 42 });
  assert.equal(s.calls(), 4);
});

test('本文を読む途中で止まったら、呼び直す', async () => {
  const stalled = () =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new DOMException('timeout', 'TimeoutError')) } as unknown as Response);
  const s = sequence(stalled, () => ok({ data: 'v' }));
  const r = await requestJd('http://x', { fetchFn: s.fetchFn, sleep: noWait });
  assert.deepEqual(r.json, { data: 'v' });
});

test('ずっとつながらなければ Jd2ConnectionError', async () => {
  const s = sequence(reset);
  await assert.rejects(requestJd('http://x', { fetchFn: s.fetchFn, sleep: noWait }), Jd2ConnectionError);
  assert.equal(s.calls(), 8);
});

test('JD2 が返したエラー（JSON でない応答も）は呼び直さずそのまま返す', async () => {
  const s = sequence(() => Promise.resolve(new Response('nope', { status: 403 })));
  const r = await requestJd('http://x', { fetchFn: s.fetchFn, sleep: noWait });
  assert.equal(r.status, 403);
  assert.equal(r.json, null);
  assert.equal(s.calls(), 1);
});
