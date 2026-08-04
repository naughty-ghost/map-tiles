/**
 * 現行 tile.openstreetmap.jp が配信するグリフ（フォント PBF）を全 range 分取得して
 * dist/fonts/ に配置する。移行後の「見た目同等」を確実にするため、
 * 生成し直すのではなく配信中の実物を流用する（ライセンスは README 参照）。
 *
 * 使い方: node scripts/fetch-fonts.mjs <fontstack> [<fontstack> ...]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://tile.openstreetmap.jp';
const CONCURRENCY = 8;

const stacks = process.argv.slice(2);
if (stacks.length === 0) {
  console.error('使い方: node scripts/fetch-fonts.mjs <fontstack> [<fontstack> ...]');
  process.exit(1);
}

const ranges = [];
for (let start = 0; start < 65536; start += 256) {
  ranges.push(`${start}-${start + 255}`);
}

for (const stack of stacks) {
  const dir = path.join(import.meta.dirname, '..', 'dist', 'fonts', stack);
  await mkdir(dir, { recursive: true });

  let failed = 0;
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    await Promise.all(
      ranges.slice(i, i + CONCURRENCY).map(async (range) => {
        const res = await fetch(`${ORIGIN}/fonts/${encodeURIComponent(stack)}/${range}.pbf`);
        if (!res.ok) {
          failed++;
          console.error(`✘ ${stack}/${range}.pbf -> ${res.status}`);
          return;
        }
        await writeFile(
          path.join(dir, `${range}.pbf`),
          Buffer.from(await res.arrayBuffer())
        );
      })
    );
  }
  console.log(`${failed === 0 ? '✔' : '⚠'} ${stack}（失敗 ${failed} 件）`);
  if (failed > 0) process.exitCode = 1;
}
