/**
 * JD2 に渡した件の見届け。JD2 のダウンロード一覧を取り込み、完了・失敗・進まない件を反映する。
 */
import { formatBytes } from '../shared/files';
import { jdLinkState, missingConfirmMs } from '../shared/jd2-status';
import type { QueueItem } from '../shared/queue';
import { loadSettings } from '../shared/settings';
import { Jd2ConnectionError } from '../shared/jd2-request';
import { errorText, MAX_ATTEMPTS, noteJdDown, runtime } from './engine-runtime';
import { discardLinks, nudgeLinks, queryLinks, type JdLink } from './jd2';
import { notify } from './notify';
import { logEvent, logEvents, readEngine, readQueue, rememberHashes, updateItems } from './store';

/** ダウンロード中の件がどれもこの時間進まなければ、知らせる（JD2が確認を待っている・止められているなど） */
const STALL_NOTICE_MS = 15 * 60_000;

/** 一覧から消えているのに最初に気づいた時刻（JD2のリンクID →） */
const missingSince = new Map<string, number>();
/** 最初に JD2 の一覧を取れた時刻・最後に取れなかった時刻（消えた件をすぐ完了とみなしてよいかを決める） */
let firstListOkAt = 0;
let lastListFailAt = 0;

/** 進み具合だけの変化は、この間隔より短くは保存しない（画面はJD2から直接取っている） */
const PROGRESS_SAVE_MS = 30_000;
const progressSavedAt = new Map<string, number>();

/**
 * JD2のダウンロード状況を取り込み、完了・失敗を反映する。
 * キュー全体の書き込みは重く、書くたびに画面も描き直されるので、変更はまとめて1回で書く
 */
let refreshing: Promise<void> | null = null;
export function refreshDownloads(): Promise<void> {
  // 見回り（1分ごと）と指示役が同時に取り込むと、同じ失敗を二重に数えかねないので1本にまとめる
  refreshing ??= doRefreshDownloads().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * ダウンロード中の件がどれも長く進まなければ、処理ログと通知で知らせる（1回だけ）。
 * 見張りの状態は runtime.stall（「開始」で消す）
 */
async function watchStall(loaded: number, active: number): Promise<void> {
  if (active === 0) {
    runtime.stall = null;
    return;
  }
  if (!runtime.stall || loaded > runtime.stall.bytes) {
    runtime.stall = { bytes: loaded, since: Date.now(), noticed: false };
    return;
  }
  runtime.stall.bytes = loaded;
  if (runtime.stall.noticed || Date.now() - runtime.stall.since < STALL_NOTICE_MS) return;
  runtime.stall.noticed = true;
  const minutes = STALL_NOTICE_MS / 60_000;
  await logEvent('warn', `JD2のダウンロードが${minutes}分以上進んでいません（JD2が確認を待っている・止められているなど）`);
  await notify('stalled', 'ダウンロードが進んでいません', `JD2で${minutes}分以上進んでいません。JD2の画面を確認してください`);
}

/** JD2で動いているのにこの時間進まなければ、止めて動かし直す。動かし直してもまた進まなければ、やり直す */
const STUCK_MS = 10 * 60_000;
const stuckWatch = new Map<string, { bytes: number; since: number; nudged: boolean }>();

/** 動いているのに進まないリンクを見張る。nudge: 止めて動かし直す / give-up: 失敗としてやり直す */
function watchStuck(jdId: string, link: JdLink): 'ok' | 'nudge' | 'give-up' {
  const bytes = link.bytesLoaded ?? 0;
  if (!link.running || (link.speed ?? 0) > 0) {
    stuckWatch.delete(jdId);
    return 'ok';
  }
  const w = stuckWatch.get(jdId);
  if (!w || bytes !== w.bytes) {
    stuckWatch.set(jdId, { bytes, since: Date.now(), nudged: false });
    return 'ok';
  }
  if (Date.now() - w.since < STUCK_MS) return 'ok';
  if (!w.nudged) {
    w.nudged = true;
    w.since = Date.now();
    return 'nudge';
  }
  stuckWatch.delete(jdId);
  return 'give-up';
}

async function doRefreshDownloads(): Promise<void> {
  const items = (await readQueue()).filter((i) => i.state === 'downloading' && i.jdId);
  if (items.length === 0) return;
  let links: Awaited<ReturnType<typeof queryLinks>>;
  try {
    links = await queryLinks(items.map((i) => i.jdId!));
    runtime.jdDownSince = 0;
    firstListOkAt ||= Date.now();
  } catch (e) {
    lastListFailAt = Date.now();
    // JD2に一時的につながらない場合は次回また確認する。つながらないままが長く続いたら、
    // ダウンロード中の件しか残っていなくても（担当が JD2 を呼ばなくても）止めて知らせる。
    // 止まっている間は見回りが1分ごとに呼ぶので、そのたびに知らせないよう数えない
    if (e instanceof Jd2ConnectionError && !(await readEngine()).paused) await noteJdDown(e);
    return;
  }
  const byId = new Map(links.map((l) => [String(l.uuid), l]));
  const stillActive = items.filter((i) => jdLinkState(byId.get(i.jdId!), i.fileSize ?? null) === 'active');
  await watchStall(
    stillActive.reduce((sum, i) => sum + (byId.get(i.jdId!)?.bytesLoaded ?? 0), 0),
    stillActive.length,
  );
  const confirmMs = missingConfirmMs(Date.now(), firstListOkAt, lastListFailAt);
  const patches = new Map<string, Partial<QueueItem>>();
  /** 完了した件の中身（ダウンロード済みとして、まとめて1回で記録する） */
  const downloaded: { hash: string; name: string }[] = [];
  const logs: [Parameters<typeof logEvent>[0], string][] = [];
  // JD2があきらめたリンク。次の周回で新しいURLを発行して渡し直す（保存せずに取る件は保存しない）ので、
  // 落としかけのファイルごとJD2の一覧から消す
  const toDiscard: string[] = [];
  // 動いているのに進まないリンク。止めて動かし直す
  const toNudge: string[] = [];
  for (const item of items) {
    const link = byId.get(item.jdId!);
    const state = jdLinkState(link, item.fileSize ?? null);
    const stuck = state === 'active' && link ? watchStuck(item.jdId!, link) : 'ok';
    if (stuck === 'nudge') {
      toNudge.push(item.jdId!);
      logs.push(['warn', `JD2で${STUCK_MS / 60_000}分以上進まないため、止めて動かし直します: ${item.name}`]);
    }
    const progress: Partial<QueueItem> = link
      ? {
          totalLength: link.bytesTotal && link.bytesTotal > 0 ? link.bytesTotal : undefined,
          completedLength: link.bytesLoaded ?? 0,
        }
      : {};
    if (state !== 'missing') missingSince.delete(item.jdId!);
    if (state === 'missing') {
      // 一覧から消えている（JD2の設定で完了後に自動で片付けられた・手で消された）。渡せた時点で成功とみなす。
      // ただし JD2 の起動直後などは一覧が一時的に空で返ることがあるので、消えたままなのを確かめてから
      // （JD2 がしばらく問題なく応答していれば数秒、そうでなければ1分。missingConfirmMs）
      const since = missingSince.get(item.jdId!) ?? Date.now();
      missingSince.set(item.jdId!, since);
      if (Date.now() - since < confirmMs) continue;
      missingSince.delete(item.jdId!);
      if (item.hash) downloaded.push({ hash: item.hash, name: item.name });
      patches.set(item.id, { state: 'done', jdId: undefined, note: 'JD2の一覧になし' });
      logs.push(['info', `完了（JD2の一覧になし）: ${item.name}`]);
    } else if (state === 'held') {
      // JD2 で無効にされた・スキップされた（「ファイルがあります」でスキップを選んだなど）。
      // 利用者の操作かもしれないので、失敗にして落としかけのファイルを消したりはせず、知らせるだけにする
      const note = 'JD2で無効・スキップにされています（JD2で有効に戻すと続きます）';
      if (item.note !== note) {
        patches.set(item.id, { ...progress, note });
        logs.push(['warn', `JD2で無効・スキップにされたため、待っています: ${item.name}`]);
      }
    } else if (state === 'done') {
      if (item.hash) downloaded.push({ hash: item.hash, name: item.name });
      patches.set(item.id, { ...progress, state: 'done', jdId: undefined });
      logs.push(['info', `完了: ${item.name}`]);
    } else if (state === 'failed' || state === 'truncated' || stuck === 'give-up') {
      toDiscard.push(item.jdId!);
      const attempts = item.attempts + 1;
      const reason =
        stuck === 'give-up'
          ? `動かし直しても${STUCK_MS / 60_000}分以上進みませんでした`
          : state === 'truncated'
          ? `途中で切れました（${formatBytes(Math.max(link?.bytesLoaded ?? 0, link?.bytesTotal ?? 0))} / ${formatBytes(item.fileSize ?? null)}）`
          : link?.status || '不明';
      patches.set(item.id, {
        ...progress,
        attempts,
        jdId: undefined,
        state: attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
        error: `JD2でのダウンロード失敗: ${reason}`,
      });
      logs.push([attempts >= MAX_ATTEMPTS ? 'error' : 'warn', `JD2でのダウンロード失敗: ${item.name} — ${reason}`]);
    } else {
      // 進み具合だけなら、変わっていて、前に保存してから時間がたったときだけ書く
      const changed =
        progress.totalLength !== item.totalLength || progress.completedLength !== (item.completedLength ?? 0);
      const due = Date.now() - (progressSavedAt.get(item.id) ?? 0) >= PROGRESS_SAVE_MS;
      // 無効・スキップから戻ったら、そのメモは消す
      const heldNote = item.note?.startsWith('JD2で無効・スキップ') ? { note: undefined } : {};
      if ((changed && (due || progress.totalLength !== item.totalLength)) || 'note' in heldNote) {
        patches.set(item.id, { ...progress, ...heldNote });
        progressSavedAt.set(item.id, Date.now());
      }
    }
  }
  await rememberHashes(downloaded);
  // 確認しているあいだに外されたり状態が変わったりした件は書き換えない
  const jdIdOf = new Map(items.map((i) => [i.id, i.jdId]));
  await updateItems(patches, (i) => i.state === 'downloading' && i.jdId === jdIdOf.get(i.id));
  for (const [id, patch] of patches) if (patch.state) progressSavedAt.delete(id);
  await logEvents(logs);
  try {
    await nudgeLinks(toNudge, (await loadSettings()).forceStart);
  } catch (e) {
    await logEvent('warn', `JD2のリンクを動かし直せませんでした: ${errorText(e)}`);
  }
  try {
    await discardLinks(toDiscard);
  } catch (e) {
    await logEvent('warn', `JD2の一覧から外せませんでした: ${errorText(e)}`);
  }
}
