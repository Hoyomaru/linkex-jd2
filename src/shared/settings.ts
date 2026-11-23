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
  /** Linkex側の保存〜削除を同時に進める数（APIを同時に呼ぶ数も同じ） */
  parallelItems: number;
  /** JD2の空き待ちのあいだに、先に保存しておく数（先読み）。0 なら空きができてから保存する */
  prefetchItems: number;
  /** すべて終わったとき・止まったときにWindowsの通知を出す */
  notifications: boolean;
  /** 右クリックやページ内のリンク収集で追加したら、すぐ開始する */
  autoStartOnAdd: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  jdUrl: 'http://127.0.0.1:3128',
  downloadDir: '',
  apiIntervalMs: 300,
  pauseOnTrafficLimit: true,
  maxDownloads: 3,
  parallelItems: 3,
  prefetchItems: 1,
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
