import type { ItemState, QueueItem } from './queue';

/**
 * 自分のストレージにコピーを置いている段階（保存〜削除）。この段階の件は、コピーが残らないよう
 * キューから外させない。画面の区分の「処理中」（GROUP_OF の active）には downloading も入るので、それとは別
 */
export const IN_STORAGE_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
const WAITING_STATES: ItemState[] = ['pending', 'retry'];

export interface PickContext {
  /** いま担当が動いている件のID */
  running: Set<string>;
  /** 保存〜削除を同時に進める数 */
  parallel: number;
  /** 保存中のコピーの合計がこれを超えないようにする（バイト） */
  budgetBytes: number;
  /** JD2に渡しておく数（保存中の件も、すぐJD2に回るので数に入れる） */
  maxDownloads: number;
  /**
   * JD2の空き待ちのあいだに、先に保存しておく数（先読み）。
   * 保存まで済ませておき、JD2に空きができたらすぐURLを発行して渡す。省略時は 0
   */
  prefetch?: number;
  /** false なら新しい件は始めず、途中の件の再開だけをする（容量の空き待ちなど） */
  allowNew: boolean;
}

/**
 * 次に担当を付けて始める件のIDを返す。
 * 安全のための決まり:
 * - 同じ名前のファイルは同時に保存しない（コピーを名前で見分けているため、取り違えて消さないように）
 * - 保存中のコピーの合計が容量の枠を超えないようにする。サイズ不明の件は単独で進める
 * - キューの順番は飛ばさない（同じ名前の件だけは後回しにする）。大きい件がいつまでも始まらなくなるのを防ぐ
 *   （順番は「先に落とす」の順位が高い件が先。同じ順位どうしはキューに入った順）
 */
export function pickStarts(items: QueueItem[], ctx: PickContext): string[] {
  const starts: string[] = [];
  // 担当が付いたばかりで、まだ待ちの状態のままの件も、保存中と同じに数える
  const prep = items.filter((i) => IN_STORAGE_STATES.includes(i.state) || ctx.running.has(i.id));

  // 保存の途中で担当がいない件（Service Worker が止められた後など）は、まず再開する
  for (const i of prep) if (!ctx.running.has(i.id)) starts.push(i.id);
  if (!ctx.allowNew) return starts;

  let slots = ctx.parallel - ctx.running.size - starts.length;
  let downloads = items.filter((i) => i.state === 'downloading').length + prep.length;
  let busy = prep.length;
  let unknownBusy = prep.some((i) => i.size === null);
  let used = prep.reduce((sum, i) => sum + (i.size ?? 0), 0);
  const names = new Set(prep.map((i) => i.name));

  for (const i of byPriority(items)) {
    if (slots <= 0 || downloads >= ctx.maxDownloads + (ctx.prefetch ?? 0) || unknownBusy) break;
    if (!WAITING_STATES.includes(i.state) || ctx.running.has(i.id)) continue;
    if (names.has(i.name)) continue;
    if (i.size === null) {
      if (busy > 0) break;
      unknownBusy = true;
    } else if (busy > 0 && used + i.size > ctx.budgetBytes) {
      break;
    }
    starts.push(i.id);
    names.add(i.name);
    used += i.size ?? 0;
    busy++;
    slots--;
    downloads++;
  }
  return starts;
}

/** 始める順に並べる。「先に落とす」の順位が高い件を先にし、同じ順位どうしはキューの順のまま */
export function byPriority(items: QueueItem[]): QueueItem[] {
  if (!items.some((i) => i.priority)) return items;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * 共有に「先に落とす」を付ける・外す（items をその場で書き換える）。
 * 付けるときは、今ある順位のどれよりも高くする（後から付けた共有ほど先になる）。
 * 終わった件には付けない。書き換えた件数を返す
 */
export function setSharePriority(items: QueueItem[], token: string, on: boolean, now = Date.now()): number {
  const top = items.reduce((m, i) => Math.max(m, i.priority ?? 0), 0) + 1;
  let n = 0;
  for (const item of items) {
    if (item.shareToken !== token) continue;
    if (on && (item.state === 'done' || item.state === 'skipped')) continue;
    if (!on && !item.priority) continue;
    if (on) item.priority = top;
    else delete item.priority;
    item.updatedAt = now;
    n++;
  }
  return n;
}

/**
 * JD2に渡し済み（または渡している最中）の数。これが「JD2に渡しておく数」に届いていたら、
 * 先読みで保存した件はJD2に渡さずに待つ
 */
/**
 * 渡し中のまま止まった件が、JD2 の一覧に jdId のリンクとして入っていたときの書き換え。
 * コピーのある件（保存してから取る件）は、渡した後と同じく削除中にしてコピーを消してから見届ける
 */
export function adoptHanded(item: QueueItem, jdId: string): Partial<QueueItem> {
  return {
    state: item.destFileId ? 'deleting' : 'downloading',
    jdId,
    hash: item.handing?.hash ?? item.hash,
    fileSize: item.handing?.fileSize ?? item.fileSize,
    handing: undefined,
    note: undefined,
    error: undefined,
  };
}

export function handedToJd(items: QueueItem[], sendingNow: number): number {
  return items.filter((i) => i.state === 'downloading' || (i.state === 'deleting' && i.jdId)).length + sendingNow;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdAt?: number;
}

/**
 * 保存前になかったファイル（fresh）から、この件のコピーを選ぶ。
 * ほかの件のコピーとして決まったもの（claimed）は選ばない。
 * サイズが合うものを優先し、合うものがなくても同じ名前のものが1つだけならそれを使う。
 */
export function findOwnCopy<T extends DriveFile>(fresh: T[], item: QueueItem, claimed: Set<string>): T | undefined {
  const sameName = fresh
    .filter((f) => String(f.name) === item.name && !claimed.has(String(f.id)))
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const exact = sameName.filter((f) => item.size === null || Number(f.size) === item.size);
  return exact[0] ?? (sameName.length === 1 ? sameName[0] : undefined);
}

/**
 * 自分のストレージに残ったコピー（片付けの対象）を選ぶ。フォルダと、キューの件のコピーとして決まっているものは除く
 */
export function pickLeftovers<T extends { id: unknown }>(files: T[], claimed: Set<string>, isFolder: (f: T) => boolean): T[] {
  return files.filter((f) => f.id !== undefined && f.id !== null && !isFolder(f) && !claimed.has(String(f.id)));
}
