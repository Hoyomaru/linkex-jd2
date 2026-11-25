import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdnObjectSize, directHttpLink, jdLinkState } from '../src/shared/jd2-status.ts';

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
