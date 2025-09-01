// netlify/lib/db.mts
import { neon, neonConfig } from '@neondatabase/serverless';

// Reuse connections to reduce cold-start handshake overhead
neonConfig.fetchConnectionCache = true;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const sql = neon(url);
