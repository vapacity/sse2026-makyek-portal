import { argv } from 'yargs';
import { execFile } from 'child-process-promise';
import AsyncCache from 'async-cache';
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

  // Initialize binary buffer directory. At runtime, the directory must not be cleared.
  const bufferDirectory = path.resolve(DI.config.runtimeDirectory, 'match_bin_buffer');
  await fsp.ensureDir(bufferDirectory);

  async function loadBinaryCache(udocid, sdocid) {
    const binPath = path.join(bufferDirectory, `${udocid}/${sdocid}.exe`);
    await fsp.ensureDir(path.dirname(binPath));
    try {
      await fsp.access(binPath);
      return binPath;
    } catch (ignore) {
      // file does not exist, go on
    }
    const content = await lzma.decompress(await api.getSubmissionBinary(sdocid), LZMA_DECOMPRESS_OPTIONS);
    await fsp.writeFile(binPath, content, { mode: 0o755 });
    return binPath;
  }

  const _binaryCache = new AsyncCache({
    max: 500,
    maxAge: 24 * 60 * 60 * 1000,
    load: (key, callback) => {
      const [udocid, sdocid] = key.split(':');
      loadBinaryCache(udocid, sdocid)
        .then(v => callback(null, v))
        .catch(err => callback(err));
    },
  });

  function getBinaryPath(udocid, sdocid) {
    return new Promise((resolve, reject) => {
      _binaryCache.get(`${udocid}:${sdocid}`, (err, value) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(value);
      });
    });
  }

  async function getAndCopyBinary(udocid, sdocid, destPath) {
    const binPath = await getBinaryPath(udocid, sdocid);
    await fsp.copy(binPath, destPath);
  }

  async function handleJudgeTask(task, affinityCores) {
    const workingDirectory = path.resolve(DI.config.runtimeDirectory, `match/${uuid.v4()}`);
    await fsp.ensureDir(workingDirectory);

    try {
      try {
        await api.roundBegin(task.mdocid, task.rid);
      } catch (err) {
        if (err instanceof api.APIUserError) {
          logger.info('Ignored match %s (round %s): %s', task.mdocid, task.rid, err.message);
          return;
        }
        throw err;
      }

      const matchConfig = { ...DI.config.match };
      for (const key of ['s1bin', 's2bin', 'config', 'summary']) {
        matchConfig[key] = path.resolve(workingDirectory, matchConfig[key]);
      }

      await getAndCopyBinary(task.u1docid, task.s1docid, matchConfig.s1bin);
      await getAndCopyBinary(task.u2docid, task.s2docid, matchConfig.s2bin);

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
        const execResult = await execFile(matchConfig.command, utils.parseArgs(matchConfig.args), {
          cwd: workingDirectory,
          maxBuffer: 10 * 1024 * 1024,
        });
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
      await api.roundComplete(task.mdocid, task.rid, code, summary, stdout);
    } catch (err) {
      await api.roundError(task.mdocid, task.rid, `System internal error occured when judging this round.\n\n${err.stack}`);
      throw err;
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

    const prefetch = ~~((os.cpus().length - 1) / 2);
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
        handleJudgeTask(task, affinityCores)
          .catch(e => logger.error(e))
          .then(() => {
            affinityCores.forEach(coreIndex => utils.releaseCore(coreIndex));
            mq.ack(msg);
          });
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
