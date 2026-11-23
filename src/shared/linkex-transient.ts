/**
 * Linkex API の失敗が「少し待てば直る一時的なもの」かを見分ける。
 * - 429（速度制限）・5xx（サーバー側の一時的な不調）
 * - 応答が返ってこなかった（通信が切れた・時間切れ）。このときは HTTP の状態も応答の中身もない
 * Linkex が中身付きで返したエラー（容量不足など）は一時的とはみなさない
 */
export function isTransientLinkexFailure(f: { error: string; status?: number | null; detail?: unknown }): boolean {
  const status = f.status ?? null;
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) return true;
  if (status !== null || (f.detail !== null && f.detail !== undefined)) return false;
  return /network\s*error|timeout|timed?\s*out|failed to fetch|ECONN|ERR_NETWORK|ERR_INTERNET|aborted/i.test(f.error);
}

/** 失敗した呼び出しを、もう一度呼んでよいか。保存（POST）は二重に保存しないよう、断られたと分かる 429 だけ */
export function mayRetryLinkex(method: 'get' | 'post', f: { error: string; status?: number | null; detail?: unknown }): boolean {
  if (!isTransientLinkexFailure(f)) return false;
  return method === 'get' || f.status === 429;
}
