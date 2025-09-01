// netlify/lib/sources-pg.mts
import { sql } from './db.mjs';

// 确保 sources 表包含 supports_pool 字段
export async function ensureSourcesSupportsPoolColumn(): Promise<void> {
  try {
    await sql/*sql*/`
      ALTER TABLE IF EXISTS sources
      ADD COLUMN IF NOT EXISTS supports_pool boolean NOT NULL DEFAULT false
    `;
  } catch (e) {
    // 忽略：若没有权限或其它原因失败，不影响读取逻辑（读取时做降级处理）
  }
}

export async function getSourceSupportsPool(source_id: string): Promise<boolean> {
  // 最多尝试两次：第一次读取失败（字段不存在）则尝试添加字段后再读一次
  for (let i = 0; i < 2; i++) {
    try {
      const rows = await sql/*sql*/`
        SELECT supports_pool FROM sources WHERE id = ${source_id}
      ` as unknown as Array<{ supports_pool?: boolean | null }>;
      if (!rows?.length) return false;
      const v = rows[0]?.supports_pool;
      return Boolean(v);
    } catch {
      // 可能是列不存在，尝试添加列
      await ensureSourcesSupportsPoolColumn().catch(() => {});
    }
  }
  return false;
}
