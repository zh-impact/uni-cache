import type { Config, Context } from '@netlify/functions';

export default async (_req: Request, _context: Context) => {
  if (_req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  return new Response('<h1>Hello, Uni-Cache!</h1><p>Uni-Cache is a cache service for third-party APIs.</p>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};

export const config: Config = {
  path: '/',
};
