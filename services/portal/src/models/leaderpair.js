import _ from 'lodash';
import mongoose from 'mongoose';

export default () => {
  const LeaderPairSchema = new mongoose.Schema({
    u1u2: Buffer,
    u1Submission: mongoose.Schema.Types.ObjectId,
    u1: mongoose.Schema.Types.ObjectId,
    u2: mongoose.Schema.Types.ObjectId,
    status: String,
  });

  // LeaderPair Model
  let LeaderPair;

  /**
   * Rebuild all pairs
   *
   * @param  {Boolean} verify Only verify integrity and do not change data
   */
  LeaderPairSchema.statics.rebuildAsync = async function (verify = false) {
    if (!verify) {
      await LeaderPair.remove({});
    }
    const lsdocs = await DI.models.Submission.getLastSubmissionsByUserAsync();
    const mdocCursor = DI.models.Match.getPairwiseMatchesCursor(_.map(lsdocs, 'sdocid'));
    const mdocCount = await mdocCursor.query.model.count(mdocCursor.query._conditions);
    for (let mdoc = await mdocCursor.next(), i = 1; mdoc !== null; mdoc = await mdocCursor.next(), i++) {
      if (i % 100 === 0) {
        DI.logger.debug('LeaderPair.rebuildAsync: %d/%d...', i, mdocCount);
      }
      await LeaderPair.updatePairByMatchAsync(mdoc, verify);
    }
    DI.logger.debug('LeaderPair.rebuildAsync: done');
    return true;
  };

  /**
   * Update a leader pair
   *
   * @param  {ObjectId} u1id
   * @param  {ObjectId} u2id
   * @param  {ObjectId} u1sid u1 submission id
   * @param  {String} status u1 submission status
   * @param  {Boolean} verify Only verify integrity and do not change data
   */
  LeaderPairSchema.statics.updatePairAsync = async function (u1id, u2id, u1sid, u1status, verify = false) {
    const u1buf = new Buffer(u1id.toString(), 'hex');
    const u2buf = new Buffer(u2id.toString(), 'hex');
    const u1u2 = Buffer.concat([u1buf, u2buf]);
    if (!verify) {
      try {
        await LeaderPair.update(
          { u1u2, u1Submission: { $lte: u1sid } },
          { $set: { u1Submission: u1sid, u1: u1id, u2: u2id, status: u1status } },
          { upsert: true }
        ).exec();
      } catch (e) {
        if (e.name === 'MongoError' && e.code === 11000) {
          // if u1Submission > u1sid, upsert will become insert (which will fail
          // because of unique index). we don't want that record being inserted
          // either so just silently ignore this duplicate-key error here.
        } else {
          throw e;
        }
      }
    } else {
      const doc = await LeaderPair.findOne({ u1u2 });
      try {
        if (doc === null) {
          throw new Error('pair_doc not found');
        }
        if (!doc.u1Submission.equals(u1sid)) {
          throw new Error('u1Submission not equal, new = ' + u1sid);
        }
        if (doc.status !== u1status) {
          throw new Error('status not equal, new = ', u1status);
        }
      } catch (err) {
        DI.logger.debug('LeaderPair.updatePairAsync: %s (u1 = %s, u2 = %s)', err.message, u1id, u2id);
        return false;
      }
    }
    return true;
  };
  LeaderPairSchema.statics.updatePairByMatchAsync = async function (mdoc, verify = false) {
    if (!await DI.models.Match.isCurrentAsync(mdoc)) return false;
    return LeaderPair.updatePairAsync(mdoc.u1, mdoc.u2, mdoc.u1Submission, mdoc.status, verify);
  };

  // Aggregate in MongoDB: return O(users) totals, not O(users^2) pair records.
  LeaderPairSchema.statics.getStatsAsync = async function () {
    return LeaderPair.aggregate([
      { $sort: { u1Submission: -1 } },
      { $group: { _id: {
        a: { $cond: [{ $lt: ['$u1', '$u2'] }, '$u1', '$u2'] },
        b: { $cond: [{ $lt: ['$u1', '$u2'] }, '$u2', '$u1'] },
      }, u1: { $first: '$u1' }, u2: { $first: '$u2' }, status: { $first: '$status' } } },
      { $project: { rows: [
        { user: '$u1', win: { $cond: [{ $eq: ['$status', 'u1win'] }, 1, 0] },
          lose: { $cond: [{ $eq: ['$status', 'u2win'] }, 1, 0] },
          draw: { $cond: [{ $eq: ['$status', 'draw'] }, 1, 0] } },
        { user: '$u2', win: { $cond: [{ $eq: ['$status', 'u2win'] }, 1, 0] },
          lose: { $cond: [{ $eq: ['$status', 'u1win'] }, 1, 0] },
          draw: { $cond: [{ $eq: ['$status', 'draw'] }, 1, 0] } },
      ] } },
      { $unwind: '$rows' },
      { $group: { _id: '$rows.user', win: { $sum: '$rows.win' },
        lose: { $sum: '$rows.lose' }, draw: { $sum: '$rows.draw' } } },
    ]).allowDiskUse(true);
  };

  /**
   * Get all leader pairs
   */
  LeaderPairSchema.statics.getAllAsync = async function () {
    const lpdocs = await LeaderPair
      .find({}, { _id: 0, u1: 1, u2: 1, status: 1 })
      .sort({ u1Submission: -1 })
      .exec();
    return lpdocs;
  };

  DI.eventBus.on('match.status:updated', async mdoc => {
    if (!DI.models.Match.isEffectiveStatus(mdoc.status)) {
      return;
    }
    try {
      await LeaderPair.updatePairByMatchAsync(mdoc);
    } catch (err) {
      DI.logger.error(err.stack);
    }
  });

  LeaderPairSchema.index({ u1u2: 1 }, { unique: true });
  LeaderPairSchema.index({ u1u2: 1, u1Submission: 1 });
  LeaderPairSchema.index({ u1Submission: -1 });

  LeaderPair = mongoose.model('LeaderPair', LeaderPairSchema);
  return LeaderPair;

};
