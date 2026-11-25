export interface Settings {
  /** JDownloader 2 のローカルAPI（詳細設定の「Deprecated Api」）の接続先 */
  jdUrl: string;
  /** ダウンロード先の基準フォルダ（空ならJD2の既定フォルダ） */
  downloadDir: string;
  /** Linkex APIを呼ぶ間隔（ミリ秒）。一時的な速度制限を避けるため */
  apiIntervalMs: number;
  /** 公式Web版と同じく、転送量の上限に達したら一時停止する */
  pauseOnTrafficLimit: boolean;
  /** JD2に渡しておく数（URLには期限があるので、JD2の中で長く待たせないよう、渡すのはこの数まで） */
  maxDownloads: number;
  /**
   * JD2に渡した件を「強制ダウンロード開始」にする。JD2の同時ダウンロード数の設定を超えて始まるので、
   * JD2をほかの用途と共用していても、JD2の設定を変えずに「JD2に渡しておく数」まで同時に落とせる
   */
  forceStart: boolean;
  /**
   * Linkex側の処理を同時に進める数。LinkexのAPIを同時に呼ぶ数の上限も兼ねる
   * （保存せずに取るときは、URLの発行を同時に進める数。保存してから取るときは、保存〜削除を同時に進める数）
   */
  parallelItems: number;
  /**
   * 共有のファイルを自分のストレージに保存せず、共有から直接ダウンロードURLを発行してJD2へ渡す。
   * 直接取れなかった件だけ、これまでどおり保存 → URL発行 → 完全削除 で取る
   */
  directDownload: boolean;
  /**
   * JD2の空き待ちのあいだに、先に保存しておく数（先読み）。0 なら空きができてから保存する。
   * 保存してから取る件にだけ使う（「保存せずにダウンロード」がオンのときは 0 として扱う）
   */
  prefetchItems: number;
  /**
   * 自分のストレージ（ルートとゴミ箱）に残ったファイルを、Linkex側で処理中の件がないときに完全削除する。
   * 保存前からあったファイルも消すので、自分のファイルを置いていない人向け
   */
  cleanupLeftovers: boolean;
  /** すべて終わったとき・止まったときにWindowsの通知を出す */
  notifications: boolean;
  /**
   * 右クリックメニューから追加したら、すぐ開始する。
   * ポップアップ・専用ページ・共有ページのパネルから追加したときは、それぞれの画面の「追加したら開始する」で決まる
   */
  autoStartOnAdd: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  jdUrl: 'http://127.0.0.1:3128',
  downloadDir: '',
  apiIntervalMs: 300,
  pauseOnTrafficLimit: true,
  maxDownloads: 3,
  parallelItems: 3,
  forceStart: false,
  prefetchItems: 1,
  directDownload: true,
  cleanupLeftovers: false,
  notifications: true,
  autoStartOnAdd: true,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  // Motrix版の設定（rpcUrl・rpcSecret）は使わないので落とす
  const { rpcUrl: _url, rpcSecret: _secret, ...rest } = (stored[KEY] ?? {}) as Partial<Settings> & {
    rpcUrl?: string;
    rpcSecret?: string;
  };
  return { ...DEFAULT_SETTINGS, ...rest };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
