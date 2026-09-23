import { argv } from 'yargs';
import path from 'path';
import del from 'del';
import fsp from 'fs-promise';
import uuid from 'uuid';
import lzma from 'lzma-native';

import api from 'libs/api';
import compile from 'libs/compile';

const LZMA_COMPRESS_OPTIONS = {
  preset: 4,
  threads: 0,
};

const COMPILE_QUEUE = 'reversi_compile';

export default async (mq, logger) => {

  if (argv.role !== 'compile') {
    return;
  }

  logger.debug('Compiler settings: %s', JSON.stringify(compile.settings, null, 2));

  async function handleCompileTask(task) {
    const workingDirectory = path.resolve(DI.config.runtimeDirectory, `compile/${uuid.v4()}`);
    await fsp.ensureDir(workingDirectory);

    try {
      let submission;
      try {
        submission = await api.compileBegin(task.sdocid, task.token);
      } catch (err) {
        if (err instanceof api.APIUserError) {
          logger.info('Ignored task %s: %s', task.sdocid, err.message);
          return;
        }
        throw err;
      }

      const { text, success, binaryBuffer } = await compile.doCompile({
        workingDirectory,
        code: submission.code,
        compiler: submission.compiler,
        limits: task.limits,
      });

      logger.info('Compile %s end (success = %s)', task.sdocid, success);

      let lzmaBuffer = null;
      if (success) {
        lzmaBuffer = await lzma.compress(binaryBuffer, LZMA_COMPRESS_OPTIONS);
      }

      await api.compileEnd(task.sdocid, task.token, text, success, lzmaBuffer);
    } catch (err) {
      await api.compileError(task.sdocid, task.token, `System internal error occured when compiling this submission.\n\n${err.stack}`);
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
    await mq.assertQueue(COMPILE_QUEUE);
    mq.prefetch(1);

    mq.consume(COMPILE_QUEUE, msg => {
      if (msg == null) {
        return;
      }
      try {
        const message = msg.content.toString();
        const task = JSON.parse(message);
        logger.info('Compile: %s: %s', task.sdocid, message);
        handleCompileTask(task)
          .catch(e => logger.error(e))
          .then(() => mq.ack(msg));
      } catch (e) {
        logger.warn('Failed to parse message content, discarded.');
        logger.warn(e.stack);
        mq.ack(msg);
      }
    });

    logger.info('Accepting compiler tasks...');
  } catch (e) {
    logger.error(e.stack);
    logger.warn('Message queue errors, exiting.');
    process.exit(1);
  }

};
