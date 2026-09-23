import assert from 'assert';

const exitCode = {};

const exitCodeMin = 33;

exitCode.EXIT_B0_WIN = exitCodeMin + 0;
exitCode.EXIT_B1_WIN = exitCodeMin + 1;
exitCode.EXIT_DRAW   = exitCodeMin + 2;
exitCode.EXIT_ERROR  = exitCodeMin + 3;

exitCode.getCodeForBrainLose = (id) => {
  if (id === "0") {
    return exitCode.EXIT_B1_WIN;
  } else if (id === "1") {
    return exitCode.EXIT_B0_WIN;
  } else {
    assert(false);
  }
};

exitCode.getCodeForBrainWin = (id) => {
  if (id === "0") {
    return exitCode.EXIT_B0_WIN;
  } else if (id === "1") {
    return exitCode.EXIT_B1_WIN;
  } else {
    assert(false);
  }
};

export default exitCode;
