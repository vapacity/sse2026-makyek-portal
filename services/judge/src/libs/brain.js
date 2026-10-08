import {EventEmitter2} from 'eventemitter2';

import errors from './errors';
import utils from './utils';

const DEBUG_SINGLE_LIMIT = 16 * 1024 + 10;
const DEBUG_SUM_LIMIT = 32 * 1024;

export default class Brain extends EventEmitter2 {
  constructor(id, options) {
    super();
    this.id = id;
    this.processExited = false;
    this.debugLogQuotaUsed = 0;
    this.ignoreAllEvents = false;

    this.maxTime = options.maxTime;
    this.usedTime = 0;

    this.process = utils.spawnSandbox(options.bin, [], options.sandbox, {
      affinity: options.affinity,
      maxMemory: options.maxMemory,
      maxTime: options.maxTime,
    });
    this.process.stdout.setEncoding('utf8');
    this.process.on('error', this.handleProcessError.bind(this));
    this.process.on('exit', this.handleProcessExit.bind(this));
    this.process.stdin.on('error', this.handleProcessError.bind(this));
    this.process.stdout.on('error', this.handleProcessError.bind(this));
    // Drain stderr so a noisy student program cannot block on a full pipe.
    this.process.stderr.resume();

    this.allowStdout = false;
    this.lineBuffer = '';
    this.process.stdout.on('data', chunk => {
      this.lineBuffer += chunk;
      let newline;
      while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '');
        this.lineBuffer = this.lineBuffer.slice(newline + 1);
        if (line.length > DEBUG_SINGLE_LIMIT) {
          this.handleProcessError(new Error('Output line exceeds limit'));
          this.kill(); return;
        }
        if (line.length) this.handleStdoutLine(line);
        if (this.processExited) return;
      }
      // Bound output even when the program never emits a newline.
      if (this.lineBuffer.length > DEBUG_SINGLE_LIMIT) {
        this.handleProcessError(new Error('Output line exceeds limit'));
        this.kill();
      }
    });
  }

  kill() {
    utils.terminateProcess(this.process);
    this.processExited = true;
  }

  handleProcessError(err) {
    if (this.processExited || this.ignoreAllEvents) {
      return;
    }
    this.emit('error', new errors.BrainError(this.id, `Brain process error: ${err.message}`));
  }

  handleProcessExit(exitCode) {
    if (this.processExited || this.ignoreAllEvents) {
      return;
    }
    this.emit('exit', exitCode);
  }

  handleStdoutLine(line) {
    const current = Date.now();
    if (this.processExited || this.ignoreAllEvents) {
      return;
    }
    if (line.length > DEBUG_SINGLE_LIMIT) {
      line = line.substr(0, DEBUG_SINGLE_LIMIT);
    }
    if (line.indexOf('DEBUG') === 0) {
      if (this.debugLogQuotaUsed > DEBUG_SUM_LIMIT) {
        return;
      }
      const message = line.substr(6);
      this.debugLogQuotaUsed += message.length;
      utils.log('debug', {type: 'brainDebug', id: this.id, message, quotaUsed: this.debugLogQuotaUsed});
      return;
    }
    utils.log('debug', {action: 'receiveResponse', id: this.id, data: line, totalElapsedMs: this.usedTime});
    if (!this.allowStdout) {
      this.emit('error', new errors.BrainError(this.id, `Not allowed to respond, but received "${line}".`));
      return;
    }
    this.emit('response', line, current);
  }

  writeInstruction(line) {
    utils.log('debug', {action: 'sendRequest', id: this.id, data: line});
    this.process.stdin.write(`${line}\n`);
  }

  async emitErrorOnException(func, ...args) {
    try {
      await func(args);
    } catch (e) {
      if (!(e instanceof errors.UserError)) {
        throw e;
      }
      let err = e;
      if (e instanceof errors.UserError) {
        if (!(e instanceof errors.BrainError)) {
          err = new errors.BrainError(this.id, e.message);
        }
      }
      this.emit('error', err);
      throw err;
    }
  }

  waitForOneResponse(timeout = 0, afterThis = function () {}) {
    let p = new Promise((resolve, reject) => {
      this.process.stdout.pause();
      this.allowStdout = true;

      afterThis();
      const beginTime = Date.now();

      this.once('response', (data, endTime) => {
        // const endTime = Date.now();
        if (endTime - beginTime > 0) {
          this.usedTime += (endTime - beginTime);
        }
        if (this.usedTime > this.maxTime) {
          reject(new errors.BrainError(this.id, `Round timeout. Total elapsed time ${this.usedTime}ms exceeded the round time limit ${this.maxTime}ms.`));
          return;
        }
        this.allowStdout = false;
        resolve(data);
      });
      this.process.stdout.resume();
    });
    if (timeout > 0) {
      p = p
        .timeout(timeout)
        .catch(Promise.TimeoutError, e => {
          throw new errors.BrainError(this.id, `Response timeout. Expect a response within ${timeout}ms.`);
        });
    }
    return p;
  }
}
