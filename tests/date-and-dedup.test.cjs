const fs=require('fs');
const src=fs.readFileSync('/home/claude/hud/index.js','utf8');
// 提取纯函数来测
const grab=(name,end)=>{const a=src.indexOf(`function ${name}(`);const b=src.indexOf(end,a);return src.slice(a,b);};
const helpers = grab('inferDateFromVagueText','function daysInMonth') +
  grab('daysInMonth','function fmtDate') + grab('fmtDate','\n// =====');
const todoKeyFn = grab('todoKey','\n/** 合并');
const normalizeDate = src.slice(src.indexOf('function normalizeDateKey('), src.indexOf('function', src.indexOf('function normalizeDateKey(')+10));
let lastInfo={date:'2026-08-13'};
const fn=new Function('lastInfo','normalizeDateKey', helpers+todoKeyFn+'; return {inferDateFromVagueText, todoKey};');
const api=fn(lastInfo, (s)=>{const m=String(s).match(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:'';});
let pass=0,fail=0;
const t=(n,c,extra='')=>{ if(c){pass++;console.log('PASS ',n,extra);}else{fail++;console.log('FAIL ',n,extra);} };
const I=api.inferDateFromVagueText;
t('八月底 -> 8/31', I('8月底：月度总结会')==='2026-08-31', I('8月底：月度总结会'));
t('8月15日 -> 精确', I('8月15日 体检')==='2026-08-15', I('8月15日 体检'));
t('月初 -> 1号', I('月初：交房租')==='2026-08-01', I('月初：交房租'));
t('中旬 -> 15号', I('9月中旬：出差')==='2026-09-15', I('9月中旬：出差'));
t('完整日期', I('2026-10-24 开会')==='2026-10-24', I('2026-10-24 开会'));
t('无日期返回 null', I('偶尔去便利店')===null, String(I('偶尔去便利店')));
t('每周三能推断', /^\d{4}-\d{2}-\d{2}$/.test(I('每周三 例会')||''), I('每周三 例会'));
const K=api.todoKey;
t('机场重复被识别', K('2026-08-13','角色今天去机场')===K('2026-08-13','角色今天下午去机场'), K('2026-08-13','角色今天下午去机场'));
t('不同事件不误判', K('2026-08-13','去机场')!==K('2026-08-13','去医院'));
t('标点差异归一', K('2026-08-13','去机场，接人')===K('2026-08-13','去机场接人'));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
