// netlify/lib/logger.mts
import { pino } from 'pino';
import pretty from 'pino-pretty';

// Use pretty output in development; keep JSON in production (better for log collection)
const usePretty = process.env.NODE_ENV !== 'production';

export const logger = usePretty
  ? pino(
      pretty({
        colorize: true,
      })
    )
  : pino();
