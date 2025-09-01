// netlify/lib/sources-pg.mts
import { sql } from './db.mjs';

// Ensure the sources table includes the supports_pool column
export async function ensureSourcesSupportsPoolColumn(): Promise<void> {
  try {
    await sql/*sql*/`
      ALTER TABLE IF EXISTS sources
      ADD COLUMN IF NOT EXISTS supports_pool boolean NOT NULL DEFAULT false
    `;
  } catch (e) {
    // Ignore errors: lack of permission or other failures should not break reads (degrade during read)
  }
}

export async function getSourceSupportsPool(source_id: string): Promise<boolean> {
  // Try at most twice: if the first read fails (column missing), attempt to add the column then read again
  for (let i = 0; i < 2; i++) {
    try {
      const rows = await sql/*sql*/`
        SELECT supports_pool FROM sources WHERE id = ${source_id}
      ` as unknown as Array<{ supports_pool?: boolean | null }>;
      if (!rows?.length) return false;
      const v = rows[0]?.supports_pool;
      return Boolean(v);
    } catch {
      // Column may be missing; attempt to add it
      await ensureSourcesSupportsPoolColumn().catch(() => {});
    }
  }
  return false;
}
