'use strict';

// Arithmetic planning, NOT a benchmark or guaranteed completion time.
function plan({ students = 500, existing = false, parallelism = 2,
  roundSeconds = 2, batch = 32, intervalSeconds = 3, logKiB = 128 } = {}) {
  for (const value of [students, parallelism, roundSeconds, batch, intervalSeconds, logKiB]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('All planning parameters must be positive');
  }
  if (![students, parallelism, batch].every(Number.isInteger) || students > 10000) throw new Error('Invalid count');
  const matches = existing ? students * (students - 1) : students * (students - 1) / 2;
  const rounds = matches * 2;
  const dispatchPerSecond = batch / intervalSeconds;
  return { students, scenario: existing ? 'all students resubmit with older effective submissions present' : 'first submissions in an empty cohort',
    matches, rounds, assumedMeanRoundSeconds: roundSeconds, parallelism,
    optimisticComputeHours: rounds * roundSeconds / parallelism / 3600,
    optimisticDispatchHours: rounds / dispatchPerSecond / 3600, dispatchPerSecond,
    assumedLogKiB: logKiB, logsGiB: rounds * logKiB / 1024 / 1024,
    rawLogCeilingGiB: rounds * 10 / 1024,
    caveats: [
      'Dispatch includes retries, completed-task cleanup and database work; real publishing capacity is lower.',
      'Round duration, compilation, preparation, reconciliation, storage, HTTP callbacks and other load need measurement.',
      'Log sizes are assumptions; the 10 MiB per-round upper estimate excludes database/chunk/index overhead and backups.',
      'These are optimistic arithmetic bounds, not capacity certification or automatic tuning.',
    ] };
}
if (require.main === module) {
  try {
    const keys = { '--students': 'students', '--parallelism': 'parallelism', '--round-seconds': 'roundSeconds',
      '--batch': 'batch', '--interval-seconds': 'intervalSeconds', '--log-kib': 'logKiB' };
    const values = {};
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (key === '--existing') values.existing = true;
      else if (keys[key] && process.argv[i + 1]) values[keys[key]] = Number(process.argv[++i]);
      else throw new Error('Unknown or missing planning option');
    }
    console.log(JSON.stringify(plan(values), null, 2));
  } catch (err) { console.error(err.message); process.exitCode = 2; }
}
module.exports = { plan };
