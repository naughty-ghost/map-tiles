/**
 * 現行 tile.openstreetmap.jp のスタイル JSON を取得し、
 * sources / glyphs / sprite の URL を自前 CDN に書き換えて dist/ に出力する。
 * スプライト画像も同時にダウンロードする（R2 へはこの dist/ をそのままアップロードする）。
 *
 * 使い方: node scripts/build-styles.mjs
 *   CDN の URL を変える場合: TILES_BASE_URL=https://example.com node scripts/build-styles.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://tile.openstreetmap.jp';
const CDN = process.env.TILES_BASE_URL || 'https://tiles.naughty-ghost.org';
const STYLES = ['osm-bright-ja', 'maptiler-basic-ja'];

// 現行スタイルの vector source 名 → 自前 PMTiles 名
const SOURCE_NAME_MAP = {
  openmaptiles: 'japan',
};

/**
 * 除去するソース。竹島・北方領土の補完データはホスティングせず
 * 空白表示を許容する決定のため（hazardmap Issue #5 の記録を参照）
 */
const REMOVED_SOURCES = new Set(['takeshima', 'hoppo']);

const distDir = path.join(import.meta.dirname, '..', 'dist');

const download = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
};

const fontStacks = new Set();

for (const name of STYLES) {
  const style = await (await download(`${ORIGIN}/styles/${name}/style.json`)).json();

  let removedLayers = 0;
  for (const [key, source] of Object.entries(style.sources)) {
    if (REMOVED_SOURCES.has(key)) {
      delete style.sources[key];
      continue;
    }
    const mapped = SOURCE_NAME_MAP[key];
    if (!mapped) {
      throw new Error(`未知の source "${key}" が ${name} に存在します。SOURCE_NAME_MAP に追加してください`);
    }
    source.url = `${CDN}/tiles/${mapped}.json`;
  }
  style.layers = style.layers.filter((layer) => {
    if (REMOVED_SOURCES.has(layer.source)) {
      removedLayers++;
      return false;
    }
    return true;
  });

  const originalSprite = style.sprite;
  style.glyphs = `${CDN}/fonts/{fontstack}/{range}.pbf`;
  style.sprite = `${CDN}/styles/${name}/sprite`;

  for (const layer of style.layers) {
    for (const font of layer.layout?.['text-font'] ?? []) {
      fontStacks.add(font);
    }
  }

  const styleDir = path.join(distDir, 'styles', name);
  await mkdir(styleDir, { recursive: true });
  await writeFile(path.join(styleDir, 'style.json'), JSON.stringify(style, null, 2));

  // スプライトは現行のものをそのまま流用する（ライセンス表記は README 参照）
  for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
    const res = await download(`${originalSprite}${suffix}`);
    await writeFile(
      path.join(styleDir, `sprite${suffix}`),
      Buffer.from(await res.arrayBuffer())
    );
  }

  console.log(`✔ ${name}（除去したレイヤー: ${removedLayers}）`);
}

console.log('\n必要なフォントスタック（グリフを fonts/ 配下に全 range 分配置すること）:');
for (const stack of fontStacks) {
  console.log(`  - ${stack}`);
}
