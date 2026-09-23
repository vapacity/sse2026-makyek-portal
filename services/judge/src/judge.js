import fs from 'fs';
import _ from 'lodash';
import fsp from 'fs-promise';
import {argv} from 'yargs';

import utils from './libs/utils';
import Brain from './libs/brain';
import Board from './libs/board';
import errors from './libs/errors';
import exitCode from './libs/exitCode';

const MSG_CAUSED_BY_SYS = 'Judge system internal error';

const DEFAULT_ROUND_LIMIT = 120;
const DEFAULT_BOARD_SIZE = 12;
const DEFAULT_START_TIMEOUT = 5000;
const DEFAULT_MOVE_TIMEOUT = 5000;
const DEFAULT_ROUND_TIMEOUT = 180000;
const DEFAULT_MEMORY_LIMIT = 350 * 1024 * 1024;

const BRAIN_IDS = ['0', '1'];

const roundConfig = {};
const brains = {};
const brainsConfig = {};

let board = null;
let argvConfig = {};
let hasShutdown = false;

function getCurrentBrain() {
  return brains[0].config.field === board.nextField ? 0 : 1;
}

function shutdown(exitCode, causedBy) {
  utils.log('debug', {action: 'shutdown', exitCode, causedBy});
  _.forEach(brains, brain => {
    brain.ignoreAllEvents = true;
    brain.kill();
  });

  if (argvConfig && argvConfig.summary) {
    const summaryData = {
      elapsedRoundTime: _.mapValues(brains, 'usedTime'),
      exitCausedBy: causedBy,
      currentBoard: board ? board.getBoardMap() : null,
      // boardSteps: board ? board.getSteps() : null,
      roundConfig,
    };
    utils.log('info', {action: 'summary', data: summaryData});
    fs.writeFileSync(argvConfig.summary, JSON.stringify(summaryData));
  }

  hasShutdown = true;
  process.exit(exitCode);
}

function handleBrainError(id, err) {
  utils.log('info', {type: 'brainError', error: err.message, id});
  shutdown(exitCode.getCodeForBrainLose(id), `Brain ${id} error: ${err.message}`);
}

function handleBrainExit(id) {
  utils.log('info', {type: 'brainProcessExit', id});
  shutdown(exitCode.getCodeForBrainLose(id), `Brain ${id} process terminated`);
}

async function main() {
  // set argvConfig
  if (argv.config) {
    try {
      argvConfig = JSON.parse((await fsp.readFile(argv.config)).toString());
    } catch (err) {
      utils.log('error', {message: `Failed to parse config from "argv.config": ${err.message}`});
      shutdown(exitCode.EXIT_ERROR, MSG_CAUSED_BY_SYS);
      return;
    }
  } else {
    argvConfig = argv;
  }

  // set brainsConfig
  for (const id of BRAIN_IDS) {
    brainsConfig[id] = {};
  }
  brainsConfig[0].field = argvConfig['brain0.field'];
  if (brainsConfig[0].field !== 'black' && brainsConfig[0].field !== 'white') {
    utils.log('error', {message: `Invalid argument "brain0.field", expecting "black" or "white", but received ${brainsConfig[0].field}`});
    shutdown(exitCode.EXIT_ERROR, MSG_CAUSED_BY_SYS);
    return;
  }
  // Translate text to constant
  brainsConfig[0].field = Board.translateField(brainsConfig[0].field);
  brainsConfig[1].field = Board.getOppositeField(brainsConfig[0].field);

  _.forEach(brainsConfig, (config, id) => {
    config.bin = argvConfig[`brain${id}.bin`];
    if (config.bin === undefined) {
      utils.log('error', {message: `Missing argument "brain${id}.bin"`});
      shutdown(exitCode.EXIT_ERROR, MSG_CAUSED_BY_SYS);
      return;
    }
    try {
      fsp.accessSync(config.bin, fsp.constants.X_OK);
    } catch (err) {
      utils.log('error', {message: `Unable to access "${config.bin}"`});
      shutdown(exitCode.EXIT_ERROR, MSG_CAUSED_BY_SYS);
      return;
    }
    config.core = parseInt(argvConfig[`brain${id}.core`], 10);
    if (isNaN(config.core)) {
      config.core = false;
    }
    config.moveTimeout = parseInt(argvConfig[`brain${id}.moveTimeout`], 10);
    if (isNaN(config.moveTimeout)) {
      config.moveTimeout = DEFAULT_MOVE_TIMEOUT;
    }
    config.roundTimeout = parseInt(argvConfig[`brain${id}.roundTimeout`], 10);
    if (isNaN(config.roundTimeout)) {
      config.roundTimeout = DEFAULT_ROUND_TIMEOUT;
    }
    config.memoryLimit = parseInt(argvConfig[`brain${id}.memoryLimit`], 10);
    if (isNaN(config.memoryLimit)) {
      config.memoryLimit = DEFAULT_MEMORY_LIMIT;
    }
  });

  // set roundConfig
  roundConfig.size = parseInt(argvConfig['round.size'], 10);
  if (isNaN(roundConfig.size)) {
    roundConfig.size = DEFAULT_BOARD_SIZE;
  }
  roundConfig.limit = parseInt(argvConfig['round.limit'], 10);
  if (isNaN(roundConfig.limit)) {
    roundConfig.limit = DEFAULT_ROUND_LIMIT;
  }

  utils.log('debug', {action: 'initialize', roundConfig, brainsConfig});

  board = new Board(roundConfig.size);

  // Spawn brain processes
  _.forEach(brainsConfig, (config, id) => {
    const brain = new Brain(id, {
      bin: config.bin,
      sandbox: argvConfig.sandbox,
      affinity: config.core,
      maxMemory: config.memoryLimit,
      maxTime: config.roundTimeout,
    });
    brain.on('error', err => handleBrainError(id, err));
    brain.on('exit', code => handleBrainExit(id, code));
    brain.config = config;
    brains[id] = brain;
  });

  if (hasShutdown) {
    return;
  }

  // Send START to both side
  try {
    await Promise.all(_.map(brains, brain => brain.emitErrorOnException(async () => {
      const resp = await brain.waitForOneResponse(DEFAULT_START_TIMEOUT, () => {
        brain.writeInstruction(`START ${brain.config.field}`);
      });
      if (resp !== 'OK') {
        throw new errors.UserError(`Expect "OK", but received "${resp}"`);
      }
    })));
  } catch (err) {
    if (err instanceof errors.UserError) {
      return;
    }
    throw err;
  }

  // Send BEGIN or TURN
  let lastPlacement = null;
  while (!hasShutdown && (lastPlacement === null || lastPlacement.ended === false)) {
    try {
      const currentBrainId = getCurrentBrain();
      const brain = brains[currentBrainId];
      const anotherBrain = brains[1 - currentBrainId];
      await brain.emitErrorOnException(async () => {
        const resp = await brain.waitForOneResponse(brain.config.moveTimeout, () => {
          brain.writeInstruction('TURN');
        });

        const m = resp.split(" ");
        if (m.length !== 2) {
          throw new errors.UserError(`Invalid response ${resp}. Expect a placement format as "x y".`);
        }
        m[0] = parseInt(m[0],10)
        m[1] = parseInt(m[1],10)

        const placement = board.place(m);
        lastPlacement = placement;
        anotherBrain.writeInstruction(`PLACE ${resp}`);
      });
    } catch (err) {
      if (err instanceof errors.UserError) {
        return;
      }
      throw err;
    }
  }

  // Round ended
  let code;
  if (board.state === Board.BOARD_STATE_DRAW) {
    code = exitCode.EXIT_DRAW;
  } else if (board.state === Board.BOARD_STATE_WIN_BLACK) {
    if (brains[0].config.field === Board.FIELD_BLACK) {
      code = exitCode.EXIT_B0_WIN;
    } else {
      code = exitCode.EXIT_B1_WIN;
    }
  } else if (board.state === Board.BOARD_STATE_WIN_WHITE) {
    if (brains[0].config.field === Board.FIELD_WHITE) {
      code = exitCode.EXIT_B0_WIN;
    } else {
      code = exitCode.EXIT_B1_WIN;
    }
  } else {
    throw new Error(`Invalid board state ${board.state}`);
  }

  _.forEach(brain => brain.ignoreAllEvents = true);
  shutdown(code, '(normal round exit)');
}

main()
  .catch(e => {
    utils.log('error', {message: `Uncaught system exception: ${e.stack}`});
    shutdown(exitCode.EXIT_ERROR, MSG_CAUSED_BY_SYS);
  });
