import pino from 'pino';

export const logger = pino(
  process.env.NODE_ENV === 'production'
    ? {
        level: 'info',
        serializers: { err: pino.stdSerializers.err },
      }
    : {
        level: 'debug',
        serializers: { err: pino.stdSerializers.err },
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
      },
);
