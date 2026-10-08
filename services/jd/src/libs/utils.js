import format from 'string-format';
import _ from 'lodash';
import shellQuote from 'shell-quote';
import os from 'os';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

const utils = {};

utils.settleTask = (promise, mq, msg, logger) => promise.then(
  () => { try { mq.ack(msg); } catch (err) { logger.error(err); } },
  err => {
    logger.error(err.stack || err);
    // Keep the delivery unacknowledged while backing off; channel closure also
    // requeues it. Never acknowledge a failed result/error callback.
    setTimeout(() => { try { mq.nack(msg, false, true); } catch (e) { logger.error(e); } }, 2000);
  }
);

utils.isObsoleteTaskError = err => err && err.statusCode === 409;

utils.iconv = (buffer) => {
  const encoding = jschardet.detect(buffer).encoding;
  if (!encoding) {
    return buffer.toString();
  }
  return iconv.decode(buffer, encoding);
};

utils.formatDeep = (value, fmt) => _.cloneDeepWith(value, val => {
  if (typeof val === 'string') {
    return format(val, fmt);
  }
});

utils.parseArgs = (args) => {
  const escape = (process.platform === 'win32') ? '^' : '\\';
  return shellQuote.parse(args, {}, { escape });
};

const availableCores = [];
for (var i = 1; i <= os.cpus().length; ++i) availableCores.push(i);

utils.captureCore = () => {
  if (availableCores.length === 0) {
    return null;
  }
  return availableCores.shift();
};

utils.releaseCore = (coreIndex1) => {
  if (availableCores.indexOf(coreIndex1) !== -1) {
    return;
  }
  if (!coreIndex1) {
    return;
  }
  availableCores.push(coreIndex1);
};

export default utils;
