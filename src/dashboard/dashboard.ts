import { send } from '../shared/messages';
import { formatBytes, isFolder, linkexApi, unwrapFile } from '../shared/linkex-api';
import type { Settings } from '../shared/settings';
import { parseShareToken } from '../shared/share-url';
import { setupQueueView } from './queue-view';
import { setupAccountsView } from './accounts-view';
import { setMeter } from '../ui/summary';
import { secondPress } from '../ui/confirm';
import { HASHES_KEY } from '../shared/queue';
import { cleanupRemovesFinished } from '../shared/jd2-status';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- ログ ----------
function log(label: string, value?: unknown) {
  const time = new Date().toLocaleTimeString();
  const body = value === undefined ? '' : `\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
  const pre = $('log');
  pre.textContent = `[${time}] ${label}${body}\n\n${pre.textContent ?? ''}`.slice(0, 200_000);
}

const queueView = setupQueueView(log);
$('log-clear').addEventListener('click', (ev) => {
  if (secondPress(ev.currentTarget as HTMLButtonElement, 'もう一度押すと消します')) $('log').textContent = '';
});

/** 失敗を、確認用タブのログと、どのタブからも見える画面上部のお知らせに出す */
function showError(e: unknown) {
  const message = String((e as Error)?.message ?? e);
  log(`エラー: ${message}`);
  queueView.showNotice(`うまくいきませんでした: ${message}`);
}

/** ボタンを押している間は無効にして、例外は画面とログに出す */
function action(button: HTMLButtonElement, fn: () => Promise<void>) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      button.disabled = false;
    }
  });
}

function makeButton(
  text: string,
  onClick: (button: HTMLButtonElement) => Promise<void>,
  className = '',
): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  action(b, () => onClick(b));
  return b;
}

function fillTable(tableId: string, rows: HTMLTableRowElement[]) {
  const table = $<HTMLTableElement>(tableId);
  const tbody = table.tBodies[0];
  tbody.replaceChildren(...rows);
  table.hidden = false;
}

function fileRow(name: string, size: string, buttons: HTMLButtonElement[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const tdName = document.createElement('td');
  tdName.textContent = name;
  const tdSize = document.createElement('td');
  tdSize.textContent = size;
  const tdActions = document.createElement('td');
  tdActions.className = 'actions';
  tdActions.append(...buttons);
  tr.append(tdName, tdSize, tdActions);
  return tr;
}

function listOf(data: any): any[] {
  return Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
}

// ---------- タブ ----------
const TABS = ['queue', 'log', 'settings', 'tools'];
function showTab() {
  const name = location.hash.slice(1);
  const tab = TABS.includes(name) ? name : 'queue';
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== tab));
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((a) => {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    // タブはページ内のリンクなので、今のページを aria-current で伝える
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', showTab);
showTab();

// ---------- Linkex の状態 ----------
const accountsView = setupAccountsView(log);

async function refreshLinkex() {
  try {
    const [usage, traffic] = await Promise.all([linkexApi.usage(), linkexApi.traffic()]);
    $('usage-text').textContent = `${formatBytes(usage.usedSpace)} / ${formatBytes(usage.totalSpace)}`;
    setMeter($('usage-bar'), usage.usedSpace, usage.totalSpace);
    const reset = traffic.resetTime ? new Date(traffic.resetTime * 1000).toLocaleString() : '-';
    $('traffic-text').textContent = `${formatBytes(traffic.usedTraffic)} / ${formatBytes(traffic.totalTraffic)}`;
    queueView.setTraffic(traffic);
    $('traffic-metric').title = `直近24時間の転送量（目安）。リセット ${reset}`;
    setMeter($('traffic-bar'), traffic.usedTraffic, traffic.totalTraffic);
    void accountsView.refresh({ used: traffic.usedTraffic, total: traffic.totalTraffic });
  } catch (e) {
    void accountsView.refresh(null);
    $('usage-text').textContent = '取得できません';
    $('usage-text').title = (e as Error).message;
    $('traffic-text').textContent = '-';
    throw e;
  }
}
action($('linkex-refresh'), refreshLinkex);
action($('linkex-open'), async () => {
  const res = await send({ type: 'linkex.openTab' });
  if (!res.ok) throw new Error(res.error);
});

// ---------- JD2 ----------
action($('jd-test'), async () => {
  const el = $('jd-status');
  el.textContent = '確認中…';
  el.className = 'muted';
  // 入力中（未保存）の設定ではなく、保存済みの設定で試す。書き換えて保存していなければ、そう添える
  const unsaved = formDirty ? '（保存済みの設定で試しました。変えた接続先は「保存」を押すと使われます）' : '';
  const res = await send({ type: 'jd.info' });
  if (res.ok) {
    const j = res.data;
    const num = (n: number | null) => (n === null ? '?' : String(n));
    const perHost = j.perHostEnabled === false ? '制限なし' : num(j.perHost);
    el.textContent =
      `接続OK（JD2 ビルド ${j.version}）・JD2の設定: 同時ダウンロード ${num(j.maxDownloads)}・同じホストから ${perHost}・1ファイルの分割数 ${num(j.chunks)}`;
    // Linkexのファイルはすべて同じCDNから来るので、同じホストからの数が1だと1件ずつしか落ちない
    if (j.perHostEnabled !== false && j.perHost === 1) {
      el.textContent += '。同じホストからの数が1なので、1件ずつ落とします（JD2の「設定 → 一般」で変えられます）';
    }
    // 完了した件をすぐ一覧から消されると、受け取った量が足りているかを確かめられず、消えたことで完了とみなすしかない
    if (cleanupRemovesFinished(j.cleanup)) {
      el.textContent +=
        '。JD2が完了したダウンロードを一覧からすぐ消す設定なので、受け取った量が足りているかを確かめられません' +
        '（JD2の「設定 → 一般 → 完了したダウンロードを削除」を「しない」か「終了時」にするのがおすすめです）';
    }
    el.textContent += unsaved;
    el.className = 'ok';
  } else {
    el.textContent = res.error + unsaved;
    el.className = 'ng';
  }
});

// ---------- 設定 ----------
const form = $<HTMLFormElement>('settings');
/** 読み込んだ後・保存した後に、書き換えたものがあるか */
let formDirty = false;
form.addEventListener('input', () => (formDirty = true));

/** 範囲の外の数値は丸めて保存するので、丸めたことを知らせる */
function clampField(form: HTMLFormElement, name: string, label: string, min: number, max: number, adjusted: string[]): number {
  const input = form.elements.namedItem(name) as HTMLInputElement;
  const raw = Number(input.value);
  const value = Math.min(max, Math.max(min, Math.floor(Number.isFinite(raw) ? raw : min)));
  if (String(value) !== input.value.trim()) {
    adjusted.push(`${label}を${value}に`);
    input.value = String(value);
  }
  return value;
}

async function loadSettingsIntoForm() {
  const res = await send({ type: 'settings.get' });
  if (!res.ok) return log(`設定の読み込みに失敗: ${res.error}`);
  const s = res.data;
  (form.elements.namedItem('jdUrl') as HTMLInputElement).value = s.jdUrl;
  (form.elements.namedItem('downloadDir') as HTMLInputElement).value = s.downloadDir;
  (form.elements.namedItem('apiIntervalMs') as HTMLInputElement).value = String(s.apiIntervalMs);
  (form.elements.namedItem('maxDownloads') as HTMLInputElement).value = String(s.maxDownloads);
  (form.elements.namedItem('parallelItems') as HTMLInputElement).value = String(s.parallelItems);
  (form.elements.namedItem('prefetchItems') as HTMLInputElement).value = String(s.prefetchItems);
  (form.elements.namedItem('directDownload') as HTMLInputElement).checked = s.directDownload;
  (form.elements.namedItem('forceStart') as HTMLInputElement).checked = s.forceStart;
  (form.elements.namedItem('pauseOnTrafficLimit') as HTMLInputElement).checked = s.pauseOnTrafficLimit;
  (form.elements.namedItem('cleanupLeftovers') as HTMLInputElement).checked = s.cleanupLeftovers;
  (form.elements.namedItem('notifications') as HTMLInputElement).checked = s.notifications;
  (form.elements.namedItem('notifyEachShare') as HTMLInputElement).checked = s.notifyEachShare;
  (form.elements.namedItem('fixExtensions') as HTMLInputElement).checked = s.fixExtensions;
  (form.elements.namedItem('autoStartOnAdd') as HTMLInputElement).checked = s.autoStartOnAdd;
  formDirty = false;
}
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = (name: string) => (form.elements.namedItem(name) as HTMLInputElement);
  const adjusted: string[] = [];
  const patch: Partial<Settings> = {
    jdUrl: v('jdUrl').value.trim(),
    downloadDir: v('downloadDir').value.trim(),
    apiIntervalMs: clampField(form, 'apiIntervalMs', 'APIを呼ぶ間隔', 0, Number.MAX_SAFE_INTEGER, adjusted),
    maxDownloads: clampField(form, 'maxDownloads', 'JD2に渡しておく数', 1, 16, adjusted),
    parallelItems: clampField(form, 'parallelItems', '同時に処理する数', 1, 6, adjusted),
    directDownload: v('directDownload').checked,
    forceStart: v('forceStart').checked,
    prefetchItems: clampField(form, 'prefetchItems', '先に保存しておく数', 0, 3, adjusted),
    pauseOnTrafficLimit: v('pauseOnTrafficLimit').checked,
    cleanupLeftovers: v('cleanupLeftovers').checked,
    notifications: v('notifications').checked,
    notifyEachShare: v('notifyEachShare').checked,
    fixExtensions: v('fixExtensions').checked,
    autoStartOnAdd: v('autoStartOnAdd').checked,
  };
  const res = await send({ type: 'settings.set', patch });
  const saved = $('settings-saved');
  clearTimeout(savedTimer);
  if (res.ok) {
    formDirty = false;
    saved.textContent = adjusted.length ? `保存しました（範囲の外だったので、${adjusted.join('・')}直しました）` : '保存しました';
    saved.className = 'ok';
    // 丸めたことは読めるよう残し、うまくいっただけのときは少しで消す
    if (!adjusted.length) savedTimer = setTimeout(() => (saved.textContent = ''), 3000);
  } else {
    // 失敗は、読めるよう消さずに残す
    saved.textContent = `保存に失敗: ${res.error}`;
    saved.className = 'ng';
  }
});
let savedTimer: ReturnType<typeof setTimeout> | undefined;

// ---------- 1. 共有リンクの中身 ----------
async function showShare(token: string, trail: { id?: string; name: string }[]) {
  const parentId = trail[trail.length - 1]?.id;
  const content = await linkexApi.shareContent(token, parentId);
  log(`共有の中身 ${token}${parentId ? ` / ${parentId}` : ''}`, content);
  $('share-path').textContent = trail.map((t) => t.name).join(' / ');

  const rows: HTMLTableRowElement[] = [];
  if (trail.length > 1) {
    rows.push(fileRow('..（上へ）', '', [makeButton('戻る', () => showShare(token, trail.slice(0, -1)))]));
  }
  for (const item of listOf(content)) {
    const f = unwrapFile(item);
    const id = String(f.id);
    if (isFolder(f)) {
      rows.push(fileRow(`📁 ${f.name}`, '', [makeButton('開く', () => showShare(token, [...trail, { id, name: f.name }]))]));
    } else {
      rows.push(fileRow(f.name, formatBytes(f.size), [makeButton('自分のストレージに保存', () => copyOne(token, id, f.name), 'primary')]));
    }
  }
  fillTable('share-table', rows);
}

action($('share-load'), async () => {
  const token = parseShareToken($<HTMLInputElement>('share-input').value);
  if (!token) throw new Error('共有URLの形式を読み取れませんでした');
  const info = await linkexApi.share(token);
  log(`共有情報 ${token}`, info);
  const name = info?.share?.name ?? info?.name ?? token;
  await showShare(token, [{ name }]);
});

async function copyOne(token: string, fileId: string, name: string) {
  log(`保存を開始: ${name}`);
  const result = await linkexApi.copyFromShare(token, fileId);
  log('file/copy の応答', result);
  const taskId = result?.taskId;
  if (!taskId) {
    log('taskId がないため、完了待ちはしません');
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    await new Promise((r) => setTimeout(r, 1000));
    const task = await linkexApi.task(String(taskId));
    const t = task?.task ?? task;
    const status = String(t?.status ?? '').toLowerCase();
    if (status === 'success') {
      log(`保存が完了: ${name}`, task);
      await loadMine();
      return;
    }
    if (status && !['pending', 'running', 'processing', 'waiting', 'queued', 'init'].includes(status)) {
      log(`保存が失敗または想定外の状態: ${status}`, task);
      return;
    }
  }
  log('保存の完了を2分待ちましたが終わりませんでした');
}

// ---------- 2. 自分のファイル ----------
interface IssuedUrl { fileId: string; name: string; url: string; issuedAt: number; result: string }
const issuedUrls: IssuedUrl[] = [];

async function loadMine() {
  const data = await linkexApi.myFiles();
  log('自分のファイル', data);
  const rows = listOf(data).map((item) => {
    const f = unwrapFile(item);
    const id = String(f.id);
    if (isFolder(f)) return fileRow(`📁 ${f.name}`, '', []);
    return fileRow(f.name, formatBytes(f.size), [
      makeButton('URL取得', async () => {
        await issueUrl(id, f.name);
      }),
      makeButton('JD2へ送る', () => sendToJd(id, f.name), 'primary'),
      makeButton('ゴミ箱へ', async () => {
        log('ゴミ箱へ移動', await linkexApi.moveToTrash(id));
        await loadMine();
        await loadTrash();
      }),
    ]);
  });
  fillTable('mine-table', rows);
}
action($('mine-load'), loadMine);

async function issueUrl(fileId: string, name: string): Promise<string> {
  const data = await linkexApi.fileGet(fileId);
  const url = String(data?.file?.url ?? data?.url ?? '');
  if (!url) throw new Error('ダウンロードURLが応答に含まれていません');
  issuedUrls.unshift({ fileId, name, url, issuedAt: Date.now(), result: '-' });
  renderUrls();
  log(`URLを発行: ${name}`, url);
  return url;
}

async function sendToJd(fileId: string, name: string) {
  const url = await issueUrl(fileId, name);
  const res = await send({ type: 'jd.add', url, out: name });
  if (!res.ok) throw new Error(res.error);
  log(`JD2に追加しました: ${name}（ID ${res.data}）`);
}

function renderUrls() {
  const rows = issuedUrls.map((u) => {
    const tr = document.createElement('tr');
    const age = Math.round((Date.now() - u.issuedAt) / 1000);
    tr.innerHTML = '<td></td><td></td><td></td><td class="actions"></td>';
    tr.cells[0].textContent = u.name;
    tr.cells[1].textContent = `${new Date(u.issuedAt).toLocaleTimeString()}（${age}秒前）`;
    tr.cells[2].textContent = u.result;
    tr.cells[3].append(
      makeButton('まだ使えるか確認', async () => {
        const res = await send({ type: 'cdn.probe', url: u.url });
        const elapsed = Math.round((Date.now() - u.issuedAt) / 1000);
        u.result = res.ok ? `HTTP ${res.data.status}（発行から${elapsed}秒）` : `失敗: ${res.error}`;
        log(`URL確認: ${u.name}`, u.result);
        renderUrls();
      }),
    );
    return tr;
  });
  fillTable('urls-table', rows);
}

// ---------- 3. ゴミ箱 ----------
async function loadTrash() {
  const data = await linkexApi.trashList();
  log('ゴミ箱', data);
  const rows = listOf(data).map((item) => {
    const f = unwrapFile(item);
    const id = String(f.id);
    return fileRow(f.name, formatBytes(f.size), [
      makeButton('元に戻す', async () => {
        log('元に戻す', await linkexApi.restore(id));
        await loadTrash();
        await loadMine();
      }),
      makeButton('完全削除', async (button) => {
        if (!secondPress(button, 'もう一度押すと完全削除')) return;
        log(`完全削除: ${f.name}`, await linkexApi.deleteForever(id));
        await loadTrash();
        await refreshLinkex();
      }, 'danger'),
    ]);
  });
  fillTable('trash-table', rows);
}
action($('trash-load'), loadTrash);

// ---------- 起動時 ----------
void loadSettingsIntoForm();
const refreshQuietly = () =>
  refreshLinkex().catch((e) => log(`Linkexの状態を取得できませんでした: ${(e as Error).message}`));
void refreshQuietly();
// 容量・転送量は1分ごとに取り直す（画面が見えているときだけ）
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshQuietly();
}, 60_000);

// ---------- ダウンロード済みの記録 ----------
const showHashCount = (hashes: Record<string, unknown> | undefined) => {
  $('hashes-count').textContent = `${Object.keys(hashes ?? {}).length.toLocaleString()}件`;
};
void chrome.storage.local.get(HASHES_KEY).then((v) => showHashCount(v[HASHES_KEY] as Record<string, unknown> | undefined));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[HASHES_KEY]) showHashCount(changes[HASHES_KEY].newValue as Record<string, unknown> | undefined);
});
$('hashes-clear').addEventListener('click', async (ev) => {
  const button = ev.currentTarget as HTMLButtonElement;
  if (!secondPress(button, 'もう一度押すと記録を消します')) return;
  button.disabled = true;
  try {
    const res = await send({ type: 'hashes.clear' });
    if (!res.ok) throw new Error(res.error);
    log('ダウンロード済みの記録を消しました');
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
});
