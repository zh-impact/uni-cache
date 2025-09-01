import type { Config } from '@netlify/functions';
import type { RunOptions } from '../lib/runner.mjs';
import { runOnce } from '../lib/runner.mjs';
import { logger } from '../lib/logger.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function parseIntEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default async (req: Request) => {
  // Netlify Scheduled Functions send a JSON event body (with next_run, etc.); absence does not affect execution
  try {
    const evt = await req.json().catch(() => ({} as any));
    if ((evt as any)?.next_run) logger.info({ event: 'scheduled-refresh.next_run', next_run: (evt as any).next_run });
  } catch {}

  const runOpts: RunOptions = {};

  const sourceId = process.env.SCHEDULED_REFRESH_SOURCE_ID;
  const maxPerSource = parseIntEnv('SCHEDULED_REFRESH_MAX_PER_SOURCE');
  const timeBudgetMs = parseIntEnv('SCHEDULED_REFRESH_TIME_BUDGET_MS');

  if (sourceId) runOpts.source_id = sourceId;
  if (typeof maxPerSource === 'number') runOpts.maxPerSource = maxPerSource;
  if (typeof timeBudgetMs === 'number') runOpts.timeBudgetMs = timeBudgetMs;

  logger.info({ event: 'scheduled-refresh.invoke_runOnce', runOpts });
  const summary = await runOnce(runOpts);
  return json({ endpoint: 'scheduled-refresh', ...summary }, 200);
};

export const config: Config = {
  // Every 5 minutes; adjust per source strategies as needed.
  schedule: '*/5 * * * *',
};
