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
  }

  let success, stdout, stderr;

  try {
    const execResult = await execFile(execOptFile, execOptArgs, {
      cwd: workingDirectory,
      env: compileConfig.env || {},
      timeout: compileConfig.timeout,
      maxBuffer: 1 * 1024 * 1024,
      encoding: 'buffer',
    });
    stdout = utils.iconv(execResult.stdout);
    stderr = utils.iconv(execResult.stderr);
    success = true;
  } catch (err) {
    stdout = utils.iconv(err.stdout);
    stderr = err.message;
    success = false;
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
