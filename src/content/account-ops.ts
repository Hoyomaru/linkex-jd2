/**
 * 裏の埋め込みページ（drive-frame.ts）の中で、今使っていないアカウントを扱う。
 * - ログイン情報をその場で更新する（Web版がトークンを更新するときと同じ通信と書き戻し方）
 * - 切り替えずに転送量を聞く（そのアカウントの token を付けて呼ぶ）
 * トークンはページの中で使って書き戻すだけで、外（Service Worker）には返さない。
 * 埋め込みでしか使わない（固定タブには送らない）ので、ほかの関数を使ってよい。
 */

const KEY = 'linkex_user_cache_v1';

/** ページの通信部品（get / post）。テストでは偽物を渡す */
export interface DriveClient {
  get(path: string, params: unknown, config: Record<string, unknown>): Promise<any>;
  post(path: string, data: unknown, config: Record<string, unknown>): Promise<any>;
}

function readRoot(): any {
  try {
    const root = JSON.parse(localStorage.getItem(KEY) ?? '');
    return root && typeof root === 'object' ? root : null;
  } catch {
    return null;
  }
}

/** 応答の形（{ code, data }）から中身を取り出す。code が 0 でなければ null */
function unwrap(res: any): any {
  if (res && typeof res === 'object' && 'code' in res) return res.code === 0 ? res.data : null;
  return res;
}

const statusOf = (e: any): number | null => Number(e?.response?.status ?? e?.status) || null;

/**
 * 更新したトークンを書き戻した後の一覧（Web版の setTokensForApp・nextRefreshTokenUpdatedAt と同じ決まり）。
 * refreshToken が変わった（または時刻が無い）ときだけ refreshTokenUpdatedAt を今にする
 */
export function applyRefreshedTokens(root: any, uid: string, access: string, refresh: string | undefined, now: number): any {
  const user = root.users[uid];
  const prev = user.credentials ?? {};
  const nextRefresh = refresh ?? prev.refreshToken;
  const changed = !!nextRefresh && (nextRefresh !== prev.refreshToken || typeof prev.refreshTokenUpdatedAt !== 'number');
  return {
    ...root,
    users: {
      ...root.users,
      [uid]: {
        ...user,
        credentials: {
          ...prev,
          token: access,
          refreshToken: nextRefresh,
          refreshTokenUpdatedAt: changed ? now : prev.refreshTokenUpdatedAt,
        },
      },
    },
  };
}

export type RefreshResult =
  | { ok: true; stampAt: number }
  | { ok: false; error: 'current' | 'not_found' | 'no_secret' | 'unreadable' }
  | { ok: false; error: 'refresh_failed'; status: number | null };

/** 今使っていないアカウントのログイン情報を更新して書き戻す。今使っているアカウントは Web版に任せて触らない */
export async function refreshAccount(uid: string, now: number, client: DriveClient): Promise<RefreshResult> {
  const root = readRoot();
  if (!root?.users || typeof root.users !== 'object') return { ok: false, error: 'unreadable' };
  if (root.currentUid === uid) return { ok: false, error: 'current' };
  const user = root.users[uid];
  if (!user || typeof user !== 'object') return { ok: false, error: 'not_found' };
  const refreshToken = user.credentials?.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken) return { ok: false, error: 'no_secret' };

  let data: any;
  try {
    data = unwrap(await client.post('/api/auth/v1/token/refresh', { refreshToken }, { skipAuth: true, skipGlobalMessage: true }));
  } catch (e) {
    return { ok: false, error: 'refresh_failed', status: statusOf(e) };
  }
  if (typeof data?.accessToken !== 'string' || !data.accessToken) return { ok: false, error: 'refresh_failed', status: null };

  // 通信のあいだに Web版が一覧を書き換えていることがあるので、読み直してから書く
  const latest = readRoot();
  if (!latest?.users?.[uid]) return { ok: false, error: 'not_found' };
  const next = applyRefreshedTokens(latest, uid, data.accessToken, typeof data.refreshToken === 'string' ? data.refreshToken : undefined, now);
  localStorage.setItem(KEY, JSON.stringify(next));
  return { ok: true, stampAt: next.users[uid].credentials.refreshTokenUpdatedAt };
}

export type TrafficResult =
  | { ok: true; used: number; total: number }
  | { ok: false; error: 'not_found' | 'no_secret' | 'unreadable' }
  | { ok: false; error: 'request_failed'; status: number | null };

/** そのアカウントの token を付けて、切り替えずに転送量を聞く */
export async function accountTraffic(uid: string, client: DriveClient): Promise<TrafficResult> {
  const root = readRoot();
  if (!root?.users || typeof root.users !== 'object') return { ok: false, error: 'unreadable' };
  const user = root.users[uid];
  if (!user || typeof user !== 'object') return { ok: false, error: 'not_found' };
  const token = user.credentials?.token;
  if (typeof token !== 'string' || !token) return { ok: false, error: 'no_secret' };
  try {
    const data = unwrap(
      await client.get(
        '/api/drive/v1/traffic',
        {},
        // 自動で付く今のアカウントのログイン情報を外し、このアカウントの token を付ける
        { skipAuth: true, skipGlobalMessage: true, headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    if (!data) return { ok: false, error: 'request_failed', status: null };
    return { ok: true, used: Number(data.usedTraffic) || 0, total: Number(data.totalTraffic) || 0 };
  } catch (e) {
    return { ok: false, error: 'request_failed', status: statusOf(e) };
  }
}

/** ページの通信部品を探す（linkexBridgeCall が見つけて覚えたものがあれば、それを使う） */
export async function findDriveClient(): Promise<DriveClient | null> {
  const w = window as unknown as { __linkexJd2Client?: DriveClient };
  if (w.__linkexJd2Client) return w.__linkexJd2Client;
  const pattern = /\/drive\/assets\/js\/index-[^/]+\.js(\?.*)?$/;
  const src =
    Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
      .map((s) => s.src)
      .find((s) => pattern.test(s)) ??
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => pattern.test(n));
  if (!src) return null;
  const mod: Record<string, unknown> = await import(/* @vite-ignore */ src);
  const client = Object.values(mod).find(
    (v: any) => v && typeof v === 'object' && typeof v.get === 'function' && typeof v.post === 'function' && v.instance,
  ) as DriveClient | undefined;
  if (client) w.__linkexJd2Client = client;
  return client ?? null;
}
