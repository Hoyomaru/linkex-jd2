import { judgeLogin } from '../shared/auth';
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
    throw new LinkexError(`${path}: ${res.error}`, Number.isFinite(code) ? code : null, detail);
  }
  const env = res.data as { code?: number; message?: string; data?: T } | null;
  if (env && typeof env === 'object' && 'code' in env && env.code !== 0) {
    throw new LinkexError(`${path}: ${env.message} (code ${env.code})`, env.code ?? null, env);
  }
  return (env?.data ?? (env as unknown)) as T;
}

export const api = {
  usage: () => call<{ totalSpace: number; usedSpace: number }>('get', '/api/drive/v1/usage'),
  traffic: () => call<{ usedTraffic: number; totalTraffic: number; resetTime: number }>('get', '/api/drive/v1/traffic'),

  share: (token: string) => call<any>('get', '/api/drive/v1/share/get', { share_token: token }),
  shareContent: (token: string, parentId: string | undefined, page: number) =>
    call<any>('get', '/api/drive/v1/share/get/content', {
      share_token: token,
      ...(parentId ? { parent_id: parentId } : {}),
      page,
      page_size: 100,
      need_parents: true,
    }),

  copyFromShare: (token: string, fileId: string) =>
    call<any>('post', '/api/drive/v1/file/copy', {
      share_token: token,
      collection: { select_all: false, file_ids: [fileId] },
      async: true,
    }),
  task: (taskId: string) => call<any>('get', '/api/drive/v1/task/get', { task_id: taskId }),

  rootFiles: (page: number) =>
    call<any>('get', '/api/drive/v1/file/list', {
      keyword: '',
      page,
      page_size: 100,
      order: 'name',
      desc: false,
      need_parents: true,
    }),
  /** 共有のファイルの情報とダウンロードURL（自分のストレージに保存しなくても返る） */
  shareFileGet: (token: string, fileId: string) =>
    call<any>('get', '/api/drive/v1/file/get', { file_id: fileId, share_token: token }),
  fileGet: (fileId: string) => call<any>('get', '/api/drive/v1/file/get', { file_id: fileId }),

  // 安全のため、削除系は必ず1件ずつ・select_all:false で送る
  moveToTrash: (fileId: string) =>
    call<any>('post', '/api/drive/v1/file/delete', { collection: { select_all: false, file_ids: [fileId] } }),
  trashList: (page: number) => call<any>('get', '/api/drive/v1/file/trash/list', { page, page_size: 100 }),
  deleteForever: (fileId: string) => call<any>('post', '/api/drive/v1/file/trash/delete', { file_ids: [fileId] }),
};

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
