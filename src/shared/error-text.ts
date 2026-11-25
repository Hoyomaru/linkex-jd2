/**
 * 拡張機能の中で使っている短いエラーの印（tab_unresponsive など）を、原因と対処がわかる文にする。
 * 印は判定にも使うので、作るところでは印のまま返し、画面に出す直前やログに書く直前にこれを通す。
 * 知らないエラーはそのまま返す。
 */
const TEXTS: Record<string, string> = {
  tab_unresponsive: 'Linkexのタブが応答しません。Linkexのタブを一度表示してから、もう一度試してください',
  no_result: 'Linkexのページから返事がありませんでした。もう一度試してください（続くときはLinkexのタブを読み込み直してください）',
  index_not_found:
    'Linkexのページの部品が見つかりません。Linkexのタブを読み込み直してください（続くときはLinkex側の仕様が変わった可能性があります）',
  client_not_found:
    'Linkexのページの通信部品が見つかりません。Linkexのタブを読み込み直してください（続くときはLinkex側の仕様が変わった可能性があります）',
  no_response: '拡張機能の裏側が応答しません。edge://extensions でこの拡張機能を再読み込みしてください',
};

/** 拡張機能を読み込み直した後、古いページから送ったときの Edge のエラー */
const STALE_PAGE = /Receiving end does not exist|Extension context invalidated/i;

export function describeError(error: string): string {
  if (STALE_PAGE.test(error)) return '拡張機能が更新されたため、つながりが切れました。このページを読み込み直してください';
  // 印のあとに詳しい中身（JSON など）が付くことがあるので、先頭の印で見分ける
  const code = /^([a-z_]+)(?:\s|$)/.exec(error)?.[1];
  const text = code ? TEXTS[code] : undefined;
  if (!text) return error;
  const rest = error.slice(code!.length).trim();
  return rest ? `${text}（${rest}）` : text;
}
