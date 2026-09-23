import 'source-map-support/register';
import 'app-module-path/register';
import { argv } from 'yargs';
import chalk from 'chalk';
import fs from 'fs-promise';
import FrameworkEntry from 'dg-framework';

import path from 'path';
// without ending slash!
global.__codeRoot = path.join(__dirname, '.');
global.__projectRoot = path.join(__dirname, '..');

(async function start() {

  if (process.getuid && process.getuid() === 0) {
    console.error('Do not run in super privilege.');
    process.exit(1);
    return;
  }

  if (argv.role !== 'compile' && argv.role !== 'match' && argv.role !== 'compileTest') {
    console.error('Invalid role. Please specify a valid role via --role.');
    process.exit(1);
    return;
  }

  process.title = `ReversiJD_${argv.role}`;

  let envProfile = 'debug';
  try {
    await fs.stat(`${__projectRoot}/.debug`);
  } catch (ignore) {
    envProfile = 'production';
  }

  if (envProfile === 'production') {
    console.log('Running in %s mode', chalk.green('PRODUCTION'));
  } else {
    console.log('Running in %s mode', chalk.red('DEBUG'));
  }

  const application = new FrameworkEntry({
    env: envProfile,
    config: ['config.yaml'],
    services: 'services.yaml',
    loadModule: (path) => require(`${__codeRoot}/services/${path}`).default,
  });

  global.DI = application.DI;

  application.start().catch(e => console.log(e.stack));

})();
