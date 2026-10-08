import { argv } from 'yargs';
import { execFile } from 'child-process-promise';
import os from 'os';
import path from 'path';
import del from 'del';
import fsp from 'fs-promise';
import lzma from 'lzma-native';
import uuid from 'uuid';
import api from 'libs/api';
import utils from 'libs/utils';

const LZMA_DECOMPRESS_OPTIONS = {
  threads: 1,
};

const JUDGE_QUEUE = 'reversi_judge';

const EXITCODE_MIN = 33;
const EXITCODE_MAX = EXITCODE_MIN + 3;

export default async (mq, logger) => {

  if (argv.role !== 'match') {
    return;
  }

  // Self running at Core 1
  utils.captureCore();

  // Each round uses its pinned executable blobs. No shared mutable cache or
  // unbounded disk growth; its private directory is removed after completion.
  async function getBinary(sdocid, blob, destPath) {
    const content = await lzma.decompress(await api.getSubmissionBinary(sdocid, blob), LZMA_DECOMPRESS_OPTIONS);
    if (content.length > 1048576) throw new Error('Executable exceeds size limit');
    await fsp.writeFile(destPath, content, { mode: 0o755 });
  }

  async function handleJudgeTask(task, affinityCores) {
    const runToken = uuid.v4();
    let claimed = false, match;
    const workingDirectory = path.resolve(DI.config.runtimeDirectory, `match/${uuid.v4()}`);
    await fsp.ensureDir(workingDirectory);

    try {
      try {
        match = await api.roundBegin(task.mdocid, task.rid, runToken);
        claimed = true;
      } catch (err) {
        if (utils.isObsoleteTaskError(err)) {
          logger.info('Ignored match %s (round %s): %s', task.mdocid, task.rid, err.message);
          return;
        }
        throw err;
      }

      const matchConfig = { ...DI.config.match };
      for (const key of ['s1bin', 's2bin', 'config', 'summary']) {
        matchConfig[key] = path.resolve(workingDirectory, matchConfig[key]);
      }

      await getBinary(match.u1Submission, match.exe1Blob, matchConfig.s1bin);
      await getBinary(match.u2Submission, match.exe2Blob, matchConfig.s2bin);

      await fsp.writeFile(matchConfig.config, JSON.stringify({
        'sandbox': DI.config.sandbox === null ? null : path.resolve(DI.config.sandbox),
        'summary': DI.config.match.summary,
        'brain0.core': affinityCores[0],
        'brain0.field': task.u1field,
        'brain0.bin': DI.config.match.s1bin,
        'brain0.moveTimeout': task.rules.moveTimeout,
        'brain0.roundTimeout': task.rules.roundTimeout,
        'brain0.memoryLimit': task.rules.memoryLimit,
        'brain1.core': affinityCores[1],
        'brain1.bin': DI.config.match.s2bin,
        'brain1.moveTimeout': task.rules.moveTimeout,
        'brain1.roundTimeout': task.rules.roundTimeout,
        'brain1.memoryLimit': task.rules.memoryLimit,
        'round.size': task.rules.size,
        'round.limit': task.rules.roundLlimit,
      }, null, 2));

      let stdout, stderr, code = 0, summary = '';
      try {
        const execution = execFile(matchConfig.command, utils.parseArgs(matchConfig.args), {
          cwd: workingDirectory,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 2 * task.rules.roundTimeout + 30000,
          killSignal: 'SIGTERM',
        });
        const execResult = await execution;
        stdout = execResult.stdout;
        stderr = execResult.stderr;
      } catch (err) {
        stdout = err.stdout;
        stderr = err.stderr;
        code = err.code;
      }

      if (code < EXITCODE_MIN || code > EXITCODE_MAX) {
        throw new Error(`Unexpected judge exit code ${code}. ${stderr}`);
      }

      summary = (await fsp.readFile(matchConfig.summary)).toString();

      logger.info('Match %s (round %s) complete', task.mdocid, task.rid);
      await api.roundComplete(task.mdocid, task.rid, code, summary, stdout, runToken);
    } catch (err) {
      if (utils.isObsoleteTaskError(err)) return;
      if (!claimed || err instanceof api.APIServerError || err instanceof api.APIRequestError ||
        (err instanceof api.APIUserError && err.statusCode !== 400)) throw err;
      await api.roundError(task.mdocid, task.rid, `System internal error occured when judging this round.\n\n${err.stack}`, runToken);
      logger.error(err.stack);
    } finally {
      try {
        await del(workingDirectory, { force: true });
      } catch (e) {
        logger.error(e);
      }
    }
  }

  try {
    await mq.assertQueue(JUDGE_QUEUE);

    const capacity = Math.max(1, Math.floor((os.cpus().length - 1) / 2));
    const prefetch = Math.min(capacity, Math.max(1, Math.floor(DI.config.match.parallelism || 2)));
    logger.info('Message queue prefetch %d.', prefetch);
    mq.prefetch(prefetch);

    mq.consume(JUDGE_QUEUE, msg => {
      if (msg == null) {
        return;
      }
      try {
        const message = msg.content.toString();
        const task = JSON.parse(message);
        logger.info('Match %s (round %s): %s', task.mdocid, task.rid, message);

        const affinityCores = [utils.captureCore(), utils.captureCore()];
        utils.settleTask(handleJudgeTask(task, affinityCores).finally(() => {
          affinityCores.forEach(coreIndex => utils.releaseCore(coreIndex));
        }), mq, msg, logger);
      } catch (e) {
        logger.warn('Failed to parse message content, discarded.');
        logger.warn(e.stack);
        mq.ack(msg);
      }
    });

    logger.info('Accepting match tasks...');
  } catch (e) {
    logger.error(e.stack);
    logger.warn('Message queue errors, exiting.');
    process.exit(1);
  }

};
