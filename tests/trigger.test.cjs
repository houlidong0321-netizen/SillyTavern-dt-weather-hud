/** 导火索排期：解析、合并进月历、随事件结束消失 */
const {JSDOM}=require('/home/claude/testenv/node_modules/jsdom');
const fs=require('fs');
const dom=new JSDOM('<!DOCTYPE html><body><div id="extensions_settings2"></div><div id="ow_menu_button"></div></body>',{url:'http://localhost/',pretendToBeVisual:true});
const w=dom.window;
const jq=fs.readFileSync('/home/claude/testenv/node_modules/jquery/dist/jquery.js','utf8');
const $=new Function('module','exports','window',jq+'\nreturn (typeof jQuery!=="undefined")?jQuery:module.exports;')({exports:{}},{},w);
w.$=$;w.jQuery=$;

const chatMetadata={ offscreen_widgets:{ plot:{ currentId:'02', deadBranches:{}, events:[
  {id:'02',title:'家族催婚',core:'逼迫直面关系',trigger:'长辈突然登门',branches:[{key:'A',condition:'当众承认',next:'03'}]}]},
  offscreen:{tables:{}} }};
const chat=[{name:'C',is_user:false,mes:`正文内容
<scene_data>
[日期: 2026-08-13 | 时间: 09:00 | 天气: 晴 28°C]
[地点: 家]
[待办: 2026-08-20 | 蓝 | 陪同就医]
[导火索: 2026-08-16 | 家族聚餐上被当众提起婚事]
</scene_data>`}];
const ST={getContext:()=>({extensionSettings:{},chatMetadata,chat,
  eventSource:{on(){}},event_types:{APP_READY:'r',CHAT_CHANGED:'c',MESSAGE_RECEIVED:'m'},
  saveSettingsDebounced(){},saveMetadataDebounced(){},setExtensionPrompt(){},
  extension_prompt_types:{IN_CHAT:1},extension_prompt_roles:{SYSTEM:0}})};
w.SillyTavern=ST; w.toastr={info(){},success(){},error(){}};
const src=fs.readFileSync('/home/claude/hud/index.js','utf8')
  +'\n;window.__H={scanChat,getAllTodos,buildPromptText,getEgoCurrentEvent};';
new Function('$','jQuery','window','document','SillyTavern','toastr','console',src)
  ($,$,w,w.document,ST,w.toastr,{log(){},warn(){},error(){},debug(){}});

let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('PASS ',n,e)):(fail++,console.log('FAIL ',n,e));};
const H=w.__H;
H.scanChat();
const todos=H.getAllTodos();
const trig=todos.find(x=>x.source==='ego-trigger');
t('解析出导火索排期', !!trig, trig?JSON.stringify(trig):'null');
t('日期正确', trig && trig.date==='2026-08-16');
t('带【导火索】前缀', trig && /^【导火索】/.test(trig.text), trig?trig.text:'');
t('标为红色置顶', trig && trig.tag==='红');
t('关联到当前事件', trig && trig.eventId==='02');
t('普通待办不受影响', todos.some(x=>x.date==='2026-08-20'&&x.source==='ai'));

// 提示词里要求排期
const p=H.buildPromptText();
t('提示词含导火索格式', p.includes('[导火索: YYYY-MM-DD'), '');
t('提示词带上当前事件的导火索', p.includes('长辈突然登门'));
t('要求近期不要拖太久', p.includes('1-14 天'));
t('要求沿用已排日期', p.includes('沿用同一个日期'));

// 事件走完后（currentId 清空）导火索不再显示
chatMetadata.offscreen_widgets.plot.currentId='';
t('事件结束后导火索消失', !H.getAllTodos().some(x=>x.source==='ego-trigger'));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
