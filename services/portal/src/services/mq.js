import bluebird from 'bluebird';
import Rascal from 'rascal';

bluebird.promisifyAll(Rascal.Broker);
bluebird.promisifyAll(Rascal.Broker.prototype);

export default async (logger) => {

  const broker = await Rascal.Broker.createAsync(Rascal.withDefaultConfig(DI.config.mq));
  broker.on('error', e => logger.error(e));

  return {
    async publish(publishId, data) {
      const publication = await broker.publishAsync(publishId, data);
      publication.on('error', e => logger.error(e));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MQ publish confirmation timed out')), 10000);
        publication.once('success', () => { clearTimeout(timer); resolve(); });
        publication.once('error', err => { clearTimeout(timer); reject(err); });
        publication.once('return', () => { clearTimeout(timer); reject(new Error('MQ message was returned')); });
      });
      return publication;
    },
    shutdown(...args) {
      return broker.shutdown(...args);
    },
  };

};

export function shutdown(broker) {
  return new Promise(resolve => broker.shutdown(resolve));
}
