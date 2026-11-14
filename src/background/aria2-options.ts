/**
 * aria2.addUri に渡すオプションを作る。
 * 一時的な通信エラーは aria2 が同じタスクの中でやり直すよう、自動再試行を常に付ける。
 * （失敗後に送り直すと別タスクになり、Motrixの一覧が汚れるため）
 */
export function downloadOptions(opts: { dir?: string; out?: string; resume?: boolean }): Record<string, string> {
  const options: Record<string, string> = {};
  if (opts.dir) options.dir = opts.dir;
  if (opts.out) options.out = opts.out;
  // 再試行のときは、途中まで落としたファイル（.aria2 の管理ファイル付き）から続きを取る
  if (opts.resume) options.continue = 'true';
  options['max-tries'] = '5';
  options['retry-wait'] = '10';
  return options;
}
