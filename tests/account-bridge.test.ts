import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkexReadAccounts, linkexSwitchAccount } from '../src/background/linkex-bridge.ts';

const KEY = 'linkex_user_cache_v1';
const H = 60 * 60 * 1000;
const now = 1_800_000_000_000;

/** localStorage と BroadcastChannel を偽物に差し替える。送られた知らせを返す */
function fakePage(value: string | null): { posted: unknown[]; store: Map<string, string> } {
  const store = new Map<string, string>();
  if (value !== null) store.set(KEY, value);
  const posted: unknown[] = [];
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  (globalThis as any).BroadcastChannel = class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    postMessage(m: unknown) {
      posted.push({ channel: this.name, message: m });
    }
    close() {}
  };
  return { posted, store };
}

function cache(patch: Record<string, unknown> = {}) {
  return {
    currentUid: '2',
    users: {
      '1': {
        profile: { nickname: 'ほよまる', email: 'a@example.com', uid: '1' },
        credentials: { token: 'SECRET-TOKEN-1', refreshToken: 'SECRET-REFRESH-1', refreshTokenUpdatedAt: now - 10 * H },
        sessionStatus: 'logged_out',
        'system.storageSpace': { usedTraffic: 109250308821, totalTraffic: 10737418240, trafficResetTime: 1 },
        _meta: { addedAt: 1, updatedAt: now - 5 * H, version: 1 },
        onlineUnzipTasks: [],
      },
      '2': {
        profile: { nickname: '', email: 'b@example.com', uid: '2' },
        credentials: { token: 'SECRET-TOKEN-2', refreshToken: 'SECRET-REFRESH-2', refreshTokenUpdatedAt: now - H },
        sessionStatus: 'online',
        'system.storageSpace': { usedTraffic: '', totalTraffic: 10737418240 },
        _meta: { addedAt: 2, updatedAt: now - H, version: 1 },
      },
    },
    ...patch,
  };
}

test('parse: 2つのアカウント', () => {
  fakePage(JSON.stringify(cache()));
  const s = linkexReadAccounts();
  assert.deepEqual(s, {
    currentUid: '2',
    accounts: [
      {
        uid: '1',
        name: 'ほよまる',
        email: 'a@example.com',
        status: 'logged_out',
        stampAt: now - 10 * H,
        hasSecret: true,
        cachedTraffic: { used: 109250308821, total: 10737418240 },
      },
      {
        uid: '2',
        name: 'b@example.com',
        email: 'b@example.com',
        status: 'online',
        stampAt: now - H,
        hasSecret: true,
        cachedTraffic: { used: 0, total: 10737418240 },
      },
    ],
  });
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
});

test('parse: 形の崩れた値', () => {
  fakePage(JSON.stringify({ currentUid: 5 }));
  assert.deepEqual(linkexReadAccounts(), { currentUid: null, accounts: [] });

  fakePage(JSON.stringify({ currentUid: '1', users: { '1': { profile: 'x', _meta: { updatedAt: 'x' } } } }));
  assert.deepEqual(linkexReadAccounts(), {
    currentUid: '1',
    accounts: [{ uid: '1', name: '1', email: '', status: null, stampAt: 0, hasSecret: false, cachedTraffic: null }],
  });

  fakePage('{not json');
  assert.equal(linkexReadAccounts(), null);
  fakePage(null);
  assert.equal(linkexReadAccounts(), null);
});

test('switch: Web版と同じ書き換え', () => {
  const before = cache();
  const page = fakePage(JSON.stringify(before));
  assert.deepEqual(linkexSwitchAccount('1', now), { ok: true, fromUid: '2' });
  const after = JSON.parse(page.store.get(KEY)!);
  assert.equal(after.currentUid, '1');
  assert.equal(after.users['1'].sessionStatus, 'online');
  assert.equal(after.users['2'].sessionStatus, 'logged_out');
  assert.deepEqual(after.users['1']._meta, { addedAt: 1, updatedAt: now, version: 1 });
  // ほかの値はそのまま
  assert.deepEqual(after.users['1'].credentials, before.users['1'].credentials);
  assert.deepEqual(after.users['1'].onlineUnzipTasks, []);
  assert.deepEqual(after.users['2'].credentials, before.users['2'].credentials);
  assert.deepEqual(after.users['2']._meta, before.users['2']._meta);
  assert.deepEqual(page.posted, [
    { channel: 'linkex-auth', message: { type: 'ACCOUNT_SWITCHED', fromUid: '2', toUid: '1', at: now, reason: 'manual-switch' } },
  ]);
});

test('switch: 期限切れは断る', () => {
  const c = cache();
  (c.users['1'].credentials as any).refreshTokenUpdatedAt = now - 481 * H;
  const raw = JSON.stringify(c);
  const page = fakePage(raw);
  assert.deepEqual(linkexSwitchAccount('1', now), { ok: false, error: 'expired' });
  assert.equal(page.store.get(KEY), raw);
  assert.deepEqual(page.posted, []);
});

test('switch: 無い uid・ログイン情報なし', () => {
  const c = cache();
  delete (c.users['1'] as any).credentials;
  const page = fakePage(JSON.stringify(c));
  assert.deepEqual(linkexSwitchAccount('9', now), { ok: false, error: 'not_found' });
  assert.deepEqual(linkexSwitchAccount('1', now), { ok: false, error: 'no_secret' });
  assert.deepEqual(page.posted, []);
  fakePage('{bad');
  assert.deepEqual(linkexSwitchAccount('1', now), { ok: false, error: 'unreadable' });
});
