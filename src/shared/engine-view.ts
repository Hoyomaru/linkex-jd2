import type { EngineState } from './queue';

export interface EngineView {
  paused: boolean;
  pill: string;
  tone: '' | 'running' | 'waiting' | 'error';
  message: string;
  /** 理由と対処を読ませたいので、省略せずに折り返して出す */
  wrap: boolean;
}

/**
 * 処理全体の状態を、画面に出す1つの言い方にまとめる（ポップアップ・専用ページ・共有ページで同じ）。
 * 一時停止しても JD2 に渡したダウンロードは最後まで続くので、そのことを文で添える。
 */
export function engineView(
  engine: Pick<EngineState, 'paused' | 'message' | 'status'> | undefined,
  items: { state: string }[],
): EngineView {
  const paused = engine?.paused ?? true;
  const message = engine?.message ?? '';
  const status = engine?.status;
  const downloading = items.filter((i) => i.state === 'downloading').length;
  const continues = downloading ? `（JD2 に渡した ${downloading}件は最後まで続きます）` : '';
  if (status === 'stopped') {
    return { paused, pill: '止まりました', tone: 'error', message: `${message}${continues}`, wrap: true };
  }
  if (status === 'crashed') {
    return {
      paused,
      pill: '問題あり',
      tone: 'error',
      message: `${message}（1分以内に自動でやり直します）`,
      wrap: true,
    };
  }
  if (paused) {
    if (downloading) {
      return { paused, pill: '一時停止中', tone: '', message: `一時停止中${continues}`, wrap: false };
    }
    const unfinished = items.some((i) => !['done', 'skipped', 'error'].includes(i.state));
    // 「すべて終わりました」などの結果はそのまま見せる
    return { paused, pill: unfinished ? '一時停止中' : '停止中', tone: '', message: message === '一時停止中' ? '' : message, wrap: false };
  }
  const waiting = status === 'waiting';
  return { paused, pill: waiting ? '待機中' : '実行中', tone: waiting ? 'waiting' : 'running', message, wrap: false };
}
