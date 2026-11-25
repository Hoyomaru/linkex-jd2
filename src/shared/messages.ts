import { describeError } from './error-text';
import type { Settings } from './settings';

/** 画面（専用ページ・ポップアップ）から Service Worker へ送るメッセージ */
export type Request =
  | { type: 'linkex.call'; method: 'get' | 'post'; path: string; params?: unknown; data?: unknown }
  | { type: 'linkex.openTab' }
  | { type: 'jd.version' }
  | { type: 'jd.info' }
  | { type: 'jd.add'; url: string; dir?: string; out?: string }
  | { type: 'jd.active' }
  | { type: 'cdn.probe'; url: string }
  | { type: 'queue.add'; text: string }
  | { type: 'share.walk'; token: string }
  | {
      type: 'queue.addFiles';
      token: string;
      shareName: string;
      files: { id: string; name: string; size: number | null; hash: string | null; folders: string[] }[];
      /** 共有全体が1つのフォルダの下にあるなら true（共有名の段を飛ばして保存する） */
      collapseRoot?: boolean;
    }
  | { type: 'dashboard.open'; tab?: string }
  | { type: 'events.clear' }
  | { type: 'hashes.clear' }
  | { type: 'queue.start' }
  | { type: 'queue.pause' }
  | { type: 'queue.retry'; id: string }
  | { type: 'queue.remove'; id: string }
  | { type: 'queue.removeMany'; ids: string[] }
  | { type: 'queue.retryFailed'; token?: string }
  | { type: 'queue.clearFinished' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; patch: Partial<Settings> };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; detail?: unknown };

/** 画面に返すエラーは、内部の印のままにせず、原因と対処がわかる文にする */
export async function send<T = unknown>(request: Request): Promise<Response<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
    if (!res) return { ok: false, error: describeError('no_response') };
    return res.ok ? res : { ...res, error: describeError(res.error) };
  } catch (e) {
    return { ok: false, error: describeError(String((e as Error)?.message ?? e)) };
  }
}

/** Linkex APIの共通応答。code 0 が成功 */
export interface LinkexEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** jd.active の応答。画面で速度と進み具合を出すのに使う */
export interface JdLive {
  /** JD2全体のダウンロード速度（バイト/秒） */
  downloadSpeed: number;
  /** ダウンロード一覧のうち、この拡張機能が渡して終わっていないリンク */
  active: { jdId: string; totalLength: number; completedLength: number; downloadSpeed: number }[];
}
