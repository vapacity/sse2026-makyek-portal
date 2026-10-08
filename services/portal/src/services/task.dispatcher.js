// Reconciliation closes the save -> enqueue crash window without requiring a
// replica set/transactions in the local MongoDB deployment.
export default (models, logger) => {
  let running = false;
  let submissionAfter = null, matchAfter = null;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const sq = { $or: [{ status: { $in: ['pending', 'compiling', 'running'] } },
        { status: 'effective', quotaCharged: false, rejudge: false }] };
      if (submissionAfter) sq._id = { $gt: submissionAfter };
      const sdocs = await models.Submission.find(sq).sort({ _id: 1 }).limit(100);
      for (const sdoc of sdocs) {
        if (sdoc.status === 'effective') {
          await models.Submission.chargeQuotaAsync(sdoc.toObject());
        } else if (sdoc.status === 'running') {
          if (sdoc.matchesReady === false) await models.Submission.prepareMatchesAsync(sdoc._id);
          else await models.Submission.reconcileMatchesAsync(sdoc._id);
        } else if (sdoc.taskToken) {
          await models.Submission.enqueueCompileAsync(sdoc);
        }
      }
      submissionAfter = sdocs.length === 100 ? sdocs[sdocs.length - 1]._id : null;
      const mq = { status: { $in: ['pending', 'running'] }, obsolete: { $ne: true } };
      if (matchAfter) mq._id = { $gt: matchAfter };
      const mdocs = await models.Match.find(mq).sort({ _id: 1 }).limit(100);
      for (const mdoc of mdocs) {
        if (await models.Match.isCurrentAsync(mdoc)) {
          await models.Match.enqueueRoundsAsync(mdoc);
          await models.Match.updateMatchStatusAsync(mdoc._id);
        }
      }
      matchAfter = mdocs.length === 100 ? mdocs[mdocs.length - 1]._id : null;
      await models.Task.dispatchAsync();
    } catch (err) {
      logger.error('Task reconciliation failed: %s', err.stack);
    } finally { running = false; }
  }
  const timer = setInterval(tick, (DI.config.tasks || {}).interval || 3000);
  timer.unref();
  DI.eventBus.on('system.started', tick);
  return { tick, shutdown: () => clearInterval(timer) };
};
