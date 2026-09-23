require('source-map-support').install();
require('any-promise/register/bluebird');
require('babel-runtime/core-js/promise').default = require('bluebird');

require('./judge');
