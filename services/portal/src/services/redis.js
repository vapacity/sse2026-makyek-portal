import redis from 'redis';
import bluebird from 'bluebird';

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

let client = null;

export default async (logger) => {
  logger.debug(`Redis: Connection host = ${DI.config.redis.host}`);
  logger.debug(`Redis: Connection port = ${DI.config.redis.port}`);
  logger.debug(`Redis: Connection password = ${DI.config.redis.password}`);
  // client = redis.createClient(DI.config.redis);
  client = redis.createClient({
    host: DI.config.redis.host,
    port: DI.config.redis.port,
    password: DI.config.redis.password,
  });
  client.on('connect', () => {
    logger.info('Redis: Connected');
  });
  client.on('error', err => {
    logger.error(`Redis error: ${err.message}`);
  });
  return client;
};

export function shutdown() {
  if (client) {
    client.quit();
    client = null;
  }
}
