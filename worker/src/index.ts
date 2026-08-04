/**
 * 地図タイル配信 Worker
 *
 * protomaps/PMTiles serverless/cloudflare（BSD-3-Clause）をベースに、
 * 以下のエンドポイント契約（初出: hazardmap Issue #5 Phase 2 設計）に合わせて変更したもの:
 * - /tiles/{source}/{z}/{x}/{y}.mvt / /tiles/{source}.json … PMTiles から切り出して配信
 * - /styles/** , /fonts/** … R2 の静的ファイルをそのまま配信
 */
import {
  Compression,
  EtagMismatch,
  PMTiles,
  RangeResponse,
  ResolvedValueCache,
  Source,
  TileType,
  tileTypeExt,
} from 'pmtiles';
import { pmtilesPath, tilePath } from './tilePath';

interface Env {
  ALLOWED_ORIGINS?: string;
  BUCKET: R2Bucket;
  CACHE_CONTROL?: string;
  PMTILES_PATH?: string;
  PUBLIC_HOSTNAME?: string;
}

class KeyNotFoundError extends Error {}

async function nativeDecompress(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return buf;
  }
  if (compression === Compression.Gzip) {
    const stream = new Response(buf).body;
    const result = stream?.pipeThrough(new DecompressionStream('gzip'));
    return new Response(result).arrayBuffer();
  }
  throw new Error('Compression method not supported');
}

const CACHE = new ResolvedValueCache(25, undefined, nativeDecompress);

class R2Source implements Source {
  env: Env;
  archiveName: string;

  constructor(env: Env, archiveName: string) {
    this.env = env;
    this.archiveName = archiveName;
  }

  getKey() {
    return this.archiveName;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    const resp = await this.env.BUCKET.get(
      pmtilesPath(this.archiveName, this.env.PMTILES_PATH),
      {
        range: { offset: offset, length: length },
        onlyIf: { etagMatches: etag },
      }
    );
    if (!resp) {
      throw new KeyNotFoundError('Archive not found');
    }

    const o = resp as R2ObjectBody;

    if (!o.body) {
      throw new EtagMismatch();
    }

    const a = await o.arrayBuffer();
    return {
      data: a,
      etag: o.etag,
      cacheControl: o.httpMetadata?.cacheControl,
      expires: o.httpMetadata?.cacheExpiry?.toISOString(),
    };
  }
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  png: 'image/png',
  pbf: 'application/x-protobuf',
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'HEAD') {
      return new Response(undefined, { status: 405 });
    }

    const url = new URL(request.url);
    const cache = caches.default;

    let allowedOrigin = '';
    if (typeof env.ALLOWED_ORIGINS !== 'undefined') {
      for (const o of env.ALLOWED_ORIGINS.split(',')) {
        if (o === request.headers.get('Origin') || o === '*') {
          allowedOrigin = o;
        }
      }
    }

    const cached = await cache.match(request.url);
    if (cached) {
      const respHeaders = new Headers(cached.headers);
      if (allowedOrigin)
        respHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
      respHeaders.set('Vary', 'Origin');

      return new Response(cached.body, {
        headers: respHeaders,
        status: cached.status,
      });
    }

    const cacheableResponse = (
      body: ArrayBuffer | string | undefined,
      cacheableHeaders: Headers,
      status: number
    ) => {
      cacheableHeaders.set(
        'Cache-Control',
        env.CACHE_CONTROL || 'public, max-age=86400'
      );

      const cacheable = new Response(body, {
        headers: cacheableHeaders,
        status: status,
      });

      ctx.waitUntil(cache.put(request.url, cacheable));

      const respHeaders = new Headers(cacheableHeaders);
      if (allowedOrigin)
        respHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
      respHeaders.set('Vary', 'Origin');
      return new Response(body, { headers: respHeaders, status: status });
    };

    // /styles/** と /fonts/** は R2 の静的ファイルをそのまま返す
    if (url.pathname.startsWith('/styles/') || url.pathname.startsWith('/fonts/')) {
      const key = decodeURIComponent(url.pathname.slice(1));
      const obj = await env.BUCKET.get(key);
      if (!obj) {
        return cacheableResponse('Not found', new Headers(), 404);
      }
      const headers = new Headers();
      const ext = key.split('.').pop() || '';
      headers.set(
        'Content-Type',
        STATIC_CONTENT_TYPES[ext] || 'application/octet-stream'
      );
      return cacheableResponse(await obj.arrayBuffer(), headers, 200);
    }

    if (!url.pathname.startsWith('/tiles/')) {
      return new Response('Invalid URL', { status: 404 });
    }

    const { ok, name, tile, ext } = tilePath(
      url.pathname.slice('/tiles'.length)
    );

    if (!ok) {
      return new Response('Invalid URL', { status: 404 });
    }

    const cacheableHeaders = new Headers();
    const source = new R2Source(env, name);
    const p = new PMTiles(source, CACHE, nativeDecompress);
    try {
      const pHeader = await p.getHeader();

      if (!tile) {
        cacheableHeaders.set('Content-Type', 'application/json');
        const t = await p.getTileJson(
          `https://${env.PUBLIC_HOSTNAME || url.hostname}/tiles/${name}`
        );
        return cacheableResponse(JSON.stringify(t), cacheableHeaders, 200);
      }

      if (tile[0] < pHeader.minZoom || tile[0] > pHeader.maxZoom) {
        return cacheableResponse(undefined, cacheableHeaders, 404);
      }

      const extToType: Record<string, TileType> = {
        mvt: TileType.Mvt,
        pbf: TileType.Mvt,
        png: TileType.Png,
        jpg: TileType.Jpeg,
        webp: TileType.Webp,
        avif: TileType.Avif,
      };

      const expectedType = extToType[ext];
      if (
        pHeader.tileType !== expectedType &&
        tileTypeExt(pHeader.tileType) !== ''
      ) {
        return cacheableResponse(
          `Bad request: requested .${ext} but archive has type ${tileTypeExt(
            pHeader.tileType
          )}`,
          cacheableHeaders,
          400
        );
      }

      const tiledata = await p.getZxy(tile[0], tile[1], tile[2]);

      switch (pHeader.tileType) {
        case TileType.Mvt:
          cacheableHeaders.set('Content-Type', 'application/x-protobuf');
          break;
        case TileType.Png:
          cacheableHeaders.set('Content-Type', 'image/png');
          break;
        case TileType.Jpeg:
          cacheableHeaders.set('Content-Type', 'image/jpeg');
          break;
        case TileType.Webp:
          cacheableHeaders.set('Content-Type', 'image/webp');
          break;
      }

      if (tiledata) {
        return cacheableResponse(tiledata.data, cacheableHeaders, 200);
      }
      return cacheableResponse(undefined, cacheableHeaders, 204);
    } catch (e) {
      if (e instanceof KeyNotFoundError) {
        return cacheableResponse('Archive not found', cacheableHeaders, 404);
      }
      throw e;
    }
  },
};
