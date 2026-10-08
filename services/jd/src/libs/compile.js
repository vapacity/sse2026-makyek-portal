import _ from 'lodash';
import path from 'path';
import fsp from 'fs-promise';
import { execFile } from 'child-process-promise';

import utils from 'libs/utils';

const enableSandbox = DI.config.sandbox !== null;

const compile = {};

// Currently only one level extension is implemented, however
// multi-level extension can be easily achieved
let compilerSettings = DI.config.compile;
for (let key in compilerSettings) {
  if (compilerSettings[key].extend) {
    let { extend, ...rest } = _.cloneDeep(compilerSettings[key]);
    extend.forEach(ek => _.merge(compilerSettings[key], compilerSettings[ek]));
    _.merge(compilerSettings[key], rest);
    delete compilerSettings[key].extend;
  }
}
compile.settings = compilerSettings;

compile.doCompile = async ({ workingDirectory, code, compiler, limits }) => {
  // Validate settings
  if (compilerSettings[compiler] === undefined) {
    throw new Error(`No settings found for compiler "${compiler}"`);
  }
  for (const key of ['timeout', 'source', 'target', 'command', 'args']) {
    if (compilerSettings[compiler][key] === undefined) {
      throw new Error(`Incorrect config for compiler "${compiler}", missing field "${key}"`);
    }
  }

  const compileConfig = { ...compilerSettings[compiler] };
  for (const key of ['source', 'target']) {
    compileConfig[key] = path.resolve(workingDirectory, compileConfig[key]);
  }

  await fsp.writeFile(compileConfig.source, code);

  let execOptFile, execOptArgs;
  if (enableSandbox) {
    execOptFile = path.resolve(DI.config.sandbox);
    execOptArgs = [
      ...utils.parseArgs(compileConfig.sandboxArgs),
      compileConfig.command,
      ...utils.parseArgs(compileConfig.args),
    ];
  } else {
    execOptFile = compileConfig.command;
    execOptArgs = utils.parseArgs(compileConfig.args);
    if (process.platform === 'linux') {
      execOptFile = '/usr/bin/prlimit';
      execOptArgs = ['--as=805306368', `--cpu=${Math.ceil(compileConfig.timeout / 1000)}`,
        '--', compileConfig.command, ...execOptArgs];
    }
  }

  let success, stdout, stderr;
  let execution, killTimer;

  try {
    execution = execFile(execOptFile, execOptArgs, {
      cwd: workingDirectory,
      env: compileConfig.env || {},
      timeout: compileConfig.timeout,
      maxBuffer: 1 * 1024 * 1024,
      encoding: 'buffer',
      detached: process.platform !== 'win32',
    });
    if (process.platform !== 'win32') {
      // execFile's timeout only kills GCC's parent process. Its cc1/assembler
      // children can keep pipes open, so enforce the deadline on the group too.
      killTimer = setTimeout(() => {
        try { process.kill(-execution.childProcess.pid, 'SIGKILL'); } catch (ignore) { /* already exited */ }
      }, compileConfig.timeout + 1000);
    }
    const execResult = await execution;
    stdout = utils.iconv(execResult.stdout);
    stderr = utils.iconv(execResult.stderr);
    success = true;
  } catch (err) {
    stdout = utils.iconv(err.stdout || Buffer.alloc(0));
    stderr = err.message;
    success = false;
  } finally {
    clearTimeout(killTimer);
    if (execution && process.platform !== 'win32') {
      try { process.kill(-execution.childProcess.pid, 'SIGKILL'); } catch (ignore) { /* already exited */ }
    }
  }
  let text = (stdout + '\n' + stderr).trim();
  if (text.length > limits.sizeOfText) {
    text = text.substr(0, limits.sizeOfText) + '...';
  }

  let binaryBuffer = null;
  if (success) {
    const stat = await fsp.stat(compileConfig.target);
    if (stat.size > limits.sizeOfBin) {
      text = 'Compile succeeded but binary limit exceeded';
      success = false;
    } else {
      binaryBuffer = await fsp.readFile(compileConfig.target);
    }
  }

  return {
    text,
    success,
    binaryBuffer,
  };
};

export default compile;
