/**
 * キューの1件の状態。取り方によって通る段階が違う。
 * - 保存せずに取る（設定「保存せずにダウンロード」、初期値）: pending/retry → downloading → done
 * - 保存してから取る（設定がオフ、または直接は取れなかった件）:
 *   pending/retry → copying（保存中） → copied（コピーあり） → deleting（JD2に渡し済み・コピーを削除中） → downloading → done
 *   deleting は、失敗したコピーや重複で省く件のコピーを消すときにも通る（このときは JD2 に渡していない）。
 * 同じ中身をダウンロード済みなら skipped。
 * 途中で失敗したら retry（次に割り当てられたとき、その時点の設定に従って取り直す）、何度も失敗したら error。
 */
export type ItemState =
  | 'pending'
  | 'copying'
  | 'copied'
  | 'deleting'
  | 'downloading'
  | 'done'
  | 'skipped'
  | 'retry'
  | 'error';

export const STATE_LABELS: Record<ItemState, string> = {
  pending: '待機中',
  copying: '保存中',
  copied: 'URL発行中',
  deleting: '削除中',
  downloading: 'ダウンロード中',
  done: '完了',
  skipped: '重複のため省略',
  retry: '再試行待ち',
  error: 'エラー',
};

export interface QueueItem {
  id: string;
  shareToken: string;
  shareName: string;
  /** 共有側のファイルID */
  sourceFileId: string;
  name: string;
  size: number | null;
  /** 基準フォルダからの相対フォルダ（共有名\共有内のフォルダ） */
  relDir: string;
  /** PCに保存するファイル名（名前がぶつかったら番号付き） */
  outName: string;
  hash: string | null;
  /** 重複していても落とし直す */
  force?: boolean;
  state: ItemState;
  attempts: number;
  /** 保存前にあった自分のファイルのID。自分が作ったコピーだけを消すために使う */
  beforeIds?: string[];
  copyStartedAt?: number;
  /** Linkex側の保存が終わった時刻（ここから一定時間コピーが見つからなければ保存し直す） */
  copiedAt?: number;
  /** 自分のストレージに作られたコピーのID */
  destFileId?: string;
  /** JD2のダウンロード一覧でのリンクのID */
  jdId?: string;
  /**
   * 受け取るべき大きさ。CDN が実際に配っている大きさ（ダウンロードURLの最後の段）で、
   * 取れなければ Linkex の file/get の size。JD2 が途中で切れた分を完了にしていないか確かめる
   */
  fileSize?: number;
  /** JD2 に渡した後のコピー削除に失敗した回数（ダウンロードの再試行回数 attempts とは別に数える） */
  deleteAttempts?: number;
  /** 保存してから取る件で、コピーを作った後に重複と分かった（コピーを消したら skipped にする） */
  duplicate?: boolean;
  totalLength?: number;
  completedLength?: number;
  note?: string;
  error?: string;
  addedAt: number;
  updatedAt: number;
}

/**
 * 処理全体の今の段階。画面の札の色と文言はこれで決める（message は表示するだけで、判定には使わない）。
 * - running / waiting: 動いている（waiting は空きや転送量などを待っているだけ）
 * - paused: 利用者が止めた / finished: 全部終わった
 * - stopped: JD2 につながらない・ログイン切れなどで、全体を止めた（message に理由と対処）
 * - crashed: 指示役が思わぬエラーで止まった（1分ごとの見回りで動かし直す）
 */
export type EngineStatus = 'running' | 'waiting' | 'paused' | 'finished' | 'stopped' | 'crashed';

export interface EngineState {
  paused: boolean;
  /** 画面に出す今の状況 */
  message: string;
  /** 古い版で保存した状態には無い */
  status?: EngineStatus;
  updatedAt: number;
}

export interface EventEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const EVENTS_KEY = 'events';
export const MAX_EVENTS = 300;

export const QUEUE_KEY = 'queue';
export const ENGINE_KEY = 'engine';
export const HASHES_KEY = 'downloadedHashes';

export const ACTIVE_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
export const FINISHED_STATES: ItemState[] = ['done', 'skipped'];

/** 画面で使う大まかな区分 */
export type QueueGroup = 'active' | 'waiting' | 'done' | 'skipped' | 'error';

export const GROUP_OF: Record<ItemState, QueueGroup> = {
  pending: 'waiting',
  retry: 'waiting',
  copying: 'active',
  copied: 'active',
  deleting: 'active',
  downloading: 'active',
  done: 'done',
  skipped: 'skipped',
  error: 'error',
};

export const GROUP_LABELS: Record<QueueGroup, string> = {
  active: '処理中',
  waiting: '待ち',
  done: '完了',
  skipped: '省略',
  error: '失敗',
};

export interface QueueSummary {
  total: number;
  counts: Record<QueueGroup, number>;
  /** 省略を除いた全体のバイト数 */
  bytesTotal: number;
  /** 落とし終わった分（ダウンロード中の途中まで含む） */
  bytesDone: number;
  /** これから落とす分（処理中・待ちの残り。失敗は含まない） */
  bytesRemaining: number;
}

/** キューを数え上げる。live にはJD2から取った今の進み具合（jdId → 取得済みバイト）を渡せる */
export function summarizeQueue(items: QueueItem[], live?: Map<string, number>): QueueSummary {
  const counts: Record<QueueGroup, number> = { active: 0, waiting: 0, done: 0, skipped: 0, error: 0 };
  let bytesTotal = 0;
  let bytesDone = 0;
  let bytesRemaining = 0;
  for (const item of items) {
    const group = GROUP_OF[item.state];
    counts[group]++;
    if (group === 'skipped') continue;
    const size = item.size ?? item.totalLength ?? 0;
    bytesTotal += size;
    let done = 0;
    if (item.state === 'done') done = size;
    else if (item.state === 'downloading') {
      done = (item.jdId ? live?.get(item.jdId) : undefined) ?? item.completedLength ?? 0;
    }
    bytesDone += done;
    if (group === 'active' || group === 'waiting') bytesRemaining += Math.max(0, size - done);
  }
  return { total: items.length, counts, bytesTotal, bytesDone, bytesRemaining };
}
