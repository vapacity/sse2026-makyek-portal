import _ from 'lodash';
import fsp from 'fs-promise';
import uuid from 'uuid';
import moment from 'moment';
import mongoose from 'mongoose';
import utils from '@/libs/utils';
import objectId from '@/libs/objectId';
import errors from '@/libs/errors';
import permissions from '@/libs/permissions';

export default () => {
  const SubmissionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    version: Number,  // nth submission of this user
    code: String,
    compiler: String,
    exeBlob: mongoose.Schema.Types.ObjectId,  // grid fs
    status: String,
    active: Boolean,
    text: String,
    taskToken: String,    // A unique token for each task, so that duplicate tasks
                          // won't be judged multiple times
    compileRunToken: String,
    compileLeaseUntil: Date,
    completedCompileRunToken: String,
    matchGeneration: String,
    matchesReady: Boolean,
    opponentsReady: Boolean,
    matchRevision: { type: Number, default: 0 },
    matchOpponents: [{ user: mongoose.Schema.Types.ObjectId,
      submission: mongoose.Schema.Types.ObjectId, exeBlob: mongoose.Schema.Types.ObjectId }],
    quotaCharged: Boolean,
    rejudge: Boolean,
    matches: [{
      _id: mongoose.Schema.Types.ObjectId,
      status: String,
      usedTime: Number,
      stateVersion: Number,
    }],
    matchLogCleared: Boolean,
  }, {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  });

  /**
   * Get total used time based on used time of each match
   */
  SubmissionSchema.virtual('totalUsedTime').get(function () {
    return _.sumBy(this.matches, 'usedTime');
  });

  // Submission Model
  let Submission;

  SubmissionSchema.statics.HOT_STATUS_COLD = 0;
  SubmissionSchema.statics.HOT_STATUS_GLOBAL_LIMIT = 1;
  SubmissionSchema.statics.HOT_STATUS_QUOTA_LIMIT = 2;
  SubmissionSchema.statics.HOT_STATUS_SUBMISSION_LIMIT = 3;
  SubmissionSchema.statics.HOT_STATUS_TIME_LIMIT = 4;

  SubmissionSchema.statics.STATUS_PENDING = 'pending';
  SubmissionSchema.statics.STATUS_COMPILING = 'compiling';
  SubmissionSchema.statics.STATUS_COMPILE_ERROR = 'ce';
  SubmissionSchema.statics.STATUS_SYSTEM_ERROR = 'se';
  SubmissionSchema.statics.STATUS_RUNNING = 'running';
  SubmissionSchema.statics.STATUS_EFFECTIVE = 'effective';

  SubmissionSchema.statics.STATUS_TEXT = {
    'pending': 'Pending',
    'compiling': 'Compiling',
    'ce': 'Compile Error',
    'se': 'System Error',
    'running': 'Running',
    'effective': 'Effective',
  };

  SubmissionSchema.pre('save', function (next) {
    this.__lastIsNew = this.isNew;
    this.__lastModifiedPaths = this.modifiedPaths();
    next();
  });

  SubmissionSchema.post('save', function () {
    const sdoc = this.toObject();
    Promise.all([
      (async () => {
        if (this.__lastIsNew) {
          await DI.eventBus.emitAsyncWithProfiling('submission:created::**', sdoc);
        }
      })(),
      ...this.__lastModifiedPaths.map(async (path) => {
        let m;
        if (path === 'status') {
          await DI.eventBus.emitAsyncWithProfiling('submission.status:updated::**', sdoc);
        } else if (m = path.match(/^matches\.(\d+)\.status$/)) {
          const smdoc = sdoc.matches[m[1]];
          await DI.eventBus.emitAsyncWithProfiling('submission.matches.status:updated::**', sdoc, smdoc);
        }
      }),
    ]).catch(err => DI.logger.error(err.stack));
  });

  /**
   * Update the submission status one by one when match status is updated
   */
  const updateStatusQueue = new utils.DedupWorkerQueue({
    delay: 1000,
    asyncWorkerFunc: sdocid => {
      return Submission.updateSubmissionStatusAsync(sdocid);
    },
  });

  DI.eventBus.on('submission.matches.status:updated', sdoc => {
    updateStatusQueue.push(String(sdoc._id));
  });

  /**
   * Update corresponding smdoc status when a match status is updated
   */
  DI.eventBus.on('match.status:updated', async mdoc => {
    try {
      await Submission.updateSubmissionMatchAsync(mdoc._id);
    } catch (err) {
      DI.logger.error(err.stack);
    }
  });

  /**
   * Update today's quota when a submission status is updated
   * Notice that there is a window between submission_status_updated and quota_updated
   */
  DI.eventBus.on('submission.status:updated', async sdoc => {
    if (sdoc.status === Submission.STATUS_EFFECTIVE && !sdoc.rejudge) {
      await Submission.chargeQuotaAsync(sdoc);
    }
  });

  /**
   * Update the status of the submission based on status of matches.
   * Status will be changed only from `running` to `effective`, or reversed.
   */
  SubmissionSchema.methods.updateStatus = function () {
    if (this.status !== Submission.STATUS_RUNNING && this.status !== Submission.STATUS_EFFECTIVE) {
      return;
    }
    if (!this.matches || this.matchesReady === false) {
      return;
    }
    const allEffective = _.every(this.matches, mdoc => DI.models.Match.isEffectiveStatus(mdoc.status));
    const newStatus = allEffective ? Submission.STATUS_EFFECTIVE : Submission.STATUS_RUNNING;
    this.status = newStatus;
  };

  SubmissionSchema.statics.updateSubmissionStatusAsync = async function (sdocid) {
    for (let i = 0; i < 5; i++) {
      const sdoc = await Submission.getSubmissionObjectByIdAsync(sdocid);
      const previous = sdoc.status;
      sdoc.updateStatus();
      if (sdoc.status === previous) return sdoc;
      const revision = sdoc.matchRevision || 0;
      const changed = await Submission.findOneAndUpdate({ _id: sdocid,
        status: previous, matchGeneration: sdoc.matchGeneration || null,
        $or: [{ matchRevision: revision }, { matchRevision: { $exists: false } }],
      }, { $set: { status: sdoc.status, ...(sdoc.status === 'effective' ? { active: false } : {}),
        updatedAt: new Date() } }, { new: true });
      if (changed) { await Submission.notifyStatusAsync(changed); return changed; }
    }
  };

  SubmissionSchema.statics.notifyStatusAsync = async function (sdoc) {
    try { await DI.eventBus.emitAsyncWithProfiling('submission.status:updated::**', sdoc.toObject()); }
    catch (err) { DI.logger.error(err.stack); }
  };

  /**
   * Get the submission object by userId
   *
   * @return {Submission} Mongoose submission object
   */
  SubmissionSchema.statics.getSubmissionObjectByIdAsync = async function (id, projection = {}, throwWhenNotFound = true) {
    if (!objectId.isValid(id)) {
      if (throwWhenNotFound) {
        throw new errors.UserError('Submission not found');
      } else {
        return null;
      }
    }
    const s = await Submission.findOne({ _id: id }, projection);
    if (s === null && throwWhenNotFound) {
      throw new errors.UserError('Submission not found');
    }
    return s;
  };

  /**
   * Get all submissions
   */
  SubmissionSchema.statics.getAllSubmissionsCursor = function () {
    return Submission
      .find({})
      .sort({ _id: -1 });
  };

  /**
   * Get all submissions of a user
   */
  SubmissionSchema.statics.getUserSubmissionsCursor = function (uid) {
    return Submission
      .find({ user: uid })
      .sort({ _id: -1 });
  };

  /**
   * Check whether a user is allowed to submit new code
   *
   * @return {[Number, Any]}
   *         Number is HOT_STATUS
   *         for HOT_STATUS_GLOBAL_LIMIT, 2nd element is the reason
   *         for HOT_STATUS_QUOTA_LIMIT, 2nd element is the quota used
   *         for HOT_STATUS_TIME_LIMIT, 2nd element is the remaining time
   */
  SubmissionSchema.statics.isUserAllowedToSubmitAsync = async function (uid) {
    const udoc = await DI.models.User.getUserObjectByIdAsync(uid);

    // Global submission lock?
    const lockdoc = await DI.models.Sys.getAsync('lock_submission', false);
    if (lockdoc && !udoc.hasPermission(permissions.BYPASS_SUBMISSION_LOCK)) {
      const reason = await DI.models.Sys.getAsync('lock_submission_reason', 'Unknown');
      return [Submission.HOT_STATUS_GLOBAL_LIMIT, reason];
    }

    // Submission quota limit?
    const usedTime = await Submission.getUsedSubmissionQuotaAsync(uid);
    if (usedTime > DI.config.compile.limits.maxExecQuota && !udoc.hasPermission(permissions.BYPASS_SUBMISSION_QUOTA)) {
      return [Submission.HOT_STATUS_QUOTA_LIMIT, usedTime];
    }

    // No last submission?
    const sdocs = await Submission.getUserSubmissionsCursor(uid).limit(1).exec();
    if (sdocs.length === 0) {
      return [Submission.HOT_STATUS_COLD];
    }

    // Last submission is CE?
    const last = sdocs[0];
    if (last.status === Submission.STATUS_COMPILE_ERROR) {
      return [Submission.HOT_STATUS_COLD];
    }

    let limit;

    // Last submission is running?
    if (last.status === Submission.STATUS_PENDING
      || last.status === Submission.STATUS_COMPILING
      || last.status === Submission.STATUS_RUNNING) {
      return [Submission.HOT_STATUS_SUBMISSION_LIMIT];
    }

    // Submission interval limit?
    if (udoc.hasPermission(permissions.BYPASS_SUBMISSION_LIMIT)) {
      limit = DI.config.compile.limits.minSubmitInterval || 1000;
    } else {
      limit = DI.config.compile.limits.submitInterval;
    }
    const interval = Date.now() - last.createdAt.getTime();
    const remaining = limit - interval;
    if (remaining > 0) {
      return [Submission.HOT_STATUS_TIME_LIMIT, remaining];
    }

    return [Submission.HOT_STATUS_COLD];
  };

  /**
   * Submit new code and create tasks
   *
   * @return {Submission}
   */
  SubmissionSchema.statics.createSubmissionAsync = async function (uid, code, compiler) {
    return DI.models.User.withSubmissionLockAsync(uid, async () => {
      const [hotStatus] = await Submission.isUserAllowedToSubmitAsync(uid);
      if (hotStatus !== Submission.HOT_STATUS_COLD) {
        throw new errors.UserError('You are not allowed to submit new code currently.');
      }
      if (code.length > DI.config.compile.limits.sizeOfCode) {
        throw new errors.ValidationError('Your source code is too large.');
      }
      const version = await DI.models.User.incAndGetSubmissionNumberAsync(uid);
      const sdoc = new Submission({
        user: uid,
        version,
        code,
        compiler,
        status: Submission.STATUS_PENDING,
        text: '',
        rejudge: false,
      });
      return await Submission._compileForMatchAsync(sdoc);
    });
  };

  /**
   * Recompile a submission
   */
  SubmissionSchema.statics.recompileAsync = async function (sid) {
    const sdoc = await Submission.getSubmissionObjectByIdAsync(sid);
    return DI.models.User.withSubmissionLockAsync(sdoc.user, async () => {
      const csdocs = await Submission.find(
        {
          status: Submission.STATUS_COMPILING,
          _id: { $lt: sdoc._id },
        },
        { _id: 1 }
      );
      if (csdocs.length !== 0) {
        const csids = _.map(csdocs, csdoc => csdoc._id.toString());
        throw new Error(`Those submissions should be recompiled first: ${csids.join(', ')}`);
      }
      sdoc.text = '';
      sdoc.taskToken = null;
      sdoc.matches = null;
      sdoc.rejudge = true;
      return await Submission._compileForMatchAsync(sdoc);
    });
  };

  /**
   * Reset status of a submission and push it to the task queue
   *
   * @param  {MongoId|Submission} sidOrSubmission Submission id or Submission object
   * @return {Submission} The new submission object
   */
  SubmissionSchema.statics._compileForMatchAsync = async function (sdoc) {
    if (!sdoc.isNew && await Submission.count({ user: sdoc.user, active: true, _id: { $ne: sdoc._id } })) {
      throw new errors.UserError('Another submission of this user is still active');
    }
    if (sdoc.taskToken) {
      const error = new Error('_compileForMatchAsync: Expect taskToken is undefined');
      DI.logger.error(error.stack);
    }
    const reset = { exeBlob: null, status: Submission.STATUS_PENDING, active: true, text: '',
      taskToken: uuid.v4(), compileRunToken: null, compileLeaseUntil: null,
      completedCompileRunToken: null, matchesReady: false, matches: [],
      matchOpponents: [], opponentsReady: false, matchGeneration: null, quotaCharged: false,
      rejudge: !!sdoc.rejudge };
    try {
      if (sdoc.isNew) { Object.assign(sdoc, reset); await sdoc.save(); }
      else { sdoc = await Submission.findOneAndUpdate({ _id: sdoc._id }, { $set: reset,
        $inc: { matchRevision: 1 } }, { new: true }); await Submission.notifyStatusAsync(sdoc); }
    } catch (err) {
      if (err.code === 11000) throw new errors.UserError('Another submission of this user is still active');
      throw err;
    }
    // If enqueue fails after save, the periodic reconciler repairs the outbox.
    try { await Submission.enqueueCompileAsync(sdoc); }
    catch (err) { DI.logger.error(err.stack); }
    return sdoc;
  };

  SubmissionSchema.statics.enqueueCompileAsync = async function (sdoc) {
    await DI.models.Task.enqueueAsync(`compile:${sdoc._id}:${sdoc.taskToken}`, 'compile', {
      sdocid: String(sdoc._id),
      token: sdoc.taskToken,
      limits: DI.config.compile.limits,
    });
  };

  /**
   * Get each users' last effective or running submission
   *
   * @param  {Boolean} onlyEffective
   * @return {[{_id, sdocid}]}
   */
  SubmissionSchema.statics.getLastSubmissionsByUserAsync = async function (onlyEffective = true, maxDatetime = null) {
    const matchExp = {};
    if (onlyEffective) {
      matchExp.status = Submission.STATUS_EFFECTIVE;
    } else {
      matchExp.status = { $in: [ Submission.STATUS_RUNNING, Submission.STATUS_EFFECTIVE ] };
    }
    if (maxDatetime) {
      // Comparing actual ObjectIds includes older records in the same second.
      matchExp._id = { $lt: maxDatetime instanceof Date ? objectId.fromDatetime(maxDatetime) : maxDatetime };
    }
    return await Submission.aggregate([
      { $match: matchExp },
      { $sort: { _id: -1 } },
      { $project: { user: 1, createdAt : 1, status: 1 } },
      { $group: { _id: '$user', sdocid: { $first: '$_id' } } },
    ]).allowDiskUse(true).exec();
  };

  /**
   * Shrink the log of matches in previous submissions
   */
  SubmissionSchema.statics.shrink = async function () {
    DI.logger.info('Collecting last submissions...');
    const lsdocs = await DI.models.Submission.getLastSubmissionsByUserAsync();
    const sdocWhitelist = {};
    lsdocs.forEach(lsdoc => sdocWhitelist[lsdoc.sdocid.toString()] = true);

    const fsFiles = DI.mongodbConnection.collection('fs.files');
    const fsChunks = DI.mongodbConnection.collection('fs.chunks');

    let shrinked = 0;
    const n = await DI.models.Submission.count({});
    const sdocs = await DI.models.Submission.find({}, { status: 1, matchLogCleared: 1 }).sort({ _id: 1 }).exec();
    for (const sdoc of sdocs) {
      if (sdoc.matchLogCleared === true) {
        DI.logger.info('[%d / %d] Ignored processed submission %s', ++shrinked, n, sdoc._id);
      } else if (sdoc.status !== Submission.STATUS_EFFECTIVE) {
        DI.logger.info('[%d / %d] Ignored non-effective submission %s', ++shrinked, n, sdoc._id);
      } else if (sdocWhitelist[sdoc._id.toString()]) {
        DI.logger.info('[%d / %d] Ignored last submission %s', ++shrinked, n, sdoc._id);
      } else {
        DI.logger.warn('[%d / %d] Shrinking submission %s...', ++shrinked, n, sdoc._id);
        const mdocCursor = DI.models.Match.find({ u1Submission: sdoc._id }, { 'rounds.logBlob': 1 }).sort({ _id: 1 }).cursor();
        for (let mdoc = await mdocCursor.next(); mdoc !== null; mdoc = await mdocCursor.next()) {
          if (mdoc.rounds) {
            const filesToRemove = [];
            for (let round of mdoc.rounds) {
              if (round.logBlob) {
                filesToRemove.push(round.logBlob);
                round.logBlob = null;
              }
            }
            try {
              await fsFiles.remove({ _id: { $in: filesToRemove } });
              await fsChunks.remove({ files_id: { $in: filesToRemove } });
            } catch (err) {
              DI.logger.error(err);
            }
            await mdoc.save();
          }
        }
        sdoc.matchLogCleared = true;
        await sdoc.save();
      }
    }
  };

  /**
   * Export everyone's latest code
   */
  SubmissionSchema.statics.exportCode = async function (location = '') {
    const directory = location + '/export_' + moment().format('YYYY-MM-DD-HH-mm');
    await fsp.ensureDir(directory);
    const lsdocs = await Submission.getLastSubmissionsByUserAsync();
    for (const lsdoc of lsdocs) {
      DI.logger.info('%s', lsdoc.sdocid);
      const sdoc = await Submission.getSubmissionObjectByIdAsync(lsdoc.sdocid);
      await sdoc.populate('user').execPopulate();
      await fsp.writeFile(`${directory}/${sdoc.user.profile.studentId}_${sdoc.user.profile.realName}.c`, sdoc.code);
    }
    DI.logger.info('Done.');
  };

  /**
   * Mark a submission as compiling and return the submission if the given taskToken
   * matches the submission
   *
   * @param  {MongoId} sid
   * @param  {String} taskToken
   * @return {Submission}
   */
  SubmissionSchema.statics.judgeStartCompileAsync = async function (sid, taskToken, runToken) {
    const sdoc = await Submission.findOneAndUpdate({ _id: sid, taskToken, $or: [
      { status: 'pending' },
      { status: 'compiling', compileLeaseUntil: { $lte: new Date() } },
      { status: 'compiling', compileLeaseUntil: { $exists: false } },
      { status: 'compiling', compileRunToken: runToken },
    ] }, { $set: { status: 'compiling', compileRunToken: runToken,
      compileLeaseUntil: new Date(Date.now() + ((DI.config.tasks || {}).compileLease || 180000)),
      updatedAt: new Date() } }, { new: true });
    if (!sdoc) throw new errors.TaskConflictError('Compile task is obsolete or already claimed');
    await Submission.notifyStatusAsync(sdoc);
    return sdoc;
  };

  SubmissionSchema.statics.checkCompileOwnerAsync = async function (sid, taskToken, runToken) {
    const sdoc = await Submission.getSubmissionObjectByIdAsync(sid);
    if (sdoc.completedCompileRunToken === runToken) return sdoc;
    if (sdoc.status !== 'compiling' || sdoc.taskToken !== taskToken || sdoc.compileRunToken !== runToken) {
      throw new errors.TaskConflictError('Compile task ownership no longer matches');
    }
    return sdoc;
  };

  /**
   * Mark a submission as System Error
   *
   * @param  {MongoId} sid
   * @param  {String} taskToken
   * @param  {String} text
   * @return {Submission}
   */
  SubmissionSchema.statics.judgeSetSystemErrorAsync = async function (sid, taskToken, text, runToken) {
    let sdoc = await Submission.checkCompileOwnerAsync(sid, taskToken, runToken);
    if (sdoc.completedCompileRunToken === runToken) return sdoc;
    sdoc = await Submission.findOneAndUpdate({ _id: sid, taskToken,
      status: 'compiling', compileRunToken: runToken }, { $set: { text, status: 'se',
      taskToken: null, active: false, compileLeaseUntil: null, completedCompileRunToken: runToken,
      updatedAt: new Date() } }, { new: true });
    if (!sdoc) throw new errors.TaskConflictError('Compile task ownership no longer matches');
    await Submission.notifyStatusAsync(sdoc);
    return sdoc;
  };

  /**
   * Mark a submission as Compile Error or Running and return the submission if the
   * given taskToken matches the submission. For success compiling, it will prepare
   * matches and push match task to the queue.
   *
   * @param  {MongoId} sid
   * @param  {String} taskToken
   * @param  {Boolean} success
   * @param  {String} text
   * @param  {MongoId} exeBlobId
   * @return {Submisison}
   */
  SubmissionSchema.statics.judgeCompleteCompileAsync = async function (sid, taskToken, success, text, exeBlobId = null, runToken) {
    if (!success && exeBlobId !== null) {
      throw new Error('judgeCompleteCompileAsync: No executable should be supplied');
    }
    if (success && !exeBlobId) throw new errors.ValidationError('Executable file is missing');
    const sdoc = await Submission.findOneAndUpdate({ _id: sid, taskToken,
      compileRunToken: runToken, status: 'compiling' }, { $set: { text,
      status: success ? 'running' : 'ce', exeBlob: exeBlobId,
      active: success,
      taskToken: null, compileLeaseUntil: null, completedCompileRunToken: runToken,
      matchGeneration: taskToken, matchesReady: false, updatedAt: new Date(),
    } }, { new: true });
    if (!sdoc) throw new errors.TaskConflictError('Compile task ownership no longer matches');
    await Submission.notifyStatusAsync(sdoc);
    return sdoc;
  };

  /**
   * Create related matches for specified submission
   */
  SubmissionSchema.statics.prepareMatchesAsync = async function (sid) {
    let sdoc = await Submission.getSubmissionObjectByIdAsync(sid);
    if (sdoc.status !== 'running' || sdoc.matchesReady !== false) return;
    // Preserve chronological pairing when several compilers run in parallel.
    if (await Submission.count({ _id: { $lt: sdoc._id }, status: { $in: ['pending', 'compiling'] } })) return;
    const lsdocs = await Submission.getLastSubmissionsByUserAsync(false, sdoc._id);
    const generation = sdoc.matchGeneration;
    const selected = _.filter(lsdocs, d => !d._id.equals(sdoc.user));
    // Persist the opponent snapshot once so retries cannot add different matches.
    if (!sdoc.opponentsReady) {
      const opponents = [];
      for (const doc of selected) {
        const opponent = await Submission.findById(doc.sdocid).select('exeBlob');
        if (opponent && opponent.exeBlob) opponents.push({ user: doc._id,
          submission: doc.sdocid, exeBlob: opponent.exeBlob });
      }
      await Submission.update({ _id: sid, matchGeneration: generation, matchesReady: false,
        opponentsReady: false }, { $set: { matchOpponents: opponents, opponentsReady: true } });
      sdoc = await Submission.getSubmissionObjectByIdAsync(sid);
      if (sdoc.matchGeneration !== generation || sdoc.matchesReady !== false) return;
    }
    const mdocs = await DI.models.Match.addMatchesForSubmissionAsync(
      sdoc._id,
      sdoc.user,
      sdoc.matchOpponents.map(d => ({ _id: d.user, sdocid: d.submission, exeBlob: d.exeBlob })),
      generation, sdoc.exeBlob
    );
    const saved = await Submission.findOneAndUpdate({ _id: sid, matchGeneration: generation,
      status: 'running', matchesReady: false }, { $set: { matchesReady: true,
      matches: mdocs.map(d => ({ _id: d._id, status: d.status, usedTime: d.usedTime || 0,
        stateVersion: d.stateVersion || 0 })),
      updatedAt: new Date() }, $inc: { matchRevision: 1 } }, { new: true });
    if (!saved) return;
    // Crucially, matches[] is committed BEFORE a single round is delivered.
    for (const mdoc of mdocs) await DI.models.Match.enqueueRoundsAsync(mdoc);
    await Submission.updateSubmissionStatusAsync(sid);
  };

  /**
   * Update the status of a smdoc according to the status of mdoc
   *
   * @param  {ObjectId} mdocid
   */
  SubmissionSchema.statics.updateSubmissionMatchAsync = async function (mdocid) {
    const mdoc = await DI.models.Match.getMatchObjectByIdAsync(mdocid);
    const query = { _id: mdoc.u1Submission, matches: { $elemMatch: { _id: mdocid,
      $or: [{ stateVersion: { $lte: mdoc.stateVersion || 0 } }, { stateVersion: { $exists: false } }],
    } } };
    if (mdoc.generation) query.matchGeneration = mdoc.generation;
    const sdoc = await Submission.findOneAndUpdate(query, { $set: {
      'matches.$.status': mdoc.status, 'matches.$.usedTime': mdoc.usedTime || 0,
      'matches.$.stateVersion': mdoc.stateVersion || 0,
    }, $inc: { matchRevision: 1 } }, { new: true });
    if (sdoc) {
      await DI.eventBus.emitAsyncWithProfiling('submission.matches.status:updated::**', sdoc.toObject());
      await Submission.updateSubmissionStatusAsync(sdoc._id);
    }
  };

  SubmissionSchema.statics.reconcileMatchesAsync = async function (sid) {
    const sdoc = await Submission.getSubmissionObjectByIdAsync(sid);
    for (const smdoc of sdoc.matches || []) {
      const mdoc = await DI.models.Match.findById(smdoc._id);
      if (!mdoc) continue;
      if (smdoc.status !== mdoc.status || smdoc.usedTime !== mdoc.usedTime || smdoc.stateVersion !== mdoc.stateVersion) {
        await Submission.updateSubmissionMatchAsync(mdoc._id);
      }
    }
    await Submission.updateSubmissionStatusAsync(sid);
  };

  SubmissionSchema.statics.chargeQuotaAsync = async function (sdoc) {
    if (sdoc.quotaCharged) return;
    const expiry = moment().add(1, 'd').startOf('day').unix();
    const usedTime = Math.max(0, Math.round(sdoc.totalUsedTime || 0));
    if (!Number.isFinite(usedTime)) throw new Error('Invalid execution quota');
    await DI.redis.evalAsync("if redis.call('SETNX', KEYS[1], '1') == 1 then " +
      "redis.call('INCRBY', KEYS[2], ARGV[1]); redis.call('EXPIREAT', KEYS[2], ARGV[2]); " +
      "redis.call('EXPIRE', KEYS[1], 604800); return 1; end; return 0;", 2,
      `charged_quota:${sdoc._id}`, `used_quota:${sdoc.user}`, usedTime, expiry);
    await Submission.update({ _id: sdoc._id }, { $set: { quotaCharged: true } });
  };

  /**
   * Get all pending, running, compiling or system_error matches
   */
  SubmissionSchema.statics.getPendingSubmissionsCursor = function () {
    return Submission
      .find({
        status: { $in: [Submission.STATUS_PENDING, Submission.STATUS_RUNNING, Submission.STATUS_COMPILING, Submission.STATUS_SYSTEM_ERROR] },
      })
      .sort({ _id: -1 });
  };

  /**
   * Get used submission quota of a user
   *
   * @param  {ObjectId} uid
   * @return {Number}
   */
  SubmissionSchema.statics.getUsedSubmissionQuotaAsync = async function (uid) {
    const result = parseInt(await DI.redis.getAsync(`used_quota:${uid}`));
    if (isNaN(result)) {
      return 0;
    }
    return result;
  };

  /**
   * Increase used submission quota of a user
   *
   * @param  {ObjectId} uid
   * @param  {Number} usedTime used time in milliseconds
   */
  SubmissionSchema.statics.incrUsedSubmissionQuotaAsync = async function (uid, usedTime) {
    return await DI.redis
      .multi()
      .incrby(`used_quota:${uid}`, usedTime)
      .expireat(`used_quota:${uid}`, moment().add(1, 'd').startOf('day').unix())
      .execAsync();
  };

  SubmissionSchema.index({ user: 1, _id: -1 });
  // Final database-level guard even if a portal process loses its user lease.
  // Existing historical records have no active field and are not rewritten.
  SubmissionSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { active: true } });
  SubmissionSchema.index({ status: 1, _id: -1 });

  Submission = mongoose.model('Submission', SubmissionSchema);
  return Submission;

};
