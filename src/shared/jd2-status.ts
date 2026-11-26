/** JD2のダウンロード一覧のリンクを、拡張機能から見た状態にまとめる */
export type JdLinkState = 'missing' | 'done' | 'truncated' | 'failed' | 'held' | 'active';

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
 * - failed: JD2があきらめた（エラーで止まった）
 * - held: 無効にされた・スキップされた（利用者がJD2で操作した、「ファイルがあります」でスキップしたなど）。
 *   失敗とはみなさない（失敗にすると、落としかけのファイルごと消して渡し直してしまう）
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
  if (link.statusIconKey === 'false') return 'failed';
  if (link.enabled === false || link.skipped) return 'held';
  return 'active';
}

/**
 * JD2へ渡すURLに directhttp:// を付ける。Linkex の CDN は動画でも Content-Type を application/xml で返すことがあり、
 * そのままだと JD2 はページとみなして中身を読みに行き（16MBを超えると失敗、それ以下でもリンクが出てこない）、
 * 何も追加されない。directhttp:// を付けると、中身を読まずにファイルとして扱う。
 */
export function directHttpLink(url: string): string {
  return /^directhttp:\/\//i.test(url) ? url : `directhttp://${url}`;
}

/**
 * Linkex の CDN の URL の最後の段にある、配っているファイルの大きさ（例: /pool/pub/…/10485760）。
 * 共有側の file/get が返す大きさは、動画などで実際に配られる大きさより少し大きいことがあるので、
 * 受け取った量が足りているかは、こちらで確かめる。読み取れなければ null
 */
export function cdnObjectSize(url: string): number | null {
  try {
    const last = new URL(url.replace(/^directhttp:\/\//i, '')).pathname.split('/').filter(Boolean).pop() ?? '';
    if (!/^\d{1,15}$/.test(last)) return null;
    const n = Number(last);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** JD2 の一覧から消えた件を完了とみなすまでの待ち（JD2 の起動直後などで、一覧が一時的に空で返ることに備える） */
export const MISSING_CONFIRM_MS = 60_000;
/** JD2 がしばらく問題なく応答しているときの待ち（取り込み2回分で、消えたままなのを確かめる） */
export const MISSING_QUICK_MS = 2_000;

/**
 * 一覧から消えた件を、どれだけ消えたままなら完了とみなすか。
 * JD2 の「完了したダウンロードを削除」がすぐ削除だと、完了した件はたいてい次の取り込みまでに消えている。
 * 毎回1分待つと、その間 JD2 に渡しておく枠が埋まったままになるので、JD2 が1分以上続けて応答している
 * （再起動の直後ではない）ときは、すぐ完了とみなす。
 * - firstOkAt: この見届けで最初に JD2 の一覧を取れた時刻（0 = まだ）
 * - lastFailAt: 最後に JD2 の一覧を取れなかった時刻（0 = なし）
 */
export function missingConfirmMs(now: number, firstOkAt: number, lastFailAt: number): number {
  const settled = firstOkAt > 0 && now - firstOkAt >= MISSING_CONFIRM_MS && now - lastFailAt >= MISSING_CONFIRM_MS;
  return settled ? MISSING_QUICK_MS : MISSING_CONFIRM_MS;
}

/**
 * JD2 の「完了したダウンロードを削除」（GeneralSettings の CleanupAfterDownloadAction）が、
 * 完了した件を処理中に一覧から消してしまう設定か。消されると完了の確かめ（受け取った量が足りているか）ができない
 */
export function cleanupRemovesFinished(action: string | null): boolean {
  return action === 'CLEANUP_IMMEDIATELY' || action === 'CLEANUP_AFTER_PACKAGE_HAS_FINISHED';
}

/**
 * JD2 の一覧（url 付きで取ったもの）から、渡し中だった URL のリンクを探し、そのIDを返す。なければ null。
 * JD2 が directhttp:// を外して持つことがあるので、外した形で比べる
 */
export function findHandedLink(links: { uuid: number; url?: string }[], url: string): string | null {
  const plain = (u: string) => u.replace(/^directhttp:\/\//i, '');
  const want = plain(url);
  const hit = links.find((l) => l.url !== undefined && plain(l.url) === want);
  return hit ? String(hit.uuid) : null;
}
