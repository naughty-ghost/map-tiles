# map-tiles

OSM ベクトルタイルを Cloudflare R2 + Workers + CDN で自前配信する汎用の地図タイル配信基盤。
`tile.openstreetmap.jp` 等の外部タイルサーバーに依存せず、複数のアプリから共用できる。

最初の利用アプリは [hazardmap](https://github.com/naughty-ghost/hazardmap)。
要件・設計の経緯は [hazardmap Issue #5](https://github.com/naughty-ghost/hazardmap/issues/5) を参照（Phase 2 詳細設計のコメントが本リポジトリの仕様の初出）。

## アーキテクチャ

```
[クライアント (MapLibre GL)]
   ▼
[Cloudflare CDN（tiles.naughty-ghost.org）]
   ├─ /styles/{name}/style.json・sprite*  ─┐
   ├─ /fonts/{fontstack}/{range}.pbf       ├─ Worker が R2 の静的ファイルをそのまま配信
   └─ /tiles/{source}/{z}/{x}/{y}.mvt      （source = japan）
        │ Worker が PMTiles から Range Request でタイルを切り出して返却
        ▼
      [R2: japan.pmtiles + 静的ファイル]
```

- Worker は [protomaps/PMTiles](https://github.com/protomaps/PMTiles) の serverless/cloudflare 実装（BSD-3-Clause）ベース
- `/tiles/{source}.json` は各 PMTiles のメタデータから TileJSON を動的生成する。
  **PMTiles のメタデータに `© OpenStreetMap contributors` の attribution が入っていることを必ず確認する**（ODbL の帰属表示義務。Planetiler は既定で付与する）
- 新しいタイルソースを追加する場合は `{name}.pmtiles` を R2 に置くだけで `/tiles/{name}/...` として配信される

## リポジトリ構成

| パス | 内容 |
|---|---|
| `worker/` | Cloudflare Worker（配信本体）。wrangler でデプロイ |
| `scripts/build-styles.mjs` | 現行スタイル JSON の取得・URL 書き換え・スプライト取得（`dist/` に出力） |
| `dist/`（生成物） | R2 にアップロードする静的ファイル一式（git 管理外） |
| `data/`（生成物） | Planetiler の入出力（git 管理外） |
| `docs/setup-report.html` | 構築記録（背景・設計判断・手順・トラブルシューティング・ライブデモ） |

## 初回セットアップ

### 1. Cloudflare 側の前提（ダッシュボード作業）

1. Cloudflare アカウントで **R2 を有効化**（無料枠でも支払い方法の登録が必要）
2. `naughty-ghost.org` ゾーンが同アカウントにあること（済）

### 2. wrangler 認証とバケット作成

```sh
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create map-tiles
```

### 3. タイル生成（Planetiler、Java 21 必須）

```sh
# Planetiler 最新版 jar を取得
curl -L -o data/planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar

# 日本全域を生成（Geofabrik から自動ダウンロード。初回は 1〜2 時間程度）
java -Xmx4g -jar data/planetiler.jar --download --area=japan --output=data/japan.pmtiles
```

> 現行 tile.openstreetmap.jp が補完ソースとして配信している takeshima / hoppo
> （竹島・北方領土）は**ホスティングせず空白表示を許容する**（2026-08-04 決定、
> hazardmap Issue #5 に記録）。`build-styles.mjs` が両ソースとその参照レイヤーを
> スタイルから除去する。

### 4. スタイル・スプライト・グリフの生成

```sh
node scripts/build-styles.mjs
node scripts/fetch-fonts.mjs migu1c-regular migu2m-regular migu2m-bold
```

`build-styles.mjs` で `dist/styles/` にスタイル 2 種（osm-bright-ja / maptiler-basic-ja）と
スプライトが出力され、必要なフォントスタック一覧が表示される。
`fetch-fonts.mjs` はそのフォントスタックのグリフ（全 256 range）を現行サーバーから取得して
`dist/fonts/` に配置する（再生成ではなく実物を流用することで見た目同等を担保する）。

> **ライセンス確認（未完了）**: 流用するスタイル JSON・スプライトのライセンス表記
> （OpenMapTiles 系スタイルは BSD-3-Clause が一般的だが ja 派生版の個別確認が必要）を確認し、
> 本 README に記録すること。グリフの元フォント（Migu）は確認済み（下記ライセンス節を参照）。

### 5. R2 アップロード

`japan.pmtiles`（約 1.7GB）は wrangler の 300MiB 制限を超えるため rclone を使う。

1. Cloudflare ダッシュボード → R2 → 「R2 API トークンの管理」で S3 互換トークンを作成
   （権限は「オブジェクトの読み取りと書き込み」、バケットは `map-tiles` に限定）
2. rclone に `r2` リモートを設定（S3 互換、provider は `Cloudflare`、endpoint は `https://<account_id>.r2.cloudflarestorage.com`）
3. アップロード:

```sh
rclone copy data/japan.pmtiles r2:map-tiles/ --s3-no-check-bucket --s3-upload-cutoff=100M --s3-chunk-size=100M
rclone copy dist/ r2:map-tiles/ --s3-no-check-bucket
```

`--s3-no-check-bucket` は必須。バケット限定トークンではバケット存在確認（HeadBucket）が
403 になり、rclone がバケットを作成しようとして失敗するため。

### 6. Worker デプロイ

```sh
cd worker
npx wrangler deploy
```

`wrangler.toml` の `custom_domain = true` により、`tiles.naughty-ghost.org` の
DNS レコードと証明書は自動作成される。

### 7. 疎通確認

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://tiles.naughty-ghost.org/tiles/japan.json
curl -s -o /dev/null -w "%{http_code}\n" https://tiles.naughty-ghost.org/tiles/japan/10/909/403.mvt
curl -s -o /dev/null -w "%{http_code}\n" https://tiles.naughty-ghost.org/styles/osm-bright-ja/style.json
```

## 月次更新手順（運用）

1. `java -Xmx4g -jar data/planetiler.jar --download --area=japan --output=data/japan.pmtiles`（`--download` が最新の japan-latest.osm.pbf を取得する）
2. `rclone copy data/japan.pmtiles r2:map-tiles/ --s3-no-check-bucket --s3-upload-cutoff=100M --s3-chunk-size=100M`
3. Cloudflare ダッシュボード → キャッシュ → **「すべてをパージ」**
   （プレフィックス指定パージは Enterprise 限定のため全パージとする。タイルは 1 日で再キャッシュされるため実用上の影響は軽微）
4. アプリで表示確認（ズーム z4 / z10 / z14 / z16）

スタイル・グリフ・スプライトは変更時のみ再生成・再アップロードする。

## ライセンス・帰属表示

- タイルデータ: © OpenStreetMap contributors（[ODbL](https://www.openstreetmap.org/copyright)）。TileJSON の attribution で表示
- Worker コード: protomaps/PMTiles（BSD-3-Clause）由来
- グリフ: [Migu フォント](https://mix-mplus-ipa.osdn.jp/migu/)（M+ と IPA ゴシックの合成、[IPA フォントライセンス v1.0](https://moji.or.jp/ipafont/license/)）から生成されたもの
- スタイル・スプライト: 上記「ライセンス確認（未完了）」を参照
