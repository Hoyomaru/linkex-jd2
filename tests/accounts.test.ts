import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountWarnings,
  isFresh,
  nextResume,
  pickKeepAlive,
  pickNextAccount,
  type AccountRecords,
  type AccountsSnapshot,
  type LinkexAccount,
} from '../src/shared/accounts.ts';

const H = 60 * 60 * 1000;
const D = 24 * H;
const now = 1_800_000_000_000;

function acc(uid: string, patch: Partial<LinkexAccount> = {}): LinkexAccount {
  return {
    uid,
    name: uid,
    email: '',
    status: 'logged_out',
    stampAt: now - D,
    hasSecret: true,
    cachedTraffic: null,
    ...patch,
  };
}
const snap = (currentUid: string | null, ...accounts: LinkexAccount[]): AccountsSnapshot => ({ currentUid, accounts });

test('pickNextAccount: 期限の近い順', () => {
  const s = snap('A', acc('A'), acc('B', { stampAt: now - 10 * D }), acc('C', { stampAt: now - 18 * D }));
  assert.equal(pickNextAccount(s, {}, [], now), 'C');
});

test('pickNextAccount: 自分しかいない', () => {
  assert.equal(pickNextAccount(snap('A', acc('A')), {}, [], now), null);
});

test('pickNextAccount: オフ・期限切れ・ログイン情報なし・尽きて24時間たっていないものは除く', () => {
  const s = snap(
    'A',
    acc('A'),
    acc('OFF'),
    acc('OLD', { stampAt: now - 481 * H }),
    acc('NOSECRET', { hasSecret: false }),
    acc('TIRED'),
  );
  const recs: AccountRecords = { TIRED: { exhaustedAt: now - 23 * H } };
  assert.equal(pickNextAccount(s, recs, ['OFF'], now), null);
  assert.equal(pickNextAccount(s, { TIRED: { exhaustedAt: now - 25 * H } }, ['OFF'], now), 'TIRED');
});

test('pickNextAccount: checkAgainAt 前は除く', () => {
  const s = snap('A', acc('A'), acc('B'));
  assert.equal(pickNextAccount(s, { B: { exhaustedAt: now - 30 * H, checkAgainAt: now + H } }, [], now), null);
  assert.equal(pickNextAccount(s, { B: { exhaustedAt: now - 30 * H, checkAgainAt: now - 1 } }, [], now), 'B');
});

test('isFresh: 期限の1時間前からは使わない', () => {
  assert.equal(isFresh(acc('A', { stampAt: now - (480 * H - 30 * 60 * 1000) }), now), false);
  assert.equal(isFresh(acc('A', { stampAt: now - (480 * H - 2 * H) }), now), true);
});

test('isFresh: stampAt が 0 なら使う', () => {
  assert.equal(isFresh(acc('A', { stampAt: 0 }), now), true);
  assert.equal(isFresh(acc('A', { stampAt: 0, hasSecret: false }), now), false);
});

test('nextResume: いちばん早く戻るもの', () => {
  const s = snap('A', acc('A'), acc('B'));
  const recs: AccountRecords = { A: { exhaustedAt: now - 20 * H }, B: { exhaustedAt: now - 22 * H } };
  assert.deepEqual(nextResume(s, recs, [], now), { uid: 'B', at: now + 2 * H });
});

test('nextResume: 今のアカウントも候補に入る', () => {
  const s = snap('A', acc('A'), acc('B'));
  const recs: AccountRecords = { A: { exhaustedAt: now - 23 * H }, B: { exhaustedAt: now - 20 * H } };
  assert.deepEqual(nextResume(s, recs, [], now), { uid: 'A', at: now + H });
});

test('nextResume: checkAgainAt のほうが遅ければそちら', () => {
  const s = snap('A', acc('A'));
  const recs: AccountRecords = { A: { exhaustedAt: now - 30 * H, checkAgainAt: now + 3 * H } };
  assert.deepEqual(nextResume(s, recs, [], now), { uid: 'A', at: now + 3 * H });
});

test('nextResume: 使えるアカウントが無ければ null', () => {
  const s = snap('A', acc('A', { hasSecret: false }), acc('B'));
  assert.equal(nextResume(s, { B: { exhaustedAt: now - H } }, ['B'], now), null);
});

test('pickKeepAlive: 残り72時間未満で、尽きておらず、今のアカウント以外', () => {
  const near = now - (480 - 50) * H; // 残り50時間
  assert.equal(pickKeepAlive(snap('A', acc('A'), acc('B', { stampAt: near })), {}, [], now), 'B');
  assert.equal(pickKeepAlive(snap('B', acc('A'), acc('B', { stampAt: near })), {}, [], now), null);
  assert.equal(pickKeepAlive(snap('A', acc('A'), acc('B', { stampAt: now - (480 - 73) * H })), {}, [], now), null);
});

test('pickKeepAlive: 同じアカウントは24時間に1回まで', () => {
  const s = snap('A', acc('A'), acc('B', { stampAt: now - (480 - 50) * H }));
  assert.equal(pickKeepAlive(s, { B: { keepAliveAt: now - 23 * H } }, [], now), null);
  assert.equal(pickKeepAlive(s, { B: { keepAliveAt: now - 25 * H } }, [], now), 'B');
});

test('pickKeepAlive: 尽きているもの・オフのものは選ばない', () => {
  const s = snap('A', acc('A'), acc('B', { stampAt: now - (480 - 50) * H }));
  assert.equal(pickKeepAlive(s, { B: { exhaustedAt: now - H } }, [], now), null);
  assert.equal(pickKeepAlive(s, {}, ['B'], now), null);
});

test('accountWarnings: 期限が近い・延命に失敗・一覧から消えた', () => {
  const s = snap('A', acc('A', { name: 'あ' }), acc('B', { name: 'べ', stampAt: now - (480 - 50) * H }));
  const recs: AccountRecords = { A: { keepAliveFailed: true }, GONE: { name: 'ごーん' } };
  const w = accountWarnings(s, recs, now);
  assert.deepEqual(w, [
    { kind: 'keepAliveFailed', uid: 'A', name: 'あ' },
    { kind: 'expiring', uid: 'B', name: 'べ', hoursLeft: 50 },
    { kind: 'gone', uid: 'GONE', name: 'ごーん' },
  ]);
});

test('isFresh: 時刻が読めない（-1）なら使わない', () => {
  assert.equal(isFresh(acc('A', { stampAt: -1 }), now), false);
});
