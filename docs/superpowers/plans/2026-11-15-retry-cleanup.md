# 再試行のキュー汚染対策 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aria2 の自動再試行を付け、失敗タスクを見つけたら Motrix から消して、キューにエラーが溜まらないようにする。

**Architecture:** linkex-motrix は aria2 へ渡すオプションを純粋関数に切り出してテストし、完了確認で失敗を見つけたら `removeDownloadResult` を呼ぶ。gofile-motrix は送信オプションに同じ値を足し、`syncHistory` で失敗を外す前に multicall で消す。

**Tech Stack:** TypeScript（node --test）、Tampermonkey ユーザースクリプト、aria2 JSON-RPC

**Spec:** `docs/superpowers/specs/2026-11-15-retry-cleanup-design.md`

## Global Constraints

- 追加する aria2 オプション: `'max-tries': '5'`, `'retry-wait': '10'`（文字列）
- `removeDownloadResult` の失敗で処理を止めない（ログのみ）
- 両リポジトリともブランチ `fix/retry-cleanup` で作業
- gofile-motrix の `@version` は `0.3.1`

## Review Focus

- 失敗確認中に Motrix へつながらない → 消去は諦めて、従来どおり状態だけ更新する
- `removeDownloadResult` が「GID が無い」で失敗（すでに消えている） → 無視する
- `removed` だが完了済み（gofile の completedLength === totalLength）→ 失敗扱いせず消さない
- `resume` 付き再送で `continue: 'true'` が残っていること（既存の動作を壊さない）
- dir / out が空のとき、オプションに空文字を入れない（既存の動作）

---

### Task 1: linkex-motrix — オプション生成の切り出しと自動再試行

**Files:**
- Create: `src/background/aria2-options.ts`
- Modify: `src/background/motrix.ts`（addDownload）
- Test: `tests/aria2-options.test.ts`

**Interfaces:**
- Produces: `downloadOptions(opts: { dir?: string; out?: string; resume?: boolean }): Record<string, string>`（dir は結合済みの絶対パス）

- [ ] テスト: 全指定で `{ dir, out, continue: 'true', 'max-tries': '5', 'retry-wait': '10' }`。dir/out 未指定・resume false では `dir`/`out`/`continue` キーが無く、`max-tries`/`retry-wait` はある。
- [ ] `npm test` で失敗を確認 → 実装 → 成功を確認
- [ ] addDownload で `downloadOptions({ dir: joinDir(...), out, resume })` を使う
- [ ] `npm run typecheck` が通る

### Task 2: linkex-motrix — 失敗タスクを Motrix から消す

**Files:**
- Modify: `src/background/motrix.ts`（`removeResult` 追加）
- Modify: `src/background/engine.ts`（完了確認の `error` / `removed` 分岐）

**Interfaces:**
- Produces: `removeResult(gid: string): Promise<void>` — `aria2('removeDownloadResult', [gid])`、例外は握りつぶさず呼び出し側に返す
- engine 側: `error` / `removed` を検出した GID を集め、`updateItems` の後に1件ずつ `removeResult`。失敗したら `logEvent('warn', ...)` のみ（not found は記録しない）

- [ ] 実装
- [ ] `npm run build` が通る
- [ ] 手動確認: Motrix 起動中に、存在しない URL を拡張機能から送らずとも、RPC で `removeDownloadResult` が効くことを curl 等で確認（Task 4）

### Task 3: gofile-motrix — 自動再試行と失敗タスクの消去

**Files:**
- Modify: `gofile-motrix.user.js`（`sendToMotrix` の options、`syncHistory`、`@version`）

- [ ] options に `'max-tries': '5'`, `'retry-wait': '10'` を追加
- [ ] `syncHistory` で failed の GID を集め、`delete d[id]` の前に `system.multicall` で `aria2.removeDownloadResult` をまとめて送る（エラーは console.warn のみ）
- [ ] `@version 0.3.1`
- [ ] `node --check gofile-motrix.user.js`

### Task 4: 動作確認

- [ ] Motrix の RPC（既定 16800）が動いていれば: 存在しない URL を `max-tries`/`retry-wait` 付きで addUri → `tellStatus` で失敗後 `removeDownloadResult` → `tellStopped` に残っていないことを確認
- [ ] 動いていなければ、その旨を報告する
