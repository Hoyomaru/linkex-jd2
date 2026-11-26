import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cdnObjectSize,
  cleanupRemovesFinished,
  directHttpLink,
  findHandedLink,
  jdLinkState,
  MISSING_CONFIRM_MS,
  MISSING_QUICK_MS,
  missingConfirmMs,
} from '../src/shared/jd2-status.ts';

// 値は JD2 v2 build 48637 の downloadsV2/queryLinks で実際に返ってきたもの

test('一覧にないリンクは missing', () => {
  assert.equal(jdLinkState(undefined, 100), 'missing');
});

test('完了のアイコンで、サイズが足りていれば done（取得済みが1バイト多くてもよい）', () => {
  const link = { finished: true, statusIconKey: 'true', bytesLoaded: 69700838, bytesTotal: 69700837 };
  assert.equal(jdLinkState(link, 69700837), 'done');
});

test('途中で切られて受け取れた分だけで完了にされたら truncated', () => {
  const link = { finished: true, statusIconKey: 'true', bytesLoaded: 1114112, bytesTotal: 1114112 };
  assert.equal(jdLinkState(link, 3145728), 'truncated');
});

test('サイズが分からなければ、完了をそのまま信じる', () => {
  assert.equal(jdLinkState({ finished: true, statusIconKey: 'true', bytesLoaded: 5 }, null), 'done');
});

test('最初から断られた（ファイルが見つかりません）は failed', () => {
  assert.equal(jdLinkState({ statusIconKey: 'false', bytesLoaded: 0, enabled: true }, 100), 'failed');
});

test('無効にされた・スキップされたリンクは、失敗ではなく held（ファイルごと消して渡し直さない）', () => {
  assert.equal(jdLinkState({ enabled: false }, 100), 'held');
  assert.equal(jdLinkState({ enabled: true, skipped: true }, 100), 'held');
});

test('最初から断られたリンクを無効にしても failed のまま', () => {
  assert.equal(jdLinkState({ statusIconKey: 'false', enabled: false }, 100), 'failed');
});

test('ダウンロード中・開始中は active', () => {
  assert.equal(jdLinkState({ running: true, statusIconKey: 'kc.d2cc9c', enabled: true } as never, 100), 'active');
  assert.equal(jdLinkState({ statusIconKey: 'run', enabled: true }, 100), 'active');
});

// CDN が動画を application/xml として返すことがあり、そのままだと JD2 はページとして中を読みに行ってしまう
test('JD2へ渡すURLには directhttp:// を付けて、直接のダウンロードとして扱わせる', () => {
  assert.equal(directHttpLink('https://file.example.com/a/1?auth_key=x'), 'directhttp://https://file.example.com/a/1?auth_key=x');
});

test('すでに directhttp:// が付いていれば二重に付けない', () => {
  assert.equal(directHttpLink('directhttp://https://file.example.com/a'), 'directhttp://https://file.example.com/a');
});

test('CDN の URL の最後の段から、配っているファイルの大きさを読む', () => {
  assert.equal(cdnObjectSize('https://file.fastspeedcdn.com/pool/pub/c1/3f/00/abc/10485760?auth_key=1-x&ip=1.2.3.4'), 10485760);
  assert.equal(cdnObjectSize('directhttp://https://file.fastspeedcdn.com/pool/pub/a/652460000?uid=1'), 652460000);
  assert.equal(cdnObjectSize('https://file.fastspeedcdn.com/pool/pub/a/file.mp4'), null);
  assert.equal(cdnObjectSize('not a url'), null);
});

test('JD2 がしばらく問題なく応答していれば、一覧から消えた件はすぐ完了とみなす', () => {
  const now = 10 * 60_000;
  assert.equal(missingConfirmMs(now, now - 2 * 60_000, 0), MISSING_QUICK_MS);
});

test('見届けを始めたばかり・JD2 とつながらなかった直後は、1分待つ（起動直後の空の一覧で取り違えない）', () => {
  const now = 10 * 60_000;
  assert.equal(missingConfirmMs(now, 0, 0), MISSING_CONFIRM_MS);
  assert.equal(missingConfirmMs(now, now - 30_000, 0), MISSING_CONFIRM_MS);
  assert.equal(missingConfirmMs(now, now - 5 * 60_000, now - 10_000), MISSING_CONFIRM_MS);
});

test('完了した件を処理中に消す片付けの設定を見分ける', () => {
  assert.equal(cleanupRemovesFinished('CLEANUP_IMMEDIATELY'), true);
  assert.equal(cleanupRemovesFinished('CLEANUP_AFTER_PACKAGE_HAS_FINISHED'), true);
  assert.equal(cleanupRemovesFinished('CLEANUP_ONCE_AT_STARTUP'), false);
  assert.equal(cleanupRemovesFinished('NEVER'), false);
  assert.equal(cleanupRemovesFinished(null), false);
});

test('渡し中だった URL のリンクを、directhttp:// の有無を問わず見つける', () => {
  const url = 'https://cdn.example/pool/pub/abc/10485760';
  const links = [
    { uuid: 1, url: 'https://cdn.example/pool/pub/other/5' },
    { uuid: 2, url },
  ];
  assert.equal(findHandedLink(links, `directhttp://${url}`), '2');
  assert.equal(findHandedLink([{ uuid: 3, url: `directhttp://${url}` }], url), '3');
});

test('同じ URL のリンクがなければ null（URL を持たないリンクも合わない）', () => {
  assert.equal(findHandedLink([{ uuid: 1 }, { uuid: 2, url: 'https://cdn.example/x/1' }], 'https://cdn.example/x/2'), null);
});
