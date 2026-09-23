import _ from 'lodash';
import { execFile } from 'child-process-promise';
import { argv } from 'yargs';
import path from 'path';
import del from 'del';
import fsp from 'fs-promise';
import uuid from 'uuid';
import assert from 'assert';

import compile from 'libs/compile';

export default async (logger) => {

  if (argv.role !== 'compileTest') {
    return;
  }

  const compilers = _.keys(DI.config.compile).filter(v => !v.startsWith('_'));
  const testingDirectory = path.resolve(DI.config.runtimeDirectory, `compile/${uuid.v4()}`);
  await fsp.ensureDir(testingDirectory);

  logger.info('Compilers to test:', compilers);
  logger.info('Testing directory: %s', testingDirectory);

  for (const compiler of compilers) {
    logger.info('## Testing compiler %s', compiler);
    const magic = uuid.v4();
    const code = `
#include <stdio.h>

int main() {
  printf("${magic}");
  return 0;
}
`;
    const workingDirectory = path.resolve(DI.config.runtimeDirectory, `compile/${uuid.v4()}`);
    await fsp.ensureDir(workingDirectory);

    logger.debug('Building binary in %s...', workingDirectory);

    try {
      const { text, success, binaryBuffer } = await compile.doCompile({
        workingDirectory,
        code,
        compiler,
        limits: {sizeOfBin: 1048576, sizeOfText: 102400},
      });

      logger.info('Compiler output: %s', text);
      assert.equal(success, true);

      logger.debug('Build success, testing...');

      const binFile = path.join(testingDirectory, `${uuid.v4()}_${compiler}.exe`);
      logger.info('Binary path: %s', binFile);

      await fsp.writeFile(binFile, binaryBuffer, { mode: 0o755 });
      const execResult = await execFile(binFile, [], {
        timeout: 2000,
        maxBuffer: 1 * 1024 * 1024,
      });

      assert.equal(execResult.stdout, magic);
    } catch (e) {
      logger.error(e.stack);
    } finally {
      logger.debug('Cleaning up...');
      await del(workingDirectory, { force: true });
    }
  }

  logger.info('All complete.');

};
