import { send, type JdLive } from '../shared/messages';

export interface LiveProgress {
  completed: number;
  total: number;
  speed: number;
}

/**
 * JD2の今のダウンロード状況を定期的に取りに行く。
 * 画面が見えているときだけ動く。戻り値を呼ぶと止まる。
 */
export function pollJd(
  onData: (live: JdLive | null, error?: string) => void,
  intervalMs = 1500,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      const res = await send<JdLive>({ type: 'jd.active' });
      if (stopped) return;
      if (res.ok) onData(res.data);
      else onData(null, res.error);
    }
    timer = setTimeout(tick, intervalMs);
  };
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    clearTimeout(timer);
    void tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  void tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** jdId ごとの進み具合にまとめる */
export function toProgressMap(live: JdLive | null): Map<string, LiveProgress> {
  const map = new Map<string, LiveProgress>();
  for (const a of live?.active ?? []) {
    map.set(a.jdId, { completed: a.completedLength, total: a.totalLength, speed: a.downloadSpeed });
  }
  return map;
}

/**
 * 処理全体の状態を、画面に出す1つの言い方にまとめる（ポップアップ・専用ページ・共有ページで同じ）。
 * 一時停止しても JD2 に渡したダウンロードは最後まで続くので、そのことを文で添える。
 */
export function engineView(
  engine: { paused: boolean; message: string } | undefined,
  items: { state: string }[],
): { paused: boolean; pill: string; tone: '' | 'running' | 'waiting'; message: string } {
  const paused = engine?.paused ?? true;
  const message = engine?.message ?? '';
  const downloading = items.filter((i) => i.state === 'downloading').length;
  const unfinished = items.some((i) => !['done', 'skipped', 'error'].includes(i.state));
  if (paused) {
    if (downloading) {
      return { paused, pill: '一時停止中', tone: '', message: `一時停止中（JD2 に渡した ${downloading}件は最後まで続きます）` };
    }
    // 「すべて終わりました」などの結果はそのまま見せる
    return { paused, pill: unfinished ? '一時停止中' : '停止中', tone: '', message: message === '一時停止中' ? '' : message };
  }
  const waiting = /待機|待ち|空き/.test(message);
  return { paused, pill: waiting ? '待機中' : '実行中', tone: waiting ? 'waiting' : 'running', message };
}
