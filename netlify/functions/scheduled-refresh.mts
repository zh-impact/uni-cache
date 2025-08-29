import type { Config, Context } from "@netlify/functions";

export default async (_req: Request, _context: Context) => {
  // This function is triggered by a schedule (cron). Add refresh logic here.
  return new Response("scheduled-refresh ok\n", { status: 200 });
};

export const config: Config = {
  // Every 5 minutes; adjust per source strategies as needed.
  schedule: "*/5 * * * *",
};
