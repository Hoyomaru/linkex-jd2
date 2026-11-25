import { directHttpLink } from '../shared/jd2-status';
import { requestJd, type RequestOptions } from '../shared/jd2-request';
import { loadSettings } from '../shared/settings';

/**
 * JDownloader 2 のローカルAPI（詳細設定の「Deprecated Api」、初期値 http://127.0.0.1:3128）を呼ぶ。
 * 引数は JSON にして URL エンコードし、順番どおり `?a&b` の形で渡す。応答は { data: ... }。
 * JD2はリクエストに Origin ヘッダーが付いていると断るので、拡張機能からのリクエストでは外している（origin-rule.ts）。
 */
export function jd<T = unknown>(path: string, ...params: unknown[]): Promise<T> {
  return jdWith<T>({}, path, ...params);
}

/**
 * 呼び直しを少なくした呼び方（画面の状態確認・開始前の確認用）。
 * JD2 が起動していないときに、ふつうの呼び方だと約9秒待ってからでないと分からないため。
 * JD2 は接続の2〜3割をいきなり切るので、5回（待ちは合計約3秒）までは呼び直す（続けて5回切られるのは 0.3% ほど）
 */
const QUICK: RequestOptions = { attempts: 5, timeoutMs: 3_000 };

async function jdWith<T>(options: RequestOptions, path: string, ...params: unknown[]): Promise<T> {
  const { jdUrl } = await loadSettings();
  const query = params.map((p) => encodeURIComponent(JSON.stringify(p))).join('&');
  const url = `${jdUrl.replace(/\/+$/, '')}/${path}${query ? `?${query}` : ''}`;

  // 切られたら呼び直す。ずっとつながらなければ Jd2ConnectionError
  const res = await requestJd(url, options);
  const json = res.json as { data?: T; type?: string } | null;
  if (!res.ok || !json) {
    const hint = json?.type === 'AUTH_FAILED' ? '（JD2にリクエストを断られました。拡張機能を再読み込みしてください）' : '';
    throw new Error(`JD2のエラー: ${json?.type ?? `HTTP ${res.status}`}${hint}（${path}）`);
  }
  return json.data as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getVersion(): Promise<number> {
  return jd<number>('jd/version');
}

/** JD2 につながるかを手早く確かめる。つながらなければ Jd2ConnectionError */
export async function pingJd(): Promise<void> {
  await jdWith(QUICK, 'jd/version');
}

const GENERAL = 'org.jdownloader.settings.GeneralSettings';

/** JD2の既定の保存先フォルダ。1件ごとに聞かないよう、しばらく覚えておく */
let folderCache: { jdUrl: string; folder: string; at: number } | null = null;
const FOLDER_CACHE_MS = 60_000;
async function defaultFolder(): Promise<string> {
  const { jdUrl } = await loadSettings();
  if (folderCache && folderCache.jdUrl === jdUrl && Date.now() - folderCache.at < FOLDER_CACHE_MS) return folderCache.folder;
  const folder = await jd<string>('config/get', GENERAL, null, 'DefaultDownloadFolder');
  folderCache = { jdUrl, folder, at: Date.now() };
  return folder;
}

/** 接続テストで見せる、JD2の同時ダウンロードの設定（読めなかった項目は null） */
export interface JdInfo {
  version: number;
  maxDownloads: number | null;
  perHostEnabled: boolean | null;
  perHost: number | null;
  chunks: number | null;
}

export async function getInfo(): Promise<JdInfo> {
  const version = await getVersion();
  const read = <T>(key: string) => jd<T>('config/get', GENERAL, null, key).catch(() => null);
  const [maxDownloads, perHostEnabled, perHost, chunks] = await Promise.all([
    read<number>('MaxSimultaneDownloads'),
    read<boolean>('MaxDownloadsPerHostEnabled'),
    read<number>('MaxSimultaneDownloadsPerHost'),
    read<number>('MaxChunksPerFile'),
  ]);
  return { version, maxDownloads, perHostEnabled, perHost, chunks };
}

/** リンクの読み取り（JD2が URL を確かめる）を待つ上限 */
const CRAWL_TIMEOUT_MS = 60_000;

/**
 * ダウンロードを追加して、ダウンロード一覧でのリンクのIDを返す。
 * CDN の URL にはファイル名が入っていないので、リンクグラバーで名前を付けてからダウンロード一覧へ移す
 * （IDはリンクグラバーとダウンロード一覧で同じ）。
 * dir は基準フォルダからの相対パスを受け取り、設定の基準フォルダ（空なら JD2 の既定）とつなげる。
 */
export async function addDownload(url: string, opts: { dir?: string; out?: string } = {}): Promise<string> {
  const { downloadDir, forceStart } = await loadSettings();
  const folder = joinDir(downloadDir || (await defaultFolder()), opts.dir ?? '');
  let job: { id: number } | undefined;
  try {
    job = await jd<{ id: number }>('linkgrabberv2/addLinks', {
      // CDN が application/xml で返すファイルをページとして読みに行かないよう、直接のダウンロードとして渡す
      links: directHttpLink(url),
      destinationFolder: folder,
      // リンクグラバーでは同じ名前のパッケージにまとめられてしまうので、保存先ごとに違う名前にする
      packageName: opts.dir || 'Linkex',
      overwritePackagizerRules: true,
      autostart: false,
      assignJobID: true,
    });
    const link = await waitCrawled(job.id, url);
    if (opts.out) await jd('linkgrabberv2/renameLink', link.uuid, opts.out);
    await jd('linkgrabberv2/moveToDownloadlist', [link.uuid], []);
    // 止まっていたら動かす（動いていれば何も起きない）
    await jd('downloadcontroller/start').catch(() => undefined);
    // JD2の同時ダウンロード数の設定に関係なく、すぐ始めさせる（失敗しても、ふつうの順番で始まる）
    if (forceStart) await jd('downloadsV2/forceDownload', [link.uuid], []).catch(() => undefined);
    return String(link.uuid);
  } catch (e) {
    // 途中で失敗したら、リンクグラバーに残った分を片付ける。
    // 追加の返事を受け取れなかった場合も、JD2 は追加していることが多い。読み取りが終わって出てくるのを少し待ってから URL で探す
    if (!job) await sleep(2_000);
    const byJob = job
      ? await jd<{ uuid: number }[]>('linkgrabberv2/queryLinks', { jobUUIDs: [job.id] }).catch(() => [])
      : [];
    const byUrl = await grabbedByUrl(url).catch(() => []);
    const left = [...new Map([...byJob, ...byUrl].map((l) => [l.uuid, l])).values()];
    if (left.length) await jd('linkgrabberv2/removeLinks', left.map((l) => l.uuid), []).catch(() => undefined);
    throw e;
  }
}

/** リンクグラバーにある、この URL のリンク */
async function grabbedByUrl(url: string): Promise<{ uuid: number }[]> {
  const plain = url.replace(/^directhttp:\/\//i, '');
  const links = await jd<{ uuid: number; url?: string }[]>('linkgrabberv2/queryLinks', { url: true, maxResults: -1, startAt: 0 });
  return links.filter((l) => l.url === plain);
}

/** ジョブが終わってから、同じ URL のリンクが出てくるのを待つ時間 */
const SAME_URL_WAIT_MS = 5_000;

/**
 * 追加したリンクがリンクグラバーに出てくるのを待つ。URLが使えないとJD2は何も出さずに終わる。
 * JD2 は接続を切っても追加は受け付けていることが多く、呼び直すと同じ URL を2回追加することになる。
 * JD2 は2回目を重複として捨てるので、こちらのジョブには何も出てこない。そのときは URL で探して、先に入った方を使う
 */
async function waitCrawled(jobId: number, url: string): Promise<{ uuid: number }> {
  const started = Date.now();
  let jobGoneAt = 0;
  // 実測では 0.2〜1.6秒で出てくる。JD2への確認はPCの中で軽いので、細かく見る
  for (let delay = 100; Date.now() - started < CRAWL_TIMEOUT_MS; delay = Math.min(delay * 1.5, 1000)) {
    await sleep(delay);
    const links = await jd<{ uuid: number }[]>('linkgrabberv2/queryLinks', { jobUUIDs: [jobId] });
    if (links.length > 0) return links[0];
    if (jobGoneAt) {
      const same = await grabbedByUrl(url);
      if (same.length > 0) return same[0];
      // 読み取りが終わっても出てこなければ、JD2が受け付けなかった
      if (Date.now() - jobGoneAt >= SAME_URL_WAIT_MS) break;
      continue;
    }
    const jobs = await jd<unknown[]>('linkgrabberv2/queryLinkCrawlerJobs', { jobIds: [jobId] });
    if (jobs.length === 0) jobGoneAt = Date.now();
  }
  const jobGone = jobGoneAt > 0;
  throw new Error(
    jobGone
      ? 'JD2がリンクを受け付けませんでした（ダウンロードURLが使えない・JD2に同じURLが残っているなど）'
      : 'JD2がリンクを読み取れませんでした（1分以内に終わりませんでした）',
  );
}

export interface JdLink {
  uuid: number;
  name?: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  speed?: number;
  finished?: boolean;
  running?: boolean;
  enabled?: boolean;
  skipped?: boolean;
  status?: string;
  statusIconKey?: string;
}

const LINK_FIELDS = {
  bytesLoaded: true,
  bytesTotal: true,
  speed: true,
  finished: true,
  running: true,
  enabled: true,
  skipped: true,
  status: true,
  maxResults: -1,
  startAt: 0,
};

/** ダウンロード一覧のリンクのうち、ids のもの */
export async function queryLinks(ids: string[], { quick = false } = {}): Promise<JdLink[]> {
  if (ids.length === 0) return [];
  const all = await jdWith<JdLink[]>(quick ? QUICK : {}, 'downloadsV2/queryLinks', LINK_FIELDS);
  const want = new Set(ids);
  return all.filter((l) => want.has(String(l.uuid)));
}

/**
 * 失敗したリンクを、落としかけのファイルごとダウンロード一覧から消す。
 * ファイルを残すと、同じ名前で渡し直したときに JD2 が「ファイルがあります」と聞いてきて止まるため。
 */
export async function discardLinks(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await jd('downloadsV2/cleanup', ids.map(Number), [], 'DELETE_ALL', 'REMOVE_LINKS_AND_DELETE_FILES', 'SELECTED');
}

/**
 * 動いているのに進まなくなったリンクを、いったん止めて動かし直す（受け取った分は残り、続きから再開する）。
 * 全部受け取ったのに仕上げ（.part を外す）に進まず「開始中...」のまま止まることがあり、これで抜けられる
 */
export async function nudgeLinks(ids: string[], force: boolean): Promise<void> {
  if (ids.length === 0) return;
  const links = ids.map(Number);
  await jd('downloadsV2/setEnabled', false, links, []);
  await sleep(2_000);
  // 有効に戻せないと、無効のまま止まってしまうので、何回か試す
  for (let attempt = 1; ; attempt++) {
    try {
      await jd('downloadsV2/setEnabled', true, links, []);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2_000);
    }
  }
  await jd('downloadcontroller/start').catch(() => undefined);
  if (force) await jd('downloadsV2/forceDownload', links, []).catch(() => undefined);
}

/** JD2全体のダウンロード速度（バイト/秒） */
export async function totalSpeed({ quick = false } = {}): Promise<number> {
  return jdWith<number>(quick ? QUICK : {}, 'downloadcontroller/getSpeedInBps');
}

function joinDir(base: string, rel: string): string {
  const parts = [base, rel].map((p) => p.replace(/[\\/]+$/, '')).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.join('\\').replace(/\//g, '\\');
}
