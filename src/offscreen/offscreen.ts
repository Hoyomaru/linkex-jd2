/**
 * 拡張機能の裏のページ（画面には出ない）。Linkex のドライブを iframe で埋め込み、
 * Service Worker からの頼みを iframe の中のスクリプト（content/drive-frame.ts）へ取り次ぐ。
 * 固定タブの代わりに、ページ自身に署名とログイン情報を付けさせるための場所。
 */
const FRAME_ORIGIN = 'https://www.linkex.io';
const DRIVE_URL = `${FRAME_ORIGIN}/drive/all`;

/**
 * 埋め込みを作る。読み直すときも src を変えずに作り直す
 * （src を変えるだけだと、古いページが消えるまでのあいだ古いページが頼みを受けてしまい、
 * 準備の確認に「できた」と答えた直後に、頼んだ呼び出しごと消えるため）
 */
function makeFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  // ページが一番上の画面を移そうとしても（埋め込み除けなど）、このページごと移されないようにする
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
  frame.src = DRIVE_URL;
  document.body.append(frame);
  return frame;
}

let iframe = makeFrame();

let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.origin !== FRAME_ORIGIN || ev.source !== iframe.contentWindow) return;
  const msg = ev.data as { __linkexJd2?: string; id?: number; result?: unknown } | null;
  if (msg?.__linkexJd2 !== 'res' || typeof msg.id !== 'number') return;
  pending.get(msg.id)?.(msg.result);
  pending.delete(msg.id);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ほかの画面から Service Worker 宛てに送られたメッセージも届くので、自分宛てのものだけ扱う
  if (message?.target !== 'linkex-frame') return false;
  if (message.kind === 'reload') {
    for (const resolve of pending.values()) resolve({ ok: false, error: 'frame_reloaded' });
    pending.clear();
    iframe.remove();
    iframe = makeFrame();
    sendResponse({ ok: true });
    return false;
  }
  // 作り直した直後は iframe の中がまだ空のページ（拡張機能と同じ出どころ）なので、
  // Linkex 宛ての postMessage は例外にならず、エラーを記録して捨てられるだけになる。
  // そのときは送らずに、すぐ「返事なし」を返す
  // （Service Worker 側は、準備の確認ならやり直し、呼び出しなら固定タブで続ける。頼みは送っていないので二重にならない）
  if (!frameShowsLinkex()) {
    sendResponse(undefined);
    return false;
  }
  const id = nextId++;
  pending.set(id, sendResponse);
  iframe.contentWindow?.postMessage({ __linkexJd2: 'req', id, body: message.body }, FRAME_ORIGIN);
  return true; // 非同期で応答する（返事がなければ Service Worker 側の時間切れで諦める）
});

/**
 * iframe の中が Linkex のページになっているか。
 * 中身がまだ空のページなら拡張機能と同じ出どころなので場所を読めるが、
 * Linkex のページになっていれば出どころが違うので、読もうとすると例外になる
 */
function frameShowsLinkex(): boolean {
  const win = iframe.contentWindow;
  if (!win) return false;
  try {
    return win.location.origin === FRAME_ORIGIN;
  } catch {
    return true;
  }
}
