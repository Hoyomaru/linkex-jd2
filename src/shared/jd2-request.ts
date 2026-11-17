/** JD2 にずっとつながらない（呼び直しても切られる・応答が止まる） */
export class Jd2ConnectionError extends Error {
  constructor() {
    super('JD2に接続できません。JD2が起動しているか、詳細設定の「Deprecated Api」がオンか、接続先の設定を確認してください');
  }
}

export interface RequestOptions {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JD2 のローカルAPIを1回呼ぶ。
 * JD2 の Deprecated Api は、負荷に関係なく接続の2〜3割をいきなり切り、ときどき応答の途中で止まる。
 * 切られる・止まるは本文を読み終えるまでのどこでも起きるので、そこまでを1回として、少し待って呼び直す。
 * JD2 が返した応答は（エラーでも）そのまま返す。JSON でなければ json は null。
 */
export async function requestJd(
  url: string,
  { fetchFn = fetch, sleep = realSleep, attempts = 8, timeoutMs = 8_000 }: RequestOptions = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // 切られるのは一瞬なので、最初は短く待つ（0.2, 0.4, 0.8, 1.6, 2, 2, 2 秒）
    if (attempt > 0) await sleep(Math.min(200 * 2 ** (attempt - 1), 2_000));
    let text: string;
    let res: Response;
    try {
      res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      text = await res.text();
    } catch {
      continue;
    }
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // JSON でない応答は JD2 側のエラーとして呼び出し元に任せる
    }
    return { ok: res.ok, status: res.status, json };
  }
  throw new Jd2ConnectionError();
}
