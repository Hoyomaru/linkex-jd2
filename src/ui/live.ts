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
      const res = await send({ type: 'jd.active' });
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

export { engineView } from '../shared/engine-view';
