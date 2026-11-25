import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindLinkexApi } from '../src/shared/linkex-endpoints.ts';

function recorder() {
  const calls: { method: string; path: string; payload?: unknown }[] = [];
  const api = bindLinkexApi(async (method, path, payload) => {
    calls.push({ method, path, payload });
    return undefined as never;
  });
  return { api, calls };
}

test('保存は POST で、1件だけ・select_all なしで送る', async () => {
  const { api, calls } = recorder();
  await api.copyFromShare('tok', 'f1');
  assert.deepEqual(calls[0], {
    method: 'post',
    path: '/api/drive/v1/file/copy',
    payload: { share_token: 'tok', collection: { select_all: false, file_ids: ['f1'] }, async: true },
  });
});

test('削除系は1件ずつ送る', async () => {
  const { api, calls } = recorder();
  await api.moveToTrash('f1');
  await api.deleteForever('f1');
  assert.deepEqual(calls[0].payload, { collection: { select_all: false, file_ids: ['f1'] } });
  assert.deepEqual(calls[1], { method: 'post', path: '/api/drive/v1/file/trash/delete', payload: { file_ids: ['f1'] } });
});

test('自分のファイルの一覧は、フォルダを省くとルートを取る', async () => {
  const { api, calls } = recorder();
  await api.myFiles(undefined, 2);
  await api.myFiles('dir', 1);
  assert.equal((calls[0].payload as Record<string, unknown>).parent_id, undefined);
  assert.equal((calls[0].payload as Record<string, unknown>).page, 2);
  assert.equal((calls[1].payload as Record<string, unknown>).parent_id, 'dir');
});

test('共有のファイルの情報は、共有のトークン付きで自分のファイルと同じ呼び先に送る', async () => {
  const { api, calls } = recorder();
  await api.shareFileGet('tok', 'f1');
  assert.deepEqual(calls[0], { method: 'get', path: '/api/drive/v1/file/get', payload: { file_id: 'f1', share_token: 'tok' } });
});
