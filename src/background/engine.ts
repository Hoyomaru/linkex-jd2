/**
 * 全体の指示役。キューから次の件を選んで担当を付け、失敗の数え方と全体の一時停止を決める。
 * 1件ごとの段階の処理は engine-steps.ts、JD2 での完了の見届けは jd-monitor.ts、
 * 両方で分け合う実行中の状態は engine-runtime.ts にある。
 */
import { formatBytes, isFolder, unwrapFile } from '../shared/files';
import { Jd2ConnectionError } from '../shared/jd2-request';
import { FINISHED_STATES, type EngineState, type QueueItem } from '../shared/queue';
import { IN_STORAGE_STATES, pickLeftovers, pickStarts } from '../shared/scheduler';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError, linkexOkAt, LinkexTrafficLimitError, LinkexTransientError } from './api';
import { errorText, IDLE_WAIT_MS, MAX_ATTEMPTS, noteJdDown, resetRuntime, runtime, sleep, stopWithNotice } from './engine-runtime';
import { resolveHanding, stepCopy, stepDelete, stepDirect, stepFindCopy, stepSend } from './engine-steps';
import { refreshDownloads } from './jd-monitor';
import { pingJd } from './jd2';
import { LinkexLoginError, takeFrozenReloads } from './linkex-tab';
import { refreshFrame } from './linkex-frame';
import { accountName, loadRecords, noteExhausted, noteTraffic, readAccounts, switchAccount, updateRecord } from './linkex-accounts';
import { nextResume, pickNextAccount, RECHECK_MS } from '../shared/accounts';
import { notify } from './notify';
import { logEvent, readEngine, readQueue, updateItem, writeEngine } from './store';

/** JD2 の完了を取り込む間隔（JD2 の一覧は全件で返ってくるので、毎周は取らない） */
const DOWNLOADS_REFRESH_MS = 3_000;
const TRAFFIC_RECHECK_MS = 5 * 60_000;
/** 転送量を調べ直すまでの間（その間は、調べた残りから始めた件のサイズを引いて見込む） */
const TRAFFIC_CACHE_MS = 60_000;
const TRAFFIC_WAIT_MESSAGE = '転送量の上限に達したため待機中';
/** 転送量の上限で URL を断られた件に付けるメモ */
const TRAFFIC_ITEM_NOTE = '転送量の上限待ち';
/** アカウントを切り替える前に、Linkex 側で処理中の件が片付くのを待つ上限 */
const SWITCH_PREP_LIMIT_MS = 10 * 60_000;
/** 切り替えの前にコピーを消している件のメモ */
const SWITCH_CLEANUP_NOTE = 'アカウント切り替えの前にコピーを削除中';
/** 全部のアカウントが尽きているとき、再開を試せるかを見る間隔 */
const RESUME_CHECK_MS = 60_000;
/** 残ったコピーの片付けの間隔（容量が足りないと言われたら、次に手が空いたときすぐ片付ける） */
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** 容量が足りないと言われてから、新しい件を始めずに待つ時間 */
const CAPACITY_WAIT_MS = 30_000;
/** 保存中のコピーの合計の上限（Linkexの容量の空きがこれより少なければ、空きのほうに合わせる） */
const STORAGE_CAP_BYTES = 5 * 1024 ** 3;
/** 空き容量を調べ直す間隔 */
const BUDGET_REFRESH_MS = 5 * 60_000;
/** JD2 につながらなかった件を、もう一度渡してみるまでの間 */
const JD_RETRY_MS = 5_000;
/** Linkex がこの時間応えないままなら（ネットが切れているなど）、全体を止めて知らせる */
const LINKEX_DOWN_LIMIT_MS = 10 * 60_000;
/** Linkex が一時的に応えなかった件を、もう一度進めてみるまでの間 */
const LINKEX_RETRY_MS = 10_000;

let loopRunning = false;
/** 保存〜削除を進めている件（ID → 担当が終わるまでの Promise） */
const workers = new Map<string, Promise<void>>();

/** キューを処理するループを起動する（すでに動いていれば何もしない） */
export function kick(): void {
  if (loopRunning) return;
  loopRunning = true;
  let failed = false;
  runLoop()
    .catch(async (e) => {
      failed = true;
      // 止められた後なら、止まった理由のほうを残す
      await writeEngine({ status: 'crashed', message: `処理が止まりました: ${errorText(e)}` }, (cur) => !cur.paused);
    })
    .finally(async () => {
      loopRunning = false;
      // ループが終わる直前に「開始」が押されていたら、ここで動かし直す
      // （失敗で止まったときは、すぐに繰り返さず1分ごとの見回りに任せる）
      if (!failed && !(await readEngine()).paused) kick();
    });
}

export async function start(): Promise<void> {
  // JD2 が起動していないまま始めると、件が進んでから（保存してから取る件は Linkex にコピーを作ってから）
  // 数分後にやっと止まるので、始める前に確かめる
  try {
    await pingJd();
  } catch (e) {
    const reason = errorText(e);
    await writeEngine({ paused: true, status: 'stopped', message: `開始できません: ${reason}` });
    await logEvent('error', `開始できません: ${reason}`);
    throw new Error(reason);
  }
  await writeEngine({ paused: false, status: 'running', message: '開始しました' });
  takeFrozenReloads(); // 前回までの分は数えない
  resetRuntime();
  refreshFrame();
  await logEvent('info', '処理を開始しました');
  kick();
}

export async function pause(): Promise<void> {
  // 処理中の件は、それぞれ区切りのよいところまで進めてから止まる
  await writeEngine({ paused: true, status: 'paused', message: '一時停止中' });
  await logEvent('info', '一時停止しました');
}

/**
 * 全体の指示役。空きがあれば次の件に担当を付けて保存〜削除を並行して進め、
 * JD2の完了を取り込み、全部終わったら知らせる。
 */
async function runLoop(): Promise<void> {
  while (true) {
    const engine = await readEngine();
    if (engine.paused) {
      // 動いている担当が区切りのよいところで止まるのを待つ
      await Promise.allSettled(workers.values());
      return;
    }

    const settings = await loadSettings();
    if (Date.now() - runtime.downloadsRefreshedAt >= DOWNLOADS_REFRESH_MS) {
      runtime.downloadsRefreshedAt = Date.now();
      await refreshDownloads();
    }
    const items = await readQueue();
    const downloading = items.filter((i) => i.state === 'downloading').length;
    const prep = items.filter((i) => IN_STORAGE_STATES.includes(i.state));
    const waiting = items.filter((i) => i.state === 'pending' || i.state === 'retry');

    if (workers.size === 0 && prep.length === 0 && waiting.length === 0 && downloading === 0) {
      runtime.openShares.clear();
      await finish(items);
      return;
    }
    if (settings.notifyEachShare) await noticeFinishedShares(items);

    // 自分のストレージに残ったコピー（時間切れの後に遅れてできたもの・削除の途中で止まったものなど）を片付ける。
    // Linkex側で処理中の件があると、保存したばかりのコピーを消してしまうので、手が空いているときだけ
    if (settings.cleanupLeftovers && workers.size === 0 && prep.length === 0 && Date.now() - runtime.cleanedAt >= CLEANUP_INTERVAL_MS) {
      runtime.cleanedAt = Date.now();
      if (await cleanupLeftovers(items)) runtime.budget = null;
    }

    // 保存中のコピーに使ってよい容量。コピーを置いていないときに調べ直す（置いている間は二重に数えてしまうため）
    if (!runtime.budget || (prep.length === 0 && Date.now() - runtime.budget.at > BUDGET_REFRESH_MS)) {
      runtime.budget = { bytes: await storageBudget(), at: Date.now() };
    }

    const ctx = {
      running: new Set(workers.keys()),
      parallel: Math.max(1, settings.parallelItems),
      budgetBytes: runtime.budget.bytes,
      maxDownloads: settings.maxDownloads,
      // 保存せずに取るときは、先に保存しておくものがない
      prefetch: settings.directDownload ? 0 : Math.max(0, settings.prefetchItems),
    };
    // アカウントを切り替える準備中なら、Linkex 側で処理中の件が片付きしだい切り替える（切り替えたら一覧を読み直す）
    if (runtime.switching) {
      if (await advanceSwitch(prep.length)) continue;
    } else if (Date.now() < runtime.trafficWaitUntil) {
      // 転送量の上限待ちのあいだ、戻っていそうなほかのアカウントがあれば切り替えて確かめる
      await maybeResume();
    }

    const allowNew = !runtime.switching && Date.now() >= runtime.capacityWaitUntil && Date.now() >= runtime.trafficWaitUntil;
    let picks = pickStarts(items, { ...ctx, allowNew });
    const newPicks = waiting.filter((w) => picks.includes(w.id));
    const newBytes = newPicks.reduce((sum, w) => sum + (w.size ?? 0), 0);
    if (newPicks.length > 0 && settings.pauseOnTrafficLimit && (await trafficExhausted(newBytes))) {
      // 別のアカウントに切り替えられるなら、切り替えの準備に入る。切り替えられなければ待つ
      if (!(await onTrafficExhausted())) {
        // 待機中に Service Worker が止められると1分ごとの見回りでここに戻ってくるので、
        // ログは待機に入った最初の1回だけ書く
        if (!engine.message.startsWith(TRAFFIC_WAIT_MESSAGE)) {
          await logEvent('warn', '転送量の上限に達したため待機します（5分ごとに確認）');
        }
        runtime.trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
      }
      picks = pickStarts(items, { ...ctx, allowNew: false });
    }
    for (const id of picks) {
      // 担当が思わぬ理由で失敗しても、全体の指示役は止めない（その件は次の周回で割り当て直す）
      const worker = runWorker(id)
        .catch((e) => logEvent('warn', `処理中に問題が起きたため、やり直します: ${errorText(e)}`))
        .finally(() => workers.delete(id));
      workers.set(id, worker);
    }

    // 周回の途中で止められていたら（ログイン切れ・一時停止など）、止まった理由を上書きしない
    await writeEngine(statusMessage(items, downloading, waiting.length, settings.maxDownloads), (cur) => !cur.paused);
    // 担当が1つ終わったら、すぐ次の件を割り当てる
    await Promise.race([sleep(IDLE_WAIT_MS), ...workers.values()]);
  }
}

/** 画面上部に出す今の状況。待っているだけ（新しく進められる件がない）なら waiting */
function statusMessage(
  items: QueueItem[],
  downloading: number,
  waiting: number,
  maxDownloads: number,
): Pick<EngineState, 'status' | 'message'> {
  if (runtime.switching) {
    return { status: 'running', message: `Linkexのアカウントを切り替える準備中（Linkex側で処理中 ${workers.size}件）` };
  }
  if (Date.now() < runtime.trafficWaitUntil && workers.size === 0) return { status: 'waiting', message: trafficWaitMessage() };
  const parts: string[] = [];
  if (workers.size > 0) {
    const first = items.find((i) => workers.has(i.id));
    parts.push(`処理中 ${workers.size}件（${first?.name ?? ''}${workers.size > 1 ? ' ほか' : ''}）`);
  }
  const slotsFull = waiting > 0 && downloading >= maxDownloads;
  if (downloading > 0) parts.push(`ダウンロード中 ${downloading}件${slotsFull ? '（空き待ち）' : ''}`);
  const capacityWait = Date.now() < runtime.capacityWaitUntil;
  if (capacityWait) parts.push('容量の空き待ち');
  if (parts.length === 0) return { status: 'waiting', message: '待機中' };
  // 担当が動いていれば実行中。ダウンロードを見届けているだけで、空きや容量を待っているなら待機中
  const status = workers.size === 0 && (slotsFull || capacityWait) ? 'waiting' : 'running';
  return { status, message: parts.join('・') };
}

/** 共有1つ分が終わったとみなすのは、最後の件がこの時間内に終わったときだけ（待ちの件を外しただけのときは知らせない） */
const SHARE_DONE_RECENT_MS = 5 * 60_000;

/**
 * 前の周回では終わっていない件があった共有のうち、今は全部終わった（完了・省略・失敗）ものを知らせる。
 * キュー全体が終わったときは finish がまとめて知らせるので、ここは他の共有がまだ残っているときだけ
 */
async function noticeFinishedShares(items: QueueItem[]): Promise<void> {
  const open = new Set<string>();
  for (const i of items) if (!FINISHED_STATES.includes(i.state) && i.state !== 'error') open.add(i.shareToken);
  const closed = [...runtime.openShares].filter((t) => !open.has(t));
  runtime.openShares = open;
  for (const token of closed) {
    const mine = items.filter((i) => i.shareToken === token);
    if (mine.length === 0 || Date.now() - mine.reduce((m, i) => Math.max(m, i.updatedAt), 0) > SHARE_DONE_RECENT_MS) continue;
    const done = mine.filter((i) => i.state === 'done');
    const errors = mine.filter((i) => i.state === 'error').length;
    const skipped = mine.filter((i) => i.state === 'skipped').length;
    const bytes = done.reduce((sum, i) => sum + (i.fileSize ?? i.size ?? 0), 0);
    const name = mine[0].shareName || token;
    const detail = [`完了 ${done.length}件（${formatBytes(bytes)}）`];
    if (skipped) detail.push(`省略 ${skipped}件`);
    if (errors) detail.push(`失敗 ${errors}件`);
    await logEvent(errors ? 'warn' : 'info', `共有「${name}」が終わりました: ${detail.join('・')}`);
    await notify(`share:${token}`, `「${name}」が終わりました${errors ? `（失敗 ${errors}件）` : ''}`, detail.join('・'));
  }
}

async function finish(items: QueueItem[]): Promise<void> {
  await writeEngine({ paused: true, status: 'finished', message: 'すべて終わりました' });
  const frozen = takeFrozenReloads();
  await logEvent(
    'info',
    `キューの処理がすべて終わりました${frozen ? `（凍結されたLinkexのタブを読み込み直した回数 ${frozen}回）` : ''}`,
  );
  const done = items.filter((i) => i.state === 'done').length;
  const errors = items.filter((i) => i.state === 'error').length;
  await notify(
    'finished',
    errors ? `終わりました（失敗 ${errors}件）` : 'すべて終わりました',
    `完了 ${done}件${errors ? `・失敗 ${errors}件。専用ページで再試行できます` : ''}`,
  );
}

/**
 * 自分のストレージのルートとゴミ箱に残ったファイルを完全削除する（設定でオンにしたときだけ）。
 * キューの件のコピーとして決まっているものは消さない。消した数を返す
 */
async function cleanupLeftovers(items: QueueItem[]): Promise<number> {
  const claimed = new Set(items.filter((i) => i.destFileId).map((i) => String(i.destFileId)));
  let count = 0;
  let bytes = 0;
  try {
    const root = (await collectPages((page) => api.myFiles(undefined, page))).map(unwrapFile);
    for (const f of pickLeftovers(root, claimed, isFolder)) {
      if ((await readEngine()).paused) break;
      try {
        await api.moveToTrash(String(f.id));
      } catch {
        // ゴミ箱に移せなくても、完全削除を試す
      }
      await api.deleteForever(String(f.id));
      count++;
      bytes += Number(f.size) || 0;
    }
    const trash = (await collectPages((page) => api.trashList(page))).map(unwrapFile);
    for (const f of pickLeftovers(trash, claimed, isFolder)) {
      if ((await readEngine()).paused) break;
      await api.deleteForever(String(f.id));
      count++;
      bytes += Number(f.size) || 0;
    }
  } catch (e) {
    await logEvent('warn', `残ったファイルの片付けに失敗しました: ${errorText(e)}`);
  }
  if (count > 0) await logEvent('info', `自分のストレージに残っていたファイルを ${count}件（${formatBytes(bytes)}）完全削除しました`);
  return count;
}

/** 保存中のコピーに使ってよい容量。5GBとLinkexの空き容量の小さいほう */
async function storageBudget(): Promise<number> {
  try {
    const usage = await api.usage();
    if (usage.totalSpace > 0) return Math.min(STORAGE_CAP_BYTES, Math.max(0, usage.totalSpace - (usage.usedSpace ?? 0)));
  } catch {
    // 調べられなければ上限だけで進める（足りなければLinkexが容量不足と返す）
  }
  return STORAGE_CAP_BYTES;
}

/**
 * 1件の担当。保存せずに取るときは、URL発行・JD2へ渡すところまで。
 * 保存してから取るときは、保存 → コピー探し → URL発行・JD2へ → 完全削除 まで進める。
 * どちらも、その後の完了の見届けは refreshDownloads が受け持つ。
 * 一時停止されたら区切りのよいところで止まる。失敗して待ちに戻ったら、割り当て直しを待つ
 */
async function runWorker(id: string): Promise<void> {
  for (let first = true; ; first = false) {
    if ((await readEngine()).paused) return;
    const item = (await readQueue()).find((i) => i.id === id);
    if (!item) return;
    const waitingState = item.state === 'pending' || item.state === 'retry';
    if (!IN_STORAGE_STATES.includes(item.state) && !(first && waitingState)) return;
    await processItem(item);
  }
}

/**
 * 転送量の上限に達しているか。1件ごとには調べず、調べた残りから始めた件のサイズを引いて見込み、
 * 見込みが尽きたときか、前に調べてから TRAFFIC_CACHE_MS たったときだけ調べ直す
 */
async function trafficExhausted(startBytes: number): Promise<boolean> {
  if (runtime.trafficLeft && Date.now() - runtime.trafficLeft.at < TRAFFIC_CACHE_MS && runtime.trafficLeft.bytes > startBytes) {
    runtime.trafficLeft.bytes -= startBytes;
    return false;
  }
  try {
    const t = await api.traffic();
    void noteTraffic(t);
    // 上限なし扱いのアカウント（usedTraffic が負）や、上限が分からないときは尽きない扱い
    const limited = t.usedTraffic >= 0 && t.totalTraffic > 0;
    const left = limited ? t.totalTraffic - t.usedTraffic : Infinity;
    runtime.trafficLeft = { bytes: left - startBytes, at: Date.now() };
    return limited && left <= 0;
  } catch {
    runtime.trafficLeft = null;
    return false;
  }
}

/** 1件を1段階進める。失敗したら再試行待ちかエラーにする */
async function processItem(item: QueueItem): Promise<void> {
  try {
    // 前回 JD2 に渡している最中に止まった件は、渡し直す前に JD2 に入っていないか確かめる
    if (await resolveHanding(item)) return;
    switch (item.state) {
      case 'pending':
      case 'retry':
        if (!(await loadSettings()).directDownload || !(await stepDirect(item))) await stepCopy(item);
        break;
      case 'copying':
        await stepFindCopy(item);
        break;
      case 'copied':
        // 転送量が尽きてアカウントを切り替える前は、コピーを消して待機中に戻す（新しいアカウントで取り直す）
        if (runtime.switching?.reason === 'traffic') {
          await updateItem(item.id, { state: 'deleting', requeueAfterDelete: true, note: SWITCH_CLEANUP_NOTE });
          return;
        }
        // 転送量の上限待ちのあいだは URL を発行しない（断られるだけなので、コピーは置いたまま待つ）
        if (Date.now() < runtime.trafficWaitUntil) {
          if (item.note !== TRAFFIC_ITEM_NOTE) await updateItem(item.id, { note: TRAFFIC_ITEM_NOTE });
          await sleep(IDLE_WAIT_MS);
          return;
        }
        await stepSend(item);
        break;
      case 'deleting':
        await stepDelete(item);
        break;
    }
  } catch (e) {
    if (e instanceof LinkexError && e.code === DISK_SPACE_FULL) {
      // 容量の確認は毎回はせず、足りないと言われたときだけ行う。
      // 容量の上限そのものより大きいファイルは、待っても保存できないので失敗にする
      if (await largerThanStorage(item)) {
        await updateItem(item.id, {
          state: 'error',
          error: `ファイルが容量の上限より大きいため保存できません（${formatBytes(item.size)}）`,
        });
        await logEvent('error', `容量の上限より大きいため保存できません: ${item.name}`);
        return;
      }
      // しばらく新しい件を始めず、空き容量を調べ直してから続ける
      await updateItem(item.id, { state: 'pending', note: '容量の空き待ち' });
      await logEvent('warn', `容量が足りないため待機: ${item.name}`);
      runtime.capacityWaitUntil = Date.now() + CAPACITY_WAIT_MS;
      runtime.budget = null;
      runtime.cleanedAt = 0;
      return;
    }
    if (e instanceof Jd2ConnectionError) {
      // しばらくは件をそのままにして待つ（長く続いたら全体を止めて知らせる）
      if (await noteJdDown(e)) return;
      await updateItem(item.id, { note: 'JD2の応答待ち' });
      await sleep(JD_RETRY_MS);
      return;
    }
    if (e instanceof LinkexTransientError) {
      // ネットが切れた・Linkexが一時的に不調なときは、件ごとの失敗に数えずに待つ。
      // 長く続いたら全体を止めて知らせる
      if (!runtime.linkexDownSince || linkexOkAt() > runtime.linkexDownSince) {
        runtime.linkexDownSince = Date.now();
        await logEvent('warn', `${errorText(e)}（しばらく待って続けます）`);
      }
      if (Date.now() - runtime.linkexDownSince >= LINKEX_DOWN_LIMIT_MS) {
        runtime.linkexDownSince = 0;
        await stopWithNotice(`Linkexが${LINKEX_DOWN_LIMIT_MS / 60_000}分以上応答しません。ネットの接続を確かめてから「開始」を押してください`);
        return;
      }
      await updateItem(item.id, { note: 'Linkexの応答待ち' });
      await sleep(LINKEX_RETRY_MS);
      return;
    }
    if (e instanceof LinkexTrafficLimitError) {
      // 別のアカウントに切り替えられるなら、切り替えの準備に入る（この件は次の周回で片付けるか、新しいアカウントで取る）
      if (await onTrafficExhausted()) {
        await updateItem(item.id, { note: 'アカウントの切り替え待ち' });
        return;
      }
      // 件ごとの失敗には数えず、新しい件を始めずに待つ（保存済みのコピーは消さずに置いておく）。
      // 待っている間に、ほかの件が同じ理由で断られてもログは1回だけ
      if (Date.now() >= runtime.trafficWaitUntil) {
        await logEvent('warn', `転送量の上限に達したため、LinkexがURLを出しません。転送量が戻るまで待機します（5分ごとに確認）: ${item.name}`);
      }
      runtime.trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
      runtime.trafficLeft = null;
      await updateItem(item.id, { note: TRAFFIC_ITEM_NOTE });
      return;
    }
    if (e instanceof LinkexLoginError || /AUTH_FAILED/.test(errorText(e))) {
      // ログイン切れやJD2側の問題は件ごとの失敗に数えず、全体を止めて知らせる
      await stopWithNotice(errorText(e));
      return;
    }
    if (runtime.switching?.reason === 'traffic' && item.state === 'copying') {
      // 切り替える前にコピーが見つからなかった。新しいアカウントで取り直す（前のアカウントにコピーが残ることがある）
      await updateItem(item.id, { state: 'pending', beforeIds: undefined, copyStartedAt: undefined, copiedAt: undefined, note: undefined });
      await logEvent(
        'warn',
        `アカウントを切り替える前に、保存したコピーが見つかりませんでした（前のアカウントに残る場合があります）: ${item.name} — ${errorText(e)}`,
      );
      return;
    }
    await fail(item, errorText(e));
  }
}

/** ファイルが容量の上限そのものより大きいか（確認できなければ false） */
async function largerThanStorage(item: QueueItem): Promise<boolean> {
  if (item.size === null) return false;
  try {
    const usage = await api.usage();
    return usage.totalSpace > 0 && item.size > usage.totalSpace;
  } catch {
    return false;
  }
}

async function fail(item: QueueItem, message: string): Promise<void> {
  // JD2 に渡し終えた件のコピー削除の失敗は、ダウンロードの再試行回数とは別に数える
  // （同じ回数で数えると、JD2 でのダウンロード中に「エラー」にして見届けなくなる）
  if (item.state === 'deleting' && item.jdId) {
    await failDelete(item, message);
    return;
  }
  const attempts = item.attempts + 1;
  // まだ自分のストレージにコピーが残っている場合は、消してからやり直す
  const keepForDelete =
    Boolean(item.destFileId) &&
    (item.state === 'copied' || item.state === 'deleting') &&
    attempts < MAX_ATTEMPTS + 2;
  await updateItem(item.id, {
    attempts,
    error: message,
    state: keepForDelete ? 'deleting' : attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
    note: keepForDelete ? '失敗したコピーを削除します' : undefined,
  });
  const final = !keepForDelete && attempts >= MAX_ATTEMPTS;
  await logEvent(final ? 'error' : 'warn', `${final ? 'エラー' : '失敗（再試行します）'}: ${item.name} — ${message}`);
  if (!keepForDelete) await sleep(2_000);
}

/** JD2 に渡した後のコピー削除を、何回まで試すか */
const MAX_DELETE_ATTEMPTS = 5;

/**
 * JD2 に渡した後のコピー削除が失敗した。何回か試してもだめなら、コピーは残したまま JD2 での見届けに進める
 * （ダウンロードURLは削除しなくても使えるので、ダウンロードには差し支えない）
 */
async function failDelete(item: QueueItem, message: string): Promise<void> {
  const deleteAttempts = (item.deleteAttempts ?? 0) + 1;
  if (deleteAttempts < MAX_DELETE_ATTEMPTS) {
    await updateItem(item.id, { deleteAttempts, note: `コピーの削除をやり直します（${message}）` });
    await logEvent('warn', `コピーの削除に失敗（やり直します）: ${item.name} — ${message}`);
    await sleep(2_000);
    return;
  }
  // 自分のコピーとしての印を外し、「残ったファイルを片付ける」がオンなら後でまとめて消せるようにする
  await updateItem(item.id, {
    state: 'downloading',
    destFileId: undefined,
    beforeIds: undefined,
    deleteAttempts: undefined,
    note: 'コピーを削除できませんでした（自分のストレージに残っています）',
  });
  await logEvent(
    'warn',
    `コピーを${MAX_DELETE_ATTEMPTS}回削除できなかったため、残したままダウンロードを見届けます: ${item.name} — ${message}`,
  );
}

/** 上限待ちの表示。全部のアカウントが尽きているときは、次に再開を試す時刻とアカウントを添える */
function trafficWaitMessage(): string {
  const hint = runtime.resumeHint;
  if (!hint || hint.at <= Date.now()) return TRAFFIC_WAIT_MESSAGE;
  const d = new Date(hint.at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${TRAFFIC_WAIT_MESSAGE}（${time}ごろに ${hint.name} で再開）`;
}

/**
 * 今のアカウントの転送量が尽きた。尽きたことを記録し、別のアカウントに切り替えられるなら切り替えの準備に入る。
 * 準備に入った（または入っている）なら true、切り替えられないなら false（今までどおり待つ）
 */
async function onTrafficExhausted(): Promise<boolean> {
  const now = Date.now();
  const s = await readAccounts();
  await noteExhausted(s, now);
  if (runtime.switching?.reason === 'traffic') return true;
  const settings = await loadSettings();
  if (!settings.switchAccounts || !s) return false;
  const to = pickNextAccount(s, await loadRecords(), settings.accountsDisabled, now);
  if (!to) return false;
  runtime.switching = { reason: 'traffic', since: now, to };
  await logEvent(
    'warn',
    `${accountName(s, s.currentUid)} の転送量が尽きたため、Linkex側で処理中の件を片付けてから ${accountName(s, to)} に切り替えます`,
  );
  return true;
}

/**
 * 切り替えの準備を進める。Linkex 側で処理中の件が片付いたら（転送量のためなら、待ちの上限を過ぎても）切り替える。
 * 切り替えを試したら true
 */
async function advanceSwitch(prepCount: number): Promise<boolean> {
  const sw = runtime.switching;
  if (!sw) return false;
  const busy = workers.size > 0 || prepCount > 0;
  if (busy && Date.now() - sw.since < SWITCH_PREP_LIMIT_MS) return false;
  if (busy && sw.reason === 'keepAlive') {
    // 期限を延ばすための切り替えは急がない。24時間後にまた試す
    runtime.switching = null;
    await updateRecord(sw.to, { keepAliveAt: Date.now() });
    await logEvent(
      'warn',
      `期限を延ばすための切り替えは、Linkex側で処理中の件が${SWITCH_PREP_LIMIT_MS / 60_000}分以内に片付かなかったため見送りました`,
    );
    return false;
  }
  await finishSwitch(sw);
  return true;
}

/** アカウントを切り替え、転送量や容量の見込みを捨てて続ける */
async function finishSwitch(sw: NonNullable<typeof runtime.switching>): Promise<void> {
  const now = Date.now();
  // 片付けが間に合わなかった件は、前のアカウントのコピーの印を外す（新しいアカウントでは使えないため）
  const leftovers = (await readQueue()).filter((i) => IN_STORAGE_STATES.includes(i.state));
  for (const i of leftovers) {
    await updateItem(
      i.id,
      i.jdId
        ? {
            state: 'downloading',
            destFileId: undefined,
            beforeIds: undefined,
            deleteAttempts: undefined,
            requeueAfterDelete: undefined,
            note: 'コピーを削除できませんでした（前のアカウントのストレージに残っています）',
          }
        : {
            state: 'pending',
            destFileId: undefined,
            beforeIds: undefined,
            copyStartedAt: undefined,
            copiedAt: undefined,
            duplicate: undefined,
            requeueAfterDelete: undefined,
            note: undefined,
          },
    );
  }
  if (leftovers.length > 0) {
    await logEvent(
      'warn',
      `切り替えの前に片付けが終わらなかった ${leftovers.length}件は、前のアカウントにコピーが残っている場合があります（新しいアカウントで取り直します）`,
    );
  }

  const before = await readAccounts();
  const stamp = before?.accounts.find((a) => a.uid === sw.to)?.stampAt ?? 0;
  const res = await switchAccount(sw.to);
  runtime.switching = null;
  if (!res.ok) {
    await logEvent('warn', `Linkexのアカウントを ${accountName(before, sw.to)} に切り替えられませんでした: ${res.error}`);
    if (sw.reason === 'keepAlive') {
      await updateRecord(sw.to, { keepAliveAt: now });
    } else {
      // しばらくはこのアカウントを選ばない。転送量の上限待ちに戻り、次の確認でほかのアカウントを選ぶ
      await updateRecord(sw.to, { checkAgainAt: now + RECHECK_MS });
      runtime.trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
    }
    return;
  }
  const after = await readAccounts();
  runtime.trafficWaitUntil = 0;
  runtime.trafficLeft = null;
  runtime.budget = null;
  runtime.cleanedAt = 0;
  runtime.resumeHint = null;
  const why = sw.reason === 'traffic' ? '転送量が尽きたため' : '期限を延ばすため';
  await logEvent('info', `${why}、Linkexのアカウントを ${accountName(before, res.fromUid)} から ${accountName(after, sw.to)} に切り替えました`);
  if (sw.reason === 'keepAlive') await updateRecord(sw.to, { keepAliveAt: now, keepAliveStamp: stamp });
}

let resumeCheckedAt = 0;
/**
 * 全部のアカウントが尽きて待っているとき、いちばん早く戻りそうなアカウントを表示用に覚え、
 * その時刻を過ぎていれば切り替えの準備に入る（今のアカウントなら、今までどおり5分ごとの確認に任せる）
 */
async function maybeResume(): Promise<void> {
  const now = Date.now();
  if (now - resumeCheckedAt < RESUME_CHECK_MS) return;
  resumeCheckedAt = now;
  const settings = await loadSettings();
  if (!settings.switchAccounts) {
    runtime.resumeHint = null;
    return;
  }
  const s = await readAccounts();
  if (!s) return;
  const next = nextResume(s, await loadRecords(), settings.accountsDisabled, now);
  runtime.resumeHint = next ? { name: accountName(s, next.uid), at: next.at } : null;
  if (next && next.at <= now && next.uid !== s.currentUid) {
    runtime.switching = { reason: 'traffic', since: now, to: next.uid };
    await logEvent('info', `${accountName(s, next.uid)} の転送量が戻っている見込みなので、切り替えて確かめます`);
  }
}
