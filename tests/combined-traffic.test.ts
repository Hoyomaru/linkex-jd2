import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinedTraffic, currentAccountName, type LinkexAccount } from '../src/shared/accounts.ts';

const GB = 1024 ** 3;
const H = 60 * 60 * 1000;
const now = 1_800_000_000_000;

function acc(uid: string, patch: Partial<LinkexAccount> = {}): LinkexAccount {
  return { uid, name: uid, email: '', status: 'logged_out', stampAt: now - H, hasSecret: true, cachedTraffic: null, ...patch };
}

test('combinedTraffic: 切り替えに使うアカウントの残りと上限を合計する', () => {
  const view = {
    snapshot: {
      currentUid: 'A',
      accounts: [
        acc('A'),
        acc('B', { cachedTraffic: { used: 9 * GB, total: 10 * GB } }),
        acc('C', { cachedTraffic: { used: 0, total: 10 * GB } }),
        acc('OFF', { cachedTraffic: { used: 0, total: 10 * GB } }),
        acc('OLD', { stampAt: now - 481 * H, cachedTraffic: { used: 0, total: 10 * GB } }),
        acc('UNKNOWN'),
      ],
    },
    // 拡張機能が確かめた値のほうが、Web版が最後に見た値より新しければそちらを使う
    records: { B: { lastTraffic: { used: 4 * GB, total: 10 * GB, at: now } } },
    disabled: ['OFF'],
    switchAccounts: true,
  };
  const t = combinedTraffic(view, { used: 8 * GB, total: 10 * GB }, now);
  // 残り: A 2 + B 6 + C 10 = 18GB、上限: 30GB
  assert.deepEqual(t, { usedTraffic: 12 * GB, totalTraffic: 30 * GB, resetTime: 0, accounts: 3 });
});

test('combinedTraffic: 切り替えがオフ・一覧が読めないなら今のアカウントだけ', () => {
  const view = { snapshot: { currentUid: 'A', accounts: [acc('A'), acc('B', { cachedTraffic: { used: 0, total: 10 * GB } })] }, records: {}, disabled: [], switchAccounts: false };
  assert.deepEqual(combinedTraffic(view, { used: 1, total: 10 }, now), { usedTraffic: 1, totalTraffic: 10, resetTime: 0, accounts: 1 });
  assert.deepEqual(combinedTraffic({ ...view, snapshot: null, switchAccounts: true }, { used: 1, total: 10 }, now), {
    usedTraffic: 1,
    totalTraffic: 10,
    resetTime: 0,
    accounts: 1,
  });
  assert.equal(combinedTraffic({ ...view, snapshot: null }, null, now), null);
});

test('combinedTraffic: 上限なしのアカウントがあれば、上限は分からない扱い', () => {
  const view = { snapshot: { currentUid: 'A', accounts: [acc('A'), acc('B', { cachedTraffic: { used: 0, total: 10 * GB } })] }, records: {}, disabled: [], switchAccounts: true };
  assert.equal(combinedTraffic(view, { used: -1, total: 0 }, now), null);
});


test('currentAccountName: アカウントが2つ以上のときだけ、今のアカウント名を返す', () => {
  assert.equal(currentAccountName({ currentUid: 'A', accounts: [acc('A', { name: 'あ' }), acc('B')] }), 'あ');
  assert.equal(currentAccountName({ currentUid: 'A', accounts: [acc('A', { name: 'あ' })] }), null);
  assert.equal(currentAccountName({ currentUid: 'Z', accounts: [acc('A'), acc('B')] }), null);
  assert.equal(currentAccountName(null), null);
});
