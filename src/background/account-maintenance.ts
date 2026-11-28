/**
 * 1時間ごとの、今使っていないアカウントの見回り（処理を動かしていなくても、Edge が開いていれば動く）。
 * - 期限が近いアカウントのログイン情報を、切り替えずにその場で更新する（期限が20日延びる）
 * - 転送量が尽きたアカウントの転送量を、切り替えずに確かめる（戻っていれば「尽きた」印を外し、すぐ使えるようにする）
 * どちらも裏の埋め込みページの中で行い、トークンは Service Worker に来ない。
 * 設定「転送量が尽きたら別のアカウントに切り替える」がオフなら何もしない。
 */
import { formatBytes } from '../shared/files';
import { accountsToCheck, needsRefresh, TRAFFIC_CHECK_MS } from '../shared/accounts';
import { loadSettings } from '../shared/settings';
import { accountName, checkAccountTraffic, loadRecords, readAccounts, refreshAccountTokens, updateRecord } from './linkex-accounts';
import { logEvent } from './store';

const LAST_RUN_KEY = 'accountMaintenanceAt';

let running = false;

/** 前の見回りから1時間たっていれば見回る（1分ごとの見回りから呼ぶ） */
export async function maintainAccounts(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!(await loadSettings()).switchAccounts) return;
    const last = Number((await chrome.storage.local.get(LAST_RUN_KEY))[LAST_RUN_KEY]) || 0;
    if (Date.now() - last < TRAFFIC_CHECK_MS) return;
    await chrome.storage.local.set({ [LAST_RUN_KEY]: Date.now() });
    await refreshExpiring();
    await checkExhausted();
  } catch (e) {
    await logEvent('warn', `アカウントの見回りに失敗しました: ${String((e as Error)?.message ?? e)}`);
  } finally {
    running = false;
  }
}

/** 期限まで11日を切った、今使っていないアカウントのログイン情報を更新する */
async function refreshExpiring(): Promise<void> {
  const s = await readAccounts({ fresh: true, noNewTab: true });
  if (!s) return;
  const now = Date.now();
  for (const a of s.accounts) {
    if (!needsRefresh(s, a, now)) continue;
    const res = await refreshAccountTokens(a.uid);
    if (res === null) return; // 埋め込みが使えない。次の見回りで
    if (res.ok) {
      await updateRecord(a.uid, { refreshedAt: Date.now(), refreshFailed: undefined });
      await logEvent('info', `${a.name} のログイン情報を更新し、期限を延ばしました`);
    } else if (res.error === 'refresh_failed') {
      await updateRecord(a.uid, { refreshFailed: true });
      await logEvent(
        'warn',
        `${a.name} のログイン情報を更新できませんでした${res.status ? `（HTTP ${res.status}）` : ''}。Linkexでログインし直すと延びます`,
      );
    }
    // current（その間に今のアカウントになった）・not_found などは何もしない
  }
}

/** 尽きたアカウントの転送量を、切り替えずに確かめる。token が切れていたら更新してから1回だけ聞き直す */
async function checkExhausted(): Promise<void> {
  const s = await readAccounts({ fresh: true, noNewTab: true });
  if (!s) return;
  for (const uid of accountsToCheck(s, await loadRecords(), Date.now())) {
    let res = await checkAccountTraffic(uid);
    if (res && !res.ok && res.error === 'request_failed' && res.status === 401) {
      const refreshed = await refreshAccountTokens(uid);
      if (refreshed?.ok) res = await checkAccountTraffic(uid);
    }
    if (res === null) return; // 埋め込みが使えない。次の見回りで
    if (!res.ok) continue;
    const now = Date.now();
    const left = res.total > 0 ? res.total - res.used : Infinity;
    if (left > 0) {
      await updateRecord(uid, { lastTraffic: { used: res.used, total: res.total, at: now }, exhaustedAt: undefined, checkAgainAt: undefined });
      await logEvent('info', `${accountName(s, uid)} の転送量が戻りました（残り ${Number.isFinite(left) ? formatBytes(left) : '上限なし'}）`);
    } else {
      await updateRecord(uid, { lastTraffic: { used: res.used, total: res.total, at: now } });
    }
  }
}
