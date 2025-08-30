// netlify/lib/db.mts
import { neon, neonConfig } from '@neondatabase/serverless';

// 复用连接以减少冷启动握手
neonConfig.fetchConnectionCache = true;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const sql = neon(url);
