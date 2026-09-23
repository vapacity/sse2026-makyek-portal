var constant = require('./constant');

/**
 * Receive a sequence of stones (exclude current placement), determine how many stones can be flipped. -1 means undetermined.
 */
function StoneFlipJudger(side) {
  this.side = side;
  this.reset();
}

StoneFlipJudger.prototype.reset = function () {
  this.state = 0;
  this.ended = false;
  this.stoneToBeFlipped = 0;
};

StoneFlipJudger.prototype._end = function () {
  this.ended = true;
  return this.stoneToBeFlipped;
};

StoneFlipJudger.prototype.next = function (posSide) {
  if (this.ended) {
    return this.stoneToBeFlipped;
  }
  switch (this.state) {
    case 0:
      if (posSide === this.side) {
        // [x]x
        return this._end();
      } else if (posSide === constant.STATE_EMPTY) {
        // [x]_
        return this._end();
      } else {
        // [x]o
        this.stoneToBeFlipped++;
        this.state = 1;
        return -1;
      }
      break;
    case 1:
      if (posSide === this.side) {
        // [x]ox
        return this._end();
      } else if (posSide === constant.STATE_EMPTY) {
        // [x]o_
        this.stoneToBeFlipped = 0;
        return this._end();
      } else {
        // [x]oo
        this.stoneToBeFlipped++;
        return -1;
      }
      break;
  }
};

module.exports = StoneFlipJudger;
