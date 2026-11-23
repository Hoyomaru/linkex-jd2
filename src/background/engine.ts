import { contentHash, formatBytes, isFolder, unwrapFile } from '../shared/files';
import type { QueueItem } from '../shared/queue';
import { findOwnCopy, handedToJd, PREP_STATES, pickLeftovers, pickStarts } from '../shared/scheduler';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError, linkexOkAt, LinkexTransientError } from './api';
import { LinkexLoginError, takeFrozenReloads } from './linkex-tab';
import { jdLinkState } from '../shared/jd2-status';
import { Jd2ConnectionError } from '../shared/jd2-request';
import { addDownload, discardLinks, queryLinks } from './jd2';
import { notify } from './notify';
import { logEvent, readEngine, readHashes, readQueue, rememberHash, updateItem, updateItems, writeEngine } from './store';

const MAX_ATTEMPTS = 3;
const COPY_TIMEOUT_MS = 5 * 60_000;
/** 保存が終わってから、コピーが一覧に出てくるのを待つ時間 */
const COPY_FIND_MS = 60_000;
/** ダウンロードの空き待ち。JD2への確認はPCの中で済み軽いので、短めに見る */
const IDLE_WAIT_MS = 1_000;
const TRAFFIC_RECHECK_MS = 5 * 60_000;
/** 転送量を調べ直すまでの間（その間は、調べた残りから始めた件のサイズを引いて見込む） */
const TRAFFIC_CACHE_MS = 60_000;
/** 保存前の一覧として、ほかの件が少し前に取り始めた一覧を使ってよい時間 */
const BEFORE_LIST_REUSE_MS = 2_000;
/** 残ったコピーの片付けの間隔（容量が足りないと言われたら、次に手が空いたときすぐ片付ける） */
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** 先読みで保存した件に付けるメモ */
const PREFETCHED_NOTE = '保存済み（JD2の空き待ち）';
const CAPACITY_WAIT_MS = 30_000;
/** JD2 にこの時間つながらないままなら、全体を止めて知らせる */
const JD_DOWN_LIMIT_MS = 3 * 60_000;
/** JD2 につながらなかった件を、もう一度渡してみるまでの間 */
const JD_RETRY_MS = 5_000;
/** Linkex がこの時間応えないままなら（ネットが切れているなど）、全体を止めて知らせる */
const LINKEX_DOWN_LIMIT_MS = 10 * 60_000;
/** Linkex が一時的に応えなかった件を、もう一度進めてみるまでの間 */
const LINKEX_RETRY_MS = 10_000;
/** ダウンロード中の件がどれもこの時間進まなければ、知らせる（JD2が確認を待っている・止められているなど） */
const STALL_NOTICE_MS = 15 * 60_000;
const TRAFFIC_WAIT_MESSAGE = '転送量の上限に達したため待機中（設定で変更できます）';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown) => String((e as Error)?.message ?? e);

/** 保存中のコピーの合計の上限（Linkexの容量の空きがこれより少なければ、空きのほうに合わせる） */
const STORAGE_CAP_BYTES = 5 * 1024 ** 3;
/** 空き容量を調べ直す間隔 */
const BUDGET_REFRESH_MS = 5 * 60_000;

let loopRunning = false;
/** 保存〜削除を進めている件（ID → 担当が終わるまでの Promise） */
const workers = new Map<string, Promise<void>>();
/** この時刻までは新しい件を始めない（容量不足と言われた後・転送量の上限） */
let capacityWaitUntil = 0;
let trafficWaitUntil = 0;
/** JD2 の完了を取り込んだ時刻 */
let downloadsRefreshedAt = 0;
/** JD2 の完了を取り込む間隔 */
const DOWNLOADS_REFRESH_MS = 3_000;
/** JD2 につながらなくなった時刻（つながっていれば 0） */
let jdDownSince = 0;
/** Linkex が応えなくなった時刻（応えていれば 0） */
let linkexDownSince = 0;
/** 保存中のコピーに使ってよい容量（バイト） */
let budget: { bytes: number; at: number } | null = null;
/** 転送量の残りの見込み（バイト）。調べた時刻から TRAFFIC_CACHE_MS の間だけ使う */
let trafficLeft: { bytes: number; at: number } | null = null;
/** 残ったコピーを最後に片付けた時刻（0 なら次に手が空いたらすぐ片付ける） */
let cleanedAt = 0;
/** いまJD2に渡している最中の件の数（先読みした件を渡しすぎないように数える） */
let sendingNow = 0;

/** キューを処理するループを起動する（すでに動いていれば何もしない） */
export function kick(): void {
  if (loopRunning) return;
  loopRunning = true;
  let failed = false;
  runLoop()
    .catch(async (e) => {
      failed = true;
      await writeEngine({ message: `処理が止まりました: ${errorText(e)}` });
    })
    .finally(async () => {
      loopRunning = false;
      // ループが終わる直前に「開始」が押されていたら、ここで動かし直す
      // （失敗で止まったときは、すぐに繰り返さず1分ごとの見回りに任せる）
      if (!failed && !(await readEngine()).paused) kick();
    });
}

export async function start(): Promise<void> {
  await writeEngine({ paused: false, message: '開始しました' });
  takeFrozenReloads(); // 前回までの分は数えない
  capacityWaitUntil = 0;
  jdDownSince = 0;
  linkexDownSince = 0;
  trafficWaitUntil = 0;
  budget = null;
  trafficLeft = null;
  stall = null;
  cleanedAt = 0;
  await logEvent('info', '処理を開始しました');
  kick();
}

export async function pause(): Promise<void> {
  // 処理中の件は、それぞれ区切りのよいところまで進めてから止まる
  await writeEngine({ paused: true, message: '一時停止中' });
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
    // JD2 の一覧は全件で返ってくるので、毎周（1秒ごと）ではなく間をあけて取り込む
    if (Date.now() - downloadsRefreshedAt >= DOWNLOADS_REFRESH_MS) {
      downloadsRefreshedAt = Date.now();
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
    if (settings.cleanupLeftovers && workers.size === 0 && prep.length === 0 && Date.now() - cleanedAt >= CLEANUP_INTERVAL_MS) {
      cleanedAt = Date.now();
      if (await cleanupLeftovers(items)) budget = null;
    }

    // 保存中のコピーに使ってよい容量。コピーを置いていないときに調べ直す（置いている間は二重に数えてしまうため）
    if (!budget || (prep.length === 0 && Date.now() - budget.at > BUDGET_REFRESH_MS)) {
      budget = { bytes: await storageBudget(), at: Date.now() };
    }

    const ctx = {
      running: new Set(workers.keys()),
      parallel: Math.max(1, settings.parallelItems),
      budgetBytes: budget.bytes,
      maxDownloads: settings.maxDownloads,
      // 保存せずに取るときは、先に保存しておくものがない
      prefetch: settings.directDownload ? 0 : Math.max(0, settings.prefetchItems),
    };
    let picks = pickStarts(items, { ...ctx, allowNew: Date.now() >= capacityWaitUntil && Date.now() >= trafficWaitUntil });
    const newPicks = waiting.filter((w) => picks.includes(w.id));
    const newBytes = newPicks.reduce((sum, w) => sum + (w.size ?? 0), 0);
    if (newPicks.length > 0 && settings.pauseOnTrafficLimit && (await trafficExhausted(newBytes))) {
      // 待機中に Service Worker が止められると1分ごとの見回りでここに戻ってくるので、
      // ログは待機に入った最初の1回だけ書く
      if (engine.message !== TRAFFIC_WAIT_MESSAGE) {
        await logEvent('warn', '転送量の上限に達したため待機します（5分ごとに確認）');
      }
      trafficWaitUntil = Date.now() + TRAFFIC_RECHECK_MS;
      picks = pickStarts(items, { ...ctx, allowNew: false });
    }
    for (const id of picks) {
      // 担当が思わぬ理由で失敗しても、全体の指示役は止めない（その件は次の周回で割り当て直す）
      const worker = runWorker(id)
        .catch((e) => logEvent('warn', `処理中に問題が起きたため、やり直します: ${errorText(e)}`))
        .finally(() => workers.delete(id));
      workers.set(id, worker);
    }

    await writeEngine({ message: statusMessage(items, downloading, waiting.length, settings.maxDownloads) });
    // 担当が1つ終わったら、すぐ次の件を割り当てる
    await Promise.race([sleep(IDLE_WAIT_MS), ...workers.values()]);
  }
}

/** 画面上部に出す今の状況 */
function statusMessage(items: QueueItem[], downloading: number, waiting: number, maxDownloads: number): string {
  if (Date.now() < trafficWaitUntil && workers.size === 0) return TRAFFIC_WAIT_MESSAGE;
  const parts: string[] = [];
  if (workers.size > 0) {
    const first = items.find((i) => workers.has(i.id));
    parts.push(`処理中 ${workers.size}件（${first?.name ?? ''}${workers.size > 1 ? ' ほか' : ''}）`);
  }
  if (downloading > 0) {
    parts.push(`ダウンロード中 ${downloading}件${waiting > 0 && downloading >= maxDownloads ? '（空き待ち）' : ''}`);
  }
  if (Date.now() < capacityWaitUntil) parts.push('容量の空き待ち');
  return parts.join('・') || '待機中';
}

async function finish(items: QueueItem[]): Promise<void> {
  await writeEngine({ paused: true, message: 'すべて終わりました' });
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
    if (usage.totalSpace > 0) return Math.min(STORAGE_CAP_BYTES, Math.max(0, usage.totalSpace - usage.usedSpace));
  } catch {
    // 調べられなければ上限だけで進める（足りなければLinkexが容量不足と返す）
  }
  return STORAGE_CAP_BYTES;
}

/**
 * 1件の担当。保存 → コピー探し → URL発行・JD2へ → 完全削除 まで進める。
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
  if (trafficLeft && Date.now() - trafficLeft.at < TRAFFIC_CACHE_MS && trafficLeft.bytes > startBytes) {
    trafficLeft.bytes -= startBytes;
    return false;
  }
  try {
    const t = await api.traffic();
    // 上限なし扱いのアカウント（usedTraffic が負）や、上限が分からないときは尽きない扱い
    const limited = t.usedTraffic >= 0 && t.totalTraffic > 0;
    const left = limited ? t.totalTraffic - t.usedTraffic : Infinity;
    trafficLeft = { bytes: left - startBytes, at: Date.now() };
    return limited && left <= 0;
  } catch {
    trafficLeft = null;
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
      capacityWaitUntil = Date.now() + CAPACITY_WAIT_MS;
      budget = null;
      cleanedAt = 0;
      return;
    }
    if (e instanceof Jd2ConnectionError) {
      // JD2 はときどき続けて接続を切るので、しばらくは件をそのままにして待つ。
      // 長く続いたら（JD2が落ちている・設定が違う）全体を止めて知らせる
      jdDownSince ||= Date.now();
      if (Date.now() - jdDownSince >= JD_DOWN_LIMIT_MS) {
        jdDownSince = 0;
        await stopWithNotice(errorText(e));
        return;
      }
      await updateItem(item.id, { note: 'JD2の応答待ち' });
      await sleep(JD_RETRY_MS);
      return;
    }
    if (e instanceof LinkexTransientError) {
      // ネットが切れた・Linkexが一時的に不調なときは、件ごとの失敗に数えずに待つ。
      // 長く続いたら全体を止めて知らせる
      if (!linkexDownSince || linkexOkAt() > linkexDownSince) {
        linkexDownSince = Date.now();
        await logEvent('warn', `${errorText(e)}（しばらく待って続けます）`);
      }
      if (Date.now() - linkexDownSince >= LINKEX_DOWN_LIMIT_MS) {
        linkexDownSince = 0;
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

/** 全体を一時停止して、処理ログと通知で知らせる */
async function stopWithNotice(reason: string): Promise<void> {
  await writeEngine({ paused: true, message: `一時停止: ${reason}` });
  await logEvent('error', `一時停止: ${reason}`);
  await notify('stopped', '一時停止しました', reason);
}

async function fail(item: QueueItem, message: string): Promise<void> {
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

/**
 * 1件ごとに、どの段階に何秒かかったかを数え、JD2に渡し終えたら処理ログに残す（遅いところを探すため）。
 * Service Worker が止められたら数えた分は消えるが、記録用なので構わない
 */
const laps = new Map<string, Map<string, number>>();
function lap(id: string, label: string, since: number): number {
  const now = Date.now();
  const m = laps.get(id) ?? new Map<string, number>();
  m.set(label, (m.get(label) ?? 0) + (now - since));
  laps.set(id, m);
  return now;
}
async function logLaps(item: QueueItem): Promise<void> {
  const m = laps.get(item.id);
  laps.delete(item.id);
  if (!m) return;
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const parts = [...m].map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)}`).join('・');
  await logEvent('info', `内訳（秒）: 計 ${(total / 1000).toFixed(1)}・${parts} — ${item.name}`);
}

interface RootListing {
  /** 取り始めた時刻 */
  since: number;
  files: Promise<Map<string, any>>;
}
let rootListing: RootListing | null = null;

/**
 * 自分のファイル（ルート）の一覧。notBefore 以降に取り始めた一覧を返す。
 * 同時に進めているほかの件が条件に合う一覧を取っている最中・取り終えたところなら、それを分け合う
 * （件ごとに全ページを取り直すと、同時に処理する数だけ同じ一覧を取ることになるため）
 */
function listRoot(notBefore: number): RootListing {
  if (rootListing && rootListing.since >= notBefore) return rootListing;
  const listing: RootListing = {
    since: Date.now(),
    files: (async () => {
      const list = await collectPages((page) => api.rootFiles(page));
      const map = new Map<string, any>();
      for (const item of list) {
        const f = unwrapFile(item);
        if (f?.id) map.set(String(f.id), f);
      }
      return map;
    })(),
  };
  rootListing = listing;
  // 失敗した一覧はほかの件に使わせない
  listing.files.catch(() => {
    if (rootListing === listing) rootListing = null;
  });
  return listing;
}

/** 件ごとに、コピー探しで最後に見た一覧を取り始めた時刻（同じ一覧を何度も見ないため） */
const findListedAt = new Map<string, number>();

/**
 * 自分のストレージに保存せず、共有から直接ダウンロードURLを発行してJD2へ渡す。
 * 直接は取れないと分かったら false を返す（呼び出し元が保存してから取る）
 */
async function stepDirect(item: QueueItem): Promise<boolean> {
  if (!item.force && item.hash && (await readHashes())[item.hash]) {
    await updateItem(item.id, { state: 'skipped', note: '同じ中身をダウンロード済み' });
    await logEvent('info', `重複のため省略: ${item.name}`);
    return true;
  }
  // URLには期限があるので、JD2に渡しておく数に空きがあるときだけ発行する（空きがなければ、次の割り当てを待つ）
  const { maxDownloads } = await loadSettings();
  if (handedToJd(await readQueue(), sendingNow) >= Math.max(1, maxDownloads)) {
    await sleep(IDLE_WAIT_MS);
    return true;
  }
  sendingNow++;
  try {
    let t = Date.now();
    let data: any;
    try {
      data = await api.shareFileGet(item.shareToken, item.sourceFileId);
    } catch (e) {
      // 共有の設定などで直接は取れない（中身付きのエラー）。保存してから取る
      if (e instanceof LinkexError) {
        await logEvent('warn', `保存せずには取れなかったため、保存してから取ります: ${item.name} — ${errorText(e)}`);
        return false;
      }
      throw e;
    }
    t = lap(item.id, 'URL取得(直接)', t);
    const file = data?.file ?? data;
    const url = String(file?.url ?? '');
    const hash = contentHash(file) ?? item.hash;
    const fileSize = Number(file?.size);
    if (!item.force && hash && (await readHashes())[hash]) {
      await updateItem(item.id, { state: 'skipped', hash, note: '同じ中身をダウンロード済み' });
      await logEvent('info', `重複のため省略: ${item.name}`);
      return true;
    }
    if (!url) {
      await logEvent('warn', `保存せずにはURLが出なかったため、保存してから取ります: ${item.name}`);
      return false;
    }
    const jdId = await addDownload(url, { dir: item.relDir, out: item.outName });
    lap(item.id, 'JD2へ', t);
    jdDownSince = 0;
    await updateItem(item.id, {
      state: 'downloading',
      hash,
      jdId,
      fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : undefined,
      note: undefined,
      error: undefined,
    });
    await logEvent('info', `JD2へ渡しました（保存なし）: ${item.relDir}\\${item.outName}`);
    await logLaps(item);
    return true;
  } finally {
    sendingNow--;
  }
}

async function stepCopy(item: QueueItem): Promise<void> {
  if (!item.force && item.hash && (await readHashes())[item.hash]) {
    await updateItem(item.id, { state: 'skipped', note: '同じ中身をダウンロード済み' });
    await logEvent('info', `重複のため省略: ${item.name}`);
    return;
  }
  let t = Date.now();
  // 保存（file/copy）を頼む前に取り終えた一覧なら、保存前の一覧として使える。
  // 取り始めがほんの少し前の、ほかの件の一覧も使う（同じ名前の件は同時に保存しないので取り違えない）
  const before = await listRoot(Date.now() - BEFORE_LIST_REUSE_MS).files;
  t = lap(item.id, `保存前の一覧(${before.size}件)`, t);
  await updateItem(item.id, {
    state: 'copying',
    beforeIds: [...before.keys()],
    copyStartedAt: Date.now(),
    copiedAt: undefined,
    destFileId: undefined,
    jdId: undefined,
    fileSize: undefined,
    note: undefined,
    error: undefined,
  });

  const res = await api.copyFromShare(item.shareToken, item.sourceFileId);
  const taskId = res?.taskId ?? res?.task?.id;
  // 応答の時点で保存が終わっていれば、完了待ちを省く
  const doneAlready = String(res?.task?.status ?? res?.status ?? '').toLowerCase() === 'success';
  if (taskId && !doneAlready) await waitTask(String(taskId));
  lap(item.id, '保存', t);
  await updateItem(item.id, { copiedAt: Date.now() });

  const fresh = (await readQueue()).find((i) => i.id === item.id);
  if (fresh) await stepFindCopy(fresh);
}

async function waitTask(taskId: string): Promise<void> {
  const started = Date.now();
  // 小さいファイルはすぐ終わることが多いので、最初は短く待ち、だんだん間隔を広げる
  let delay = 400;
  while (Date.now() - started < COPY_TIMEOUT_MS) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
    const data = await api.task(taskId);
    const task = data?.task ?? data;
    const status = String(task?.status ?? '').toLowerCase();
    if (status === 'success') return;
    if (status === 'insufficient_storage') {
      throw new LinkexError('容量が足りません', DISK_SPACE_FULL, task);
    }
    if (/fail|error|cancel/.test(status)) throw new Error(`保存に失敗しました（${status}）`);
  }
  throw new Error('保存が5分以内に終わりませんでした');
}

/**
 * 保存前になかったファイルのうち、名前が同じものを「自分が作ったコピー」とみなす。
 * 共有一覧のサイズは実際とずれることがあるので、サイズが合うものを優先し、
 * 合うものがなくても同じ名前の新しいファイルが1つだけならそれを使う。
 */
async function stepFindCopy(item: QueueItem): Promise<void> {
  const t = Date.now();
  const before = new Set(item.beforeIds ?? []);
  // 保存が終わった後に取り始めた一覧だけを見る（前の周回で見た一覧より新しいもの）
  const notBefore = Math.max(item.copiedAt ?? item.copyStartedAt ?? 0, (findListedAt.get(item.id) ?? -1) + 1);
  const listing = listRoot(notBefore);
  findListedAt.set(item.id, listing.since);
  const now = await listing.files;
  lap(item.id, 'コピー探し', t);
  const fresh = [...now.entries()].filter(([id]) => !before.has(id)).map(([, f]) => f);
  const sizeOf = (f: any) => Number(f.size);
  // 同時に進めているほかの件のコピーとして決まったファイルは選ばない
  const found = findOwnCopy(fresh, item, await claimedByOthers(item.id));

  if (!found) {
    // 保存が終わってから少し待っても出てこなければ、保存し直す（再試行するとすぐ見つかることが多い）
    const since = item.copiedAt ?? item.copyStartedAt ?? 0;
    const limit = item.copiedAt ? COPY_FIND_MS : COPY_TIMEOUT_MS;
    if (Date.now() - since < limit) {
      await sleep(2_000);
      return; // 次の周回でもう一度探す
    }
    const seen = fresh.slice(0, 5).map((f) => `${f.name}（${formatBytes(sizeOf(f))}）`).join('、');
    throw new Error(
      `保存したはずのファイルが見つかりません（新しく増えたファイル ${fresh.length}件${seen ? `: ${seen}` : ''}）`,
    );
  }
  findListedAt.delete(item.id);
  await updateItem(item.id, { state: 'copied', destFileId: String(found.id) });
}

/** ほかの件のコピーとして決まっている、自分のストレージのファイルID */
async function claimedByOthers(id: string): Promise<Set<string>> {
  const items = await readQueue();
  return new Set(items.filter((i) => i.id !== id && i.destFileId).map((i) => String(i.destFileId)));
}

async function stepSend(item: QueueItem): Promise<void> {
  if (!item.destFileId) throw new Error('コピーのIDがありません');
  // 先読みで保存した件は、JD2に渡しておく数に空きができるまで待つ（URLには期限があるので、URLは渡す直前に発行する）
  const { maxDownloads } = await loadSettings();
  const items = await readQueue();
  if (handedToJd(items, sendingNow) >= Math.max(1, maxDownloads)) {
    if (item.note !== PREFETCHED_NOTE) await updateItem(item.id, { note: PREFETCHED_NOTE });
    await sleep(IDLE_WAIT_MS);
    return;
  }
  sendingNow++;
  try {
    await sendToJd(item);
  } finally {
    sendingNow--;
  }
}

async function sendToJd(item: QueueItem): Promise<void> {
  let t = Date.now();
  const data = await api.fileGet(item.destFileId!);
  t = lap(item.id, 'URL取得', t);
  const file = data?.file ?? data;
  const url = String(file?.url ?? '');
  const hash = contentHash(file) ?? item.hash;
  // 共有一覧のサイズは実際とずれることがあるので、完了の確かめには自分のコピーのサイズを使う
  const fileSize = Number(file?.size);

  if (!item.force && hash && (await readHashes())[hash]) {
    await updateItem(item.id, { state: 'deleting', hash, note: '同じ中身をダウンロード済み' });
    return;
  }
  if (!url) throw new Error('ダウンロードURLを取得できませんでした');

  // 再試行のときも同じ保存先・同じ名前で渡すので、JD2が途中まで落としたファイルの続きから取る
  const jdId = await addDownload(url, { dir: item.relDir, out: item.outName });
  lap(item.id, 'JD2へ', t);
  jdDownSince = 0;
  await updateItem(item.id, {
    state: 'deleting',
    hash,
    jdId,
    fileSize: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : undefined,
    note: undefined,
  });
  await logEvent('info', `JD2へ渡しました: ${item.relDir}\\${item.outName}`);
}

/** JD2に渡した直後に、自分のストレージのコピーを完全削除して容量を空ける */
async function stepDelete(item: QueueItem): Promise<void> {
  const destId = item.destFileId;
  if (!destId) throw new Error('削除するコピーのIDがありません');
  // 安全確認: 保存前から存在したファイルは絶対に消さない
  if ((item.beforeIds ?? []).includes(destId)) {
    await updateItem(item.id, { state: 'error', error: '削除対象が保存前から存在していたため、削除を中止しました' });
    return;
  }
  // 安全確認: ほかの件のコピーとして決まったファイルは消さない
  if ((await claimedByOthers(item.id)).has(destId)) {
    await updateItem(item.id, { state: 'error', error: '削除対象がほかの件のコピーと重なったため、削除を中止しました' });
    return;
  }

  const t = Date.now();
  try {
    await api.moveToTrash(destId);
  } catch {
    // すでにゴミ箱にある場合などは、そのまま完全削除へ進む
  }
  await api.deleteForever(destId);

  const after: Partial<QueueItem> = { destFileId: undefined, beforeIds: undefined };
  lap(item.id, '削除', t);
  if (item.jdId) {
    await updateItem(item.id, { ...after, state: 'downloading', note: undefined });
    await logLaps(item);
  } else if (item.note === '同じ中身をダウンロード済み') {
    await updateItem(item.id, { ...after, state: 'skipped' });
  } else {
    // 失敗したコピーを片付けた場合は、共有から保存し直す
    await updateItem(item.id, {
      ...after,
      state: item.attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
      note: undefined,
    });
  }
}

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

/** ダウンロード中の件の進み具合の合計と、それが最後に増えた時刻 */
let stall: { bytes: number; since: number; noticed: boolean } | null = null;

/** ダウンロード中の件がどれも長く進まなければ、処理ログと通知で知らせる（1回だけ） */
async function watchStall(loaded: number, active: number): Promise<void> {
  if (active === 0) {
    stall = null;
    return;
  }
  if (!stall || loaded > stall.bytes) {
    stall = { bytes: loaded, since: Date.now(), noticed: false };
    return;
  }
  stall.bytes = loaded;
  if (stall.noticed || Date.now() - stall.since < STALL_NOTICE_MS) return;
  stall.noticed = true;
  const minutes = STALL_NOTICE_MS / 60_000;
  await logEvent('warn', `JD2のダウンロードが${minutes}分以上進んでいません（JD2が確認を待っている・止められているなど）`);
  await notify('stalled', 'ダウンロードが進んでいません', `JD2で${minutes}分以上進んでいません。JD2の画面を確認してください`);
}

async function doRefreshDownloads(): Promise<void> {
  const items = (await readQueue()).filter((i) => i.state === 'downloading' && i.jdId);
  if (items.length === 0) return;
  let links: Awaited<ReturnType<typeof queryLinks>>;
  try {
    links = await queryLinks(items.map((i) => i.jdId!));
    jdDownSince = 0;
  } catch {
    return; // JD2に一時的につながらない場合は次回また確認
  }
  const byId = new Map(links.map((l) => [String(l.uuid), l]));
  const stillActive = items.filter((i) => jdLinkState(byId.get(i.jdId!), i.fileSize ?? null) === 'active');
  await watchStall(
    stillActive.reduce((sum, i) => sum + (byId.get(i.jdId!)?.bytesLoaded ?? 0), 0),
    stillActive.length,
  );
  const patches = new Map<string, Partial<QueueItem>>();
  const logs: [Parameters<typeof logEvent>[0], string][] = [];
  // JD2があきらめたリンク。保存し直して新しいURLで渡すので、落としかけのファイルごとJD2の一覧から消す
  const toDiscard: string[] = [];
  for (const item of items) {
    const link = byId.get(item.jdId!);
    const state = jdLinkState(link, item.fileSize ?? null);
    const progress: Partial<QueueItem> = link
      ? {
          totalLength: link.bytesTotal && link.bytesTotal > 0 ? link.bytesTotal : undefined,
          completedLength: link.bytesLoaded ?? 0,
        }
      : {};
    if (state === 'missing') {
      // 一覧から消えている（JD2の設定で完了後に自動で片付けられた・手で消された）。渡せた時点で成功とみなす
      if (item.hash) await rememberHash(item.hash, item.name);
      patches.set(item.id, { state: 'done', jdId: undefined, note: 'JD2の一覧になし' });
      logs.push(['info', `完了（JD2の一覧になし）: ${item.name}`]);
    } else if (state === 'done') {
      if (item.hash) await rememberHash(item.hash, item.name);
      patches.set(item.id, { ...progress, state: 'done', jdId: undefined });
      logs.push(['info', `完了: ${item.name}`]);
    } else if (state === 'failed' || state === 'truncated') {
      toDiscard.push(item.jdId!);
      const attempts = item.attempts + 1;
      const reason =
        state === 'truncated'
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
      if (changed && (due || progress.totalLength !== item.totalLength)) {
        patches.set(item.id, progress);
        progressSavedAt.set(item.id, Date.now());
      }
    }
  }
  // 確認しているあいだに外されたり状態が変わったりした件は書き換えない
  const jdIdOf = new Map(items.map((i) => [i.id, i.jdId]));
  await updateItems(patches, (i) => i.state === 'downloading' && i.jdId === jdIdOf.get(i.id));
  for (const [id, patch] of patches) if (patch.state) progressSavedAt.delete(id);
  for (const [level, message] of logs) await logEvent(level, message);
  try {
    await discardLinks(toDiscard);
  } catch (e) {
    await logEvent('warn', `JD2の一覧から外せませんでした: ${errorText(e)}`);
  }
}
