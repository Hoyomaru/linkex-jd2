/**
 * 処理（engine.ts・engine-steps.ts・jd-monitor.ts）で分け合う、実行中の状態と共通の決まり。
 * Service Worker が止められると消えるが、どれも起き直したときに数え直せば済むものだけを置く。
 */
import { notify } from './notify';
import { logEvent, writeEngine } from './store';

/** 1件を何回まで試すか（JD2での失敗・保存の失敗などを合わせて数える） */
export const MAX_ATTEMPTS = 3;
/** ダウンロードの空き待ち。JD2への確認はPCの中で済み軽いので、短めに見る */
export const IDLE_WAIT_MS = 1_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const errorText = (e: unknown) => String((e as Error)?.message ?? e);

export interface Runtime {
  /** この時刻までは新しい件を始めない（容量不足と言われた後） */
  capacityWaitUntil: number;
  /** この時刻までは新しい件を始めない（転送量の上限） */
  trafficWaitUntil: number;
  /** JD2 の完了を取り込んだ時刻 */
  downloadsRefreshedAt: number;
  /** JD2 につながらなくなった時刻（つながっていれば 0） */
  jdDownSince: number;
  /** Linkex が応えなくなった時刻（応えていれば 0） */
  linkexDownSince: number;
  /** 保存中のコピーに使ってよい容量（バイト） */
  budget: { bytes: number; at: number } | null;
  /** 転送量の残りの見込み（バイト）。調べた時刻から少しの間だけ使う */
  trafficLeft: { bytes: number; at: number } | null;
  /** 残ったコピーを最後に片付けた時刻（0 なら次に手が空いたらすぐ片付ける） */
  cleanedAt: number;
  /** ダウンロード中の件の進み具合の合計と、それが最後に増えた時刻（進まなければ知らせるため） */
  stall: { bytes: number; since: number; noticed: boolean } | null;
  /** いまJD2に渡している最中の件の数（先読みした件を渡しすぎないように数える） */
  sendingNow: number;
  /** 前の周回で、まだ終わっていない件があった共有（共有1つ分が終わったら知らせるため） */
  openShares: Set<string>;
  /**
   * Linkex のアカウントを切り替える準備中（新しい件を始めず、Linkex 側で処理中の件が片付くのを待つ）。
   * traffic: 転送量が尽きたため（保存済みのコピーは消して取り直す） / keepAlive: 期限を延ばすため（コピーは最後まで進める）
   */
  switching: { reason: 'traffic' | 'keepAlive'; since: number; to: string } | null;
  /** 全部のアカウントが尽きているとき、次に再開を試すアカウントの名前と時刻（表示用） */
  resumeHint: { name: string; at: number } | null;
}

export const runtime: Runtime = {
  capacityWaitUntil: 0,
  trafficWaitUntil: 0,
  downloadsRefreshedAt: 0,
  jdDownSince: 0,
  linkexDownSince: 0,
  budget: null,
  trafficLeft: null,
  cleanedAt: 0,
  stall: null,
  sendingNow: 0,
  openShares: new Set(),
  switching: null,
  resumeHint: null,
};

/** 全体を一時停止して、処理ログと通知で知らせる */
export async function stopWithNotice(reason: string): Promise<void> {
  await writeEngine({ paused: true, status: 'stopped', message: `一時停止: ${reason}` });
  await logEvent('error', `一時停止: ${reason}`);
  await notify('stopped', '一時停止しました', reason);
}

/** JD2 にこの時間つながらないままなら、全体を止めて知らせる */
const JD_DOWN_LIMIT_MS = 3 * 60_000;

/**
 * JD2 につながらなかったことを数える。JD2 はときどき続けて接続を切るので、すぐには止めず、
 * つながらないままの時間が長く続いたら（JD2が落ちている・設定が違う）全体を止めて知らせる。止めたら true
 */
export async function noteJdDown(e: unknown): Promise<boolean> {
  runtime.jdDownSince ||= Date.now();
  if (Date.now() - runtime.jdDownSince < JD_DOWN_LIMIT_MS) return false;
  runtime.jdDownSince = 0;
  await stopWithNotice(errorText(e));
  return true;
}

/**
 * 「開始」のときに、前回までの待ちや見込みを捨てる。
 * 次のものは消さない:
 * - sendingNow: 一時停止の後も、区切りまで進めている担当が数えている
 * - downloadsRefreshedAt: 取り込みの間隔を空けるためだけのもの
 * - 件ごとの記録（engine-steps.ts の lap・コピー探し、jd-monitor.ts の進まない件の見張り）:
 *   一時停止しても JD2 でのダウンロードや Linkex での保存は続くので、続けて数える
 */
export function resetRuntime(): void {
  runtime.capacityWaitUntil = 0;
  runtime.trafficWaitUntil = 0;
  runtime.jdDownSince = 0;
  runtime.linkexDownSince = 0;
  runtime.budget = null;
  runtime.trafficLeft = null;
  runtime.cleanedAt = 0;
  runtime.stall = null;
  runtime.switching = null;
  runtime.resumeHint = null;
}
