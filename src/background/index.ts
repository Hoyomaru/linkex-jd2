import type { JdLive, Request, Response } from '../shared/messages';
import { ACTIVE_STATES, FINISHED_STATES, type QueueItem } from '../shared/queue';
import { loadSettings, saveSettings } from '../shared/settings';
import { kick, pause, start } from './engine';
import { refreshDownloads } from './jd-monitor';
import { addWalkedToQueue, enqueueShares } from './enqueue';
import { callLinkex, ensureLinkexTab, walkShareInTab } from './linkex-tab';
import { addDownload, getInfo, getVersion, queryLinks, totalSpeed } from './jd2';
import { clearEvents, clearHashes, mutateQueue, readEngine, readQueue } from './store';
import { watchBadge } from './badge';
import { createMenus, setupMenuClicks } from './menus';
import { setupNotificationClick } from './notify';
import { installOriginRule } from './origin-rule';

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  handle(message, sender.tab?.id)
    .then((data) => sendResponse({ ok: true, data } satisfies Response))
    .catch((e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) } satisfies Response));
  return true; // 非同期で応答する
});

// JD2に断られないよう、JD2へのリクエストから Origin を外す（Service Worker が起きるたびに入れ直す）
void installOriginRule();

// Service Worker が止められても、1分ごとに起きて続きを再開する
chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tick') return;
  const engine = await readEngine();
  if (!engine.paused) kick();
  else await refreshDownloads().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(resumeIfRunning);

// ツールバーの残り件数・右クリックメニュー・通知のクリック
watchBadge();
setupMenuClicks();
setupNotificationClick(() => openDashboard());
chrome.runtime.onInstalled.addListener(async () => {
  // Motrix版で渡したダウンロードは、Motrixの中で最後まで続くので、こちらでは完了扱いにする
  await mutateQueue((items) => {
    for (const item of items) {
      const old = item as QueueItem & { gid?: string };
      if (old.gid !== undefined) {
        if (item.state === 'downloading') {
          Object.assign(item, { state: 'done', note: 'Motrix版で渡した分（確認なし）', updatedAt: Date.now() });
        }
        delete old.gid;
      }
    }
  });
  createMenus();
  await resumeIfRunning();
});

/** 専用ページを開く。すでに開いていればそのタブを前に出す */
async function openDashboard(tab?: string): Promise<true> {
  const base = chrome.runtime.getURL('dashboard.html');
  const url = tab ? `${base}#${tab}` : undefined;
  // タブを切り替えた後は末尾に #log などが付くので、前方一致で探す
  const existing = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, url ? { active: true, url } : { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url ?? base });
  }
  return true;
}

async function resumeIfRunning() {
  const engine = await readEngine();
  if (!engine.paused) kick();
}

/** pageTabId: 頼んできたタブ（共有ページのパネルから頼まれたとき、そのページの中で共有を読むのに使う） */
async function handle(req: Request, pageTabId?: number): Promise<unknown> {
  switch (req.type) {
    case 'linkex.call': {
      const result = await callLinkex({ method: req.method, path: req.path, params: req.params, data: req.data });
      if (!result.ok) {
        throw new Error(`${result.error}${result.detail ? ` ${JSON.stringify(result.detail)}` : ''}`);
      }
      return result.data;
    }
    case 'linkex.openTab': {
      const tabId = await ensureLinkexTab();
      await chrome.tabs.update(tabId, { active: true });
      return tabId;
    }
    case 'jd.version':
      return getVersion();
    case 'jd.info':
      return getInfo();
    case 'jd.add':
      return addDownload(req.url, { dir: req.dir, out: req.out });
    case 'jd.active': {
      const ids = (await readQueue()).filter((i) => i.state === 'downloading' && i.jdId).map((i) => i.jdId!);
      // 画面の状態確認は、JD2 が落ちていることを早く見せたいので呼び直しを少なくする
      const [links, speed] = await Promise.all([queryLinks(ids, { quick: true }), totalSpeed({ quick: true })]);
      return {
        downloadSpeed: speed || 0,
        active: links
          .filter((l) => !l.finished)
          .map((l) => ({
            jdId: String(l.uuid),
            totalLength: l.bytesTotal ?? 0,
            completedLength: l.bytesLoaded ?? 0,
            downloadSpeed: l.speed ?? 0,
          })),
      } satisfies JdLive;
    }
    case 'cdn.probe':
      return probeCdn(req.url);

    case 'queue.add':
      return enqueueShares(req.text, pageTabId);
    case 'share.walk': {
      const res = await walkShareInTab(req.token, { pageTabId });
      if (!res.ok) throw new Error(res.error);
      return { shareName: res.shareName, files: res.files };
    }
    case 'queue.addFiles':
      return addWalkedToQueue([{ token: req.token, shareName: req.shareName, files: req.files, collapseRoot: req.collapseRoot }]);
    case 'dashboard.open':
      return openDashboard(req.tab);
    case 'queue.start':
      return start();
    case 'queue.pause':
      return pause();
    case 'queue.retry':
      return mutateQueue((items) => {
        const item = items.find((i) => i.id === req.id);
        if (item) retryItem(item);
      });
    case 'queue.retryFailed':
      return mutateQueue((items) => {
        let n = 0;
        for (const item of items) {
          if (item.state === 'error' && (!req.token || item.shareToken === req.token) && retryItem(item)) n++;
        }
        return n;
      });
    case 'queue.remove':
      return mutateQueue((items) => removeItems(items, new Set([req.id])));
    case 'queue.removeMany':
      return mutateQueue((items) => removeItems(items, new Set(req.ids)));
    case 'queue.clearFinished':
      return mutateQueue((items) => {
        const keep = items.filter((i) => !FINISHED_STATES.includes(i.state));
        items.splice(0, items.length, ...keep);
      });

    case 'events.clear':
      return clearEvents();
    case 'hashes.clear':
      return clearHashes();
    case 'settings.get':
      return loadSettings();
    case 'settings.set':
      return saveSettings(req.patch);
  }
}

/** 失敗・省略した件を、もう一度最初からやり直す状態に戻す */
function retryItem(item: QueueItem): boolean {
  if (item.state !== 'error' && item.state !== 'skipped') return false;
  // 「重複のため省略」を落とし直す場合は、重複判定を外す
  const force = item.state === 'skipped' || item.force;
  Object.assign(item, {
    state: 'retry',
    attempts: 0,
    error: undefined,
    note: undefined,
    duplicate: undefined,
    force,
    updatedAt: Date.now(),
  });
  return true;
}

/** 一覧から消す。保存中・削除中の件は、ストレージにコピーが残らないよう消させない */
function removeItems(items: QueueItem[], ids: Set<string>): number {
  const keep = items.filter((i) => !ids.has(i.id) || ACTIVE_STATES.includes(i.state));
  const removed = items.length - keep.length;
  items.splice(0, items.length, ...keep);
  return removed;
}

/** ダウンロードURLがまだ使えるかを、先頭1バイトだけ取得して確かめる */
async function probeCdn(url: string): Promise<{ status: number; contentRange: string | null }> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status, contentRange: res.headers.get('content-range') };
}
