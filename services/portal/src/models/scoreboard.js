import _ from 'lodash';

export default () => {
  let cache = { available: false, dirty: true, at: null, rows: [] };
  let revision = 0, flushing = null;

  async function refresh() {
    if (!cache.dirty && cache.at && Date.now() - cache.at.getTime() < 30000) return;
    const startedRevision = revision;
    const [lsdocs, users, badges, stats] = await Promise.all([
      DI.models.Submission.getLastSubmissionsByUserAsync(),
      DI.models.User.getAllUsersAsync(), DI.models.Badge.getBadgesAsync(),
      DI.models.LeaderPair.getStatsAsync(),
    ]);
    await DI.models.Submission.populate(lsdocs, { path: 'sdocid', select: { code: 0, matches: 0 } });
    const badgesById = _.keyBy(badges, 'studentId');
    const statsByUser = _.keyBy(stats, '_id');
    const latestByUser = _.keyBy(lsdocs, '_id');
    const rows = users.map(udoc => {
      const stat = statsByUser[String(udoc._id)] || { win: 0, lose: 0, draw: 0 };
      return { udoc, badge: badgesById[_.get(udoc, 'profile.studentId')], rank: 0,
        score: stat.win * 3 + stat.draw, win: stat.win, lose: stat.lose, draw: stat.draw,
        lsdoc: _.get(latestByUser[String(udoc._id)], 'sdocid', null) };
    });
    const sorted = _.orderBy(rows, ['score', 'win', 'draw', 'lose', 'lsdoc._id', 'udoc._id'],
      ['desc', 'desc', 'desc', 'asc', 'asc', 'asc']);
    let lastRank = 0, lastScore = -1;
    sorted.forEach((row, idx) => {
      if (row.score !== lastScore) { lastRank = idx + 1; lastScore = row.score; }
      row.rank = lastRank;
    });
    // A notification during the refresh must trigger another refresh.
    cache = { available: true, dirty: startedRevision !== revision, at: new Date(), rows: sorted };
  }

  function flushCache() {
    if (!flushing) flushing = refresh().catch(err => {
      cache.dirty = true; DI.logger.error(err.stack);
    }).finally(() => { flushing = null; });
    return flushing;
  }
  const timer = setInterval(flushCache, DI.config.scoreboard.cacheDuration);
  timer.unref();
  DI.eventBus.on('system.started', flushCache);
  const markDirty = () => { revision++; cache.dirty = true; };
  DI.eventBus.on('submission.status:updated', markDirty);
  DI.eventBus.on('match.status:updated', markDirty);
  return { modelName: 'Scoreboard',
    calculate: async () => cache.available ? [cache.rows, cache.at] : [false],
    flushCache, shutdown: () => clearInterval(timer) };
};
