var constant = require('./constant');

module.exports = {
  checkPlayerSide: function (side) {
    if (side !== constant.STATE_BLACK && side !== constant.STATE_WHITE) {
      throw new Error('invalid playerSide');
    }
  },
};
