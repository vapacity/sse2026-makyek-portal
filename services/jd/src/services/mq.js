import amqp from 'amqplib';

export default async (logger) => {
  try {
    logger.info('Attempting to connect to message queue...');
    const conn = await amqp.connect(DI.config.mq.connection);
    const ch = await conn.createChannel();
    ch.on('close', () => {
      logger.warn('Message queue closed, existing.');
      process.exit(1);
    });
    ch.on('error', e => {
      logger.error(e.stack);
      logger.warn('Message queue errors, exiting.');
      process.exit(1);
    });
    return ch;
  } catch (e) {
    logger.error(e.stack);
    logger.warn('Message queue connection errors, exiting.');
    process.exit(1);
  }
};
