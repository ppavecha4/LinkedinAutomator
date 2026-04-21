/**
 * Shared Winston logger.
 *
 * Uses structured JSON in production (CloudWatch friendly) and a colourised
 * human format in development. Every log line carries a `service` field so
 * multi-service log aggregation can filter on it.
 */

import winston from 'winston';

import { env } from './env';

const isProd = env.nodeEnv === 'production';

export const logger = winston.createLogger({
  level: env.logLevel,
  defaultMeta: { service: 'api' },
  format: isProd
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).filter((k) => k !== 'service').length
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `${timestamp} ${level} ${message}${metaStr}`;
        }),
      ),
  transports: [new winston.transports.Console()],
});
