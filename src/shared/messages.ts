import type { AccountRecords, AccountsSnapshot, AccountWarning } from './accounts';
import { describeError } from './error-text';
import type { Settings } from './settings';
import type { WalkedFile } from './walk';

/** 画面（専用ページ・ポップアップ・共有ページのパネル）から Service Worker へ送るメッセージ */
export type Request =
  | { type: 'linkex.call'; method: 'get' | 'post'; path: string; params?: unknown; data?: unknown }
  | { type: 'linkex.openTab' }
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
      files: WalkedFile[];
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
  /** 共有に「先に落とす」を付ける（on: false で外す） */
  | { type: 'queue.prioritize'; token: string; on: boolean }
  | { type: 'queue.clearFinished' }
  | { type: 'settings.get' }
  /** Linkex Web版に覚えさせてあるアカウントの一覧と、拡張機能の記録 */
  | { type: 'accounts.list' }
  /** アカウントを切り替えに使うか */
  | { type: 'accounts.setEnabled'; uid: string; on: boolean }
  /** 一覧から消えたアカウントの記録を消す（知らせを出さなくする） */
  | { type: 'accounts.forget'; uid: string }
  | { type: 'settings.set'; patch: Partial<Settings> };

/**
 * メッセージごとの応答の中身。Service Worker（background/index.ts の handle）はこれに合わせて返し、
 * 画面は send の戻り値としてこの型で受け取る（呼ぶ側で書き写さない）
 */
export interface ResponseMap {
  /** Linkex の応答そのまま（形は呼ぶ側の linkexApi が決める） */
  'linkex.call': unknown;
  /** Linkex の固定タブのID */
  'linkex.openTab': number;
  'jd.info': JdInfo;
  /** JD2 の一覧でのリンクのID */
  'jd.add': string;
  'jd.active': JdLive;
  'cdn.probe': { status: number; contentRange: string | null };
  'queue.add': EnqueueResult;
  'share.walk': { shareName: string; files: WalkedFile[] };
  'queue.addFiles': AddFilesResult;
  'dashboard.open': true;
  'events.clear': void;
  'hashes.clear': void;
  'queue.start': void;
  'queue.pause': void;
  'queue.retry': void;
  /** 外した件数 */
  'queue.remove': number;
  'queue.removeMany': number;
  /** 再試行に戻した件数 */
  'queue.retryFailed': number;
  /** 書き換えた件数 */
  'queue.prioritize': number;
  'queue.clearFinished': void;
  'settings.get': Settings;
  'settings.set': Settings;
  'accounts.list': AccountsView;
  'accounts.setEnabled': void;
  'accounts.forget': void;
}

/** accounts.list の応答 */
export interface AccountsView {
  /** 読めなければ null */
  snapshot: AccountsSnapshot | null;
  records: AccountRecords;
  disabled: string[];
  switchAccounts: boolean;
  warnings: AccountWarning[];
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; detail?: unknown };

/** 画面に返すエラーは、内部の印のままにせず、原因と対処がわかる文にする */
export async function send<R extends Request>(request: R): Promise<Response<ResponseMap[R['type']]>> {
  type T = ResponseMap[R['type']];
  try {
    const res = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
    if (!res) return { ok: false, error: describeError('no_response') };
    return res.ok ? res : { ...res, error: describeError(res.error) };
  } catch (e) {
    return { ok: false, error: describeError(String((e as Error)?.message ?? e)) };
  }
}

/** queue.addFiles の応答 */
export interface AddFilesResult {
  added: number;
  /** 追加したファイルの合計バイト数（サイズ不明は0として数える） */
  addedBytes: number;
  alreadyQueued: number;
}

/** queue.add（共有URLを読んでキューに追加）の応答 */
export interface EnqueueResult extends AddFilesResult {
  /** 共有URLとして読めなかった行 */
  invalid: string[];
  /** 開けなかった共有（error は原因と対処がわかる文） */
  failed: { token: string; error: string }[];
  elapsedMs: number;
}

/** 接続テストで見せる、JD2の同時ダウンロードの設定（読めなかった項目は null） */
export interface JdInfo {
  version: number;
  maxDownloads: number | null;
  perHostEnabled: boolean | null;
  perHost: number | null;
  chunks: number | null;
  /** 「完了したダウンロードを削除」（CleanupAfterDownloadAction。NEVER・CLEANUP_IMMEDIATELY など） */
  cleanup: string | null;
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
