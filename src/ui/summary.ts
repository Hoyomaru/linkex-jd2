/**
 * 進み具合・見積もり・件数の表示を、ポップアップ・専用ページ・共有ページのパネルで同じ決まりで出すための部品。
 * 表示のきまり（何を「-」にするか、件数の並べ方など）を変えるときは、ここだけ直す。
 */
import { estimateHeadline, estimateRemaining, estimateTrafficLine, type TrafficInfo } from '../shared/estimate';
import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format';
import { summarizeQueue, type QueueItem, type QueueSummary } from '../shared/queue';

export interface Overview extends QueueSummary {
  /** 落とす対象の件数（省略を除く） */
  target: number;
  /** バイト数で見た進み具合（0〜100） */
  pct: number;
  /** この拡張機能が渡した件の、今の速度の合計（バイト/秒） */
  speed: number;
  /** JD2でダウンロード中の件数 */
  downloading: number;
}

/** キューと、JD2から取った今の進み具合（jdId →）から、表示に使う数をまとめる */
export function overviewOf(items: QueueItem[], live: Map<string, { completed: number; speed: number }>): Overview {
  const completed = new Map<string, number>();
  for (const [jdId, p] of live) completed.set(jdId, p.completed);
  const s = summarizeQueue(items, completed);
  let speed = 0;
  for (const item of items) if (item.jdId) speed += live.get(item.jdId)?.speed ?? 0;
  return {
    ...s,
    target: s.total - s.counts.skipped,
    pct: percent(s.bytesDone, s.bytesTotal),
    speed,
    downloading: items.filter((i) => i.state === 'downloading').length,
  };
}

/** 大きな数字の割合（「42%」の % を小さく出す） */
export const percentHtml = (o: Overview) => `${Math.floor(o.pct)}<small>%</small>`;
export const countText = (o: Overview) => `${o.counts.done} / ${o.target}件 完了`;
export const bytesText = (o: Overview) => `${formatBytes(o.bytesDone)} / ${formatBytes(o.bytesTotal)}`;
export const speedText = (o: Overview) => (o.speed > 0 ? formatSpeed(o.speed) : '-');
export const leftText = (o: Overview) => (o.bytesRemaining > 0 ? formatBytes(o.bytesRemaining) : '-');
export const etaText = (o: Overview) =>
  o.bytesRemaining > 0 && o.speed > 0 ? formatEta(o.bytesRemaining, o.speed) : '-';

/**
 * 状態ごとの件数の札（処理中・待ち・完了・省略・失敗）。0件のものは完了以外出さない。
 * errorLink なら失敗の札をリンクにする（押したときの動きは、置く側で決める）
 */
export function countChips(counts: QueueSummary['counts'], errorLink = false): HTMLElement[] {
  const chip = (cls: string, label: string, n: number, link = false) => {
    const e = document.createElement(link ? 'a' : 'span');
    e.className = cls;
    if (link) {
      (e as HTMLAnchorElement).href = '#';
      e.title = '専用ページで確認';
    }
    const b = document.createElement('b');
    b.textContent = String(n);
    e.append(`${label} `, b);
    return e;
  };
  return [
    counts.active ? chip('c-active', '処理中', counts.active) : null,
    counts.waiting ? chip('c-waiting', '待ち', counts.waiting) : null,
    chip('c-done', '完了', counts.done),
    counts.skipped ? chip('c-skipped', '省略', counts.skipped) : null,
    counts.error ? chip('c-error', '失敗', counts.error, errorLink) : null,
  ].filter((c): c is HTMLElement => c !== null);
}

/** 見積もりの欄（これから落とす量と、転送量の残りで足りるか） */
export function renderEstimate(
  els: { box: HTMLElement; headline: HTMLElement; traffic: HTMLElement },
  items: QueueItem[],
  summary: QueueSummary,
  traffic: TrafficInfo | null,
): void {
  const est = estimateRemaining(items, summary, traffic);
  els.box.hidden = est.files === 0;
  const line = estimateTrafficLine(est);
  els.box.className = `estimate ${line.kind === 'muted' ? '' : line.kind}`;
  els.headline.textContent = estimateHeadline(est);
  els.traffic.textContent = line.text;
}

/** 容量・転送量の使い具合のメーター（8割で注意、使い切りで赤） */
export function setMeter(bar: HTMLElement, used: number, total: number): void {
  const ratio = total > 0 ? used / total : 0;
  bar.style.width = `${Math.min(100, ratio * 100)}%`;
  bar.parentElement!.className = `meter${ratio >= 1 ? ' ng' : ratio >= 0.8 ? ' warn' : ''}`;
}
