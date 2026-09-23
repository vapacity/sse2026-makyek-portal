import test from 'ava';
import StoneFlipJudger from '../stoneFlipJudger';

const testCases = {
  '_____________': 0,
  '___x_________': 0,
  'x____________': 0,
  '____________x': 0,
  'o____________': 0,
  'xx___________': 0,
  'oo___________': 0,
  'xxo__________': 0,
  'ox___________': 1,
  'oxxxx________': 1,
  'oxxxxoooox___': 1,
  'ox_xxxoooox__': 1,
  'oxxxx_oooox__': 1,
  'oxxxxoooo_x__': 1,
  'ox_xxxoooo_x_': 1,
  'oxxxx_oooo_x_': 1,
  'ox__xxxoooox_': 1,
  'oox__________': 2,
  'xxoo_________': 0,
  'xxoox________': 0,
  'oxxoox_______': 1,
  'ooxoox_______': 2,
  'ooooox_______': 5,
  // below are randomly generated
  'o______o__xxo': 0,
  'xo_xxx_x_xooo': 0,
  '_xox_o_x__ox_': 0,
  'oox__ooxx_oxo': 2,
  'xo_o_oo_o_xxx': 0,
  'oooooox_x_xxx': 6,
  'xxoox_oox_ooo': 0,
  '_xo_x__oxoxxo': 0,
  'o_xxx__oox_oo': 0,
  'oxoxxoo_xooxo': 1,
  '___x___oxoxo_': 0,
  '_oxx_ox__ooxo': 0,
  'x__oox_oxx___': 0,
  'xxo___ooxx_o_': 0,
  'xx___x_ooxxox': 0,
  '_xxoxxxxoo_x_': 0,
  '_o_ooox__ox_o': 0,
  'ooxo_ooo__o__': 2,
  'o_xx_xxxxooo_': 0,
  'oxxxoo_o_x_xx': 1,
  '_oxooxo_oo_x_': 0,
  'xo__oxxo__oxx': 0,
  '_o___x_x_x__o': 0,
  'xoooxox__oooo': 0,
  'o____xxxoo___': 0,
  'x_o_ox_oxxxox': 0,
  'oxx_oox_xxx_o': 1,
  '_xoooxxoooxo_': 0,
  'ooxxx_xxox_xx': 2,
  'xo___oxxooo_o': 0,
  'xxx_ooo_x___o': 0,
  'o____xooxx_x_': 0,
  'xxxx___x_x_o_': 0,
  '__oo____oxx_o': 0,
  'ooo___oxo____': 0,
  'xoxxx_xxoxo__': 0,
  'xx__xoxxxxo__': 0,
  'ox__oxo__x_oo': 1,
  'xoooooxoxox_x': 0,
  'o__oo_o_o_x__': 0,
};

const charSideMap = {
  '_': 0,
  'x': 1,
  'o': 2,
};

for (const testCaseSrc in testCases) {
  const expectedResult = testCases[testCaseSrc];
  test(`StoneFlipJudger ${testCaseSrc}`, t => {
    const judger = new StoneFlipJudger(1);
    let hasDeterminedResult = false;
    for (let i = 0; i < testCaseSrc.length; i++) {
      const side = charSideMap[testCaseSrc.slice(i, i + 1)];
      const result = judger.next(side);
      if (result >= 0) {
        hasDeterminedResult = true;
        t.is(expectedResult, result);
      }
    }
    if (!hasDeterminedResult) {
      t.is(expectedResult, 0);
    }
  });
}
