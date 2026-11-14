# 再試行をツール側で引き受け、Motrix のキューを汚さない

対象: linkex-motrix と gofile-motrix（同じ設計を両方に入れる）

## 目的

Motrix にエラーのタスクが放置され、再試行のたびに新しいタスクとして追加されてキューが汚れる問題をなくす。
ダウンローダー（Motrix / aria2）は替えない。

原因: aria2 には失敗したタスクを同じ GID で再開する機能がなく、再試行は必ず新しいタスクになる。
しかも両ツールとも再送するときに古い失敗タスクを消していない。

## 検討した案

- **A（採用）**: ツール側で古いタスクを消し、aria2 の自動再試行も付ける。ダウンローダーを替えずに済む。
- B: Gopeed へ移行。通信部分の作り直しが大きく、失敗したタスクを同じタスクのまま再開できるかも未確認のため見送り。
- AriaNg への切り替えは任意。A の後に必要なら行う（コード変更はほぼ不要）。

## 変更内容

### 共通

1. addUri のオプションに `max-tries: 5` と `retry-wait: 10` を付ける。一時的な通信エラーは aria2 が同じタスクの中でやり直す。
2. 失敗（`error`、または完了前の `removed`）を見つけたら、その場で `aria2.removeDownloadResult(gid)` を呼んで Motrix の一覧から消す。
   失敗の記録はツール側に残る。消すのに失敗しても処理は止めない。

### linkex-motrix

- `src/background/motrix.ts`: addDownload に上記オプションを追加。`removeResult(gid)` を追加。
- `src/background/engine.ts`: 完了確認で `error` / `removed` を見つけたら removeResult を呼ぶ（最終失敗も含む）。

### gofile-motrix

- `sendToMotrix` の options に上記オプションを追加。
- `syncHistory` で失敗を見つけたとき、記録を外す前に `system.multicall` で `removeDownloadResult` をまとめて呼ぶ。
- バージョンを v0.3.1 にする。

## やらないこと

- Motrix の画面で手動で再試行したタスクの追跡（再試行はツールに任せる運用にする）。
- AriaNg への切り替えや、名前から Motrix を外すこと。

## 実装側で決めたこと

- `max-tries: 5` / `retry-wait: 10` の値。
- 最終失敗のタスクも Motrix から消す（記録はツール側にある）。
