import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadOptions } from '../src/background/aria2-options.ts';

test('全部指定すると保存先・名前・続きから・自動再試行が入る', () => {
  assert.deepEqual(downloadOptions({ dir: 'D:\\DL\\share', out: 'a.mp4', resume: true }), {
    dir: 'D:\\DL\\share',
    out: 'a.mp4',
    continue: 'true',
    'max-tries': '5',
    'retry-wait': '10',
  });
});

test('未指定の項目は入れず、自動再試行だけは常に付ける', () => {
  assert.deepEqual(downloadOptions({ dir: '', resume: false }), {
    'max-tries': '5',
    'retry-wait': '10',
  });
});
