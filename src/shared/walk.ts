/** 共有をたどって集めたファイル（Linkexのページの中で集め、Service Worker と共有ページのパネルで使う） */
export interface WalkedFile {
  id: string;
  name: string;
  size: number | null;
  hash: string | null;
  /** 共有の中でのフォルダ（上から順） */
  folders: string[];
}

/** 共有を読んでいる途中の件数。Service Worker が storage に書き、共有ページのパネルが見て表示する */
export const WALK_PROGRESS_KEY = 'walkProgress';
export interface WalkProgress {
  /** tab: Linkexのタブを用意している / 省略: 読んでいる */
  phase?: 'tab';
  files: number;
  bytes: number;
  folders: number;
  at: number;
}
