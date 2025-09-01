// netlify/lib/logger.mts
import { pino } from 'pino';
import pretty from 'pino-pretty';

// 在开发环境使用 pretty 输出，在生产保持 JSON（便于采集）
const usePretty = process.env.NODE_ENV !== 'production';

export const logger = usePretty
  ? pino(
      pretty({
        colorize: true,
      })
    )
  : pino();
