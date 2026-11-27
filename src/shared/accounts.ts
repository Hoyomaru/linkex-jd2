/**
 * Linkex Web版に覚えさせてあるアカウントのうち、どれを使うかを決める（純粋な関数だけ）。
 * 一覧は Web版の localStorage（linkex_user_cache_v1）から読む。拡張機能はトークンを持たない。
 */

/** Web版の一覧の1アカウント（トークンの中身は持たない） */
export interface LinkexAccount {
  uid: string;
  /** nickname、無ければ email、無ければ uid */
  name: string;
  email: string;
  status: 'online' | 'logged_out' | null;
  /**
   * 期限の基準時刻（refreshTokenUpdatedAt、無ければ _meta.updatedAt）。
   * 無ければ 0（Web版と同じく期限なし）、あっても数値でなければ -1（Web版と同じく期限切れ）
   */
  stampAt: number;
  /** token か refreshToken があるか */
  hasSecret: boolean;
  /** Web版が最後に見た転送量（system.storageSpace） */
  cachedTraffic: { used: number; total: number } | null;
}

export interface AccountsSnapshot {
  currentUid: string | null;
  /** Web版の「アカウントを切り替え」に出るもの（ログイン情報があり、期限が切れていないもの） */
  accounts: LinkexAccount[];
  /** Web版の「編集 → ⊖」で外された（ログイン情報だけ消された）アカウントの uid */
  removed?: string[];
}

/** 拡張機能がアカウントごとに覚えておくこと */
export interface AccountRecord {
  /** 最後に見た表示名（一覧から消えたときの知らせに使う） */
  name?: string;
  /** 転送量が尽きたと分かった時刻 */
  exhaustedAt?: number;
  /** 尽きた後に確かめてまだ尽きていたとき、次に確かめてよい時刻 */
  checkAgainAt?: number;
  /** 最後に確かめた転送量と、その時刻 */
  lastTraffic?: { used: number; total: number; at: number };
  /** ログイン情報をその場で更新した時刻 */
  refreshedAt?: number;
  /** ログイン情報の更新に失敗した（ログインし直すまで期限を延ばせない） */
  refreshFailed?: boolean;
}
export type AccountRecords = Record<string, AccountRecord>;

/** Web版が一覧から消すまでの時間（REFRESH_TOKEN_MEMORY_MS） */
export const REFRESH_TOKEN_MEMORY_MS = 480 * 60 * 60 * 1000;
/** 期限ぎりぎりのアカウントには切り替えない */
export const EXPIRY_MARGIN_MS = 60 * 60 * 1000;
/** 尽きたアカウントを再び試すまでの時間 */
export const TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 試してまだ尽きていたら、次に試すまでの時間 */
export const RECHECK_MS = 60 * 60 * 1000;
/**
 * 期限（20日）までこれを切ったら、今使っていないアカウントのログイン情報をその場で更新する。
 * token は10日で切れるので、その少し前（9日目）に更新して、転送量の確認にも使えるようにしておく
 */
export const REFRESH_BEFORE_MS = 11 * 24 * 60 * 60 * 1000;
/** 尽きたアカウントの転送量を、切り替えずに確かめる間隔 */
export const TRAFFIC_CHECK_MS = 60 * 60 * 1000;
/** 期限までこれを切ったら、ダッシュボードで知らせる */
export const EXPIRY_WARN_MS = 72 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

/** Web版が一覧から消す時刻。基準時刻が無ければ期限なし、読めなければ期限切れ（Web版と同じ扱い） */
export function expiresAt(a: LinkexAccount): number {
  if (a.stampAt < 0) return -Infinity;
  return a.stampAt > 0 ? a.stampAt + REFRESH_TOKEN_MEMORY_MS : Infinity;
}

/** 切り替えに使えるだけの期限とログイン情報があるか */
export function isFresh(a: LinkexAccount, now: number): boolean {
  return a.hasSecret && now < expiresAt(a) - EXPIRY_MARGIN_MS;
}

/** 転送量が戻っていそうか（尽きていない、または24時間たって、確かめ直しの時刻も過ぎた） */
export function isRested(rec: AccountRecord | undefined, now: number): boolean {
  if (!rec) return true;
  if (rec.checkAgainAt !== undefined && now < rec.checkAgainAt) return false;
  if (rec.exhaustedAt !== undefined && now - rec.exhaustedAt < TRAFFIC_WINDOW_MS) return false;
  return true;
}

const usable = (a: LinkexAccount, recs: AccountRecords, disabled: string[], now: number) =>
  isFresh(a, now) && !disabled.includes(a.uid) && isRested(recs[a.uid], now);

const byExpiry = (a: LinkexAccount, b: LinkexAccount) => expiresAt(a) - expiresAt(b);

/** 転送量が尽きたときの切り替え先。使えるもののうち期限がいちばん近いもの */
export function pickNextAccount(s: AccountsSnapshot, recs: AccountRecords, disabled: string[], now: number): string | null {
  const candidates = s.accounts.filter((a) => a.uid !== s.currentUid && usable(a, recs, disabled, now)).sort(byExpiry);
  return candidates[0]?.uid ?? null;
}

/** 全部尽きているとき、いちばん早く試せるアカウントとその時刻（今のアカウントも含む） */
export function nextResume(
  s: AccountsSnapshot,
  recs: AccountRecords,
  disabled: string[],
  now: number,
): { uid: string; at: number } | null {
  let best: { uid: string; at: number } | null = null;
  for (const a of s.accounts) {
    if (!isFresh(a, now) || disabled.includes(a.uid)) continue;
    const rec = recs[a.uid];
    const at = isRested(rec, now)
      ? now
      : Math.max((rec?.exhaustedAt ?? 0) + TRAFFIC_WINDOW_MS, rec?.checkAgainAt ?? 0);
    if (!best || at < best.at) best = { uid: a.uid, at };
  }
  return best;
}

/**
 * 今使っていないアカウントのログイン情報を、その場で更新するか（期限まで11日を切ったもの）。
 * 今使っているアカウントは Web版が自分で更新する。期限の基準時刻が無い・読めないものは更新しない
 */
export function needsRefresh(s: AccountsSnapshot, a: LinkexAccount, now: number): boolean {
  if (a.uid === s.currentUid || !a.hasSecret || a.stampAt <= 0) return false;
  return expiresAt(a) - now < REFRESH_BEFORE_MS;
}

/** 切り替えずに転送量を確かめるアカウント（尽きた印があり、今使っておらず、1時間以上確かめていないもの） */
export function accountsToCheck(s: AccountsSnapshot, recs: AccountRecords, now: number): string[] {
  return s.accounts
    .filter((a) => {
      const rec = recs[a.uid];
      if (a.uid === s.currentUid || rec?.exhaustedAt === undefined) return false;
      return rec.lastTraffic === undefined || now - rec.lastTraffic.at >= TRAFFIC_CHECK_MS;
    })
    .map((a) => a.uid);
}

export type AccountWarning =
  | { kind: 'expiring'; uid: string; name: string; hoursLeft: number }
  | { kind: 'refreshFailed'; uid: string; name: string }
  | { kind: 'gone'; uid: string; name: string };

/** ダッシュボードに出す注意。一覧の順に、更新の失敗・期限が近いもの、最後に一覧から消えたもの */
export function accountWarnings(s: AccountsSnapshot, recs: AccountRecords, now: number): AccountWarning[] {
  const out: AccountWarning[] = [];
  for (const a of s.accounts) {
    if (recs[a.uid]?.refreshFailed) out.push({ kind: 'refreshFailed', uid: a.uid, name: a.name });
    const left = expiresAt(a) - now;
    if (a.hasSecret && left > 0 && left < EXPIRY_WARN_MS) {
      out.push({ kind: 'expiring', uid: a.uid, name: a.name, hoursLeft: Math.floor(left / HOUR) });
    }
  }
  const listed = new Set(s.accounts.map((a) => a.uid));
  for (const [uid, rec] of Object.entries(recs)) {
    if (!listed.has(uid)) out.push({ kind: 'gone', uid, name: rec.name ?? uid });
  }
  return out;
}
