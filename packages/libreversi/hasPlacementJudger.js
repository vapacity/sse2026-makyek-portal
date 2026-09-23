var constant = require('./constant');

function HasPlacementJudger(side) {
  this.side = side;
  this.oppoSide = constant.STATE_REVERSE - side;
  this.reset();
}

HasPlacementJudger.prototype.reset = function () {
  this.state = 0;
  this.ended = false;
};

HasPlacementJudger.prototype.next = function (posSide) {
  if (this.ended) {
    return true;
  }
  switch (this.state) {
    case 0:
      if (posSide === this.side) {
        // ...x
        this.state = 1;
      }
      // ...o
      // ..._
      break;
    case 1:
      if (posSide === this.oppoSide) {
        // ...xo
        this.state = 2;
      } else if (posSide === constant.STATE_EMPTY) {
        // ...x_
        this.state = 0;
      }
      // ...xx
      break;
    case 2:
      if (posSide === constant.STATE_EMPTY) {
        // ...xo_
        this.ended = true;
        return true;
      } else if (posSide === this.side) {
        // ...xox
        this.state = 1;
      }
      // ...xoo
      break;
  }
  return false;
};

module.exports = HasPlacementJudger;
