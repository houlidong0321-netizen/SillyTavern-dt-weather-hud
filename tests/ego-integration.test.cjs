const {JSDOM}=require('/home/claude/testenv/node_modules/jsdom');
const fs=require('fs');
const dom=new JSDOM('<!DOCTYPE html><body><div id="extensions_settings2"></div><div id="ow_menu_button"></div></body>',{url:'http://localhost/',pretendToBeVisual:true});
const w=dom.window;
const jq=fs.readFileSync('/home/claude/testenv/node_modules/jquery/dist/jquery.js','utf8');
const $=new Function('module','exports','window',jq+'\nreturn (typeof jQuery!=="undefined")?jQuery:module.exports;')({exports:{}},{},w);
w.$=$;w.jQuery=$;

// 模拟 Ego 已写入的数据
const chatMetadata={ offscreen_widgets:{
  plot:{ currentId:'02', deadBranches:{'02':['B']}, events:[
    {id:'01',title:'催婚风暴',core:'c',branches:[{key:'A',condition:'承认',next:'02'}]},
    {id:'02',title:'代价',core:'暴露软肋',branches:[{key:'A',condition:'硬刚到底',next:'OPEN'},{key:'B',condition:'选择退让',next:'OPEN'}]}]},
  offscreen:{ tables:{
    timelineTable:[{time:'2026-08-20 14:00',task:'慈善晚宴出席',chapter:'`[Chapter_4]`'}],
    scheduleTable:[{role:'安琳',routine:'每周一晨会',seasonal:'8月底：季度总结会议',pool:''}],
    foreshadowTable:[{tag:'`[F_1]`',content:'那封没寄出的信',chapter:'`[Chapter_2]`',status:'未回收'},
                     {tag:'`[F_2]`',content:'已解开的谜',chapter:'`[Chapter_1]`',status:'已回收'}],
  }},
}};
const ST={getContext:()=>({
  extensionSettings:{}, chatMetadata, chat:[{name:'C',mes:'[日期: 2026-08-13 | 时间: 09:00 | 天气: 晴 28°C]\n[地点: 家]\n正文',is_user:false}],
  eventSource:{on(){}}, event_types:{APP_READY:'ready',CHAT_CHANGED:'cc',MESSAGE_RECEIVED:'mr'},
  saveSettingsDebounced(){}, saveMetadataDebounced(){}, setExtensionPrompt(){},
  extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0},
})};
w.SillyTavern=ST; w.toastr={info(){},success(){},error(){}};
const src=fs.readFileSync('/home/claude/hud/index.js','utf8').replace(/\}\)\;\s*$/,'});')
  + '\n;window.__H={getEgoCurrentEvent,getEgoCalendarItems,getAllTodos,isEgoInstalled,getEgoTable,renderEgoBlock,init};';
new Function('$','jQuery','window','document','SillyTavern','toastr','console',src)
  ($,$,w,w.document,ST,w.toastr,{log(){},warn(){},error(){},debug(){}});

let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('PASS ',n,e)):(fail++,console.log('FAIL ',n,e));};
const H=w.__H;
t('检测到 Ego 已安装', H.isEgoInstalled()===true);
const ev=H.getEgoCurrentEvent();
t('读到当前事件', ev && ev.id==='02' && ev.title==='代价', ev?ev.title:'null');
t('读到伏笔表', H.getEgoTable('foreshadowTable').length===2);
const items=H.getEgoCalendarItems();
t('待办表转成月历项', items.some(i=>i.date==='2026-08-20'&&i.text==='慈善晚宴出席'), JSON.stringify(items.find(i=>i.source==='ego-todo')||{}));
t('日程表模糊日期被推断', items.some(i=>i.date==='2026-08-31'&&/季度总结会议/.test(i.text)), JSON.stringify(items.find(i=>i.source==='ego-schedule')||{}));
t('日程项标记为推断', (items.find(i=>i.source==='ego-schedule')||{}).vague===true);
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
