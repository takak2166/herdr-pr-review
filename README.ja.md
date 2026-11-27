# herdr-pr-review

[Herdr](https://herdr.dev) で GitHub の Pull Request をレビューするためのレイアウトです。[English](README.md)

- 自分の PR とレビュー依頼を、次にやることで分けて並べる（レビューする・対応する・返事待ち・ウォッチ）
- 差分をフォルダの木（テストと自動生成のファイルはコードの後ろにまとめる）からファイルごとに、シンタックスハイライト付きで読む（1 列・左右）。GitHub の Viewed の印も使える
- 行・複数行へのコメントと返信を手元で下書きして、まとめて 1 つのレビューとして送る。解決済み（Resolved）のスレッドは畳んでおき、クリックで開く
- Markdown のファイルをプレビューで読み、ブロック（見出し・段落・リストの項目・表・引用・コード）を押してその行にコメントする。Mermaid の図は SVG で描き、クリックで拡大・ドラッグで移動できる
- PR の head のコードを開き、F12 で定義、Shift+F12 で参照（Go は gopls で型を見て調べ、gRPC のサービスをまたいだ呼び出しも出す）、行の blame、Cmd+F（Ctrl+F）で検索、文字の選択、Cmd+クリックでファイルを右の列に並べて開く
- 下調べ: Claude Code に先に PR を読ませ、PR の本文・設計書・ADR と食い違うコードや、理由がどこにも書かれていない選択を、must・should・nits の重さつきで差分に挙げる。クリックで行コメントの下書きにできる（自分の PR では、何を説明すべきかのメモになる）。1 件ずつ・全部を、ファイルと行つきでコピーできる
- 右のペインで、その PR について Claude Code に聞く
- 日本語と英語（Mac の言語に合わせる。切り替えも可）

![PR Review](preview.png)

## 入れ方

Herdr のエージェントに、バージョン（git のタグ。[CHANGELOG.md](CHANGELOG.md) を参照）を指定して次のように頼むと、手順（ファイルのコピーとキー設定のマージ）に沿って入れてくれます。

```
github.com/takak2166/herdr-pr-review のレイアウトを、タグ v0.5.0 で入れて
```

手で入れる場合は、そのタグの `layouts/pr-review.json` と `mods/pr-review/` を `~/.config/herdr-app/` の同じ場所に写し、`keys.json` を自分の `keys.json` にマージしてから、`ctrl-shift-l`（または `layout.switch {name: "pr-review"}`）で切り替えます。

## 更新のしかた

Herdr にはパッケージ管理の仕組みがありません。レイアウトは `~/.config/herdr-app/` に置いたファイルにすぎず、どのバージョンを入れたかはどこにも記録されません。入れたときのタグを控えておいてください（写したバージョンの `CHANGELOG.md` でも分かります）。

Herdr の手順では、エージェントは同じ名前があると上書きせずに名前を変えて入れます。そのため、もう一度「入れて」と頼むと別物（`pr-review-2`）ができてしまいます。更新であることをはっきり伝えてください。

```
github.com/takak2166/herdr-pr-review のレイアウトを、タグ v0.5.0 に更新して。
mods/pr-review/ と layouts/pr-review.json はその場で置き換えてよい（上書きして構わない）。
keys.json に新しいキーがあればマージして。
```

手で更新する場合は、`mods/pr-review/` と `layouts/pr-review.json` を新しいバージョンのものに置き換え、`keys.json` の新しい項目をマージします。下書き・Viewed の印（GitHub 側）・ペインの幅・言語の設定は、これらのファイルの外にあるので残ります。`data/pr-review/config.json` はあなたのファイルで、更新では触りません。

## 前提

- macOS
- `gh` にログイン済み（一覧・差分・Viewed の印・レビューの送信に使います）
- レビューするリポジトリのクローンが `~/ghq/github.com/<owner>/<repo>` にあること（コード表示・定義・参照・blame に使います。差分だけならなくても動きます）
- 任意: `gopls` と `go`（Go の定義と参照を型で調べます。なければ単語の検索になります）。`go` は、gopls のセッションを開いたままにする小さな補助プログラム（`mods/pr-review/lsp/main.go`、標準ライブラリのみ）を初回にビルドするのにも使います。2 回目以降の問い合わせは 1 秒かかりません
- 右のペインと下調べには `claude`（Claude Code）。下調べは既定で Opus を effort high で使い、リポジトリを広く読むので、1 回で Claude の利用枠をかなり使うことがあります（モデルは下で変えられます）
- 任意: Google Chrome、Node.js 22 以上、Mermaid 本体（Markdown のプレビューで Mermaid の図を描くのに使います。なければ図のコードをそのまま出します）。Mermaid は npm から一度だけ取ってきます。図は手元で描き、どこにも送りません:

  ```sh
  d=~/.config/herdr-app/data/pr-review/mermaid; mkdir -p "$d" && cd "$(mktemp -d)" \
    && npm install --no-audit --no-fund mermaid@11 && cp node_modules/mermaid/dist/mermaid.min.js "$d/"
  ```

## キー

| キー | 動き |
|---|---|
| F12 | ハイライトした名前の定義へ |
| Shift+F12 | 参照へ（もう一度で次へ） |
| Ctrl+- / Ctrl+Shift+- | 戻る / 進む |
| Cmd+Shift+C | コードと差分を切り替え |
| Cmd+F / Ctrl+F | 表示中のファイルを検索 |
| ファイルを Cmd+クリック（コード表示） | 右の列に並べて開く |
| Cmd+Enter | 書いているコメントを保存（Enter は改行） |
| Cmd+C | 選んだ文字をコピー |

## 自分のタブと質問

`~/.config/herdr-app/data/pr-review/config.json` に書きます（[config.example.json](config.example.json) を参照）。

```json
{
  "tabs": [{ "name": "チーム", "query": "repo:owner/name" }],
  "prompts": [{ "label": "セキュリティ", "ask": "この PR のセキュリティ上の問題を探してください。" }],
  "research": { "model": "sonnet", "effort": "medium" }
}
```

タブの query は GitHub の検索条件です（`is:pr is:open` が付きます）。prompts を書くと、最初から入っている 2 つの質問（レビューして・図解して）の代わりになります。`research` は下調べに使うモデルと effort です（既定は `opus` と `high`。effort は `low`・`medium`・`high`・`xhigh`・`max` のどれか）。書き換えたら `pr-review.config` を実行するか、Herdr を起動し直してください。

## 一覧の絞り込み

絞り込みの欄は、題・番号・リポジトリ・作者で探します。`review:required` / `approved` / `changes`、`is:draft`、`ci:failing` / `passing`、`author:<名前>`、`repo:<名前>` も使えます。

作りの詳細は [RECIPE.md](RECIPE.md)（英語）にあります。

## 貢献とライセンス

issue や PR を歓迎します。手順は [CONTRIBUTING.md](CONTRIBUTING.md)（英語）にあります。ライセンスは [MIT](LICENSE) です。
