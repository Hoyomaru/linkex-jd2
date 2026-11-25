/**
 * 全体の指示役。キューから次の件を選んで担当を付け、失敗の数え方と全体の一時停止を決める。
 * 1件ごとの段階の処理は engine-steps.ts、JD2 での完了の見届けは jd-monitor.ts、
 * 両方で分け合う実行中の状態は engine-runtime.ts にある。
 */
import { formatBytes, isFolder, unwrapFile } from '../shared/files';
import { Jd2ConnectionError } from '../shared/jd2-request';
import type { EngineState, QueueItem } from '../shared/queue';
import { PREP_STATES, pickLeftovers, pickStarts } from '../shared/scheduler';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError, linkexOkAt, LinkexTransientError } from './api';
import { errorText, IDLE_WAIT_MS, MAX_ATTEMPTS, noteJdDown, resetRuntime, runtime, sleep, stopWithNotice } from './engine-runtime';
import { stepCopy, stepDelete, stepDirect, stepFindCopy, stepSend } from './engine-steps';
import { refreshDownloads } from './jd-monitor';
import { pingJd } from './jd2';
import { LinkexLoginError, takeFrozenReloads } from './linkex-tab';
import { notify } from './notify';
import { logEvent, readEngine, readQueue, updateItem, writeEngine } from './store';

/** JD2 の完了を取り込む間隔（JD2 の一覧は全件で返ってくるので、毎周は取らない） */
const DOWNLOADS_REFRESH_MS = 3_000;
const TRAFFIC_RECHECK_MS = 5 * 60_000;
/** 転送量を調べ直すまでの間（その間は、調べた残りから始めた件のサイズを引いて見込む） */
const TRAFFIC_CACHE_MS = 60_000;
const TRAFFIC_WAIT_MESSAGE = '転送量の上限に達したため待機中（設定で変更できます）';
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
    const prep = items.filter((i) => PREP_STATES.includes(i.state));
    const waiting = items.filter((i) => i.state === 'pending' || i.state === 'retry');

    if (workers.size === 0 && prep.length === 0 && waiting.length === 0 && downloading === 0) {
      await finish(items);
      return;
    }

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
    let picks = pickStarts(items, { ...ctx, allowNew: Date.now() >= runtime.capacityWaitUntil && Date.now() >= runtime.trafficWaitUntil });
    const newPicks = waiting.filter((w) => picks.includes(w.id));
    const newBytes = newPicks.reduce((sum, w) => sum + (w.size ?? 0), 0);
    if (newPicks.length > 0 && settings.pauseOnTrafficLimit && (await trafficExhausted(newBytes))) {
      // 待機中に Service Worker が止められると1分ごとの見回りでここに戻ってくるので、
      // ログは待機に入った最初の1回だけ書く
      if (engine.message !== TRAFFIC_WAIT_MESSAGE) {
        await logEvent('warn', '転送量の上限に達したため待機します（5分ごとに確認）');
      }
      runtime.trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
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
  if (Date.now() < runtime.trafficWaitUntil && workers.size === 0) return { status: 'waiting', message: TRAFFIC_WAIT_MESSAGE };
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
    const root = (await collectPages((page) => api.rootFiles(page))).map(unwrapFile);
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
    if (!PREP_STATES.includes(item.state) && !(first && waitingState)) return;
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
    switch (item.state) {
      case 'pending':
      case 'retry':
        if (!(await loadSettings()).directDownload || !(await stepDirect(item))) await stepCopy(item);
        break;
      case 'copying':
        await stepFindCopy(item);
        break;
      case 'copied':
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
    if (e instanceof LinkexLoginError || /AUTH_FAILED/.test(errorText(e))) {
      // ログイン切れやJD2側の問題は件ごとの失敗に数えず、全体を止めて知らせる
      await stopWithNotice(errorText(e));
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
