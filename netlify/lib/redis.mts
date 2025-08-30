import { Redis } from '@upstash/redis';

// Use Upstash standard env vars: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// Netlify: set them in site/environment settings. This avoids hardcoding secrets.
export const redis = Redis.fromEnv();
