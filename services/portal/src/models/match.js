import _ from 'lodash';
import mongoose from 'mongoose';
import utils from '@/libs/utils';
import objectId from '@/libs/objectId';
import errors from '@/libs/errors';

export default () => {
  const MatchSchema = new mongoose.Schema({
    status: String,
    u1: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    u2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    u1Submission: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
    u2Submission: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
    matchKey: String,
    generation: String,
    obsolete: Boolean,
    exe1Blob: mongoose.Schema.Types.ObjectId,
    exe2Blob: mongoose.Schema.Types.ObjectId,
    stateVersion: { type: Number, default: 0 },
    rounds: [{
      _id: mongoose.Schema.Types.ObjectId,
      status: String,
      u1Black: Boolean,
      u2Black: Boolean, // !u1Black
      beginJudgeAt: Date,
      endJudgeAt: Date,
      logBlob: mongoose.Schema.Types.ObjectId,  // grid fs
      text: String,
      summary: String,
      usedTime: Number,   // extracted from summary by controller
      runToken: String,
      leaseUntil: Date,
      completedRunToken: String,
    }],
  }, {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  });

  MatchSchema.virtual('usedTime').get(function () {
    return _.sumBy(this.rounds, 'usedTime');
  });

  // Match Model
  let Match;

  // For both match and round
  MatchSchema.statics.STATUS_PENDING = 'pending';
  MatchSchema.statics.STATUS_RUNNING = 'running';
  MatchSchema.statics.STATUS_SYSTEM_ERROR = 'se';
  MatchSchema.statics.STATUS_U1WIN = 'u1win';
  MatchSchema.statics.STATUS_U2WIN = 'u2win';
  MatchSchema.statics.STATUS_DRAW = 'draw';

  MatchSchema.statics.RELATIVE_STATUS_WIN = 'win';
  MatchSchema.statics.RELATIVE_STATUS_LOSE = 'lose';
  MatchSchema.statics.RELATIVE_STATUS_DRAW = 'draw';

  MatchSchema.statics.JUDGE_EXITCODE_MIN = 33;

  MatchSchema.statics.JUDGE_EXITCODE_STATUS = {
    [MatchSchema.statics.JUDGE_EXITCODE_MIN + 0]: MatchSchema.statics.STATUS_U1WIN,
    [MatchSchema.statics.JUDGE_EXITCODE_MIN + 1]: MatchSchema.statics.STATUS_U2WIN,
    [MatchSchema.statics.JUDGE_EXITCODE_MIN + 2]: MatchSchema.statics.STATUS_DRAW,
    [MatchSchema.statics.JUDGE_EXITCODE_MIN + 3]: MatchSchema.statics.STATUS_SYSTEM_ERROR,
  };

  MatchSchema.statics.STATUS_TEXT = {
    'pending': 'Pending',
    'running': 'Running',
    'se': 'Error',
    'win': 'Win',
    'lose': 'Lose',
    'u1win': 'Challenger Win',
    'u2win': 'Challenger Lose',
    'draw': 'Draw',
  };

  MatchSchema.statics.ROUND_STATUS_TEXT = MatchSchema.statics.STATUS_TEXT;

  MatchSchema.pre('save', function (next) {
    this.__lastModifiedPaths = this.modifiedPaths();
    next();
  });

  MatchSchema.post('save', function () {
    const mdoc = this.toObject();
    Promise.all(this.__lastModifiedPaths.map(async (path) => {
      let m;
      if (path === 'status') {
        await DI.eventBus.emitAsyncWithProfiling('match.status:updated::**', mdoc);
      } else if (m = path.match(/^rounds\.(\d+)$/)) {
        const rdoc = mdoc.rounds[m[1]];
        await DI.eventBus.emitAsyncWithProfiling('match.rounds:updated::**', mdoc, rdoc);
      } else if (m = path.match(/^rounds\.(\d+)\.status$/)) {
        const rdoc = mdoc.rounds[m[1]];
        await DI.eventBus.emitAsyncWithProfiling('match.rounds.status:updated::**', mdoc, rdoc);
      }
    })).catch(err => DI.logger.error(err.stack));
  });

  /**
   * Update the match status one by one when round status is updated
   */
  const updateStatusQueue = new utils.DedupWorkerQueue({
    delay: 15,
    asyncWorkerFunc: mdocid => {
      return Match.updateMatchStatusAsync(mdocid);
    },
  });

  DI.eventBus.on('match.rounds.status:updated', mdoc => {
    updateStatusQueue.push(String(mdoc._id));
  });

  /**
   * Determine whether a match status is one of running status (pending / running)
   *
   * @param  {String}  matchStatus
   * @return {Boolean}
   */
  MatchSchema.statics.isEffectiveStatus = function (matchStatus) {
    return matchStatus === Match.STATUS_U1WIN ||
      matchStatus === Match.STATUS_U2WIN ||
      matchStatus === Match.STATUS_DRAW;
  };

  /**
   * Get the match object by match id
   *
   * @return {Match} Mongoose match object
   */
  MatchSchema.statics.getMatchObjectByIdAsync = async function (id, projection = {}, throwWhenNotFound = true) {
    if (!objectId.isValid(id)) {
      if (throwWhenNotFound) {
        throw new errors.UserError('Match not found');
      } else {
        return null;
      }
    }
    const s = await Match.findOne({ _id: id }, projection).exec();
    if (s === null && throwWhenNotFound) {
      throw new errors.UserError('Match not found');
    }
    return s;
  };

  /**
   * Get the round and match object by match id and round id.
   *
   * @return {[Match, Round]}
   */
  MatchSchema.statics.getRoundObjectByIdAsync = async function (mdocid, rdocid) {
    const mdoc = await Match.getMatchObjectByIdAsync(mdocid, {}, false);
    if (!mdoc) throw new errors.TaskConflictError('Match no longer exists');
    const rdoc = mdoc.rounds.find(rdoc => rdoc._id.equals(rdocid));
    if (rdoc === undefined) {
      throw new errors.TaskConflictError('Round no longer exists');
    }
    return [mdoc, rdoc];
  };

  /**
   * Get round status from fun-judge exit code
   * @param  {Number} exitCode
   * @return {String}
   */
  MatchSchema.statics.getStatusFromJudgeExitCode = function (exitCode) {
    if (Match.JUDGE_EXITCODE_STATUS[exitCode] !== undefined) {
      return Match.JUDGE_EXITCODE_STATUS[exitCode];
    }
    return Match.STATUS_SYSTEM_ERROR;
  };

  /**
   * Generate initial round docs for a match
   * @return {[Match.Round]}
   */
  function generateRoundDocs() {
    const rounds = [];
    for (const u1Black of [true, false]) {
      rounds.push({
        _id: mongoose.Types.ObjectId(),
        status: Match.STATUS_PENDING,
        u1Black,
        u2Black: !u1Black,
      });
    }
    return rounds;
  }

  /**
   * Push a round task into the queue
   */
  async function publishRoundTaskAsync(mdoc, rdoc) {
    await DI.models.Task.enqueueAsync(`judge:${mdoc._id}:${rdoc._id}`, 'judge', {
      mdocid: String(mdoc._id),
      s1docid: String(mdoc.u1Submission),
      s2docid: String(mdoc.u2Submission),
      u1docid: String(mdoc.u1),
      u2docid: String(mdoc.u2),
      rid: rdoc._id,
      u1field: rdoc.u1Black ? 'black' : 'white',
      rules: DI.config.match.rules,
    });
  }

  MatchSchema.statics.isCurrentAsync = async function (mdoc) {
    if (mdoc.obsolete) return false;
    if (!mdoc.generation) return true; // compatibility with existing local data
    const sdoc = await DI.models.Submission.findById(mdoc.u1Submission).select('matchGeneration matchesReady matches');
    if (!sdoc || sdoc.matchGeneration !== mdoc.generation) {
      await Match.update({ _id: mdoc._id }, { $set: { obsolete: true } });
      return false;
    }
    return sdoc.matchesReady === true && sdoc.matches.some(d => d._id.equals(mdoc._id));
  };

  MatchSchema.statics.enqueueRoundsAsync = async function (mdoc) {
    for (const rdoc of mdoc.rounds) {
      if (rdoc.status === 'pending' || rdoc.status === 'running') await publishRoundTaskAsync(mdoc, rdoc);
    }
  };

  /**
   * Add matches idempotently, without deleting the previous generation's data.
   *
   * @param {Submission} s1
   * @param {User} u1
   * @param {[{_id: User, sdocid: Submission}]} s2u2docs
   */
  MatchSchema.statics.addMatchesForSubmissionAsync = async function (s1, u1, s2u2docs, generation, exe1Blob) {
    if (s2u2docs.length === 0) {
      return [];
    }

    const endProfile = utils.profile('Match.addMatchesForSubmissionAsync', DI.config.profiling.addMatches);

    const mdocs = [];
    const batchSize = Math.max(1, (DI.config.tasks || {}).matchBatchSize || 8);
    for (let i = 0; i < s2u2docs.length; i += batchSize) {
      await Promise.all(s2u2docs.slice(i, i + batchSize).map(async s2u2doc => {
        const matchKey = `${s1}:${s2u2doc.sdocid}:${generation}`;
        const data = {
          matchKey, generation, exe1Blob, exe2Blob: s2u2doc.exeBlob,
          status: Match.STATUS_PENDING,
          u1,
          u2: s2u2doc._id,
          u1Submission: s1,
          u2Submission: s2u2doc.sdocid,
          usedTime: 0,
          rounds: generateRoundDocs(),
        };
        try { await Match.update({ matchKey }, { $setOnInsert: data }, { upsert: true }); }
        catch (err) { if (err.code !== 11000) throw err; }
        mdocs.push(await Match.findOne({ matchKey }));
      }));
    }

    endProfile();

    return mdocs;
  };

  /**
   * Reset match and regenerate rounds for a match.
   */
  MatchSchema.statics.rejudgeMatchAsync = async function (mdocid) {
    const original = await Match.getMatchObjectByIdAsync(mdocid);
    if (!await Match.isCurrentAsync(original)) throw new errors.UserError('Cannot rejudge an obsolete match');
    const mdoc = await Match.findOneAndUpdate({ _id: mdocid }, { $set: {
      status: 'pending', rounds: generateRoundDocs(), updatedAt: new Date(),
    }, $inc: { stateVersion: 1 } }, { new: true });
    await Match.notifyStatusAsync(mdoc);
    await Match.enqueueRoundsAsync(mdoc);
    return mdoc;
  };

  /**
   * Rejudge system error matches
   */
  MatchSchema.statics.rejudgeErrorMatchAsync = async function () {
    const mdocCursor = Match
      .find({ status: Match.STATUS_SYSTEM_ERROR })
      .sort({ _id: 1 })
      .cursor();
    for (let mdoc = await mdocCursor.next(); mdoc !== null; mdoc = await mdocCursor.next()) {
      DI.logger.debug('Match.rejudgeErrorMatchAsync: %s', mdoc._id);
      await DI.models.Match.rejudgeMatchAsync(mdoc._id);
    }
    DI.logger.debug('Match.rejudgeErrorMatchAsync: done');
  };

  /**
   * Translate MatchStatus into RelativeStatus
   *
   * @param  {String}  status
   * @param  {Boolean} isU1
   * @return {String}
   */
  MatchSchema.statics.getRelativeStatus = function (status, isU1 = true) {
    if (status !== Match.STATUS_U1WIN && status !== Match.STATUS_U2WIN) {
      return status;
    }
    if (isU1) {
      if (status === Match.STATUS_U1WIN) {
        return Match.RELATIVE_STATUS_WIN;
      } else {
        return Match.RELATIVE_STATUS_LOSE;
      }
    } else {
      if (status === Match.STATUS_U1WIN) {
        return Match.RELATIVE_STATUS_LOSE;
      } else {
        return Match.RELATIVE_STATUS_WIN;
      }
    }
  };

  /**
   * Update match status according to round status
   */
  MatchSchema.methods.updateStatus = function () {
    const statusStat = {
      [Match.STATUS_PENDING]: 0,
      [Match.STATUS_RUNNING]: 0,
      [Match.STATUS_SYSTEM_ERROR]: 0,
      [Match.STATUS_U1WIN]: 0,
      [Match.STATUS_U2WIN]: 0,
      [Match.STATUS_DRAW]: 0,
    };
    this.rounds.forEach(rdoc => statusStat[rdoc.status]++);
    if (statusStat[Match.STATUS_PENDING] === this.rounds.length) {
      // all pending
      this.status = Match.STATUS_PENDING;
      return;
    }
    if (statusStat[Match.STATUS_SYSTEM_ERROR] > 0) {
      // some system error
      this.status = Match.STATUS_SYSTEM_ERROR;
      return;
    }
    if (statusStat[Match.STATUS_RUNNING] > 0 || statusStat[Match.STATUS_PENDING] > 0) {
      // some pending, or some running
      this.status = Match.STATUS_RUNNING;
      return;
    }
    if (statusStat[Match.STATUS_U1WIN] > statusStat[Match.STATUS_U2WIN]) {
      this.status = Match.STATUS_U1WIN;
    } else if (statusStat[Match.STATUS_U1WIN] < statusStat[Match.STATUS_U2WIN]) {
      this.status = Match.STATUS_U2WIN;
    } else {
      this.status = Match.STATUS_DRAW;
    }
  };

  MatchSchema.statics.updateMatchStatusAsync = async function (mdocid) {
    for (let i = 0; i < 5; i++) {
      const mdoc = await Match.getMatchObjectByIdAsync(mdocid);
      const previous = mdoc.status;
      mdoc.updateStatus();
      if (mdoc.status === previous) return mdoc;
      const version = mdoc.stateVersion || 0;
      const changed = await Match.findOneAndUpdate({ _id: mdocid, status: previous,
        $or: [{ stateVersion: version }, { stateVersion: { $exists: false } }],
      }, { $set: { status: mdoc.status, updatedAt: new Date() } }, { new: true });
      if (changed) { await Match.notifyStatusAsync(changed); return changed; }
    }
  };

  MatchSchema.statics.notifyStatusAsync = async function (mdoc, rid = null) {
    try {
      await DI.eventBus.emitAsyncWithProfiling('match.status:updated::**', mdoc.toObject());
      if (rid) await DI.eventBus.emitAsyncWithProfiling('match.rounds:updated::**', mdoc.toObject(), mdoc.rounds.id(rid).toObject());
    } catch (err) { DI.logger.error(err.stack); }
  };

  /**
   * Mark a pending round as running
   *
   * @param  {MongoId} mdocid Match Id
   * @param  {MongoId} rid Round Id
   * @return {Match}
   */
  MatchSchema.statics.judgeStartRoundAsync = async function (mdocid, rid, runToken) {
    const original = await Match.getMatchObjectByIdAsync(mdocid, {}, false);
    if (!original || !await Match.isCurrentAsync(original)) throw new errors.TaskConflictError('Match is obsolete or not ready');
    const mdoc = await Match.findOneAndUpdate({ _id: mdocid, obsolete: { $ne: true },
      rounds: { $elemMatch: { _id: rid, $or: [
        { status: 'pending' },
        { status: 'running', leaseUntil: { $lte: new Date() } },
        { status: 'running', leaseUntil: { $exists: false } },
        { status: 'running', runToken },
      ] } },
    }, { $set: { 'rounds.$.status': 'running', 'rounds.$.runToken': runToken,
      'rounds.$.beginJudgeAt': new Date(), 'rounds.$.leaseUntil': new Date(Date.now() +
        ((DI.config.tasks || {}).roundLease || 600000)), updatedAt: new Date() },
      $inc: { stateVersion: 1 } }, { new: true });
    if (!mdoc) throw new errors.TaskConflictError('Round is obsolete or already claimed');
    await Match.updateMatchStatusAsync(mdocid);
    const current = await Match.findById(mdocid);
    await Match.notifyStatusAsync(current, rid);
    return current;
  };

  /**
   * Mark a round as completed (u1win, u2win or draw) or error.
   *
   * @param  {MongoId} mdocid Match Id
   * @param  {MongoId} rid Round Id
   * @param  {String} status
   * @param  {Object} extra Extra fields to be added to the round
   * @return {Match}
   */
  MatchSchema.statics.judgeCompleteRoundAsync = async function (mdocid, rid, status, extra = {}, runToken) {
    if (
      status !== Match.STATUS_U1WIN
      && status !== Match.STATUS_U2WIN
      && status !== Match.STATUS_DRAW
      && status !== Match.STATUS_SYSTEM_ERROR
    ) {
      throw new Error(`judgeCompleteRoundAsync: status ${status} is invalid`);
    }
    const [mdoc, rdoc] = await Match.getRoundObjectByIdAsync(mdocid, rid);
    if (!await Match.isCurrentAsync(mdoc)) throw new errors.TaskConflictError('Match is obsolete');
    if (rdoc.completedRunToken === runToken) return mdoc;
    if (rdoc.status !== 'running' || rdoc.runToken !== runToken) throw new errors.TaskConflictError('Round ownership no longer matches');
    let file = null;
    if (extra.logBlobStream) {
      // if a log stream is specified, put it into gridfs
      file = await DI.gridfs.putBlobAsync(extra.logBlobStream, {
        contentType: 'text/plain',
        metadata: {
          type: 'match.log',
          match: mdocid,
          round: rid,
        },
      });
      extra.logBlob = file._id;
      extra.logBlobStream = null;
    }
    const set = { 'rounds.$.status': status, 'rounds.$.endJudgeAt': new Date(),
      'rounds.$.completedRunToken': runToken, 'rounds.$.leaseUntil': null, updatedAt: new Date() };
    for (const key of ['summary', 'text', 'usedTime', 'logBlob']) {
      if (extra[key] !== undefined) set[`rounds.$.${key}`] = extra[key];
    }
    const changed = await Match.findOneAndUpdate({ _id: mdocid, obsolete: { $ne: true },
      rounds: { $elemMatch: { _id: rid, status: 'running', runToken } },
    }, { $set: set, $inc: { stateVersion: 1 } }, { new: true });
    if (!changed) {
      if (file) await DI.gridfs.removeAsync({ _id: file._id });
      throw new errors.TaskConflictError('Round ownership no longer matches');
    }
    await Match.updateMatchStatusAsync(mdocid);
    const current = await Match.findById(mdocid);
    await Match.notifyStatusAsync(current, rid);
    return current;
  };

  /**
   * Get all related matches for a submission
   * @param  {MongoId} sid
   * @return {[Cursor]}
   */
  MatchSchema.statics.getMatchesForSubmissionCursor = function (sid) {
    return Match
      .find({
        $or: [
          { u1Submission: sid },
          { u2Submission: sid },
        ],
      })
      .sort({ _id: -1 });
  };

  /**
   * Get all pending, running or system_error matches
   */
  MatchSchema.statics.getPendingMatchesAsync = async function (maxId = null) {
    const query = {};
    query['status'] = { $in: [Match.STATUS_RUNNING, Match.STATUS_SYSTEM_ERROR, Match.STATUS_PENDING] };
    if (maxId) {
      query['_id'] = { $lte: maxId };
    }
    return await Match
      .find(query)
      .sort({ _id: -1 })
      .exec();
  };

  /**
   * Update status of all matches
   */
  MatchSchema.statics.refreshAllMatchesAsync = async function () {
    let ret = {
      updated: 0,
      all: 0,
    };
    const cursor = Match.find().sort({ _id: 1 }).cursor();
    for (let mdoc = await cursor.next(); mdoc !== null; mdoc = await cursor.next()) {
      ret.all++;
      mdoc.updateStatus();
      if (mdoc.isModified('status')) {
        ret.updated++;
        await mdoc.save();
      }
    }
    return ret;
  };

  /**
   * Get pairwise matches for the given submissions
   */
  MatchSchema.statics.getPairwiseMatchesAsync = async function (sids) {
    return await Match
      .find({
        u1Submission: { $in: sids },
        u2Submission: { $in: sids },
        status: { $in: [Match.STATUS_U1WIN, Match.STATUS_U2WIN, Match.STATUS_DRAW] },
      })
      .sort({ _id: -1 })
      .exec();
  };
  MatchSchema.statics.getPairwiseMatchesCursor = function (sids) {
    return Match
      .find({
        u1Submission: { $in: sids },
        u2Submission: { $in: sids },
        status: { $in: [Match.STATUS_U1WIN, Match.STATUS_U2WIN, Match.STATUS_DRAW] },
      })
      .sort({ _id: -1 })
      .cursor();
  };


  // Sparse index preserves old records while enforcing uniqueness for new work.
  MatchSchema.index({ matchKey: 1 }, { unique: true, sparse: true });
  MatchSchema.index({ u1Submission: 1, _id: -1 });
  MatchSchema.index({ u2Submission: 1, _id: -1 });
  MatchSchema.index({ status: 1, _id: -1 });

  Match = mongoose.model('Match', MatchSchema);
  return Match;

};
