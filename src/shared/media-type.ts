/**
 * ファイルの先頭のバイト（マジックナンバー）から種類を調べ、拡張子が無いファイル名に拡張子を付ける。
 * 判定の決まりは scripts/fix-extensions.ps1 と同じ（変えるときはそろえる）。
 * ここでは、拡張子が無い・見慣れない名前に付け足すだけで、知っている拡張子の差し替えはしない
 * （中身と違う拡張子を直したいときは、落とした後に fix-extensions.ps1 を使う）
 */

/** 先頭から何バイト取れば判定できるか（MPEG-TS は 188 バイトごとの同期バイトを3つ見る） */
export const SNIFF_BYTES = 512;

/** 種類ごとに、正しいとみなす拡張子（先頭が付ける拡張子） */
const TYPES: Record<string, string[]> = {
  jpg: ['.jpg', '.jpeg', '.jfif', '.jpe'],
  png: ['.png'],
  gif: ['.gif'],
  webp: ['.webp'],
  bmp: ['.bmp'],
  avif: ['.avif'],
  heic: ['.heic', '.heif'],
  mp4: ['.mp4', '.m4v'],
  mov: ['.mov', '.qt'],
  m4a: ['.m4a'],
  webm: ['.webm'],
  mkv: ['.mkv'],
  avi: ['.avi'],
  flv: ['.flv'],
  ts: ['.ts', '.m2ts', '.mts'],
  mp3: ['.mp3'],
  wav: ['.wav'],
  pdf: ['.pdf'],
  zip: ['.zip'],
};

/** 拡張子として知っているもの。これが付いている名前には手を付けない */
const KNOWN_EXTS = new Set([
  ...Object.values(TYPES).flat(),
  ...['.tif', '.tiff', '.mpg', '.mpeg', '.wmv', '.3gp', '.html', '.htm', '.xml', '.txt', '.bin', '.dat', '.tmp', '.part'],
  ...['.7z', '.rar', '.gz', '.tar', '.psd', '.svg', '.json', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.apk', '.exe', '.iso', '.flac', '.ogg', '.aac', '.opus', '.srt', '.ass'],
]);

/** 名前の拡張子（小文字・ドット付き）。無ければ空 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** 知っている拡張子が付いているか（付いていなければ、中身を調べて付ける対象） */
export function hasKnownExtension(name: string): boolean {
  return KNOWN_EXTS.has(extensionOf(name));
}

const ascii = (b: Uint8Array, start: number, len: number): string =>
  b.length < start + len ? '' : String.fromCharCode(...b.subarray(start, start + len));

/** 先頭のバイトから種類（付ける拡張子、ドットなし）を返す。分からなければ null */
export function detectType(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26) return 'bmp';
  if (ascii(b, 0, 4) === '%PDF') return 'pdf';
  if (ascii(b, 0, 4) === 'PK\u0003\u0004') return 'zip';
  if (ascii(b, 0, 3) === 'FLV') return 'flv';
  if (ascii(b, 0, 3) === 'ID3') return 'mp3';
  if (ascii(b, 0, 4) === 'RIFF') {
    const kind = ascii(b, 8, 4);
    if (kind === 'WEBP') return 'webp';
    if (kind === 'AVI ') return 'avi';
    if (kind === 'WAVE') return 'wav';
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'qt  ') return 'mov';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (brand === 'M4A ') return 'm4a';
    return 'mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return ascii(b, 0, b.length).includes('webm') ? 'webm' : 'mkv';
  }
  // MPEG-TS: 188 バイトごとに 0x47
  if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'ts';
  // ID3 タグなし MP3（フレーム同期）
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** 拡張子が無い・見慣れない名前に、中身の種類の拡張子を付け足す（付けなくてよいなら null） */
export function nameWithDetectedType(name: string, head: Uint8Array): string | null {
  if (hasKnownExtension(name)) return null;
  const type = detectType(head);
  return type ? `${name}.${type}` : null;
}

/** ファイルの大まかな種類（「選んで追加」の絞り込み用）。名前の拡張子で決める */
export type FileKind = 'video' | 'image' | 'audio' | 'archive' | 'other';

const KIND_EXTS: Record<Exclude<FileKind, 'other'>, string[]> = {
  video: ['.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.avi', '.flv', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.wmv', '.3gp'],
  image: ['.jpg', '.jpeg', '.jfif', '.jpe', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif', '.tif', '.tiff', '.svg', '.psd'],
  audio: ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac', '.opus'],
  archive: ['.zip', '.7z', '.rar', '.gz', '.tar'],
};

export const KIND_LABELS: Record<FileKind, string> = {
  video: '動画',
  image: '画像',
  audio: '音声',
  archive: '圧縮',
  other: 'その他',
};

export function fileKind(name: string): FileKind {
  const ext = extensionOf(name);
  for (const [kind, exts] of Object.entries(KIND_EXTS) as [FileKind, string[]][]) {
    if (exts.includes(ext)) return kind;
  }
  return 'other';
}
