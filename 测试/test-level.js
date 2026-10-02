const level = require('../配置/level');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { pass++; console.log('  PASS ' + name + ' = ' + got); }
  else { fail++; console.log('  FAIL ' + name + ' 期望 ' + want + '，实际 ' + got); }
};

console.log('— 积分缩写（阈值 ' + level.K_THRESHOLD + '）—');
eq('formatPoints(0)', level.formatPoints(0), '0');
eq('formatPoints(99)', level.formatPoints(99), '99');
eq('formatPoints(999)', level.formatPoints(999), '999');
eq('formatPoints(1000)', level.formatPoints(1000), '1k');
eq('formatPoints(1200)', level.formatPoints(1200), '1.2k');
eq('formatPoints(15400)', level.formatPoints(15400), '15.4k');
eq('formatPoints(150000)', level.formatPoints(150000), '150k');
eq('formatPoints(null)', level.formatPoints(null), '0');

console.log('— 等级阶梯 —');
eq('0 级', level.getLevelInfo(0).level + '/' + level.getLevelInfo(0).name, '1/初来乍到');
eq('100 级', level.getLevelInfo(100).level + '/' + level.getLevelInfo(100).name, '2/校园新人');
eq('999 级', level.getLevelInfo(999).level + '/' + level.getLevelInfo(999).name, '4/小有名气');
eq('1000 级', level.getLevelInfo(1000).level + '/' + level.getLevelInfo(1000).name, '5/论坛达人');
eq('15400 级', level.getLevelInfo(15400).level + '/' + level.getLevelInfo(15400).name, '9/传奇前辈');
eq('20000 级', level.getLevelInfo(20000).level + '/' + level.getLevelInfo(20000).name, '10/荣誉元老');
eq('20000 封顶', level.getLevelInfo(20000).isMax, true);
eq('99999 仍封顶', level.getLevelInfo(99999).isMax, true);
eq('20000 之后 remaining', level.getLevelInfo(99999).remaining, 0);

console.log('— 进度计算 —');
const l = level.getLevelInfo(15400);
eq('15400 progress', l.progress, 54);
eq('15400 remaining', l.remaining, 4600);
eq('15400 nextName', l.nextName, '荣誉元老');
eq('0 progress', level.getLevelInfo(0).progress, 0);
eq('1000 progress', level.getLevelInfo(1000).progress, 0);

console.log('\n==== ' + pass + ' 通过 / ' + fail + ' 失败 ====');
process.exit(fail === 0 ? 0 : 1);
