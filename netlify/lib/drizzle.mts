// netlify/lib/drizzle.mts
import { drizzle } from 'drizzle-orm/neon-http';
import { neonConfig } from '@neondatabase/serverless';
import * as schema from '../../src/db/schema.ts';

neonConfig.fetchConnectionCache = true;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const db = drizzle(url, { schema });
