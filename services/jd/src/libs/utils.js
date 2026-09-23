import format from 'string-format';
import _ from 'lodash';
import shellQuote from 'shell-quote';
import os from 'os';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

const utils = {};

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
