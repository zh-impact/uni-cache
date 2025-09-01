import type { Config, Context } from '@netlify/functions';

import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/tasks/status/:task_id',
  method: 'GET',
};

async function GET(_req: Request, context: Context) {
  const params = context.params || {};
  const task_id = (params['task_id'] as string) ?? null;
  return json({ ok: true, endpoint: 'tasks-status', task_id, state: 'queued', progress: 0 });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
