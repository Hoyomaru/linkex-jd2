import {
  ENGINE_KEY,
  EVENTS_KEY,
  HASHES_KEY,
  MAX_EVENTS,
  QUEUE_KEY,
  type EngineState,
  type EventEntry,
  type QueueItem,
} from '../shared/queue';

// 処理ログ。新しいものを先頭に、最大 MAX_EVENTS 件まで残す
let eventLock: Promise<unknown> = Promise.resolve();
export function logEvent(level: EventEntry['level'], message: string): Promise<void> {
  return logEvents([[level, message]]);
}

/**
 * 処理ログに何件かまとめて書く（並べた順に書いたことにする）。
 * ログは書くたびに全体を読み書きし、専用ページも描き直すので、まとまって出るものは1回で書く
 */
export function logEvents(entries: [EventEntry['level'], string][]): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  const run = async () => {
    const stored = await chrome.storage.local.get(EVENTS_KEY);
    const events = (stored[EVENTS_KEY] as EventEntry[] | undefined) ?? [];
    const at = Date.now();
    // 新しいものが先頭なので、後に並べたものほど前に置く
    events.unshift(...entries.map(([level, message]) => ({ at, level, message })).reverse());
    await chrome.storage.local.set({ [EVENTS_KEY]: events.slice(0, MAX_EVENTS) });
  };
  const next = eventLock.then(run, run);
  eventLock = next.catch(() => undefined);
  return next;
}

export async function clearEvents(): Promise<void> {
  await chrome.storage.local.set({ [EVENTS_KEY]: [] });
}

// キューの読み書きを1本にまとめ、同時に書き換えて内容が消えるのを防ぐ
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

/**
 * キューの中身を Service Worker の中に持っておく（指示役は毎秒、担当は段階ごとに読むため）。
 * キューを書き換えるのはこのファイルの mutateQueue だけなので、ここで書いた内容が常に最新になる
 * （画面は storage を読み、onChanged で変化を受け取る）。Service Worker が起き直したら storage から読み直す
 */
let queueCache: QueueItem[] | null = null;

async function loadQueue(): Promise<QueueItem[]> {
  if (queueCache) return queueCache;
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  // 読んでいるあいだに書き込みが済んでいれば、そちらが新しい
  queueCache ??= (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  return queueCache;
}

/** キューの写しを返す（書き換えても保存されない。書き換えは mutateQueue で） */
export async function readQueue(): Promise<QueueItem[]> {
  return structuredClone(await loadQueue());
}

export function mutateQueue<T>(fn: (items: QueueItem[]) => T): Promise<T> {
  return exclusive(async () => {
    // 写しを書き換えて、保存できてから入れ替える（保存に失敗したら、持っている中身も元のまま）
    const items = structuredClone(await loadQueue());
    const result = fn(items);
    await chrome.storage.local.set({ [QUEUE_KEY]: items });
    queueCache = items;
    return result;
  });
}

export function updateItem(id: string, patch: Partial<QueueItem>): Promise<QueueItem | null> {
  return mutateQueue((items) => {
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: Date.now() });
    return { ...item };
  });
}

/** 複数の件をまとめて1回で書き換える（キュー全体の書き込みは重いため） */
export function updateItems(
  patches: Map<string, Partial<QueueItem>>,
  /** 書き換える直前の状態で確かめる条件（読んでから書くまでに別の操作で変わっていたら書かない） */
  when: (item: QueueItem) => boolean = () => true,
): Promise<void> {
  if (patches.size === 0) return Promise.resolve();
  return mutateQueue((items) => {
    const now = Date.now();
    for (const item of items) {
      const patch = patches.get(item.id);
      if (patch && when(item)) Object.assign(item, patch, { updatedAt: now });
    }
  });
}

export async function readEngine(): Promise<EngineState> {
  const stored = await chrome.storage.local.get(ENGINE_KEY);
  return (stored[ENGINE_KEY] as EngineState | undefined) ?? { paused: true, message: '停止中', updatedAt: Date.now() };
}

// 全体の状態の書き換えも1本にまとめる。
// 読んでから書くまでの間に別の書き換え（一時停止など）が入ると、古い値で上書きして消してしまうため
let engineLock: Promise<unknown> = Promise.resolve();
export function writeEngine(
  patch: Partial<EngineState>,
  /** 書く直前の状態で確かめる条件。合わなければ書かない（止まった後に、止まる前の状況で上書きしないため） */
  when: (current: EngineState) => boolean = () => true,
): Promise<EngineState> {
  const run = async () => {
    const current = await readEngine();
    if (!when(current)) return current;
    // 中身が変わらないなら書かない（空き待ちの間は毎秒同じ表示を書こうとするため。
    // 書くたびにアイコンの件数を数え直す処理が走る）
    const same = Object.entries(patch).every(([k, v]) => current[k as keyof EngineState] === v);
    if (same) return current;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [ENGINE_KEY]: next });
    return next;
  };
  const next = engineLock.then(run, run);
  engineLock = next.catch(() => undefined);
  return next;
}

export async function readHashes(): Promise<Record<string, { name: string; at: number }>> {
  const stored = await chrome.storage.local.get(HASHES_KEY);
  return (stored[HASHES_KEY] as Record<string, { name: string; at: number }> | undefined) ?? {};
}

/** ダウンロード済みの記録（重複の省略に使う）を全部消す */
export async function clearHashes(): Promise<void> {
  await chrome.storage.local.remove(HASHES_KEY);
}

// ダウンロード済みの記録の書き換えも1本にまとめる（同時に書くと片方の記録が消えるため）
let hashLock: Promise<unknown> = Promise.resolve();
export function rememberHash(hash: string, name: string): Promise<void> {
  const run = async () => {
    const hashes = await readHashes();
    hashes[hash] = { name, at: Date.now() };
    await chrome.storage.local.set({ [HASHES_KEY]: hashes });
  };
  const next = hashLock.then(run, run);
  hashLock = next.catch(() => undefined);
  return next;
}
