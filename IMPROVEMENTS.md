# 改善点の調査結果

> **対応状況（2026-11-25）**: おすすめの着手順の上位5件（E-1、D-1＋A-3、D-2、B-2、B-1）を対応済み。あわせて D-6 のうちポップアップのボタン（失敗の表示と二重押しの防止）も直した（共有ページの緑表示は未対応）。typecheck と test（engineView のテストを足して67件）は通っている。拡張機能での動作確認済み。表の行番号は、調査したときのもの。
>
> **対応状況（2026-11-25・2回目）**: バグ系の D-3、A-1、A-2、A-4、A-5 を対応済み。A-4 では JD2 の「有効に戻す」の呼び直しも足した。A-2 は保存（file/copy）だけを送り直さない対象にした（削除などは送り直しても同じ結果になるため従来どおり）。typecheck と test（68件）は通っている。拡張機能での動作確認済み。
>
> **対応状況（2026-11-25・3回目）**: 画面の D-4、D-5、D-6（残りの共有ページの表示）を対応済み。D-5 は shared/error-text.ts の describeError を、画面への send・共有の読み込み失敗・Linkex のエラーに通した。typecheck と test（72件）は通っている。拡張機能での動作確認済み。
>
> **対応状況（2026-11-25・4回目）**: 文書の E-2、E-3、F-1 を対応済み（あわせて E-4 の範囲も README の表に書いた）。A-4 の変更に合わせ、README の「ファイルが既に存在する場合」のおすすめを「名前を変える」にした。package.json に engines を足したが、package-lock.json は次の npm install まで更新していない。
>
> **対応状況（2026-11-25・5回目）**: main に取り込んだ後、npm update で F-4（vite 8.3.8・@types/chrome 0.3.8）と lock の engines を反映。パフォーマンスの C-1、C-4、C-3 を対応済み（C-3 は見えていないタブを描かないところまで。行ごとの差し替えは未対応）。typecheck と test（72件）は通っている。拡張機能での動作確認済み。v2.2.0 として main に取り込んだ。
>
> **対応状況（2026-11-25・6回目）**: 小さな片付けの E-5（docs/superpowers を private/ に移し .gitignore に追加）、B-4（IN_STORAGE_STATES に一本化）、A-6、A-7、A-8（C-9 の Set による引き当ても一緒に）、B-8（jd.version・api.share・api.shareContent を削除、ファイル内だけで使う export を外した。Motrix 版からの移行処理は残した）を対応済み。typecheck と test（73件）は通っている。拡張機能での動作確認済み。main に取り込んだ。
>
> **対応状況（2026-11-25・7回目）**: C-2（Service Worker の中にキューを持ち、書き換えは写しに対して行って保存できてから入れ替える。続けて起きる更新の1回化と、バッジの newValue 利用は未対応）、C-5（logEvents でまとめて書く）、D-7（作り直した後もフォーカスを戻す。行ごとの差し替えは未対応）を対応済み。typecheck と test（73件）は通っている。拡張機能での動作確認済み。main に取り込んだ。
>
> **対応状況（2026-11-25・8回目）**: 重複をまとめる B-7（messages.ts の ResponseMap と、background/index.ts の型付きの受け持ち表）、B-3（shared/linkex-endpoints.ts に呼び先を一本化）、B-6（ui/summary.ts）、B-5（共有ページの send・型・storage のキーを共通に寄せ、mount を mount・setupStatus・setupAdding に分けた。速度の取得は「ダウンロード中のときだけ」の動きを残すため pollJd に寄せていない）を対応済み。typecheck・test（77件）・build は通っている。拡張機能での動作確認はまだ。

## 1. 概要

**プロジェクトの把握内容**
- Linkex の共有ファイルを JDownloader 2（ローカル API、127.0.0.1:3128）に渡してまとめてダウンロードし、完了まで見届ける Edge 拡張機能（Manifest V3）。v2.1.0 で、初期設定は「保存せずにダウンロード」（共有から直接 URL を発行する）。直接取れない件だけ、自分のストレージに保存してから取る。
- 構成は次のとおり。
  - `src/background/`：Service Worker。指示役の `engine.ts`（871行）、Linkex の固定タブ経由で API を呼ぶ `linkex-tab.ts` と `linkex-bridge.ts`、JD2 API の `jd2.ts`、メッセージを受ける `index.ts` など
  - `src/content/share-page.ts`：共有ページに出すパネル（635行）
  - `src/dashboard/`：専用ページ
  - `src/popup/`：ポップアップ
  - `src/shared/`：共通の型と、純粋な処理
  - `tests/`：`node --test` で動かすテスト。61件
- ソースはおよそ 4,500 行。依存は devDependencies の3つだけ（typescript、vite、@types/chrome）。

**調査範囲**
- 調べたもの：`src/`、`tests/`、`public/manifest.json`、`popup.html`、`dashboard.html`、`vite*.config.ts`、`tsconfig.json`、`package.json`、`scripts/`、`README.md`、`docs/`、`.gitignore`
- 対象外：`node_modules/`、`dist/`、`private/`
- 観点 A〜F は、観点ごとにサブエージェントを分けて並列で調べた。効果「高」の5件（B-1、B-2、D-1、D-2、E-1）は、まとめる側が該当コードを開き、行番号と根拠を確かめた。
- 拡張機能は実際には動かしていない。動作はコードから判断した。

**実行したコマンド**

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | エラーなし |
| `npm test` | 61件すべて成功 |
| `npm outdated` | パッチ更新が2件 |

- このほかにファイルの一覧を読み取りで確かめた。
- 規模をつかむために最初に `git ls-files` を1回実行した（読み取りのみ）。git 操作をしない決まりだったので、ここに書いておく。

## 2. 一覧表

| ID | 観点 | 概要（1行） | 該当箇所 | 効果 | 作業量 | 確認レベル |
|---|---|---|---|---|---|---|
| A-1 | バグ | コピー削除の失敗が JD2 での再試行回数を食う | engine.ts `fail` | 中 | 小 | コード確認 |
| A-2 | バグ | タブが無応答や凍結のとき、保存（POST）を送り直して二重にコピーする | linkex-tab.ts `execute` | 中 | 小 | コード確認 |
| A-3 | バグ | 一時停止の理由が、指示役の状況表示で上書きされる | engine.ts `runLoop` | 中 | 小 | コード確認 |
| A-4 | バグ | JD2 で無効やスキップにしたリンクを失敗とみなし、ファイルごと消す | jd2-status.ts `jdLinkState` | 中 | 小 | コード確認 |
| A-5 | バグ | JD2 の一覧から消えた件を「完了」にしてハッシュまで記録する | engine.ts `doRefreshDownloads` | 中 | 小 | 推測 |
| A-6 | バグ | 担当が付いた直後の待ちの件を外すと、コピーや JD2 の件が管理から外れる | index.ts `removeItems` | 低 | 小 | コード確認 |
| A-7 | バグ | SW が起きるたびにアラームを作り直し、起きた直後に再開しない | index.ts 最上位 | 低 | 小 | コード確認 |
| A-8 | バグ | 保存名の重複チェックが大文字と小文字を区別する | enqueue.ts `addWalkedToQueue` | 低 | 小 | コード確認 |
| A-9 | バグ | JD2 に渡した直後に SW が止まると、二重に渡す | engine.ts `stepDirect`/`sendToJd` | 低 | 中 | 推測 |
| B-1 | 設計 | engine.ts に責務が集中し、状態変数が散らばり、初期化も漏れている | engine.ts 全体 | 高 | 中 | コード確認 |
| B-2 | 設計 | 直接と保存経由で同じ処理が重複し、メモの文言を状態の目印に使っている | engine.ts `stepDirect`/`sendToJd`/`stepDelete` | 高 | 中 | コード確認 |
| B-3 | 設計 | Linkex API の呼び先が2か所に重複し、使われていないものもある | api.ts / linkex-api.ts | 中 | 中 | 実証 |
| B-4 | 設計 | 同じ中身の状態リストが別名で2つある | queue.ts / scheduler.ts | 中 | 小 | 実証 |
| B-5 | 設計 | 共有ページが共通の部品を使わずに作り直していて、mount が約450行ある | share-page.ts | 中 | 中 | 実証 |
| B-6 | 設計 | 進み具合と見積もりの表示処理が3つの画面に重複している | popup.ts / queue-view.ts / share-page.ts | 中 | 中 | コード確認 |
| B-7 | 設計 | メッセージの応答に型がなく、呼ぶ側がそれぞれ書き写している | messages.ts `send` | 中 | 中 | 実証 |
| B-8 | 設計 | 使われていないメッセージ、export、移行処理が残っている | index.ts / messages.ts ほか | 低 | 小 | 実証 |
| B-9 | 設計 | 順番に実行するためのロックと sleep を何か所でも手書きしている | store.ts / linkex-tab.ts ほか | 低 | 小 | 実証 |
| C-1 | 性能 | JD2 の全リンク取得を、指示役と各画面が別々に繰り返している | jd2.ts `queryLinks` / index.ts `jd.active` | 中 | 小 | コード確認 |
| C-2 | 性能 | キューを毎回 storage から全件読み、全件書き戻している | store.ts `readQueue`/`mutateQueue` | 中 | 中 | コード確認 |
| C-3 | 性能 | 見えていないタブでもキューとログを全件描き直している | queue-view.ts `render`/`renderEvents` | 中 | 小 | コード確認 |
| C-4 | 性能 | Linkex を呼ぶたびに、ページの準備確認を1往復している | linkex-tab.ts `ensureLinkexTab` | 中 | 小 | コード確認 |
| C-5 | 性能 | 処理ログを1件ずつ、300件まとめて読み書きしている | store.ts `logEvent` | 低 | 小 | コード確認 |
| C-6 | 性能 | ダウンロード済みの記録を、1件ごとに全件読み書きしている | store.ts `rememberHash` | 低 | 小 | コード確認 |
| C-7 | 性能 | 設定を API 呼び出しのたびに storage から読んでいる | settings.ts `loadSettings` | 低 | 小 | コード確認 |
| C-8 | 性能 | タブの凍結を見張るのに、呼び出しごとに 250ms 間隔で確かめている | linkex-tab.ts `watchFrozen` | 低 | 小 | 推測 |
| C-9 | 性能 | キューへの追加の重複チェックが、件数の掛け算で重くなる（将来） | enqueue.ts `addWalkedToQueue` | 低 | 小 | コード確認 |
| D-1 | UI/UX | 異常で止まったことが手動の一時停止と区別できず、理由も途中で切れる | live.ts `engineView` / popup.html | 高 | 小 | コード確認 |
| D-2 | UI/UX | JD2 が起動していないことに気づきにくく、そのまま開始できてしまう | popup.ts / engine.ts `start` | 高 | 中 | コード確認 |
| D-3 | UI/UX | ダウンロード中の件しかないときに JD2 が落ちても知らせない | engine.ts `doRefreshDownloads` | 中 | 小 | コード確認 |
| D-4 | UI/UX | 設定タブで起きた失敗が、設定タブに表示されない | dashboard.ts `action` | 中 | 小 | コード確認 |
| D-5 | UI/UX | 内部のエラーコードがそのまま画面に出る | linkex-tab.ts / popup.ts ほか | 中 | 小 | コード確認 |
| D-6 | UI/UX | 開始・一時停止ボタンが失敗を無視する | popup.ts / share-page.ts `afterAdd` | 中 | 小 | コード確認 |
| D-7 | UI/UX | 一覧を全部作り直すたびに、フォーカスや押しかけのクリックが失われる | queue-view.ts `render` | 中 | 中 | コード確認 |
| D-8 | UI/UX | アクセシビリティの細かい不足（aria-pressed、色だけの区別など） | dashboard.html / queue-view.ts | 低 | 小 | コード確認 |
| E-1 | 文書 | 状態遷移とサイズのコメントが、保存経由の流れのまま古くなっている | queue.ts / engine.ts | 高 | 小 | コード確認 |
| E-2 | 文書 | 「追加したらすぐ開始」がどこからの追加に効くか、説明が食い違っている | settings.ts / README | 中 | 小 | コード確認 |
| E-3 | 文書 | 直接ダウンロードのとき、一部の設定が何に効くのか書かれていない | README 設定表 | 中 | 小 | コード確認 |
| E-4 | 文書 | 設定の数値の範囲が README に書かれていない | README 設定表 | 低 | 小 | コード確認 |
| E-5 | 文書 | docs/superpowers が v1（Motrix）向けのまま残っている | docs/superpowers/ | 中 | 小 | コード確認 |
| E-6 | 文書 | JSDoc が関数でなく、別の宣言の上に付いている | linkex-tab.ts | 低 | 小 | コード確認 |
| E-7 | 文書 | 手元の環境に固定した絶対パスが書かれている | fix-extensions.ps1 / docs | 低 | 小 | コード確認 |
| F-1 | 依存 | 必要な Node の版がどこにも書かれていない（engines、README） | package.json / README | 中 | 小 | コード確認 |
| F-2 | 依存 | tests/ が型チェックの対象外で、型除去の制約も守らせていない | tsconfig.json | 中 | 小 | コード確認 |
| F-3 | 依存 | lint と formatter がない | package.json | 低 | 小 | 実証 |
| F-4 | 依存 | パッチ更新が2件ある（vite、@types/chrome） | package.json | 低 | 小 | 実証 |

## 3. 詳細

### A. バグ・不具合

#### A-1 コピー削除の失敗が JD2 での再試行回数を食う
- **内容**：保存経由の件で、JD2 に渡した後（`deleting`、`jdId` あり）にコピーの削除が失敗すると、`fail()` が `attempts` を増やす。
  - 2回失敗すると、JD2 で1回失敗しただけで `error` になる。
  - 5回失敗すると `state: 'error'` になる。このとき JD2 はダウンロードを続けているので、完了を取り込まず、ハッシュも記録しない。ここで再試行すると、同じ名前で二重に渡す。
- **該当箇所**：`src/background/engine.ts` `fail()` 394–410行、`stepDelete()` 694–706行
- **根拠コード**
  ```ts
  const keepForDelete =
    Boolean(item.destFileId) &&
    (item.state === 'copied' || item.state === 'deleting') &&
    attempts < MAX_ATTEMPTS + 2;
  await updateItem(item.id, {
    attempts,
    state: keepForDelete ? 'deleting' : attempts >= MAX_ATTEMPTS ? 'error' : 'retry',
  ```
- **修正案**：`jdId` がある件の削除失敗は、別のカウンタ（`deleteAttempts`）で数える。上限に達したら、コピーを残したまま `downloading` に進め、警告をログに出す。
- **効果の理由**：保存経由で取るときに、JD2 で落としている最中の件を見失わずに済む。
- **確認方法**：`moveToTrash` か `deleteForever` が必ず例外を投げるように一時的に変え、保存経由の件を流す。`downloading` に進み、`attempts` が 0 のままであることを確かめる。
- **依存関係**：B-2（`stepDelete` を整理するとき一緒に直すと楽）

#### A-2 タブが無応答や凍結のとき、保存（POST）を送り直して二重にコピーする
- **内容**：`mayRetryLinkex` は、POST の呼び直しを 429 のときだけにしている。ところが一段下の `execute()` は、`TabTimeoutError` や `TabFrozenError` のときにタブを読み込み直し、メソッドに関係なく同じリクエストを送り直す。`file/copy` がサーバーに届いていれば、コピーが2つできる。
- **該当箇所**：`src/background/linkex-tab.ts` `execute()` 433–465行、`src/shared/linkex-transient.ts` `mayRetryLinkex()` 15–18行
- **根拠コード**
  ```ts
  if (e instanceof TabTimeoutError) {
    if (++timeouts > 1) { throw ... }
  ...
  await reloadAndWait(tabId);   // → ループの先頭で同じ req を送り直す
  ```
- **修正案**：POST が送信後にタイムアウトや凍結になったときは送り直さない。タブを読み込み直したうえで、一時的な失敗として呼び出し元に返す（コピーは次の周回のコピー探しで拾う）。
- **効果の理由**：持ち主のないコピーが容量を食うのを防ぐ。
- **確認方法**：`linkexBridgeCall` の結果待ちを一時的に20秒以上遅らせ、`file/copy` が1回しか送られないことをログで確かめる。

#### A-3 一時停止の理由が、指示役の状況表示で上書きされる
- **内容**：`runLoop` は周回の先頭で `paused` を読む。その後 await を挟んでから、`writeEngine({ message })` を書く。その間に `stopWithNotice()` や `pause()` が入ると、`paused: true` のまま、メッセージだけが「処理中 n件…」で上書きされる。
- **該当箇所**：`src/background/engine.ts` `runLoop()` 180行、`stopWithNotice()` 388–392行、`pause()` 105–109行
- **根拠コード**
  ```ts
  await writeEngine({ message: statusMessage(items, downloading, waiting.length, settings.maxDownloads) });
  ...
  await writeEngine({ paused: true, message: `一時停止: ${reason}` });
  ```
- **修正案**：`writeEngine` に、ロックの中で「止まっていなければ書く」という条件を渡せるようにする。
- **効果の理由**：止まった理由が消えると、何をすればよいか分からなくなる。
- **確認方法**：JD2 を止めた状態で開始し、止まった後も「一時停止: …」の文が残ることを確かめる。
- **依存関係**：D-1 と組み合わせて直す（D-1 は、この文が正しく残っている前提で表示を変える）

#### A-4 JD2 で無効やスキップにしたリンクを失敗とみなし、ファイルごと消す
- **内容**：`enabled === false || skipped` の件を `failed` と判定し、`discardLinks`（`REMOVE_LINKS_AND_DELETE_FILES`）で、落としかけのファイルごと消す。次の場合も消される。
  - 利用者が JD2 で一時的に無効にした。
  - 「ファイルがあります」の確認でスキップした。
  - `nudgeLinks` で有効に戻す呼び出しが失敗した。
- **該当箇所**：`src/shared/jd2-status.ts` `jdLinkState()` 31行、`src/background/jd2.ts` `nudgeLinks()` 200–208行、`src/background/engine.ts` `doRefreshDownloads()` 828–829行
- **根拠コード**
  ```ts
  if (link.enabled === false || link.skipped) return 'failed';
  ...
  await jd('downloadsV2/setEnabled', false, links, []);
  await sleep(2_000);
  await jd('downloadsV2/setEnabled', true, links, []);
  ```
- **修正案**：無効とスキップは「止まっている」扱いにして、知らせるだけにする。動かし直している最中の ID は、消す対象から外す。有効に戻す呼び出しは、何回か呼び直す。
- **効果の理由**：JD2 での手作業が、知らないうちにファイルの削除につながるのを防ぐ。
- **確認方法**：JD2 でダウンロード中のリンクを無効にし、3秒以上たってもファイルが消えないことを確かめる。

#### A-5 JD2 の一覧から消えた件を「完了」にしてハッシュまで記録する
- **内容**：JD2 の一覧にない件は、すぐ `done` にしてハッシュを記録する。次の場合、追跡中の件がまとめて完了扱いになる。記録が残るので、再試行しても「重複のため省略」になる。
  - JD2 の再起動直後で、一覧がまだ空。
  - 接続先を変えた。
  - JD2 で手で消した。
- **該当箇所**：`src/background/engine.ts` `doRefreshDownloads()` 819–823行
- **根拠コード**
  ```ts
  if (state === 'missing') {
    if (item.hash) await rememberHash(item.hash, item.name);
    patches.set(item.id, { state: 'done', jdId: undefined, note: 'JD2の一覧になし' });
  ```
- **修正案**：一覧が空で追跡中の件があるときは、判定を見送る。一覧にない状態が2〜3回続いたら完了にする。一覧にないことで完了にした件は、ハッシュを記録しない。
- **効果の理由**：取りこぼしたのに「完了」と記録され、後から取り直しにくくなるのを防ぐ。
- **確認方法**：ダウンロード中に JD2 を再起動し、キューの件が「完了」にならないことを確かめる。

#### A-6 担当が付いた直後の待ちの件を外すと、コピーや JD2 の件が管理から外れる
- **内容**：`removeItems` が守るのは、`copying`、`copied`、`deleting` の件だけ。担当が付いたばかりで、まだ `pending` や `retry` のままの件は消せる。消した後も、担当は保存や JD2 への受け渡しを続ける。`stepCopy` は `updateItem` が null を返しても続ける。
- **該当箇所**：`src/background/index.ts` `removeItems()` 173–178行、`src/background/engine.ts` `stepCopy()` 545–557行
- **根拠コード**
  ```ts
  const keep = items.filter((i) => !ids.has(i.id) || ACTIVE_STATES.includes(i.state));
  ...
  await updateItem(item.id, { state: 'copying', ... });   // 戻り値 null を見ていない
  const res = await api.copyFromShare(item.shareToken, item.sourceFileId);
  ```
- **修正案**：`updateItem` が null を返したら、そこで打ち切る。
- **効果の理由**：起きる時間の幅は狭いが、起きると持ち主のないコピーが残る。
- **確認方法**：開始した直後に、待ちの件を「外す」で消す。ストレージに新しいコピーが残らないことを確かめる。
- **依存関係**：B-4（守る状態のリストを整理するとき、一緒に見直す）

#### A-7 SW が起きるたびにアラームを作り直し、起きた直後に再開しない
- **内容**：最上位で毎回 `chrome.alarms.create('tick', …)` を呼ぶので、周期の起点が毎回今に戻る。また最上位では `resumeIfRunning()` を呼ばないので、メッセージで起きた直後には処理が再開しない。
- **該当箇所**：`src/background/index.ts` 25–32行
- **根拠コード**
  ```ts
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  ```
- **修正案**：`chrome.alarms.get('tick')` でアラームがないときだけ作る。最上位でも `void resumeIfRunning()` を呼ぶ。
- **効果の理由**：SW が止まった後に再開するまでの遅れが減る。
- **確認方法**：`edge://serviceworker-internals` で SW を止め、ポップアップを開いたときにすぐ処理が進むことを確かめる。

#### A-8 保存名の重複チェックが大文字と小文字を区別する
- **内容**：Windows では `A.mp4` と `a.mp4` は同じファイルになるが、`===` で比べているので別名として扱い、JD2 の「ファイルがあります」の確認が出る。
- **該当箇所**：`src/background/enqueue.ts` `addWalkedToQueue()` 74–76行
- **根拠コード**
  ```ts
  for (let n = 2; items.some((i) => i.relDir === relDir && i.outName === outName); n++) {
  ```
- **修正案**：`toLowerCase()` で揃えてから比べる。
- **効果の理由**：確認待ちで止まる原因を1つ減らせる。
- **確認方法**：大文字と小文字だけが違う2つのファイルを追加し、2つ目の名前に「(2)」が付くことを確かめる。
- **依存関係**：C-9（Set で比べる形に変えるなら同時に直す）

#### A-9 JD2 に渡した直後に SW が止まると、二重に渡す
- **内容**：`addDownload` が成功してから `jdId` を書くまでの間に SW が止まると、件は渡す前の状態に残る。再開後、同じ名前でもう一度 JD2 に渡す。
- **該当箇所**：`src/background/engine.ts` `stepDirect()` 515–525行、`sendToJd()` 666–675行
- **修正案**：渡す前に「渡し中」の印を書く。再開したときに印があれば、JD2 の一覧から同じ保存先・同じ名前のリンクを探して `jdId` を拾い直す。
- **効果の理由**：起きるのはまれだが、起きると確認待ちで止まる。
- **確認方法**：`addDownload` の直後に一時的に `await new Promise(()=>{})` を入れ、SW を止めてから再開して確かめる。

### B. 設計・可読性

#### B-1 engine.ts に責務が集中し、状態変数が散らばり、初期化も漏れている
- **内容**：871行の engine.ts が、全体のループ、担当の割り当て、エラーの扱い、各段階の処理、JD2 の完了の取り込み、停滞の見張り、残ったファイルの片付けを、すべて持っている。モジュール直下の変更できる状態変数は約20個で、ファイル内のあちこちに置かれている。定数も途中に散っている。`start()` で初期化するのは一部だけ（`stall` はするが、`stuckWatch`、`progressSavedAt` などはしない）。
- **該当箇所**：`src/background/engine.ts` 状態変数 49–70、721、727、737、759行、`start()` 90–103行
- **根拠コード**（まとめる側で確認済み）
  ```ts
  90 export async function start(): Promise<void> {
  ...
  99   stall = null;
  100  cleanedAt = 0;
  ...
  721 const progressSavedAt = new Map<string, number>();
  737 let stall: { bytes: number; since: number; noticed: boolean } | null = null;
  759 const stuckWatch = new Map<string, { bytes: number; since: number; nudged: boolean }>();
  ```
- **修正案**：
  - 3つに分ける。
    - `engine-loop.ts`：runLoop、kick、start、pause、エラーの扱い
    - `engine-steps.ts`：stepDirect〜stepDelete
    - `jd-monitor.ts`：refreshDownloads、watchStall、watchStuck
  - 実行中の状態は1つの `runtime` オブジェクトにまとめ、`resetRuntime()` を1つ用意する。
  - 定数は先頭に集める。
- **効果の理由**：直すたびに読む範囲が狭くなり、初期化の漏れもなくなる。保守にいちばん効く。
- **確認方法**：`npm run typecheck`、`npm test`、`npm run build` を通したうえで、直接取得と保存経由の両方の件を1件ずつ最後まで流す。
- **依存関係**：先に B-2 で重複を整理しておくと、移す量が減る。E-1 のコメントも、移すときに一緒に直す。

#### B-2 直接と保存経由で同じ処理が重複し、メモの文言を状態の目印に使っている
- **内容**：
  - (a) `stepDirect` と `sendToJd` に、ファイル情報の取得、url・hash・サイズの取り出し、重複の確認、`addDownload`、`updateItem` がほぼ同じ形で書かれている。
  - (b) JD2 の空きを確かめ、`sendingNow` を増減する処理が `stepDirect` と `stepSend` に重複している。
  - (c) 「重複で省略した件か」を、`note` の日本語の文言が一致するかで見分けている。この文言は src 内に5か所ある。
  - (d) コピーしたときの名残で、657行だけ字下げがずれている。
- **該当箇所**：`src/background/engine.ts` `stepDirect()` 474–532行、`stepSend()` 630–646行、`sendToJd()` 648–677行、`stepDelete()` 707行
- **根拠コード**（まとめる側で確認済み）
  ```ts
  482   if (handedToJd(await readQueue(), sendingNow) >= Math.max(1, maxDownloads)) {
  501     const file = data?.file ?? data;
  505     const fileSize = cdnObjectSize(url) ?? Number(file?.size);
  ...
  635   if (handedToJd(items, sendingNow) >= Math.max(1, maxDownloads)) {
  652   const file = data?.file ?? data;
  657     const fileSize = cdnObjectSize(url) ?? Number(file?.size);
  ...
  707   } else if (item.note === '同じ中身をダウンロード済み') {
  ```
- **修正案**：次の3つを切り出す。省略の目印は、`QueueItem` に `duplicate?: true` を持たせる（少なくとも定数にする）。
  - `readDownloadable(data)`：`{url, hash, fileSize}` を返す
  - `withJdSlot(fn)`：空きの確認と `sendingNow` の増減
  - `skipIfDuplicate(item, hash)`
- **効果の理由**：完了の確かめ方を直すときに2か所を直さずに済む。表示の文言を変えても、動きが黙って壊れなくなる。
- **確認方法**：テストを通したうえで、ダウンロード済みの件を「もう一度」追加して、「重複のため省略」になることを確かめる（直接取得と保存経由の両方で）。
- **依存関係**：B-1 の前にやる。A-1 と E-1 も同じ範囲を直す。

#### B-3 Linkex API の呼び先が2か所に重複し、使われていないものもある
- **内容**：パスと送る中身の一覧が、`background/api.ts` と `shared/linkex-api.ts` の両方に別々にある。応答の `code !== 0` を確かめる処理も、両方にある。`api.share` と `api.shareContent` は、どこからも呼ばれていない（grep で0件）。
- **該当箇所**：`src/background/api.ts` 58–99行（`share` 62行、`shareContent` 63–70行）、`src/shared/linkex-api.ts` 22–64行
- **根拠コード**（両方に同じ形がある）
  ```ts
  '/api/drive/v1/file/copy', { share_token, collection: { select_all: false, file_ids: [fileId] }, async: true }
  ```
- **修正案**：`shared/linkex-endpoints.ts` に、リクエストを作る関数の表を1つだけ置き、両方から使う。使われていない2つは消す。
- **効果の理由**：Linkex 側の仕様が変わったとき、直すのが1か所で済む。
- **確認方法**：typecheck を通したうえで、容量と転送量の表示、共有の追加、保存経由のダウンロードを試す。

#### B-4 同じ中身の状態リストが別名で2つある
- **内容**：`ACTIVE_STATES`（queue.ts）と `PREP_STATES`（scheduler.ts）は、どちらも `['copying','copied','deleting']`。一方、画面の区分の `'active'` には `downloading` も含まれ、意味がずれている。popup.ts は同じ区分を配列で直に書いている。
- **該当箇所**：`src/shared/queue.ts` 85行、`src/shared/scheduler.ts` 4行、`src/popup/popup.ts` `render()` 268行
- **根拠コード**
  ```ts
  export const ACTIVE_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
  export const PREP_STATES: ItemState[] = ['copying', 'copied', 'deleting'];
  items.filter((i) => ['copying', 'copied', 'deleting', 'downloading'].includes(i.state));
  ```
- **修正案**：`IN_STORAGE_STATES` のような、意味の分かる名前の1つにまとめる。popup は `GROUP_OF[i.state] === 'active'` を使う。
- **効果の理由**：外してよい件と外せない件を判断するときの読み違いを防ぐ（A-6 にも関係する）。
- **確認方法**：typecheck と test を通す。ポップアップの「処理中」の件数が変わらないことを確かめる。

#### B-5 共有ページが共通の部品を使わずに作り直していて、mount が約450行ある
- **内容**：share-page.ts で、次のものを書き写している。
  - 型のない `send()`
  - `WalkProgress` と `WalkedFile` の型
  - storage のキー `'walkProgress'` の直書き
  - `pollJd` 相当の setInterval

  また `mount()` は 168–623行の1つの関数で、描画、状態、イベントが混ざっている。
- **該当箇所**：`src/content/share-page.ts` 21–41行、374–387行、401–402行、`mount()` 168–623行
- **根拠コード**
  ```ts
  36 function send<T>(message: unknown): Promise<Response<T>> {
  401 if (changes.walkProgress && loading) {
  ```
- **修正案**：
  - `shared/messages` の `send` と、型の `import type` を使う。
  - `WALK_PROGRESS_KEY` は shared に移して共有する。
  - 速度は `pollJd` で取る。
  - `mount()` は、進み具合、選んで追加、小さくする、の3つに分ける。
- **効果の理由**：メッセージや型を変えたときに、共有ページだけ壊れるのを防ぐ。
- **確認方法**：`npm run build` をした後、共有ページで「選んで追加」と、進み具合の表示を確かめる。
- **依存関係**：B-7（応答の型）と一緒にやると効果が大きい。

#### B-6 進み具合と見積もりの表示処理が3つの画面に重複している
- **内容**：割合、件数、速度の合計、残り時間、状態の件数チップ、`setMeter`、追加の結果の文の組み立てが、ポップアップ、専用ページ、共有ページにほぼ同じ形で書かれている。`setMeter` は、popup.ts と dashboard.ts で一字一句同じ。
- **該当箇所**：`src/popup/popup.ts` `render()` 210–265行、`setMeter` 328–333行、`src/dashboard/queue-view.ts` `renderOverview` 252–297行、`src/dashboard/dashboard.ts` `setMeter` 91–96行、`src/content/share-page.ts` `renderProgress` 325–364行
- **根拠コード**
  ```ts
  let speed = 0; for (const item of items) if (item.jdId) speed += progress.get(item.jdId)?.speed ?? 0;
  ```
- **修正案**：`ui/summary.ts` を作り、`overviewModel(items, progress)`（純粋関数）、`renderChips()`、`setMeter()`、`describeAddResult()` を置く。
- **効果の理由**：表示のきまりを1か所で変えられる。テストも書ける。
- **確認方法**：3つの画面で、同じキューの割合と件数が一致することを確かめる。

#### B-7 メッセージの応答に型がなく、呼ぶ側がそれぞれ書き写している
- **内容**：`Request` には型があるが、応答の型はつながっていない。呼ぶ側が、`send<{ added; addedBytes; … }>` をそれぞれ書き写している。`EnqueueResult` は export されているが、どこからも import されていない。
- **該当箇所**：`src/shared/messages.ts` `send()` 37行、`src/popup/popup.ts` 44行、`src/dashboard/queue-view.ts` 113–120行、`src/content/share-page.ts` 516・598行、`src/background/enqueue.ts` 8行
- **修正案**：`ResponseMap` を定義し、`send<K>(req): Promise<Response<ResponseMap[K]>>` の形にする。
- **効果の理由**：応答の形を変えたとき、受け取る側の直し漏れを型チェックで見つけられる。
- **確認方法**：typecheck を通す。応答のフィールド名を試しに変えて、型エラーが出ることを確かめる。

#### B-8 使われていないメッセージ、export、移行処理が残っている
- **内容**：
  - `'jd.version'` は、どこからも送られていない。
  - export しているのに、ファイルの中でしか使っていないもの：`DEFAULT_SETTINGS`、`formatDuration`、`updateBadge`、`WALK_PROGRESS_KEY` など。
  - Motrix 版から移すための処理（`index.ts` onInstalled 40–50行、`settings.ts` 56–60行）が残っている。
- **該当箇所**：`src/background/index.ts` 90–91行、`src/shared/messages.ts` 7行
- **修正案**：`'jd.version'` は消す。export を絞る。移行処理は次のメジャー版で消す。
- **効果の理由**：読むべきコードが少し減る。
- **確認方法**：typecheck と test を通す。

#### B-9 順番に実行するためのロックと sleep を何か所でも手書きしている
- **内容**：前の Promise につないで1本ずつ実行する形を、store.ts で4回、linkex-tab.ts で2回、手で書いている。`sleep` も4つのファイルにある。
- **該当箇所**：`src/background/store.ts` 13–23・31–36・84–98・112–121行、`sleep` は engine.ts 41行、api.ts 26行、jd2.ts 25行、linkex-tab.ts 15行
- **根拠コード**
  ```ts
  const next = eventLock.then(run, run); eventLock = next.catch(() => undefined);
  ```
- **修正案**：`shared/async.ts` に `createSerial()` と `sleep` を置く。
- **効果の理由**：書き方の間違いが入る場所が減る。
- **確認方法**：typecheck と test を通す。
- **依存関係**：C-2 と C-5 で store.ts を直すときに一緒にやる。

### C. パフォーマンス

#### C-1 JD2 の全リンク取得を、指示役と各画面が別々に繰り返している
- **内容**：`queryLinks` は毎回 JD2 の全リンクを取ってから絞り込む。これを、指示役が3秒ごと、専用ページとポップアップが1.5秒ごと、共有ページがタブ1つにつき1.5秒ごとに、別々に呼んでいる。`jd.active` は呼ぶたびにキュー全件も読む。JD2 に履歴が多いと、1回の応答が大きくなる。
- **該当箇所**：`src/background/jd2.ts` `queryLinks` 180–185行、`src/background/index.ts` `'jd.active'` 96–110行、`src/ui/live.ts` `pollJd`、`src/content/share-page.ts` 374–387行
- **根拠コード**
  ```ts
  const all = await jd<JdLink[]>('downloadsV2/queryLinks', LINK_FIELDS);
  const want = new Set(ids);
  return all.filter((l) => want.has(String(l.uuid)));
  ```
- **修正案**：SW の中で、`queryLinks` の結果を約1秒覚えておき、取得中なら同じ Promise を分け合う。
- **効果の理由**：画面をいくつ開いても、JD2 への問い合わせは1秒に1回までになる。
- **確認方法**：専用ページとポップアップを両方開き、JD2 のログか DevTools の Network で、問い合わせの回数が減ったことを確かめる。

#### C-2 キューを毎回 storage から全件読み、全件書き戻している
- **内容**：`readQueue` は毎回全件を読み、`mutateQueue` は1件だけ変えるときも全件を書き戻す。書くたびに `onChanged` で、新旧の全件がすべての画面に届く。保存経由の件は、1件あたり最低5回書く。保存中の件は `beforeIds` を持つので、1回に書く量がさらに増える。
- **該当箇所**：`src/background/store.ts` `readQueue` / `mutateQueue` / `updateItem` 38–59行、`src/background/badge.ts` `updateBadge` 12–13行
- **根拠コード**
  ```ts
  export function mutateQueue<T>(fn: (items: QueueItem[]) => T): Promise<T> {
    return exclusive(async () => {
      const items = await readQueue();
      const result = fn(items);
      await chrome.storage.local.set({ [QUEUE_KEY]: items });
  ```
- **修正案**：キューを書き換えるのは SW だけなので、SW の中にメモリのキャッシュを置く。続けて起きる更新は1回にまとめる。badge は `newValue` をそのまま使う。将来（数千件を大きく超える場合）は、1件ごとのキーに分ける。
- **効果の理由**：数百件のキューを処理している間の CPU と、画面の描き直しが減る。
- **確認方法**：test を通す。数百件を流しながら、SW の DevTools の Performance で storage の時間を比べる。
- **依存関係**：C-3（描き直しの回数）、C-5、C-6、B-9

#### C-3 見えていないタブでもキューとログを全件描き直している
- **内容**：キューが変わるたびに（200ms にまとめて）、グループと行をすべて作り直す。処理ログも、増えるたびに最大300件を作り直す。今「ログ」や「設定」のタブを見ていても同じ。
- **該当箇所**：`src/dashboard/queue-view.ts` `onChanged` 174–188行、`render` 315–344行、`renderEvents` 472–489行
- **根拠コード**
  ```ts
  $('queue-groups').replaceChildren(...fragments);
  ```
- **修正案**：キューのタブが見えていない間は、印だけ付けておき、表示されたときに1回描く。ログは、増えた分だけ前に足す。
- **効果の理由**：専用ページを開いたまま処理を回しているときの負荷が減る。
- **確認方法**：設定タブを開いたまま処理を回し、Performance で描画の時間がほぼなくなることを確かめる。
- **依存関係**：D-7（行ごとに差し替える形にすれば、両方とも解決する）

#### C-4 Linkex を呼ぶたびに、ページの準備確認を1往復している
- **内容**：タブの status が `'complete'` でないと、Linkex の呼び出しのたびに `pageReady`（executeScript、最大2秒）を通る。コミット aad54e7 によると、このタブは complete にならないことがある。
- **該当箇所**：`src/background/linkex-tab.ts` `ensureLinkexTab` 133–141行、`pageReady` 55–73行
- **根拠コード**
  ```ts
  if (tab?.id !== undefined && isDrive(tab.url) && (tab.status === 'complete' || (await pageReady(tab.id)))) {
  ```
- **修正案**：一度確認が通ったタブを覚えておき、読み込み直すか URL が変わるまでは確認を省く。
- **効果の理由**：Linkex の呼び出し1回ごとの遅れが減る。
- **確認方法**：処理ログの「URL取得(直接)」の時間が短くなることを確かめる。

#### C-5 処理ログを1件ずつ、300件まとめて読み書きしている
- **内容**：`logEvent` は1件ごとにログ全体を読み、書き戻す。完了を取り込むときは、件数分を1件ずつ書く。
- **該当箇所**：`src/background/store.ts` `logEvent` 14–24行、`src/background/engine.ts` 860行
- **根拠コード**
  ```ts
  for (const [level, message] of logs) await logEvent(level, message);
  ```
- **修正案**：まとめて書く `logEvents(entries[])` を作る。
- **効果の理由**：書く回数と、C-3 の描き直しが減る。
- **確認方法**：複数の件が同時に完了したとき、`onChanged` が1回だけ届くことを確かめる。

#### C-6 ダウンロード済みの記録を、1件ごとに全件読み書きしている
- **内容**：`rememberHash` も、重複の確認も、記録全体を読む。記録は消すまで増え続ける。
- **該当箇所**：`src/background/store.ts` `readHashes` / `rememberHash` 101–122行、`src/background/engine.ts` 475・506・821行
- **修正案**：SW の中に Map で持ち、まとめて書く。将来（数万件になったら）は、キーを分ける。
- **効果の理由**：今は小さいが、使い続けるほど効いてくる。
- **確認方法**：test を通す。重複の判定が今までどおりに働くことを確かめる。

#### C-7 設定を API 呼び出しのたびに storage から読んでいる
- **内容**：`jd()`、`callLinkex`、周回ごとの処理などが、毎回 `loadSettings()` を呼ぶ。
- **該当箇所**：`src/shared/settings.ts` `loadSettings` 54–62行、`src/background/jd2.ts` `jd` 11行、`src/background/linkex-tab.ts` 333行
- **修正案**：SW の中にキャッシュを置き、`onChanged` で入れ替える。
- **効果の理由**：小さいが、作業は軽い。
- **確認方法**：設定を変えたとき、次の呼び出しから新しい値が使われることを確かめる。

#### C-8 タブの凍結を見張るのに、呼び出しごとに 250ms 間隔で確かめている
- **内容**：Linkex の呼び出し1回ごとに、250ms 間隔で `chrome.tabs.get` を呼ぶ。同時に3本呼んでいると、1秒に約12回になる。
- **該当箇所**：`src/background/linkex-tab.ts` `watchFrozen` 489–499行
- **修正案**：見張りを1つにまとめて共有する。`tabs.onUpdated` で `frozen` を受け取れるなら、それを使う（受け取れるかは未確認）。
- **効果の理由**：小さい。
- **確認方法**：タブを凍結させたとき、今までどおり検出されることを確かめる。

#### C-9 キューへの追加の重複チェックが、件数の掛け算で重くなる（将来）
- **内容**：追加するファイルごとに、キュー全体を `items.some` で2回調べる。数百件なら問題ない。
- **該当箇所**：`src/background/enqueue.ts` `addWalkedToQueue` 63–98行
- **修正案**：先に Set を作って、そこから引く。
- **効果の理由**：数千件を超えたときに効く。
- **確認方法**：test を通す。
- **依存関係**：A-8

### D. 使い勝手（UI/UX）
※どれも、実際には操作せず、コードから判断した。

#### D-1 異常で止まったことが手動の一時停止と区別できず、理由も途中で切れる
- **内容**：
  - 異常で止まると `一時停止: <理由>` と出るが、ポップアップでも専用ページでも1行で省略表示されるので、対処を書いた後半が「…」で隠れる。
  - 札は、手動で止めたときと同じ灰色の「一時停止中」になる。
  - 走っている間の「待機中」「実行中」は、engine の日本語の文を正規表現で調べて決めている（観点 B の指摘をまとめた）。
  - ループが例外で止まったときも、`paused` は false のままで、札は「実行中」のまま（観点 D のもう1件をまとめた）。
- **該当箇所**：`src/ui/live.ts` `engineView()` 58–75行、`popup.html` 14行、`src/dashboard/dashboard.css` 12行、`src/background/engine.ts` `stopWithNotice()` 388–392行、`kick()` 80行
- **根拠コード**（まとめる側で確認済み）
  ```ts
  // live.ts
  71  return { paused, pill: unfinished ? '一時停止中' : '停止中', tone: '', message: ... };
  73  const waiting = /待機|待ち|空き/.test(message);
  // popup.html
  14  #engine { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  // engine.ts
  80  await writeEngine({ message: `処理が止まりました: ${errorText(e)}` });
  389 await writeEngine({ paused: true, message: `一時停止: ${reason}` });
  ```
- **修正案**：`EngineState` に `phase: 'running' | 'waiting' | 'paused' | 'stopped-error' | 'crashed'` を持たせ、engine が書き、画面はそれを読むだけにする。異常で止まったときは、札を赤の「止まりました」にし、理由を折り返して全文表示する（`nowrap` を外す）。
- **効果の理由**：止まった理由と対処がすぐ読める。留守中に止まったときに効く。
- **確認方法**：JD2 を止めた状態で開始し、約3分後にポップアップで赤い札と全文が出ることを確かめる。手動で止めたときは、灰色のままであることも確かめる。
- **依存関係**：A-3 と一緒に直す（理由の文が上書きされないことが前提）

#### D-2 JD2 が起動していないことに気づきにくく、そのまま開始できてしまう
- **内容**：
  - (a) ポップアップでは、JD2 の未接続はフッターの小さい灰色の文字だけで、原因と対処はツールチップにしかない。
  - (b) `requestJd` は8回呼び直す（待ち時間の合計は約9秒）ので、その間ずっと確認中のまま。
  - (c) 開始のときに JD2 を確かめない。JD2 がなくても件が進み、約3分後にやっと止まる。保存経由だと、その間に Linkex 側へコピーが作られる。
  - (d) 共有ページのパネルには、JD2 の状態が出ない。
- **該当箇所**：`src/popup/popup.ts` 320–326行、`src/shared/jd2-request.ts` `requestJd` 23–47行、`src/background/engine.ts` `start()` 90–103行、`JD_DOWN_LIMIT_MS` 30行、338–343行
- **根拠コード**（まとめる側で確認済み）
  ```ts
  // popup.ts
  323  $('jd-text').textContent = live ? 'JD2 接続中' : 'JD2 に接続できません';
  324  $('jd').title = error ?? '';
  // jd2-request.ts
  25   { fetchFn = fetch, sleep = realSleep, attempts = 8, timeoutMs = 8_000 }: RequestOptions = {},
  // engine.ts（start() では JD2 を確かめず、件の処理で失敗してから数え始める）
  30   const JD_DOWN_LIMIT_MS = 3 * 60_000;
  341      jdDownSince ||= Date.now();
  ```
- **修正案**：
  - `start()` で、呼び直しの少ない `jd/version` を1回試し、失敗したら開始せずに理由を返す。
  - 画面での状態確認は、呼び直しの少ない軽い確認にする。
  - 未接続のときは、ポップアップの上部に赤い帯で対処を出す。
- **効果の理由**：JD2 を起動し忘れることは日常的に起こり、気づくまでの3分と、無駄なコピーを減らせる。
- **確認方法**：JD2 を終了した状態で「開始」を押し、すぐに理由が出て開始されないことを確かめる。
- **依存関係**：D-1（止まった理由の表示を使う）、D-6（開始の失敗を表示する）

#### D-3 ダウンロード中の件しかないときに JD2 が落ちても知らせない
- **内容**：`doRefreshDownloads` は JD2 につながらないとき、何もせずに戻る。`jdDownSince` も進まないので止まらず、通知も出ない。表示は「ダウンロード中 N件」のまま。
- **該当箇所**：`src/background/engine.ts` `doRefreshDownloads()` 786–792行
- **根拠コード**
  ```ts
  } catch {
    return; // JD2に一時的につながらない場合は次回また確認
  }
  ```
- **修正案**：catch で `jdDownSince ||= Date.now()` とし、上限を超えたら `stopWithNotice` を呼ぶ（止めないなら、表示の文だけ変える）。
- **効果の理由**：残り数件のときに JD2 が落ちても気づける。
- **確認方法**：ダウンロード中に JD2 を終了し、約3分後に通知が出ることを確かめる。

#### D-4 設定タブで起きた失敗が、設定タブに表示されない
- **内容**：
  - 「Linkexのタブを表示」「容量・転送量を更新」「記録を消す」が失敗しても、確認用タブの `<pre id="log">` に書かれるだけ。
  - 「接続テスト」は保存済みの値で試すが、そのことが画面に書かれていない。
  - 保存の結果は、失敗しても3秒で消える。
  - 範囲外の数値は、知らせずに丸められる。
- **該当箇所**：`src/dashboard/dashboard.ts` `action` 26–37行、`jd-test` 122–143行、`submit` 164–185行
- **根拠コード**
  ```ts
  32  log(`エラー: ${(e as Error).message}`);
  126 // 入力中（未保存）の設定ではなく、保存済みの設定で試す
  184 setTimeout(() => ($('settings-saved').textContent = ''), 3000);
  ```
- **修正案**：失敗は `showNotice` にも出す。接続テストは、保存してから試す。失敗の文は消さずに残す。丸めたときは知らせる。
- **効果の理由**：設定を変えたときの試行錯誤が楽になる。
- **確認方法**：JD2 を止めた状態で、「容量・転送量を更新」などを押して、設定タブに失敗が出ることを確かめる。

#### D-5 内部のエラーコードがそのまま画面に出る
- **内容**：`tab_unresponsive`、`no_result`、`no_response` などが、そのまま「読み込めませんでした: …」として出る。ポップアップは件数だけを出し、理由を出さない。
- **該当箇所**：`src/background/linkex-tab.ts` `walkIn` 275・280行、`src/background/linkex-bridge.ts` 52・58・234・243行、`src/popup/popup.ts` `addUrls` 53行
- **根拠コード**
  ```ts
  resolve({ ok: false, error: 'tab_unresponsive' });
  if (r.failed.length) parts.push(`開けなかった共有 ${r.failed.length}件`);
  ```
- **修正案**：コードを日本語の文に置き換える表を shared に置き、どの画面でもそれを通す。ポップアップにも、最初の1件の理由を出す。
- **効果の理由**：何をすればよいか分かる。
- **確認方法**：Linkex のタブを凍結させた状態で共有を追加し、日本語の対処の文が出ることを確かめる。

#### D-6 開始・一時停止ボタンが失敗を無視する
- **内容**：ポップアップの開始・一時停止ボタンは結果を見ず、押している間も無効にならない。共有ページの `afterAdd` は、開始に失敗しても緑で表示する。
- **該当箇所**：`src/popup/popup.ts` 27–29行、`src/content/share-page.ts` `afterAdd` 255–263行
- **根拠コード**
  ```ts
  $('toggle').addEventListener('click', async () => { await send({ type: engine?.paused === false ? 'queue.pause' : 'queue.start' }); });
  setStatus(text, 'ok');
  ```
- **修正案**：押している間は disabled にする。`!res.ok` なら赤で表示する。
- **効果の理由**：押したのに何も起きない状態をなくせる。
- **確認方法**：D-2 の修正の後、JD2 を止めた状態で開始を押し、赤で理由が出ることを確かめる。
- **依存関係**：D-2

#### D-7 一覧を全部作り直すたびに、フォーカスや押しかけのクリックが失われる
- **内容**：処理中は一覧が頻繁に作り直され、フォーカスしていたボタンが消える。「待ち N件を外す」の2回押しは、1回目で作り直しが起きるので、キーボードでは続けて押せない。クリックが失われることもありそうだが、これは推測。
- **該当箇所**：`src/dashboard/queue-view.ts` 176–179行、`render` 336行、88行
- **根拠コード**
  ```ts
  $('queue-groups').replaceChildren(...fragments);
  const armedKeys = new ArmedKeys(() => scheduleRender(0));
  ```
- **修正案**：作り直す前に、フォーカスしているボタンのキーを覚えておき、作り直した後に戻す。本格的にやるなら、行ごとに差し替える。
- **効果の理由**：処理中でも一覧を操作しやすくなる。
- **確認方法**：処理中に Tab キーで「外す」ボタンにフォーカスし、数秒待ってもフォーカスが残っていることを確かめる。
- **依存関係**：C-3

#### D-8 アクセシビリティの細かい不足
- **内容**：
  - タブに `role="tab"` を付けているが、矢印キーで移動できず、aria-controls もない。
  - 絞り込みのチップに aria-pressed がない。
  - 処理ログの info と warn を、色だけで区別している。
  - 共有ページの `.status` に aria-live がない。
- **該当箇所**：`dashboard.html` 40–45行・104–105行、`src/dashboard/queue-view.ts` `renderFilters` 299–313行、`src/dashboard/dashboard.css` 122–123行、`src/content/share-page.ts` 202行
- **修正案**：チップに aria-pressed を付ける。ログの行頭に「注意」「エラー」の文字を付ける。`.status` に `aria-live="polite"` を付ける。
- **効果の理由**：小さいが、作業は軽い。
- **確認方法**：DevTools の Accessibility パネルで確かめる。

### E. ドキュメント

#### E-1 状態遷移とサイズのコメントが、保存経由の流れのまま古くなっている
- **内容**：
  - `ItemState` のコメントには、保存経由の流れしか書かれていない（v2.1 の初期設定は直接取得で、`pending → downloading` と進む）。retry の説明も「共有から保存し直す」のまま。
  - `fileSize` の説明は「自分のコピーのサイズ」になっているが、実際は CDN の大きさを優先して使っている。
  - `runWorker` と `toDiscard` のコメントも、直接取得の経路を書いていない。
  - `sendToJd` に、食い違う古いコメントが残っている（観点 E の2件目をまとめた）。
- **該当箇所**：`src/shared/queue.ts` 1–5行・55行、`src/background/engine.ts` `runWorker` 264行、`sendToJd` 655–657行、`doRefreshDownloads` 801行
- **根拠コード**（まとめる側で確認済み）
  ```ts
  // queue.ts
  3   * pending → copying → copied → deleting → downloading → done
  4   * 途中で失敗したら retry（共有から保存し直す）、何度も失敗したら error。
  55  /** 自分のコピーのサイズ（Linkexの file/get）。JD2が途中で切れた分を完了にしていないか確かめる */
  // engine.ts
  264  * 1件の担当。保存 → コピー探し → URL発行・JD2へ → 完全削除 まで進める。
  655  // 共有一覧のサイズは実際とずれることがあるので、完了の確かめには自分のコピーのサイズを使う
  656  // 受け取った量の確かめには、CDN が実際に配っている大きさ（URL の最後の段）を使う
  657      const fileSize = cdnObjectSize(url) ?? Number(file?.size);
  801  // JD2があきらめたリンク。保存し直して新しいURLで渡すので、落としかけのファイルごとJD2の一覧から消す
  ```
- **修正案**：
  - 状態遷移を2つの経路に分けて書く。
    - 直接：`pending/retry → downloading → done`
    - 保存経由：`pending/retry → copying → copied → deleting(JD2渡し済み) → downloading → done`
  - `skipped` と、「retry は次の周回で、設定に従って取り直す」ことも書き足す。
  - `fileSize`、`runWorker`、801行のコメントを直す。
  - 655行を消し、657行の字下げを直す。
- **効果の理由**：保守のときに最初に読む箇所が、実装と食い違っている。
- **確認方法**：コメントだけの変更なので、typecheck を通し、差分を読んで確かめる。
- **依存関係**：B-1 と B-2 の前にやると、整理するときに読み違えない。

#### E-2 「追加したらすぐ開始」がどこからの追加に効くか、説明が食い違っている
- **内容**：設定の `autoStartOnAdd` を見ているのは、右クリックからの追加だけ。ポップアップと共有ページは、それぞれ画面のチェックで決まる。ところが settings.ts のコメントは「ページ内のリンク収集」にも効くと書いていて、README の手順4も、どの画面の設定なのか分からない。
- **該当箇所**：`src/shared/settings.ts` 33–34行、`src/background/menus.ts` 53–54行、`README.md` 47行・70行
- **根拠コード**
  ```ts
  /** 右クリックやページ内のリンク収集で追加したら、すぐ開始する */
  const { autoStartOnAdd } = await loadSettings(); if (r.added > 0 && autoStartOnAdd && …
  ```
- **修正案**：コメントは「右クリックメニューから追加したとき」に直す。README の手順4は、画面ごとに書き分ける。
- **効果の理由**：設定の誤解を防げる。
- **確認方法**：差分を読んで確かめる。

#### E-3 直接ダウンロードのとき、一部の設定が何に効くのか書かれていない
- **内容**：「先に保存しておく数」は、直接取得では0として扱われる。「同時に処理する数」は、Linkex の API を同時に呼ぶ数の上限も兼ねている。README の表には、どちらも書かれていない。
- **該当箇所**：`README.md` 64・66行、`src/background/engine.ts` 158行、`src/background/linkex-tab.ts` 334行
- **根拠コード**
  ```ts
  prefetch: settings.directDownload ? 0 : Math.max(0, settings.prefetchItems),
  while (activeCalls >= Math.max(1, parallelItems)) await …
  ```
- **修正案**：表の該当する行に、1文ずつ書き足す。
- **効果の理由**：初期設定で使うときに、設定の意味が分かる。
- **確認方法**：差分を読んで確かめる。

#### E-4 設定の数値の範囲が README に書かれていない
- **内容**：JD2 に渡しておく数は1〜16、同時に処理する数は1〜6、先に保存しておく数は0〜3。README の表には初期値しかない。
- **該当箇所**：`README.md` 61–66行、`src/dashboard/dashboard.ts` 170–175行
- **修正案**：初期値の列を「初期値（範囲）」にする。
- **効果の理由**：小さい。
- **確認方法**：差分を読んで確かめる。

#### E-5 docs/superpowers が v1（Motrix）向けのまま残っている
- **内容**：retry-cleanup の設計書は、今はない `src/background/motrix.ts` を前提にしている。計画書はチェックが1つも付いておらず、未着手の作業に見える。利用者向けの文書ではない（観点 F の「不要ファイル」の指摘をまとめた）。
- **該当箇所**：`docs/superpowers/specs/2026-11-15-retry-cleanup-design.md`、`docs/superpowers/plans/2026-11-15-retry-cleanup.md`
- **根拠コード**
  ```
  - `src/background/motrix.ts`: addDownload に上記オプションを追加。
  ```
- **修正案**：残すなら、先頭に「v1 向けの記録」と書く。不要なら private/ に移す。今後も作るなら .gitignore に足す。
- **効果の理由**：保守のときの誤解を防げる。
- **確認方法**：差分を読んで確かめる。

#### E-6 JSDoc が関数でなく、別の宣言の上に付いている
- **内容**：`walkIn` の説明が `WALK_STALL_MS` の上にあり、`ensureLinkexTab` の説明が `let cachedTabId` の上にある。
- **該当箇所**：`src/background/linkex-tab.ts` 262–266行、121–130行
- **根拠コード**
  ```ts
  /** 指定したタブの中で共有をたどる。そのあいだ、途中経過を拾って storage に書く */
  /** ページから20秒以上返事がなければ、凍結などで止まっているとみなす */
  const WALK_STALL_MS = 20_000;
  ```
- **修正案**：それぞれ、関数の直前に移す。
- **効果の理由**：エディターで関数にカーソルを合わせたとき、説明が出るようになる。
- **確認方法**：エディターで関数にホバーして確かめる。

#### E-7 手元の環境に固定した絶対パスが書かれている
- **内容**：使い方の例が、`E:\Tools\linkex-jd2\scripts\...` や、PATH を「設定済み」とする書き方になっている。
- **該当箇所**：`scripts/fix-extensions.ps1` 8–17行、`docs/fix-extensions.md` 8行
- **修正案**：相対パスか、`<リポジトリ>\scripts` という書き方にする。
- **効果の理由**：小さい（公開リポジトリとして読みやすくなる）。
- **確認方法**：差分を読んで確かめる。

### F. 依存関係・開発環境

#### F-1 必要な Node の版がどこにも書かれていない（engines、README）
- **内容**：`npm test` は、`.ts` のテストを Node の型除去でそのまま実行する。Node 公式ドキュメントでは、型除去が既定で有効になったのは v22.18.0 と v23.6.0 から。package.json に engines はなく、README も「ビルドする場合は Node.js」だけ。README の「自分でビルドする」には、`npm run typecheck` と `npm test` も書かれていない（観点 E の指摘をまとめた）。手元の v26.13.1 では問題なく動いた。
- **該当箇所**：`package.json` 12–17行（engines がない）、`README.md` 17行・29–36行
- **根拠コード**
  ```json
  "test": "node --test tests/"
  ```
- **修正案**：package.json に `"engines": { "node": ">=22.18.0" }` を足し、README にも同じ範囲を書く。README には typecheck と test のコマンドも1行ずつ足す。
- **効果の理由**：環境を作り直したときに、つまずかずに済む。
- **確認方法**：`npm test` が今までどおり通ることを確かめる。

#### F-2 tests/ が型チェックの対象外で、型除去の制約も守らせていない
- **内容**：
  - tsconfig の include に tests が入っていないので、テストの型の誤りを見つけられない。
  - 型除去で実行できない書き方を、コンパイラで禁止していない。
    - 拡張子のない相対 import（`estimate.ts` 1行 `from './files'` など）
    - パラメータプロパティ（`src/ui/confirm.ts` 36行）
  - 今テストしているモジュール以外を、テストから読めない。
- **該当箇所**：`tsconfig.json` 3–15行
- **根拠コード**
  ```json
  "include": ["src", "vite.config.ts", "vite.content.config.ts"]
  ```
- **修正案**：テスト用の tsconfig（例：`tsconfig.test.json`）を足し、`allowImportingTsExtensions` と `erasableSyntaxOnly` を有効にして、`tests` を含める。TS 7 でこれらのオプションが使えるかは要確認。
- **効果の理由**：テストを増やしやすくなる。
- **確認方法**：`npx tsc -p tsconfig.test.json --noEmit` が通ることを確かめる。

#### F-3 lint と formatter がない
- **内容**：ESLint、Biome、Prettier、.editorconfig のどれもない。tsc の strict と noUnused* で、ある程度は補えている。
- **該当箇所**：`package.json` 18–22行
- **修正案**：入れるなら、lint と format を兼ねる Biome を1つだけ入れる。必須ではない。
- **効果の理由**：作業するのが1人なので、低い。B-2 にある字下げのずれのようなものは防げる。
- **確認方法**：`npx biome check src` を実行する。

#### F-4 パッチ更新が2件ある（vite、@types/chrome）
- **内容**：`npm outdated` の結果は次のとおり。どちらも指定範囲（^）の中のパッチ更新で、メジャー更新はない。typescript 7.0.2 は最新。CHANGELOG は読んでいないので、内容は要確認。
  ```
  @types/chrome    0.3.7   0.3.8   0.3.8
  vite             8.3.5   8.3.8   8.3.8
  ```
- **該当箇所**：`package.json` 19–21行
- **修正案**：次に手を入れるついでに `npm update` し、build と test を確かめる。
- **効果の理由**：低い。
- **確認方法**：`npm outdated` の結果が空になり、build と test が通ることを確かめる。

**F の観点で問題がなかったもの**（確認した範囲）
- 未使用パッケージ：3つとも使われている。
  - @types/chrome：tsconfig の `types`
  - vite：設定ファイルと `scripts/watch.mjs`
  - typescript：`tsc`
- manifest.json の permissions と host_permissions：すべて使われていて、必要最小限。
  - storage、tabs、scripting、alarms、notifications、contextMenus、activeTab、declarativeNetRequestWithHostAccess：それぞれ src に使っている箇所がある。
  - `*.fastspeedcdn.com`：CDN の確認に使う。
  - 127.0.0.1 と localhost：JD2 に使う。
- .gitignore：node_modules/、dist/、private/ の3つで、意図どおり。
- `scripts/watch.mjs`：存在する。package.json から参照されている。

## 4. おすすめの着手順（5件）

1. **E-1**（効果 高・作業量 小）：コメントだけで済み、この後の B-2、B-1、D-2 で engine.ts を読むときの前提になる。
2. **D-1**（高・小）＋ A-3：異常で止まったときに理由が読めるようになり、日常の使い勝手にいちばん直接効く。A-3 は、理由の文が上書きされないための前提なので一緒に直す。
3. **D-2**（高・中）：JD2 の起動し忘れを開始の時点で止められる。D-1 の表示を使う。
4. **B-2**（高・中）：重複を先に関数へまとめておくと、B-1 で分割するときに移す量が減る。
5. **B-1**（高・中）：engine.ts を分け、状態を1か所にまとめる。B-2 で中身を整理した後にやるのが楽。

## 5. 対象外だが要注意

該当なし。API キー、パスワード、トークン、メールアドレス、`C:\Users` を含むパスを検索したが、見つからなかった。見つかったのは、GitHub のユーザー名（LICENSE、package.json、README）と、使わなくなった設定 rpcSecret を捨てる処理（settings.ts 56–60行）だけ。
