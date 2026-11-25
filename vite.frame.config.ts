import { defineConfig } from 'vite';

// 裏の埋め込みページ（offscreen.html の iframe）の中で動くコンテンツスクリプト。
// content.js と同じく import を使えないので、1ファイルにまとめた IIFE としてビルドする。
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: 'src/content/drive-frame.ts',
      formats: ['iife'],
      name: 'LinkexJd2DriveFrame',
      fileName: () => 'drive-frame.js',
    },
  },
});
