/**
 * Linkex Web版に覚えさせてあるアカウントを、Service Worker から読み・切り替える。
 * ログイン情報の保存と更新は Web版に任せ、拡張機能は切り替え先（currentUid）を指定するだけ。
 * 判定（どれに切り替えるか・期限・延命）は shared/accounts.ts にある。
 */
import type { AccountRecord, AccountRecords, AccountsSnapshot } from '../shared/accounts';
import { linkexReadAccounts, linkexSwitchAccount } from './linkex-bridge';
import { frameRequest, refreshFrame } from './linkex-frame';
import { runInLinkexTab } from './linkex-tab';

export const ACCOUNT_STATE_KEY = 'accountState';
/** 一覧を読み直すまでの間 */
const READ_CACHE_MS = 60_000;

let cached: { at: number; snapshot: AccountsSnapshot | null } | null = null;

/** 一覧を読む。1分間は覚えた値を返す（fresh で読み直す）。読めなければ null */
export async function readAccounts(opts: { fresh?: boolean } = {}): Promise<AccountsSnapshot | null> {
  if (!opts.fresh && cached && Date.now() - cached.at < READ_CACHE_MS) return cached.snapshot;
  const res =
    (await frameRequest<AccountsSnapshot | null>({ kind: 'accounts' })) ?? (await runInLinkexTab(linkexReadAccounts, []));
  const snapshot = res?.value ?? null;
  cached = { at: Date.now(), snapshot };
  if (snapshot) await rememberAccounts(snapshot);
  return snapshot;
}

/**
 * アカウントを切り替える。書き換えた後は埋め込みを読み込み直す
 * （開いている Linkex のタブや固定タブは、localStorage の変化で自分から読み込み直す）。
 * 読み直して、今のアカウントが切り替え先になっていれば成功
 */
export async function switchAccount(toUid: string): Promise<{ ok: true; fromUid: string | null } | { ok: false; error: string }> {
  const now = Date.now();
  const res =
    (await frameRequest<ReturnType<typeof linkexSwitchAccount>>({ kind: 'switch', toUid, now })) ??
    (await runInLinkexTab(linkexSwitchAccount, [toUid, now]));
  if (!res?.value) return { ok: false, error: 'Linkexのページから返事がありません' };
  if (!res.value.ok) return { ok: false, error: res.value.error };
  refreshFrame();
  cached = null;
  const after = await readAccounts({ fresh: true });
  if (after?.currentUid !== toUid) return { ok: false, error: '切り替えた後の確認で、今のアカウントが変わっていませんでした' };
  return { ok: true, fromUid: res.value.fromUid };
}

/** 一覧の覚えを捨てる（手で切り替えられたときなど） */
export function forgetAccounts(): void {
  cached = null;
}

export async function loadRecords(): Promise<AccountRecords> {
  return ((await chrome.storage.local.get(ACCOUNT_STATE_KEY))[ACCOUNT_STATE_KEY] ?? {}) as AccountRecords;
}

let recordWrite: Promise<unknown> = Promise.resolve();
/**
 * アカウントの記録を書き換える。値が undefined の項目は消す。patch が null ならアカウントごと消す。
 * 書き込みは1本の鎖で順に行う（同時に書いて、片方の変更が消えないように）
 */
export function updateRecord(uid: string, patch: Partial<AccountRecord> | null): Promise<void> {
  const next = recordWrite.then(async () => {
    const all = await loadRecords();
    if (patch === null) {
      delete all[uid];
    } else {
      const rec: Record<string, unknown> = { ...all[uid], ...patch };
      for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key];
      all[uid] = rec as AccountRecord;
    }
    await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: all });
  });
  recordWrite = next.catch(() => undefined);
  return next;
}

/** 一覧にあるアカウントの表示名を記録に書く（一覧から消えたときに名前で知らせるため） */
export async function rememberAccounts(s: AccountsSnapshot): Promise<void> {
  const all = await loadRecords();
  for (const a of s.accounts) {
    if (all[a.uid]?.name !== a.name) await updateRecord(a.uid, { name: a.name });
  }
}
