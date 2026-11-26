/**
 * 1件を1段階ずつ進める処理（engine.ts の担当から呼ばれる）。
 * - 保存せずに取る: stepDirect（共有から直接URLを発行してJD2へ）
 * - 保存してから取る: stepCopy（保存） → stepFindCopy（コピー探し） → stepSend（JD2へ） → stepDelete（完全削除）
 * 失敗は投げ返し、件ごとの失敗の数え方は engine.ts の processItem が決める。
 */
import { contentHash, formatBytes, unwrapFile } from '../shared/files';
import { cdnObjectSize } from '../shared/jd2-status';
import type { QueueItem } from '../shared/queue';
import { adoptHanded, findOwnCopy, handedToJd } from '../shared/scheduler';
import { loadSettings } from '../shared/settings';
import { api, collectPages, DISK_SPACE_FULL, LinkexError } from './api';
import { errorText, IDLE_WAIT_MS, MAX_ATTEMPTS, runtime, sleep } from './engine-runtime';
import { addDownload, findHanded } from './jd2';
import { isDownloaded, logEvent, readQueue, updateItem } from './store';

const COPY_TIMEOUT_MS = 5 * 60_000;
/** 保存が終わってから、コピーが一覧に出てくるのを待つ時間 */
const COPY_FIND_MS = 60_000;
/** 保存前の一覧として、ほかの件が少し前に取り始めた一覧を使ってよい時間 */
const BEFORE_LIST_REUSE_MS = 2_000;
/** 先読みで保存した件に付けるメモ */
const PREFETCHED_NOTE = '保存済み（JD2の空き待ち）';

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
      const list = await collectPages((page) => api.myFiles(undefined, page));
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
export async function stepDirect(item: QueueItem): Promise<boolean> {
  if (await isDuplicate(item, item.hash)) {
    await skipDuplicate(item, item.hash);
    return true;
  }
  // URLには期限があるので、JD2に渡しておく数に空きがあるときだけ発行する（空きがなければ、次の割り当てを待つ）
  const handled = await withJdSlot(() => sendDirect(item));
  if (handled === null) {
    await sleep(IDLE_WAIT_MS);
    return true;
  }
  return handled;
}

async function sendDirect(item: QueueItem): Promise<boolean> {
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
  const { url, hash, fileSize } = readDownloadable(data, item);
  if (await isDuplicate(item, hash)) {
    await skipDuplicate(item, hash);
    return true;
  }
  if (!url) {
    await logEvent('warn', `保存せずにはURLが出なかったため、保存してから取ります: ${item.name}`);
    return false;
  }
  // URLを発行しているあいだにキューから外された件は、JD2に渡さない（渡すと見届けない件になる）
  if (!(await stillQueued(item.id))) return true;
  const jdId = await handToJd(item, { url, hash, fileSize }, t);
  await updateItem(item.id, { state: 'downloading', hash, jdId, fileSize, handing: undefined, note: undefined, error: undefined });
  await logEvent('info', `JD2へ渡しました（保存なし）: ${item.relDir}\\${item.outName}`);
  await logLaps(item);
  return true;
}

// ---------- 直接と保存経由で共通の部品 ----------

/** 重複で省く件のメモ（古い版では、保存経由の件の目印にもこの文言を使っていた） */
const DUPLICATE_NOTE = '同じ中身をダウンロード済み';

/** 同じ中身をダウンロード済みか（「もう一度ダウンロード」で強制した件は除く） */
async function isDuplicate(item: QueueItem, hash: string | null): Promise<boolean> {
  return !item.force && hash !== null && (await isDownloaded(hash));
}

/** 重複のため省く（自分のストレージにコピーがない件だけ。コピーがある件は消してから省く） */
async function skipDuplicate(item: QueueItem, hash: string | null): Promise<void> {
  await updateItem(item.id, { state: 'skipped', hash, note: DUPLICATE_NOTE, duplicate: undefined });
  await logEvent('info', `重複のため省略: ${item.name}`);
}

/** file/get（共有のファイル・自分のファイルのどちらも）の応答から、渡すのに要るものを取り出す */
function readDownloadable(data: any, item: QueueItem): { url: string; hash: string | null; fileSize: number | undefined } {
  const file = data?.file ?? data;
  const url = String(file?.url ?? '');
  // 受け取った量の確かめには、CDN が実際に配っている大きさ（URL の最後の段）を使う。
  // 取れなければ file/get の size（共有一覧のサイズは実際とずれることがあるので使わない）
  const size = cdnObjectSize(url) ?? Number(file?.size);
  return { url, hash: contentHash(file) ?? item.hash, fileSize: Number.isFinite(size) && size > 0 ? size : undefined };
}

/**
 * JD2に渡しておく数に空きがあれば、渡している最中の件として数えながら fn を実行する。空きがなければ null。
 * 数えておかないと、同時に進めている件がそろって空きを見て、渡しすぎる
 */
async function withJdSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  const { maxDownloads } = await loadSettings();
  if (handedToJd(await readQueue(), runtime.sendingNow) >= Math.max(1, maxDownloads)) return null;
  runtime.sendingNow++;
  try {
    return await fn();
  } finally {
    runtime.sendingNow--;
  }
}

/**
 * まだキューにあるか。待ちの件は、担当が付いた後でもキューから外せるので、
 * 取り消せない操作（保存・JD2へ渡す）の直前に確かめる
 */
async function stillQueued(id: string): Promise<boolean> {
  return (await readQueue()).some((i) => i.id === id);
}

/**
 * JD2 に渡し、JD2 の一覧でのリンクのIDを返す（再試行のときも同じ保存先・同じ名前なので、続きから取る）。
 * 渡す前に「渡し中」の印を書いておき、呼び出し元が jdId を書くときに外す。
 * 渡し終えてから jdId を書くまでに止まったり、一覧へ移す返事が切れたりしても、次に進めるとき resolveHanding が拾い直す。
 * 渡せなかった（例外）ときも印は残し、次に進めるとき JD2 に入っていないことを確かめてから渡し直す
 */
async function handToJd(item: QueueItem, handing: NonNullable<QueueItem['handing']>, since: number): Promise<string> {
  await updateItem(item.id, { handing });
  const jdId = await addDownload(handing.url, { dir: item.relDir, out: item.outName });
  lap(item.id, 'JD2へ', since);
  runtime.jdDownSince = 0;
  return jdId;
}

/**
 * 渡し中の印が残っている件（前回、渡している最中に止まった）を片付ける。
 * JD2 に入っていれば拾い直して true（この件の今回の段階はここで終わり）。
 * 入っていなければ印を外して false（いつもどおり渡し直す）
 */
export async function resolveHanding(item: QueueItem): Promise<boolean> {
  if (!item.handing || item.jdId) return false;
  const jdId = await findHanded(item.handing.url);
  if (jdId === null) {
    await updateItem(item.id, { handing: undefined });
    return false;
  }
  await updateItem(item.id, adoptHanded(item, jdId));
  await logEvent('info', `JD2に渡し済みだったため、そのまま見届けます: ${item.relDir}\\${item.outName}`);
  return true;
}

// ---------- 保存してから取る ----------

export async function stepCopy(item: QueueItem): Promise<void> {
  if (await isDuplicate(item, item.hash)) {
    await skipDuplicate(item, item.hash);
    return;
  }
  let t = Date.now();
  // 保存（file/copy）を頼む前に取り終えた一覧なら、保存前の一覧として使える。
  // 取り始めがほんの少し前の、ほかの件の一覧も使う（同じ名前の件は同時に保存しないので取り違えない）
  const before = await listRoot(Date.now() - BEFORE_LIST_REUSE_MS).files;
  t = lap(item.id, `保存前の一覧(${before.size}件)`, t);
  // 一覧を取っているあいだにキューから外された件は、保存しない（保存すると持ち主のないコピーが残る）。
  // 保存中（copying）にした後は外せなくなる
  const started = await updateItem(item.id, {
    state: 'copying',
    beforeIds: [...before.keys()],
    copyStartedAt: Date.now(),
    copiedAt: undefined,
    destFileId: undefined,
    jdId: undefined,
    fileSize: undefined,
    duplicate: undefined,
    note: undefined,
    error: undefined,
  });
  if (!started) return;

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
export async function stepFindCopy(item: QueueItem): Promise<void> {
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

export async function stepSend(item: QueueItem): Promise<void> {
  if (!item.destFileId) throw new Error('コピーのIDがありません');
  // 先読みで保存した件は、JD2に渡しておく数に空きができるまで待つ（URLには期限があるので、URLは渡す直前に発行する）
  const sent = await withJdSlot(() => sendToJd(item));
  if (sent === null) {
    if (item.note !== PREFETCHED_NOTE) await updateItem(item.id, { note: PREFETCHED_NOTE });
    await sleep(IDLE_WAIT_MS);
  }
}

async function sendToJd(item: QueueItem): Promise<true> {
  const t = Date.now();
  const data = await api.fileGet(item.destFileId!);
  const { url, hash, fileSize } = readDownloadable(data, item);
  const since = lap(item.id, 'URL取得', t);

  if (await isDuplicate(item, hash)) {
    // コピーを消してから省く（stepDelete が duplicate を見て skipped にする）
    await updateItem(item.id, { state: 'deleting', hash, duplicate: true, note: DUPLICATE_NOTE });
    return true;
  }
  if (!url) throw new Error('ダウンロードURLを取得できませんでした');

  const jdId = await handToJd(item, { url, hash, fileSize }, since);
  await updateItem(item.id, { state: 'deleting', hash, jdId, fileSize, handing: undefined, note: undefined });
  await logEvent('info', `JD2へ渡しました: ${item.relDir}\\${item.outName}`);
  return true;
}

/** JD2に渡した直後に、自分のストレージのコピーを完全削除して容量を空ける */
export async function stepDelete(item: QueueItem): Promise<void> {
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

  const after: Partial<QueueItem> = { destFileId: undefined, beforeIds: undefined, deleteAttempts: undefined };
  lap(item.id, '削除', t);
  if (item.jdId) {
    await updateItem(item.id, { ...after, state: 'downloading', note: undefined });
    await logLaps(item);
  } else if (item.duplicate || item.note === DUPLICATE_NOTE) {
    // note で見分けるのは、古い版で削除中のまま残っている件のため
    await updateItem(item.id, { ...after, state: 'skipped', duplicate: undefined });
    await logEvent('info', `重複のため省略: ${item.name}`);
  } else {
    // 失敗したコピーを片付けた場合は、共有から保存し直す
    await updateItem(item.id, {
      ...after,
      state: item.attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
      note: undefined,
    });
  }
}
