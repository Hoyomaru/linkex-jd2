/** JD2のダウンロード一覧のリンクを、拡張機能から見た状態にまとめる */
export type JdLinkState = 'missing' | 'done' | 'truncated' | 'failed' | 'active';

export interface JdLinkLike {
  bytesLoaded?: number;
  bytesTotal?: number;
  finished?: boolean;
  enabled?: boolean;
  skipped?: boolean;
  statusIconKey?: string;
}

/**
 * - missing: 一覧にない（JD2で消された・完了後に自動で片付けられた）
 * - done: 完了
 * - truncated: JD2は完了にしたが、受け取った量が本来のサイズに足りない
 *   （途中で接続を切られ、続きも取れなかったとき、JD2は受け取れた分で完了にしてしまう）
 * - failed: JD2があきらめた（エラーで止まった・無効にされた・スキップされた）
 * - active: 待ち・ダウンロード中・JD2が自分で再試行するまでの待ち時間
 *
 * expectedSize: Linkexが返したファイルのサイズ（分からなければ null）
 */
export function jdLinkState(link: JdLinkLike | undefined, expectedSize: number | null): JdLinkState {
  if (!link) return 'missing';
  if (link.finished) {
    if (link.statusIconKey && link.statusIconKey !== 'true') return 'failed';
    // JD2は取得済みを全体より1バイト多く数えることがあるので、大きいほうで比べる
    const got = Math.max(link.bytesLoaded ?? 0, link.bytesTotal ?? 0);
    return expectedSize !== null && expectedSize > 0 && got < expectedSize ? 'truncated' : 'done';
  }
  if (link.enabled === false || link.skipped) return 'failed';
  if (link.statusIconKey === 'false') return 'failed';
  return 'active';
}
