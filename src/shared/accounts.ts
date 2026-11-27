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
  lastTraffic?: { used: number; total: number; at: number };
  /** 延命のために切り替えた時刻 */
  keepAliveAt?: number;
  /** 延命のために切り替えたときの期限の基準時刻（これより進めば延びた） */
  keepAliveStamp?: number;
  keepAliveFailed?: boolean;
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
/** 期限までこれを切ったら、延命のために使う */
export const KEEP_ALIVE_BEFORE_MS = 72 * 60 * 60 * 1000;
/** 同じアカウントへの延命の切り替えの間隔 */
export const KEEP_ALIVE_EVERY_MS = 24 * 60 * 60 * 1000;

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

/** 転送量が尽きたときの切り替え先。使えるもののうち期限がいちばん近いもの（使うことで延命にもなる） */
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

/** 延命のために切り替えるアカウント（期限まで72時間を切り、尽きておらず、24時間以内に延命していないもの） */
export function pickKeepAlive(s: AccountsSnapshot, recs: AccountRecords, disabled: string[], now: number): string | null {
  const candidates = s.accounts
    .filter((a) => {
      if (a.uid === s.currentUid || !usable(a, recs, disabled, now)) return false;
      if (expiresAt(a) - now >= KEEP_ALIVE_BEFORE_MS) return false;
      const last = recs[a.uid]?.keepAliveAt;
      return last === undefined || now - last >= KEEP_ALIVE_EVERY_MS;
    })
    .sort(byExpiry);
  return candidates[0]?.uid ?? null;
}

export type AccountWarning =
  | { kind: 'expiring'; uid: string; name: string; hoursLeft: number }
  | { kind: 'keepAliveFailed'; uid: string; name: string }
  | { kind: 'gone'; uid: string; name: string };

/** ダッシュボードに出す注意。一覧の順に、延命の失敗・期限が近いもの、最後に一覧から消えたもの */
export function accountWarnings(s: AccountsSnapshot, recs: AccountRecords, now: number): AccountWarning[] {
  const out: AccountWarning[] = [];
  for (const a of s.accounts) {
    if (recs[a.uid]?.keepAliveFailed) out.push({ kind: 'keepAliveFailed', uid: a.uid, name: a.name });
    const left = expiresAt(a) - now;
    if (a.hasSecret && left > 0 && left < KEEP_ALIVE_BEFORE_MS) {
      out.push({ kind: 'expiring', uid: a.uid, name: a.name, hoursLeft: Math.floor(left / HOUR) });
    }
  }
  const listed = new Set(s.accounts.map((a) => a.uid));
  for (const [uid, rec] of Object.entries(recs)) {
    if (!listed.has(uid)) out.push({ kind: 'gone', uid, name: rec.name ?? uid });
  }
  return out;
}
