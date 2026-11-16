import { loadSettings } from '../shared/settings';

/**
 * JDownloader 2 のローカルAPI（詳細設定の「Deprecated Api」、初期値 http://127.0.0.1:3128）を呼ぶ。
 * 引数は JSON にして URL エンコードし、順番どおり `?a&b` の形で渡す。応答は { data: ... }。
 * JD2はリクエストに Origin ヘッダーが付いていると断るので、拡張機能からのリクエストでは外している（origin-rule.ts）。
 */
export async function jd<T = unknown>(path: string, ...params: unknown[]): Promise<T> {
  const { jdUrl } = await loadSettings();
  const query = params.map((p) => encodeURIComponent(JSON.stringify(p))).join('&');
  const url = `${jdUrl.replace(/\/+$/, '')}/${path}${query ? `?${query}` : ''}`;

  let res: Response | undefined;
  // JD2はときどき接続を切ることがあるので、つながらなかったら少し待って何度か試す
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      // JD2が固まっていても処理全体が止まらないよう、15秒で諦める
      res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    } catch {
      // 次の回へ
    }
  }
  if (!res) {
    throw new Error(
      'JD2に接続できません。JD2が起動しているか、詳細設定の「Deprecated Api」がオンか、接続先の設定を確認してください',
    );
  }
  const json = (await res.json().catch(() => null)) as { data?: T; type?: string } | null;
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

/** JD2の既定の保存先フォルダ */
async function defaultFolder(): Promise<string> {
  return jd<string>('config/get', 'org.jdownloader.settings.GeneralSettings', null, 'DefaultDownloadFolder');
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
  const { downloadDir } = await loadSettings();
  const folder = joinDir(downloadDir || (await defaultFolder()), opts.dir ?? '');
  const job = await jd<{ id: number }>('linkgrabberv2/addLinks', {
    links: url,
    destinationFolder: folder,
    // リンクグラバーでは同じ名前のパッケージにまとめられてしまうので、保存先ごとに違う名前にする
    packageName: opts.dir || 'Linkex',
    overwritePackagizerRules: true,
    autostart: false,
    assignJobID: true,
  });

  try {
    const link = await waitCrawled(job.id);
    if (opts.out) await jd('linkgrabberv2/renameLink', link.uuid, opts.out);
    await jd('linkgrabberv2/moveToDownloadlist', [link.uuid], []);
    // 止まっていたら動かす（動いていれば何も起きない）
    await jd('downloadcontroller/start').catch(() => undefined);
    return String(link.uuid);
  } catch (e) {
    // 途中で失敗したら、リンクグラバーに残った分を片付ける
    const left = await jd<{ uuid: number }[]>('linkgrabberv2/queryLinks', { jobUUIDs: [job.id] }).catch(() => []);
    if (left.length) await jd('linkgrabberv2/removeLinks', left.map((l) => l.uuid), []).catch(() => undefined);
    throw e;
  }
}

/** 追加したリンクがリンクグラバーに出てくるのを待つ。URLが使えないとJD2は何も出さずに終わる */
async function waitCrawled(jobId: number): Promise<{ uuid: number }> {
  const started = Date.now();
  let jobGone = false;
  for (let delay = 300; Date.now() - started < CRAWL_TIMEOUT_MS; delay = Math.min(delay * 1.5, 3000)) {
    await sleep(delay);
    const links = await jd<{ uuid: number }[]>('linkgrabberv2/queryLinks', { jobUUIDs: [jobId] });
    if (links.length > 0) return links[0];
    // 読み取りが終わってもリンクが出てこなければ、JD2が受け付けなかった（もう1回だけ見てから諦める）
    if (jobGone) break;
    const jobs = await jd<unknown[]>('linkgrabberv2/queryLinkCrawlerJobs', { jobIds: [jobId] });
    jobGone = jobs.length === 0;
  }
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
export async function queryLinks(ids: string[]): Promise<JdLink[]> {
  if (ids.length === 0) return [];
  const all = await jd<JdLink[]>('downloadsV2/queryLinks', LINK_FIELDS);
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

/** JD2全体のダウンロード速度（バイト/秒） */
export async function totalSpeed(): Promise<number> {
  return jd<number>('downloadcontroller/getSpeedInBps');
}

function joinDir(base: string, rel: string): string {
  const parts = [base, rel].map((p) => p.replace(/[\\/]+$/, '')).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.join('\\').replace(/\//g, '\\');
}
