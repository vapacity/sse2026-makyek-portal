import winston from 'winston';
import moment from 'moment';

const timeFormatter = () => moment().format('YYYY-MM-DD HH:mm:ss Z');

export default () => {

  const logger = new (winston.Logger)({
    exitOnError: false,
    transports: [
      new (winston.transports.Console)({
        name: 'console',
        level: 'debug',
        json: false,
        colorize: true,
        timestamp: timeFormatter,
        handleExceptions: true,
        humanReadableUnhandledException: true,
      }),
      new (winston.transports.File)({
        name: 'debug-file-log',
        filename: `${__projectRoot}/logs/debug.log`,
        maxsize: 20 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
        level: 'debug',
        timestamp: timeFormatter,
      }),
      new (winston.transports.File)({
        name: 'error-file-log',
        filename: `${__projectRoot}/logs/error.log`,
        maxsize: 20 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
        level: 'warn',
        timestamp: timeFormatter,
        handleExceptions: true,
        humanReadableUnhandledException: true,
      }),
    ],
  });

  logger.level = 'debug';
  return logger;

};
