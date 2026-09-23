import mongoose from 'mongoose';

export default async (dbConnection) => {

  // gridfs-stream 1.x hangs with modern Node.js streams. The MongoDB driver
  // bundled with Mongoose exposes the same GridFS storage through GridFSBucket.
  const bucket = new mongoose.mongo.GridFSBucket(dbConnection.db);

  return {
    putBlobAsync(rstream, options) {
      return new Promise((resolve, reject) => {
        const wstream = bucket.openUploadStream(options.filename || 'blob', {
          contentType: options.contentType,
          metadata: options.metadata,
        });
        wstream.on('finish', () => resolve({ _id: wstream.id }));
        wstream.on('error', err => reject(err));
        rstream.pipe(wstream);
      });
    },
    getBlobAsync(id, wstream) {
      return new Promise((resolve, reject) => {
        const rstream = bucket.openDownloadStream(id);
        rstream.on('end', () => resolve());
        rstream.on('error', err => reject(err));
        rstream.pipe(wstream);
      });
    },
    existsAsync(id) {
      return new Promise((resolve, reject) => {
        bucket.find({ _id: id }).limit(1).toArray((err, files) => {
          if (err) {
            return reject(err);
          }
          resolve(files.length > 0);
        });
      });
    },
    removeAsync(options) {
      return new Promise((resolve, reject) => {
        bucket.delete(options._id, (err) => {
          if (err) {
            return reject(err);
          }
          resolve();
        });
      });
    },
  };

};
