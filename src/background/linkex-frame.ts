import type { BridgeRequest, BridgeResult, WalkResult } from './linkex-bridge';
import type { FrameRequest } from '../content/drive-frame';
import { logEvent } from './store';

/**
 * 固定タブを使わず、拡張機能の裏のページ（offscreen.html）に埋め込んだ Linkex のドライブで API を呼ぶ。
 * 拡張機能のページは Edge のタブの凍結の対象にならないので、タブのように凍結されて止まることもない。
 * 使えないとき（ログイン画面に移された・読み込みが終わらないなど）は null を返し、呼び出し側は固定タブで続ける。
 */
const OFFSCREEN_PATH = 'offscreen.html';
/** 埋め込みの用意を待つ上限 */
const READY_TIMEOUT_MS = 30_000;
/** API呼び出し1回の待ち時間の上限（固定タブと同じ） */
const CALL_TIMEOUT_MS = 20_000;
/** 使えなかったら、しばらくは固定タブで続け、この時間が過ぎたら埋め込みを読み込み直して試す */
const RETRY_AFTER_MS = 5 * 60_000;
/** ページから20秒以上返事がなければ、共有の読み込みが止まっているとみなす */
const WALK_STALL_MS = 20_000;
/** 最後の返事からこれだけたっていたら、頼む前に埋め込みが応えるかを確かめる */
const IDLE_CHECK_MS = 60_000;
/** その確かめの待ち時間の上限 */
const PING_TIMEOUT_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FrameTimeout extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FrameTimeout('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

let creating: Promise<void> | null = null;
async function ensureDocument(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: 'Linkexのドライブを裏で開き、ページ自身の通信部品でAPIを呼ぶため',
    })
    .finally(() => (creating = null));
  await creating;
}

/** 埋め込みの中の Linkex のページから最後に返事があった時刻 */
let lastAliveAt = 0;

function send<T>(body: FrameRequest, timeoutMs: number): Promise<T> {
  return withTimeout(chrome.runtime.sendMessage({ target: 'linkex-frame', body }) as Promise<T>, timeoutMs).then((value) => {
    // 空の返事は、埋め込みの中がまだ Linkex のページになっていないとき（ページは返事をしていない）
    if (value !== undefined) lastAliveAt = Date.now();
    return value;
  });
}

/** 'ok': 使える / 'down': 使えないと分かっている（その時刻） */
let state: { kind: 'ok' } | { kind: 'down'; at: number } | { kind: 'unknown' } = { kind: 'unknown' };
let readying: Promise<boolean> | null = null;
let checking: Promise<boolean> | null = null;

/** 埋め込みが使えるようにする。使えなければ false */
async function ensureFrame(): Promise<boolean> {
  if (state.kind === 'ok') {
    if (Date.now() - lastAliveAt < IDLE_CHECK_MS) return true;
    checking ??= checkAlive().finally(() => (checking = null));
    return checking;
  }
  if (state.kind === 'down' && Date.now() - state.at < RETRY_AFTER_MS) return false;
  readying ??= prepare().finally(() => (readying = null));
  return readying;
}

/**
 * しばらく使っていなかった埋め込みが、まだ応えるかを短く確かめる。
 * 埋め込みの中のページは、スリープ中などにドライブ以外のページへ移ったり止まったりすることがあり、
 * そのまま頼むと返事の待ちの上限（20秒）まで待ってしまう。応えなければ、固定タブに逃げずに作り直す
 */
async function checkAlive(): Promise<boolean> {
  const res = await send<{ ready: boolean } | undefined>({ kind: 'ping' }, PING_TIMEOUT_MS).catch(() => undefined);
  if (res?.ready) return true;
  void logEvent('info', 'しばらく使っていなかった裏の埋め込みページが応答しないため、作り直します');
  state = { kind: 'down', at: 0 };
  readying ??= prepare().finally(() => (readying = null));
  return readying;
}

async function prepare(): Promise<boolean> {
  let lastPath = '';
  try {
    const wasDown = state.kind === 'down';
    await ensureDocument();
    // 前に使えなかったときや「開始」を押したときは、埋め込みを読み込み直してから試す
    if (wasDown) await chrome.runtime.sendMessage({ target: 'linkex-frame', kind: 'reload' });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await send<{ ok: boolean; ready: boolean; path: string } | undefined>({ kind: 'ping' }, 1_500).catch(
        () => undefined,
      );
      if (res?.path) lastPath = res.path;
      if (res?.ready) {
        state = { kind: 'ok' };
        void logEvent('info', 'Linkexを裏の埋め込みページで呼びます（固定タブは使いません）');
        return true;
      }
      await sleep(500);
    }
    return markDown(
      lastPath
        ? `ドライブのページ（${lastPath}）の部品が読み込まれませんでした`
        : '埋め込んだページから返事がありません（ログイン画面に移されたか、埋め込みを断られた可能性）',
    );
  } catch (e) {
    return markDown(String((e as Error)?.message ?? e));
  }
}

/**
 * 次に呼ぶときに埋め込みを読み込み直す。「開始」のたびに呼ぶ
 * （ログインし直した後も、埋め込んだページが古いログイン情報を持ったままにならないように）
 */
export function refreshFrame(): void {
  state = { kind: 'down', at: 0 };
}

function markDown(reason: string): false {
  state = { kind: 'down', at: Date.now() };
  void logEvent('warn', `裏の埋め込みページが使えないため、固定タブで続けます: ${reason}`);
  return false;
}

/**
 * 埋め込みでAPIを1回呼ぶ。埋め込みが使えなければ null（固定タブで呼び直してよい）。
 * 保存（file/copy）は、返事がないまま固定タブで呼び直すと二重に保存しかねないので、時間切れを失敗として返す
 */
export async function callViaFrame(req: BridgeRequest, mayResend: boolean): Promise<BridgeResult | null> {
  if (!(await ensureFrame())) return null;
  for (let attempt = 1; ; attempt++) {
    let result: BridgeResult | undefined;
    const since = Date.now();
    try {
      result = await send<BridgeResult | undefined>({ kind: 'call', req }, CALL_TIMEOUT_MS);
    } catch (e) {
      const why = e instanceof FrameTimeout ? `応答がありません（${req.path}・${await diagnose(since)}）` : String((e as Error)?.message ?? e);
      markDown(why);
      if (!mayResend) {
        return { ok: false, error: `timeout: 埋め込みページが応答しなかったため、二重に保存しないよう送り直していません（${req.path}）` };
      }
      return null;
    }
    if (!result) return null;
    // ページの部品がまだ読み込まれていない場合は少し待って1回だけやり直す
    if (!result.ok && result.error === 'index_not_found' && attempt < 2) {
      await sleep(1500);
      continue;
    }
    if (!loggedFirstCall) {
      loggedFirstCall = true;
      void logEvent(
        'info',
        `埋め込みページでの最初の呼び出し: ${req.path}・${result.ok ? '成功' : `失敗（${result.error}）`}・${((Date.now() - since) / 1000).toFixed(1)}秒`,
      );
    }
    return result;
  }
}

/** 埋め込みでの最初の呼び出しの結果を、一度だけ処理ログに残す（動いているかを確かめるため） */
let loggedFirstCall = false;

/**
 * 返事がないときの、埋め込みのページの様子（原因を見分けるための記録用）。
 * ページが返事をするか、頼んだ呼び出しがどこまで進んだか、その通信が送られて返ってきたかを見る
 */
async function diagnose(since: number): Promise<string> {
  try {
    const d = await send<FrameDiag | undefined>({ kind: 'diag', since }, 3_000);
    if (!d) return '埋め込みのページから診断の返事なし';
    const calls = d.calls.map((c) => `${c.path}:${c.stage}(${Math.round(c.ms / 100) / 10}秒)`).join(',') || 'なし';
    const net = d.net.map((n) => `${n.path}:${n.ms < 0 ? '未完了' : `${n.ms}ms`}`).join(',') || 'なし';
    return `ページは応答する・場所 ${d.path}・${d.visible}・部品 ${d.client ? 'あり' : 'なし'}・受け取り ${d.received}件・処理中 ${calls}・通信 ${net}`;
  } catch {
    return 'ページも応答しない';
  }
}

interface FrameDiag {
  path: string;
  visible: string;
  client: boolean;
  received: number;
  calls: { path: string; stage: string; ms: number }[];
  net: { path: string; ms: number }[];
}

/** 埋め込みで共有の中身を読む。埋め込みが使えなければ null */
export async function walkViaFrame(
  token: string,
  concurrency: number,
  onProgress: (p: { files: number; bytes: number; folders: number }) => void,
): Promise<WalkResult | null> {
  if (!(await ensureFrame())) return null;
  let lastAlive = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  try {
    progressTimer = setInterval(async () => {
      try {
        const p = await send<{ files: number; bytes: number; folders: number } | null>({ kind: 'progress', token }, 3_000);
        lastAlive = Date.now();
        if (p) onProgress(p);
      } catch {
        // 途中経過は出せなくても構わない
      }
    }, 700);
    const stalled = new Promise<'stalled'>((resolve) => {
      stallTimer = setInterval(() => {
        if (Date.now() - lastAlive > WALK_STALL_MS) resolve('stalled');
      }, 1000);
    });
    const run = send<WalkResult | undefined>({ kind: 'walk', token, concurrency }, 30 * 60_000).catch(() => undefined);
    const result = await Promise.race([run, stalled]);
    if (result === 'stalled' || !result) {
      markDown('共有の読み込み中に応答がなくなりました');
      return null;
    }
    return result;
  } finally {
    clearInterval(progressTimer);
    clearInterval(stallTimer);
  }
}

/**
 * 埋め込みに頼みを1つ送る（アカウントの読み取り・切り替えなど）。
 * 埋め込みが使えない・返事がなければ null（呼び出し側は固定タブで続ける）
 */
export async function frameRequest<T>(body: FrameRequest, timeoutMs = 5_000): Promise<{ value: T } | null> {
  if (!(await ensureFrame())) return null;
  try {
    const value = await send<T | undefined>(body, timeoutMs);
    // 返事が空なのは、埋め込みの中がまだ Linkex のページになっていないとき（頼みは送っていない）
    return value === undefined ? null : { value };
  } catch {
    return null;
  }
}
