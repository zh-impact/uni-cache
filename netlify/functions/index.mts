import type { Config, Context } from '@netlify/functions';

export const config: Config = {
  path: '/',
  method: 'GET',
};

async function GET(_req: Request, _context: Context) {
  return new Response('<h1>Hello, Uni-Cache!</h1><p>Uni-Cache is a cache service for third-party APIs.</p>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
