import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountTraffic, applyRefreshedTokens, refreshAccount } from '../src/content/account-ops.ts';

const KEY = 'linkex_user_cache_v1';
const now = 1_800_000_000_000;

function fakeStorage(value: unknown): Map<string, string> {
  const store = new Map<string, string>([[KEY, JSON.stringify(value)]]);
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  return store;
}

function cache() {
  return {
    currentUid: '2',
    users: {
      '1': {
        profile: { nickname: 'ほよまる' },
        credentials: { token: 'OLD-A', refreshToken: 'OLD-R', refreshTokenUpdatedAt: 5 },
        sessionStatus: 'logged_out',
        _meta: { addedAt: 1, updatedAt: 2, version: 1 },
      },
      '2': { credentials: { token: 'CUR-A', refreshToken: 'CUR-R', refreshTokenUpdatedAt: 7 }, sessionStatus: 'online' },
    },
  };
}

/** 呼ばれた内容を覚え、決めた返事を返す偽の通信部品 */
function fakeClient(reply: { post?: unknown; get?: unknown; fail?: { status: number } }) {
  const calls: { method: string; path: string; body: unknown; config: any }[] = [];
  const answer = (method: string) => async (path: string, body: unknown, config: any) => {
    calls.push({ method, path, body, config });
    if (reply.fail) throw Object.assign(new Error('Request failed'), { response: { status: reply.fail.status } });
    return method === 'post' ? reply.post : reply.get;
  };
  return { calls, client: { get: answer('get'), post: answer('post') } };
}

test('applyRefreshedTokens: Web版と同じく、refreshToken が変わったら時刻を進める', () => {
  const root = cache();
  const next = applyRefreshedTokens(root, '1', 'NEW-A', 'NEW-R', now);
  assert.deepEqual(next.users['1'].credentials, { token: 'NEW-A', refreshToken: 'NEW-R', refreshTokenUpdatedAt: now });
  // ほかの値・ほかのアカウント・今のアカウントはそのまま
  assert.equal(next.currentUid, '2');
  assert.deepEqual(next.users['1']._meta, root.users['1']._meta);
  assert.deepEqual(next.users['2'], root.users['2']);
});

test('applyRefreshedTokens: refreshToken が同じ・無いなら時刻は進めない', () => {
  assert.equal(applyRefreshedTokens(cache(), '1', 'NEW-A', 'OLD-R', now).users['1'].credentials.refreshTokenUpdatedAt, 5);
  const kept = applyRefreshedTokens(cache(), '1', 'NEW-A', undefined, now).users['1'].credentials;
  assert.deepEqual(kept, { token: 'NEW-A', refreshToken: 'OLD-R', refreshTokenUpdatedAt: 5 });
});

test('refreshAccount: 更新して書き戻し、トークンは返さない', async () => {
  const store = fakeStorage(cache());
  const { calls, client } = fakeClient({ post: { code: 0, data: { accessToken: 'NEW-A', refreshToken: 'NEW-R' } } });
  const res = await refreshAccount('1', now, client);
  assert.deepEqual(res, { ok: true, stampAt: now });
  assert.equal(JSON.stringify(res).includes('NEW'), false);
  assert.equal(calls[0].path, '/api/auth/v1/token/refresh');
  assert.deepEqual(calls[0].body, { refreshToken: 'OLD-R' });
  assert.equal(calls[0].config.skipAuth, true);
  const saved = JSON.parse(store.get(KEY)!);
  assert.deepEqual(saved.users['1'].credentials, { token: 'NEW-A', refreshToken: 'NEW-R', refreshTokenUpdatedAt: now });
});

test('refreshAccount: 今使っているアカウントは触らない', async () => {
  const store = fakeStorage(cache());
  const before = store.get(KEY);
  const { calls, client } = fakeClient({});
  assert.deepEqual(await refreshAccount('2', now, client), { ok: false, error: 'current' });
  assert.equal(calls.length, 0);
  assert.equal(store.get(KEY), before);
});

test('refreshAccount: 断られたら書き換えない', async () => {
  const store = fakeStorage(cache());
  const before = store.get(KEY);
  const { client } = fakeClient({ fail: { status: 401 } });
  assert.deepEqual(await refreshAccount('1', now, client), { ok: false, error: 'refresh_failed', status: 401 });
  assert.equal(store.get(KEY), before);
  const env = fakeClient({ post: { code: 40100, message: 'expired' } });
  assert.deepEqual(await refreshAccount('1', now, env.client), { ok: false, error: 'refresh_failed', status: null });
});

test('refreshAccount: 無いアカウント・ログイン情報の無いアカウント', async () => {
  const c = cache();
  delete (c.users['1'] as any).credentials;
  fakeStorage(c);
  const { client } = fakeClient({});
  assert.deepEqual(await refreshAccount('9', now, client), { ok: false, error: 'not_found' });
  assert.deepEqual(await refreshAccount('1', now, client), { ok: false, error: 'no_secret' });
});

test('accountTraffic: そのアカウントの token を付けて、切り替えずに転送量を聞く', async () => {
  fakeStorage(cache());
  const { calls, client } = fakeClient({ get: { code: 0, data: { usedTraffic: 30, totalTraffic: 100, resetTime: 1 } } });
  const res = await accountTraffic('1', client);
  assert.deepEqual(res, { ok: true, used: 30, total: 100 });
  assert.equal(calls[0].path, '/api/drive/v1/traffic');
  assert.equal(calls[0].config.skipAuth, true);
  assert.equal(calls[0].config.headers.Authorization, 'Bearer OLD-A');
});

test('accountTraffic: 断られたら status を返す', async () => {
  fakeStorage(cache());
  const { client } = fakeClient({ fail: { status: 401 } });
  assert.deepEqual(await accountTraffic('1', client), { ok: false, error: 'request_failed', status: 401 });
  assert.deepEqual(await accountTraffic('9', client), { ok: false, error: 'not_found' });
});
