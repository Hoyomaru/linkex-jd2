/**
 * Linkex API の呼び先（パスと送る中身）の一覧。Service Worker（background/api.ts）と
 * 画面（shared/linkex-api.ts）はそれぞれの呼び方で同じ一覧を使う（API の形が変わったら、ここだけ直す）。
 */

/** 1回の呼び出し。result は応答の型を運ぶだけで、値は入らない */
export interface Endpoint<T> {
  method: 'get' | 'post';
  path: string;
  payload?: unknown;
  readonly result?: T;
}

export interface Usage {
  totalSpace: number;
  usedSpace: number;
}
export interface Traffic {
  usedTraffic: number;
  totalTraffic: number;
  resetTime: number;
}

const get = <T>(path: string, payload?: unknown): Endpoint<T> => ({ method: 'get', path, payload });
const post = <T>(path: string, payload?: unknown): Endpoint<T> => ({ method: 'post', path, payload });

export const linkexEndpoints = {
  usage: () => get<Usage>('/api/drive/v1/usage'),
  traffic: () => get<Traffic>('/api/drive/v1/traffic'),

  share: (shareToken: string) => get<any>('/api/drive/v1/share/get', { share_token: shareToken }),
  shareContent: (shareToken: string, parentId?: string, page = 1) =>
    get<any>('/api/drive/v1/share/get/content', {
      share_token: shareToken,
      ...(parentId ? { parent_id: parentId } : {}),
      page,
      page_size: 100,
      need_parents: true,
    }),

  /** 共有のファイルを自分のストレージに保存する（非同期タスク） */
  copyFromShare: (shareToken: string, fileId: string) =>
    post<any>('/api/drive/v1/file/copy', {
      share_token: shareToken,
      collection: { select_all: false, file_ids: [fileId] },
      async: true,
    }),
  task: (taskId: string) => get<any>('/api/drive/v1/task/get', { task_id: taskId }),

  /** 自分のファイルの一覧（parentId を省くとルート） */
  myFiles: (parentId?: string, page = 1) =>
    get<any>('/api/drive/v1/file/list', {
      keyword: '',
      page,
      page_size: 100,
      order: 'name',
      desc: false,
      need_parents: true,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  /** 自分のファイルの情報とダウンロードURL */
  fileGet: (fileId: string) => get<any>('/api/drive/v1/file/get', { file_id: fileId }),
  /** 共有のファイルの情報とダウンロードURL（自分のストレージに保存しなくても返る） */
  shareFileGet: (shareToken: string, fileId: string) =>
    get<any>('/api/drive/v1/file/get', { file_id: fileId, share_token: shareToken }),

  // 安全のため、削除系は必ず1件ずつ・select_all:false で送る
  /** ゴミ箱へ移動（容量はまだ空かない） */
  moveToTrash: (fileId: string) =>
    post<any>('/api/drive/v1/file/delete', { collection: { select_all: false, file_ids: [fileId] } }),
  trashList: (page = 1) => get<any>('/api/drive/v1/file/trash/list', { page, page_size: 100 }),
  restore: (fileId: string) => post<any>('/api/drive/v1/file/trash/restore', { file_ids: [fileId] }),
  /** ゴミ箱から完全削除（取り消せない） */
  deleteForever: (fileId: string) => post<any>('/api/drive/v1/file/trash/delete', { file_ids: [fileId] }),
};

type Endpoints = typeof linkexEndpoints;
export type LinkexApi = {
  [K in keyof Endpoints]: (...args: Parameters<Endpoints[K]>) => Promise<NonNullable<ReturnType<Endpoints[K]>['result']>>;
};

/** 呼び先の一覧に、それぞれの呼び方を付けて、api.usage() のように呼べる形にする */
export function bindLinkexApi(call: <T>(method: 'get' | 'post', path: string, payload?: unknown) => Promise<T>): LinkexApi {
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, make] of Object.entries(linkexEndpoints) as [string, (...args: unknown[]) => Endpoint<unknown>][]) {
    api[name] = (...args) => {
      const e = make(...args);
      return call(e.method, e.path, e.payload);
    };
  }
  return api as unknown as LinkexApi;
}
