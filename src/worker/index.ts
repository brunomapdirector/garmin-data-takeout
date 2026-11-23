// The relay. It exists only because Garmin's API sends no CORS headers, so a browser
// cannot call it directly. It stores nothing, logs nothing, and forwards only:
//
//   POST /api/token          -> Garmin's token endpoint (the one request with the key)
//   GET  /api/garmin/<path>  -> Garmin, if <path> is a Personal API endpoint
//
// Everything else under /api is a 404. The static site never reaches this code.

import { isAllowedPath } from './allowlist';

const GARMIN = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

interface Env {
  EXTRA_ORIGINS?: string;
  /** Workers Rate Limiting binding (wrangler.jsonc); absent in setups without it. */
  RELAY_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Browsers say where a request comes from; refuse other websites. Non-browser clients
// can lie about this, which is fine: the check is to stop other sites embedding the
// relay, not to authenticate anyone (Garmin does that).
function originAllowed(req: Request, env: Env): boolean {
  const self = new URL(req.url).origin;
  const extra = (env.EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin');
  if (origin && origin !== self && !extra.includes(origin)) return false;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none' && !(origin && extra.includes(origin))) return false;
  return true;
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin');
  const extra = (env.EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !extra.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization',
    'access-control-allow-methods': 'GET, POST',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

async function forward(upstreamUrl: string, init: RequestInit, extra: Record<string, string>) {
  const upstream = await fetch(upstreamUrl, { ...init, redirect: 'manual' });
  const headers = new Headers({ 'cache-control': 'no-store', ...extra });
  for (const h of ['content-type', 'content-length', 'retry-after']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Stream the body through; never buffer an activity file in the Worker.
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return json(404, 'not found');
    if (!originAllowed(req, env)) return json(403, 'origin not allowed');

    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Per-IP cap. Answers like Garmin's own limit (429 + Retry-After), so the page's
    // client simply waits and carries on.
    if (env.RELAY_LIMITER) {
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.RELAY_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response(JSON.stringify({ error: 'too many requests' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30', 'cache-control': 'no-store', ...cors },
        });
      }
    }

    const auth = req.headers.get('authorization') ?? '';

    if (url.pathname === '/api/token') {
      if (req.method !== 'POST') return json(405, 'POST only');
      if (!/^ApiKey \S+$/.test(auth)) return json(400, 'expected Authorization: ApiKey <key>');
      return forward(GARMIN + TOKEN_PATH, { method: 'POST', headers: { authorization: auth } }, cors);
    }

    if (url.pathname.startsWith('/api/garmin/')) {
      if (req.method !== 'GET') return json(405, 'GET only');
      const path = url.pathname.slice('/api/garmin'.length);
      if (!isAllowedPath(path)) return json(404, 'not a Personal API endpoint');
      if (!/^Bearer \S+$/.test(auth)) return json(401, 'expected Authorization: Bearer <token>');
      return forward(
        GARMIN + path + url.search,
        { method: 'GET', headers: { authorization: auth, accept: req.headers.get('accept') ?? '*/*' } },
        cors,
      );
    }

    return json(404, 'not found');
  },
} satisfies ExportedHandler<Env>;
