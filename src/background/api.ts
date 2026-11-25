import { judgeLogin } from '../shared/auth';
import { describeError } from '../shared/error-text';
import { bindLinkexApi } from '../shared/linkex-endpoints';
import { isTransientLinkexFailure, mayRetryLinkex } from '../shared/linkex-transient';
import { callLinkex, LinkexLoginError } from './linkex-tab';

/** 容量不足のエラーコード（Web版のコードより） */
export const DISK_SPACE_FULL = 413300;

export class LinkexError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly detail: unknown = null) {
    super(message);
  }
}

/**
 * Linkex が一時的に応えない（通信が切れた・速度制限・サーバーの不調）。
 * 件ごとの失敗には数えず、しばらく待ってから続ける
 */
export class LinkexTransientError extends Error {}

/** 最後に Linkex から応答を受け取れた時刻（つながらない時間を数えるため） */
let okAt = Date.now();
export const linkexOkAt = () => okAt;

/** 一時的な失敗のとき、呼び直すまでの待ち時間（ミリ秒） */
const RETRY_DELAYS_MS = [1_000, 3_000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(method: 'get' | 'post', path: string, payload?: unknown): Promise<T> {
  const req = { method, path, ...(method === 'get' ? { params: payload } : { data: payload }) };
  let res = await callLinkex(req);
  for (const delay of RETRY_DELAYS_MS) {
    if (res.ok || !mayRetryLinkex(method, res)) break;
    await sleep(delay);
    res = await callLinkex(req);
  }
  // 中身付きのエラーでも、Linkex から応答は来ている
  if (res.ok || !isTransientLinkexFailure(res)) okAt = Date.now();
  if (!res.ok) {
    // 401、またはログイン情報が消えている状態での失敗は、ログイン切れとして全体を止める
    // （ログイン情報が読めない形のときは決めつけず、件ごとの失敗として扱う）
    if (res.status === 401 || judgeLogin(res.authEntries ?? []) === false) {
      throw new LinkexLoginError(`${path}: ${res.error}`);
    }
    if (isTransientLinkexFailure(res)) {
      throw new LinkexTransientError(`Linkexが一時的に応答しません: ${path}: ${res.error}${res.status ? `（HTTP ${res.status}）` : ''}`);
    }
    const detail = res.detail as any;
    const code = Number(detail?.code ?? NaN);
    throw new LinkexError(`${path}: ${describeError(res.error)}`, Number.isFinite(code) ? code : null, detail);
  }
  const env = res.data as { code?: number; message?: string; data?: T } | null;
  if (env && typeof env === 'object' && 'code' in env && env.code !== 0) {
    throw new LinkexError(`${path}: ${env.message} (code ${env.code})`, env.code ?? null, env);
  }
  return (env?.data ?? (env as unknown)) as T;
}

/** Linkex API（呼び先の一覧は shared/linkex-endpoints.ts。裏の埋め込みページ（使えなければ固定タブ）の中で呼び、一時的な失敗は呼び直す） */
export const api = bindLinkexApi(call);

/** ページ送りしながら一覧を全部取る */
export async function collectPages(fetchPage: (page: number) => Promise<any>, maxPages = 200): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage(page);
    const list = Array.isArray(data?.list) ? data.list : [];
    all.push(...list);
    const pg = data?.pagination;
    const hasNext = pg ? Boolean(pg.hasNext ?? (pg.totalPages && page < pg.totalPages)) : list.length >= 100;
    if (!hasNext || list.length === 0) break;
  }
  return all;
}
