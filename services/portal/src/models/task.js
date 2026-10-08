import mongoose from 'mongoose';

// Durable outbox. Delivery is at-least-once; workers must atomically claim work.
export default () => {
  const schema = new mongoose.Schema({
    key: String,
    topic: String,
    payload: mongoose.Schema.Types.Mixed,
    nextAttemptAt: Date,
    attempts: { type: Number, default: 0 },
    lastError: String,
    completedAt: Date,
  }, { timestamps: true });
  let Task;
  schema.index({ key: 1 }, { unique: true });
  schema.index({ completedAt: 1, nextAttemptAt: 1 });
  schema.index({ completedAt: 1 }, { expireAfterSeconds: 86400 });
  schema.statics.enqueueAsync = async function (key, topic, payload) {
    try {
      await Task.update({ key }, { $setOnInsert: {
        key, topic, payload, nextAttemptAt: new Date(),
      } }, { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  };
  schema.statics.dispatchAsync = async function () {
    const config = DI.config.tasks || {};
    for (let i = 0; i < (config.batchSize || 32); i++) {
      const task = await Task.findOneAndUpdate({
        completedAt: { $exists: false }, nextAttemptAt: { $lte: new Date() },
      }, { $set: { nextAttemptAt: new Date(Date.now() + (config.retryDelay || 30000)) },
        $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } });
      if (!task) break;
      try {
        let active, leaseUntil;
        if (task.topic === 'compile') {
          const sdoc = await DI.models.Submission.findById(task.payload.sdocid);
          active = sdoc && sdoc.taskToken === task.payload.token &&
            ['pending', 'compiling'].indexOf(sdoc.status) !== -1;
          leaseUntil = sdoc && sdoc.compileLeaseUntil;
        } else {
          const mdoc = await DI.models.Match.findById(task.payload.mdocid);
          const rdoc = mdoc && mdoc.rounds.id(task.payload.rid);
          active = rdoc && ['pending', 'running'].indexOf(rdoc.status) !== -1;
          if (active) active = await DI.models.Match.isCurrentAsync(mdoc);
          leaseUntil = rdoc && rdoc.leaseUntil;
        }
        if (!active) {
          await Task.update({ _id: task._id }, { $set: { completedAt: new Date() } });
        } else if (leaseUntil && leaseUntil.getTime() > Date.now()) {
          await Task.update({ _id: task._id }, { $set: { nextAttemptAt: leaseUntil } });
        } else {
          await DI.mq.publish(task.topic, task.payload);
          await Task.update({ _id: task._id }, { $unset: { lastError: 1 } });
        }
      } catch (err) {
        await Task.update({ _id: task._id }, { $set: { lastError: err.message } });
        DI.logger.error('Task dispatch failed: %s: %s', task.key, err.stack);
        // Broker failures must not create a tight retry loop.
        break;
      }
    }
  };
  Task = mongoose.model('Task', schema);
  return Task;
};
