import mongoose from 'mongoose';
import bluebird from 'bluebird';

export default async (logger) => {

  mongoose.Promise = bluebird;

  const db = await new Promise((resolve, reject) => {
      logger.debug('MongoDB: Connecting (credentials omitted)');
    mongoose.connect(DI.config.db, { useMongoClient: true });
    const db = mongoose.connection;
    db.on('error', () => {
      reject(new Error('Unable to connect to MongoDB (connection details omitted)'));
    });
    db.once('open', () => {
      logger.info('MongoDB: Connected');
      resolve(db);
    });
  });

  return db;

};

export function shutdown() {
  mongoose.connection.close();
}
