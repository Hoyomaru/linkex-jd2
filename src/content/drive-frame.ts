import {
  linkexBridgeCall,
  linkexBridgeWalkShare,
  linkexReadAccounts,
  linkexSwitchAccount,
  type BridgeRequest,
} from '../background/linkex-bridge';
import { accountTraffic, findDriveClient, refreshAccount } from './account-ops';

/**
 * 拡張機能の裏のページ（offscreen.html）に埋め込まれた Linkex のドライブの中で動く（MAIN world）。
 * 親（拡張機能のページ）から postMessage で頼まれたら、固定タブのときと同じ関数でAPIを呼び、結果を返す。
 * 普通のタブで開いたドライブでは何もしない。
 */
export type FrameRequest =
  | { kind: 'ping' }
  | { kind: 'call'; req: BridgeRequest }
  | { kind: 'walk'; token: string; concurrency: number }
  | { kind: 'progress'; token: string }
  | { kind: 'diag'; since: number }
  /** Web版に覚えさせてあるアカウントの一覧（トークンは返さない） */
  | { kind: 'accounts' }
  /** Web版と同じ書き換えでアカウントを切り替える */
  | { kind: 'switch'; toUid: string; now: number }
  /** 今使っていないアカウントのログイン情報をその場で更新する（トークンは返さない） */
  | { kind: 'refreshAccount'; uid: string; now: number }
  /** 切り替えずに、そのアカウントの転送量を聞く */
  | { kind: 'accountTraffic'; uid: string };

/** 処理中の呼び出し（返事がないときに、どこまで進んだかを診断で返す） */
const inflight = new Map<number, { path: string; stage: string; at: number }>();
let nextCall = 1;
/** 受け取った呼び出しの数（頼みがページまで届いているかを見る） */
let received = 0;

const parentOrigin = window.top !== window ? (location.ancestorOrigins?.[0] ?? '') : '';

if (parentOrigin.startsWith('chrome-extension://')) {
  window.addEventListener('message', async (ev: MessageEvent) => {
    if (ev.origin !== parentOrigin || ev.source !== window.parent) return;
    const msg = ev.data as { __linkexJd2?: string; id?: number; body?: FrameRequest } | null;
    if (msg?.__linkexJd2 !== 'req' || typeof msg.id !== 'number' || !msg.body) return;
    let result: unknown;
    try {
      result = await handle(msg.body);
    } catch (e) {
      result = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    window.parent.postMessage({ __linkexJd2: 'res', id: msg.id, result }, parentOrigin);
  });
}

async function handle(body: FrameRequest): Promise<unknown> {
  switch (body.kind) {
    case 'ping': {
      const pattern = /\/drive\/assets\/js\/index-[^/]+\.js(\?.*)?$/;
      const ready =
        document.readyState !== 'loading' &&
        (Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).some((s) => pattern.test(s.src)) ||
          performance.getEntriesByType('resource').some((e) => pattern.test(e.name)));
      return { ok: true, ready, path: location.pathname };
    }
    case 'call': {
      received++;
      const id = nextCall++;
      inflight.set(id, { path: body.req.path, stage: 'ページで開始', at: Date.now() });
      try {
        return await linkexBridgeCall(body.req);
      } finally {
        inflight.delete(id);
      }
    }
    case 'diag': {
      const origin = performance.timeOrigin;
      const net = performance
        .getEntriesByType('resource')
        .filter((e) => /\/api\//.test(e.name) && origin + e.startTime >= body.since - 1000)
        .slice(-8)
        .map((e) => ({
          path: new URL(e.name).pathname,
          ms: (e as PerformanceResourceTiming).responseEnd > 0 ? Math.round(e.duration) : -1,
        }));
      return {
        path: location.pathname,
        visible: document.visibilityState,
        client: !!(window as any).__linkexJd2Client,
        received,
        calls: [...inflight.values()].map((c) => ({ path: c.path, stage: c.stage, ms: Date.now() - c.at })),
        net,
      };
    }
    case 'walk':
      return linkexBridgeWalkShare(body.token, body.concurrency);
    case 'accounts':
      return linkexReadAccounts();
    case 'switch':
      return linkexSwitchAccount(body.toUid, body.now);
    // 通信部品が見つからなければ返事をしない（Service Worker 側は「埋め込みが使えない」として、次の見回りに回す）
    case 'refreshAccount': {
      const client = await findDriveClient();
      return client ? refreshAccount(body.uid, body.now, client) : undefined;
    }
    case 'accountTraffic': {
      const client = await findDriveClient();
      return client ? accountTraffic(body.uid, client) : undefined;
    }
    case 'progress': {
      const p = (window as any).__linkexJd2WalkProgress?.[body.token];
      return p && !p.done ? { files: p.files, bytes: p.bytes, folders: p.folders } : null;
    }
  }
}
