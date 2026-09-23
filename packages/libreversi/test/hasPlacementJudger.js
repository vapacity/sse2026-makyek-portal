import test from 'ava';
import HasPlacementJudger from '../hasPlacementJudger';

const testCases = {
  '_____________': false,
  '___x_________': false,
  'x____________': false,
  '____________x': false,
  '___o_________': false,
  'o____________': false,
  '____________o': false,
  '___xx________': false,
  'xx___________': false,
  '___________xx': false,
  '___oo________': false,
  'oo___________': false,
  '___________oo': false,
  '___xxo_______': true,
  'xxo__________': true,
  '__________xxo': false,
  '___oox_______': false,
  'oox__________': false,
  '__________oox': false,
  '___xxoo______': true,
  'xxoo_________': true,
  '_________xxoo': false,
  '___xxoox_____': false,
  'xxoox________': false,
  '________xxoox': false,
  '___xxoox__x__': false,
  'xxoox___x____': false,
  '___x____xxoox': false,
  '___xxoox__xo_': true,
  'xxoox___xo___': true,
  '___xo___xxoox': true,
  '___xxoox___xo': false,
  '___xxoox__xoo': false,
  '___xxoox__xox': false,
  '___xxoox__xxx': false,
  'xxoox_xoooooo': false,
  'xxoox_xooooo_': true,
  'xxoox_xoooo_x': true,
  '___xo___xxoox': true,
  '___xox__xxoox': false,
  '___xoxo_xxoox': true,
  '___xoxx_xxoox': false,
  'xo_xoxx_xxoox': true,
  'xx_xoxx_xxoox': false,
  // below are randomly generated
  'o______o__xxo': false,
  'xo_xxx_x_xooo': true,
  '_xox_o_x__ox_': false,
  'oox__ooxx_oxo': false,
  'xo_o_oo_o_xxx': true,
  'oooooox_x_xxx': false,
  'xxoox_oox_ooo': false,
  '_xo_x__oxoxxo': true,
  'o_xxx__oox_oo': false,
  'oxoxxoo_xooxo': true,
  '___x___oxoxo_': true,
  '_oxx_ox__ooxo': false,
  'x__oox_oxx___': false,
  'xxo___ooxx_o_': true,
  'xx___x_ooxxox': false,
  '_xxoxxxxoo_x_': true,
  '_o_ooox__ox_o': false,
  'ooxo_ooo__o__': true,
  'o_xx_xxxxooo_': true,
  'oxxxoo_o_x_xx': true,
};

const charSideMap = {
  '_': 0,
  'x': 1,
  'o': 2,
};

for (const testCaseSrc in testCases) {
  const expectedResult = testCases[testCaseSrc];
  test(`HasPlacementJudger ${testCaseSrc}`, t => {
    const judger = new HasPlacementJudger(1);
    let hasSuccessfulCheck = false;
    for (let i = 0; i < testCaseSrc.length; i++) {
      const side = charSideMap[testCaseSrc.slice(i, i + 1)];
      const result = judger.next(side);
      if (result) {
        hasSuccessfulCheck = true;
        t.is(expectedResult, true);
      }
    }
    if (!hasSuccessfulCheck) {
      t.is(expectedResult, false);
    }
  });
}
