import { Redis } from '@upstash/redis';

// export const redis = Redis.fromEnv();

export const redis = new Redis({
  url: 'https://full-kingfish-50270.upstash.io',
  token: 'AcReAAIncDE3N2M3ZDJlZmNkN2U0MWNjODEyZmI3YmNiZjFhNDk2M3AxNTAyNzA',
})
