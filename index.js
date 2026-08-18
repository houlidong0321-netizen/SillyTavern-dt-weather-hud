// ==========================================================
// 剧情时间天气悬浮窗 + 侧边信息栏 (SillyTavern Extension) v3
// ----------------------------------------------------------
// 功能总览：
// 1. 注入提示词，要求模型每次回复末尾输出固定格式的结构化数据块：
//    日期/时间/天气、当前地点、主要人物着装、待办事项、章节摘要。
// 2. 扫描聊天记录，提取上述信息（时间天气取"最后一条"，摘要/待办累积全量）。
// 3. 悬浮窗显示时间天气；点击悬浮窗从左/右展开侧栏：
//    - 月历（带颜色标签圆点，点击某天查看该日待办）
//    - 当前地点
//    - 主要人物着装
//    - 章节摘要列表
// 4. 可自动隐藏正文中的标记块（仅影响显示，不修改聊天记录）。
// ==========================================================

const MODULE_NAME = 'dt_weather_hud';

// ================= 固定格式正则 =================
// [日期: 2026-08-05 | 时间: 09:45 | 天气: 晴 28°C]
const INFO_REGEX = /\[\s*日期\s*[:：]\s*([^|\]]+?)\s*\|\s*时间\s*[:：]\s*([^|\]]+?)\s*\|\s*天气\s*[:：]\s*([^\]]+?)\s*\]/;
// [地点: 老城区咖啡馆二楼]
const LOCATION_REGEX = /\[\s*地点\s*[:：]\s*([^\]]+?)\s*\]/;
// [着装: 林夏=米色针织衫，黑色长裙; 陈默=深灰风衣]
const OUTFIT_REGEX = /\[\s*着装\s*[:：]\s*([^\]]+?)\s*\]/;
// [待办: 2026-08-10 | 红 | 与陈默在码头碰面]   （可出现多条）
const TODO_REGEX_G = /\[\s*待办\s*[:：]\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/g;
// [Chapter_1]2026-08-05 09:20-09:45 咖啡馆 摘要正文……
const CHAPTER_REGEX_G = /\[\s*Chapter[_\s]*(\d+)\s*\]\s*([^\n\r]+)/gi;
// [导火索: 2026-08-18 | 家族聚餐上被当众提起婚事]
const TRIGGER_REGEX = /\[\s*导火索\s*[:：]\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/;

// 用于「隐藏正文标记」的整体匹配（含可选包裹标签与前置换行）
const HIDE_PATTERNS = [
    /\n?<\s*scene_data\s*>[\s\S]*?<\s*\/\s*scene_data\s*>\s*/gi,
    /\n?\[\s*日期\s*[:：]\s*[^|\]]+?\s*\|\s*时间\s*[:：]\s*[^|\]]+?\s*\|\s*天气\s*[:：]\s*[^\]]+?\s*\]\s*/g,
    /\n?\[\s*地点\s*[:：]\s*[^\]]+?\s*\]\s*/g,
    /\n?\[\s*着装\s*[:：]\s*[^\]]+?\s*\]\s*/g,
    /\n?\[\s*待办\s*[:：]\s*[^|\]]+?\s*\|\s*[^|\]]+?\s*\|\s*[^\]]+?\s*\]\s*/g,
    /\n?\[\s*导火索\s*[:：]\s*[^|\]]+?\s*\|\s*[^\]]+?\s*\]\s*/g,
    /\n?\[\s*Chapter[_\s]*\d+\s*\][^\n\r]*\s*/gi,
];

// ================= 颜色标签 =================
const COLOR_TAGS = {
    '红': '#ff5f6d', 'red': '#ff5f6d',
    '橙': '#ff9f43', 'orange': '#ff9f43',
    '黄': '#ffd93d', 'yellow': '#ffd93d',
    '绿': '#4ade80', 'green': '#4ade80',
    '青': '#22d3ee', 'cyan': '#22d3ee',
    '蓝': '#60a5fa', 'blue': '#60a5fa',
    '紫': '#c084fc', 'purple': '#c084fc',
    '粉': '#f9a8d4', 'pink': '#f9a8d4',
    '灰': '#9ca3af', 'gray': '#9ca3af', 'grey': '#9ca3af',
};
const DEFAULT_TAG_COLOR = '#9ca3af';
const TAG_PICKER_ORDER = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '灰'];

function resolveTagColor(tag) {
    const key = String(tag || '').trim().toLowerCase();
    const cn = String(tag || '').trim();
    return COLOR_TAGS[cn] || COLOR_TAGS[key] || DEFAULT_TAG_COLOR;
}

// ================= 默认设置 =================
const defaultSettings = Object.freeze({
    egoIntegration: true,   // 读取 Ego 小助手的日程/待办/剧情数据
    egoScheduleTrigger: true, // 让模型给"下一个事件的导火索"排一个具体日期，落到月历
    egoToast: true,         // Ego 生成开始/结束时弹提示
    enabled: true,              // 总开关：是否注入提示词
    panelVisible: true,         // 悬浮窗是否显示
    panelCollapsed: false,      // 悬浮窗是否折叠
    drawerSide: 'left',         // 侧栏展开方向: left / right
    injectPosition: 'IN_CHAT',
    injectDepth: 0,
    injectRole: 'SYSTEM',
    // 分模块注入开关
    injectWeather: true,
    injectLocation: true,
    injectOutfit: true,
    injectTodo: true,
    injectSummary: true,
    hideMarkers: true,          // 自动隐藏正文中的标记（仅显示层）
    useCustomCss: false,
    customCss: '',
    panelX: null,
    panelY: null,
});

const POSITION_FALLBACK = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const ROLE_FALLBACK = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

// ================= 运行时状态 =================
let lastInfo = null;        // { date, time, weather, index }
let lastLocation = '';      // 当前地点
let lastOutfits = [];       // [{ name, desc }]
let lastChapter = null;     // 只保留最后一条章节摘要 { num, text, index }
let parsedTodos = [];       // 从正文解析出的待办 [{ date, tag, text, source:'ai' }]
let parsedTrigger = null;   // 下一个剧情事件的导火索排期 { date, text }
let calendarCursor = null;  // { year, month }  当前月历显示的月份（month 从 0 开始）
let selectedDay = null;     // 'YYYY-MM-DD'
let drawerOpen = false;

// ================= 基础工具 =================
function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.prototype.hasOwnProperty.call(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---- 手动待办：存放在当前聊天的 metadata 中，随聊天存档 ----
function getManualTodos() {
    const ctx = getContext();
    if (!ctx.chatMetadata) return [];
    if (!ctx.chatMetadata[MODULE_NAME]) ctx.chatMetadata[MODULE_NAME] = {};
    if (!Array.isArray(ctx.chatMetadata[MODULE_NAME].todos)) ctx.chatMetadata[MODULE_NAME].todos = [];
    return ctx.chatMetadata[MODULE_NAME].todos;
}

function saveManualTodos() {
    const ctx = getContext();
    if (typeof ctx.saveMetadata === 'function') {
        ctx.saveMetadata();
    } else if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
    } else {
        ctx.saveSettingsDebounced();
    }
}

/**
 * 待办去重用的归一化键。
 * 直接比较原文会漏掉"角色今天去机场"和"角色今天下午去机场"这类只差几个字的重复，
 * 所以先剥掉标点、时段词、指代今天的说法再比。
 */
function todoKey(date, text) {
    const t = String(text || '')
        .replace(/[\s\u3000，,。.、；;：:！!？?"'""''（）()【】\[\]]/g, '')
        .replace(/今天|今日|当天|明天|后天/g, '')
        .replace(/凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜/g, '')
        .replace(/大约|大概|左右|可能|预计/g, '');
    return `${date}||${t}`;
}

/** 合并三个来源的待办：用户手动 > 正文解析 > Ego 表格（按归一化键去重） */
function getAllTodos() {
    const settings = getSettings();
    const merged = [];
    const seen = new Set();
    const push = (t) => {
        const k = todoKey(t.date, t.text);
        if (seen.has(k)) return;
        seen.add(k);
        merged.push(t);
    };

    // 手动优先级最高（用户亲手写的不能被顶掉）
    for (const t of getManualTodos()) push({ ...t, source: 'manual' });

    // 剧情导火索：只有当它指向的事件仍在进行中才显示
    if (settings.egoIntegration !== false && settings.egoScheduleTrigger !== false && parsedTrigger) {
        const ev = getEgoCurrentEvent();
        if (ev) {
            push({
                date: parsedTrigger.date, tag: '红',
                text: `【导火索】${parsedTrigger.text}`,
                source: 'ego-trigger', done: false,
                eventId: ev.id, eventTitle: ev.title,
            });
        }
    }
    for (const t of parsedTodos) push(t);
    if (settings.egoIntegration !== false) {
        for (const t of getEgoCalendarItems()) push(t);
    }
    return merged;
}

// ================= Ego 小助手数据桥接 =================
// 监听 Ego 广播的生成事件（Ego ≥3.3.0 会发），用来显示开始/结束提醒。
// Ego 版本较旧或没装时，下面的监听不会触发，一切照常。
function bindEgoEvents() {
    try {
        window.addEventListener('ego:task', (ev) => {
            if (getSettings().egoIntegration === false) return;
            const d = ev.detail || {};
            const badge = document.getElementById('dt_hud_ego_busy');
            if (d.phase === 'start') {
                if (badge) { badge.textContent = `⏳ ${d.label || '生成中'}`; badge.style.display = ''; }
                if (getSettings().egoToast !== false) toastr?.info?.(`Ego 开始生成：${d.label || ''}`);
            } else {
                if (badge) badge.style.display = 'none';
                if (getSettings().egoToast !== false) {
                    if (d.ok === false) toastr?.error?.(`Ego 生成失败：${d.label || ''}`);
                    else toastr?.success?.(`Ego 生成完成：${d.label || ''}${d.seconds ? `（${d.seconds}s）` : ''}`);
                }
                // 生成完数据就变了，刷新月历与事件区
                renderDrawerContent();
            }
        });
    } catch (e) { /* 忽略 */ }
}

// Ego 的数据全部存在同一个聊天的 chatMetadata 里，所以这里纯读取，
// 不发任何请求、不消耗任何 token。Ego 没装或没数据时一律安全返回空。

const EGO_MODULE = 'offscreen_widgets';

function getEgoData() {
    try {
        const md = getContext()?.chatMetadata;
        return (md && md[EGO_MODULE]) || null;
    } catch (e) {
        return null;
    }
}

function isEgoInstalled() {
    try {
        return !!document.querySelector('#ow_menu_button') || !!getEgoData();
    } catch (e) {
        return false;
    }
}

/** 当前所处的剧情事件 { id, title, core, branches } */
function getEgoCurrentEvent() {
    const ego = getEgoData();
    const plot = ego?.plot;
    if (!plot?.currentId || !Array.isArray(plot.events)) return null;
    return plot.events.find(e => e.id === plot.currentId) || null;
}

/** 取某张 Ego 表格的行 */
function getEgoTable(key) {
    const t = getEgoData()?.offscreen?.tables;
    return (t && Array.isArray(t[key])) ? t[key] : [];
}

/**
 * 从 Ego 的表格里提取可以落到月历上的条目。
 * 三个来源：
 *   核心待办事项表 —— 本来就带确切时间，直接用
 *   日程表         —— "时节性必然事件"常写成"八月底：月度总结会"，需要推断具体日期
 *   伏笔表         —— 没有日期，只在侧栏列出，不占月历格子
 */
function getEgoCalendarItems() {
    const out = [];

    // 待办事项表：时间 | 事项 | 关联章节
    // 其中关联章节写成 `[Plot_XX]` 的，是 Ego 推演排期过来的"剧情导火索"，单独标记
    for (const r of getEgoTable('timelineTable')) {
        const date = normalizeDateKey(r.time || '');
        if (!date || !r.task) continue;
        const isPlot = /\[Plot_/.test(String(r.chapter || ''));
        const raw = String(r.task).trim();
        // 形如 "[事件02] 代价｜导火索：媒体拍到" —— 月历里显示导火索本身更有用
        const m = raw.match(/^\[事件(\w+)\]\s*(.*?)｜导火索[:：]\s*(.+)$/);
        out.push({
            date,
            tag: isPlot ? '红' : '蓝',
            text: m ? `${m[3]}` : raw,
            title: m ? `事件${m[1]}「${m[2]}」的导火索` : raw,
            source: isPlot ? 'ego-plot' : 'ego-todo',
            done: false,
        });
    }

    // 日程表：角色 | 固定日程规律 | 时节性必然事件 | 弹性事务参考池
    for (const r of getEgoTable('scheduleTable')) {
        const who = String(r.role || '').trim();
        const seasonal = String(r.seasonal || '').trim();
        if (!seasonal || seasonal === '—') continue;
        // 一格里可能写了多条，用分号/换行分开
        for (const seg of seasonal.split(/[;；\n]/)) {
            const piece = seg.trim();
            if (!piece || piece === '—') continue;
            const date = inferDateFromVagueText(piece);
            if (!date) continue;
            const text = piece.replace(/^[^：:]*[：:]\s*/, '').trim() || piece;
            out.push({ date, tag: '紫', text: who ? `${who}：${text}` : text, source: 'ego-schedule', done: false, vague: true });
        }
    }
    return out;
}

/**
 * 把"八月底""下周三""8月15日"这类模糊说法推断成具体日期。
 * 以剧情当前日期为基准年月；推不出来就返回 null（宁可不显示，也不要瞎标）。
 */
function inferDateFromVagueText(text) {
    const t = String(text || '');
    const base = lastInfo?.date ? new Date(normalizeDateKey(lastInfo.date) + 'T00:00:00') : new Date();
    if (isNaN(base.getTime())) return null;
    const Y = base.getFullYear();

    // 明确写了月日
    let m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (m) return fmtDate(Y, +m[1] - 1, +m[2]);
    m = t.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
    if (m) return fmtDate(+m[1], +m[2] - 1, +m[3]);

    // X月上旬/中旬/下旬/初/中/底/末
    m = t.match(/(\d{1,2})\s*月\s*(上旬|中旬|下旬|初|中|底|末)/);
    if (m) return fmtDate(Y, +m[1] - 1, dayOfPart(Y, +m[1] - 1, m[2]));

    // 本月/这个月 + 上下旬
    m = t.match(/(本月|这个月|当月)\s*(上旬|中旬|下旬|初|中|底|末)/);
    if (m) return fmtDate(Y, base.getMonth(), dayOfPart(Y, base.getMonth(), m[2]));

    // 单独的"月底/月初/月中"
    if (/月底|月末/.test(t)) return fmtDate(Y, base.getMonth(), daysInMonth(Y, base.getMonth()));
    if (/月初/.test(t)) return fmtDate(Y, base.getMonth(), 1);
    if (/月中/.test(t)) return fmtDate(Y, base.getMonth(), 15);

    // 每周X（固定日程）——取基准日之后最近的那一天
    m = t.match(/每?周([一二三四五六日天])/);
    if (m) {
        const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
        const want = map[m[1]];
        const d = new Date(base);
        for (let i = 0; i < 7; i++) {
            d.setDate(d.getDate() + (i === 0 ? 0 : 1));
            if (d.getDay() === want) return fmtDate(d.getFullYear(), d.getMonth(), d.getDate());
        }
    }
    return null;
}

function daysInMonth(y, mIdx) { return new Date(y, mIdx + 1, 0).getDate(); }
function dayOfPart(y, mIdx, part) {
    if (/上旬|初/.test(part)) return 5;
    if (/中旬|中/.test(part)) return 15;
    return daysInMonth(y, mIdx); // 下旬/底/末
}
function fmtDate(y, mIdx, d) {
    const dt = new Date(y, mIdx, Math.min(d, daysInMonth(y, mIdx)));
    if (isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// ================= 提示词构建 =================

function buildPromptText() {
    const settings = getSettings();
    const now = new Date();
    const fallbackDate = now.toISOString().slice(0, 10);
    const nextChapter = lastChapter ? (lastChapter.num + 1) : 1;

    const lines = [];
    lines.push('【系统指令：章节结构化数据块】');

    if (lastInfo) {
        lines.push(`当前已知剧情状态：日期 ${lastInfo.date}，时间 ${lastInfo.time}，天气 ${lastInfo.weather}${lastLocation ? `，地点 ${lastLocation}` : ''}。请在此基础上结合剧情合理推进，不要无故大幅跳跃或倒退。`);
    } else {
        lines.push(`当前没有已知剧情状态，请根据设定自行确定合理的初始日期（可参考现实日期 ${fallbackDate}）、时间、天气与地点。`);
    }

    lines.push('在你每次回复的【正文完全结束之后】，另起一行，输出下面的数据块。数据块整体用 <scene_data> 标签包裹，内部每一项独占一行，符号必须与示例完全一致（方括号、竖线、冒号），不要加粗、不要放进引号或代码块中：');
    lines.push('');
    lines.push('<scene_data>');

    if (settings.injectWeather) {
        lines.push('[日期: YYYY-MM-DD | 时间: HH:MM | 天气: 天气状况 温度]');
    }
    if (settings.injectLocation) {
        lines.push('[地点: 正文结束时角色所处的具体地点]');
    }
    if (settings.injectOutfit) {
        lines.push('[着装: 角色名=着装描述; 角色名=着装描述]');
    }
    if (settings.injectTodo) {
        lines.push('[待办: YYYY-MM-DD | 颜色 | 待办事项内容]');
    }
    if (settings.injectSummary) {
        lines.push(`[Chapter_${nextChapter}]日期+时间（正文开始时间-正文结束时间）+地点+摘要`);
    }
    if (settings.injectTodo && settings.egoScheduleTrigger && getEgoCurrentEvent()) {
        lines.push('[导火索: YYYY-MM-DD | 一句话说明这件事会怎么开始]');
    }

    lines.push('</scene_data>');
    lines.push('');
    lines.push('各项说明与硬性要求：');

    let n = 1;
    if (settings.injectWeather) {
        lines.push(`${n++}. 【日期/时间/天气】日期为 YYYY-MM-DD，时间为 24 小时制 HH:MM，取"正文结束时"的时刻；天气用简短词语并附温度（如：晴 28°C、小雨 15°C）。每次回复必须且只能有一行。`);
    }
    if (settings.injectLocation) {
        lines.push(`${n++}. 【地点】填写正文结束时角色所在的具体地点，简短名词短语，不要整句描写。`);
    }
    if (settings.injectOutfit) {
        lines.push(`${n++}. 【着装】只记录本章出场的主要人物（含{{char}}与{{user}}，一般不超过 4 人）。格式为「角色名=着装描述」，多个角色之间用分号「;」隔开。着装未变化时也要照常输出当前着装。`);
    }
    if (settings.injectTodo) {
        lines.push(`${n++}. 【待办】仅当本章正文中出现了明确的约定、计划、期限、任务时才输出，可以有多行，没有则完全不输出该行。颜色只能从【红/橙/黄/绿/青/蓝/紫/灰】中选一个，用于表示紧急或分类（如：红=紧急或危险，蓝=普通约定，绿=日常事务）。日期填该事项发生或截止的日期。`);
    }

    if (settings.injectTodo && settings.egoScheduleTrigger) {
        const ev = getEgoCurrentEvent();
        if (ev) {
            lines.push(`${n++}. 【导火索】当前正在进行的剧情事件是「${ev.title || ''}」，它的导火索是：${ev.trigger || '（未写明）'}`);
            lines.push('   请为这个导火索**排一个具体日期**（在当前剧情日期之后的合理近期，一般 1-14 天内），让它有明确的切入点，不要拖太久。');
            lines.push('   已经排过期、且日期仍在未来的，请沿用同一个日期不要改动；导火索已经实际发生过了，就不要再输出这一行。');
            lines.push('   只输出这一个导火索的日期，不要为后续其它事件排期。');
        }
    }

    if (settings.injectSummary) {
        lines.push(`${n++}. 【章节摘要】必须生成，遵守以下硬性法则：`);
        lines.push('   (1) 语言与字数：强制使用【简体中文】，字数限制在 50-100 字以内，一段话完成。');
        lines.push('   (2) 视角与语调：必须采用【绝对冷酷的上帝监控视角】。只能使用"主语+动作+宾语"的陈述句。绝对禁止任何文学修饰、抒情、价值判断或主观评价。');
        lines.push('   (3) 情绪变化提取：若正文中涉及{{char}}或{{user}}的明确情绪转变，必须作为客观事实记录下来，严禁想象原因或过度解释。');
        lines.push('   (4) 关键原话保留：章节中出现事件或态度大幅度转折、权力转移、承诺的关键对话时，必须在摘要中保留角色原话，并以双引号标注。');
        lines.push('   (5) 范围：只对本章正文做总结，不要总结历史章节。');
        lines.push(`   (6) [Chapter_X] 为章节标签，X 为阿拉伯数字，从 1 开始按回复顺序递增，本次应为 Chapter_${nextChapter}。`);
        lines.push('   (7) 格式：[Chapter_X]日期+时间（正文开始时间-正文结束时间）+地点+摘要');
    }

    lines.push(`${n++}. 整个 <scene_data> 数据块是幕后系统记录，角色本身不会"读到"它，正文中不要提及数据块的存在。`);

    return lines.join('\n');
}

function applyInjection() {
    const context = getContext();
    const settings = getSettings();
    const types = context.extension_prompt_types || POSITION_FALLBACK;
    const roles = context.extension_prompt_roles || ROLE_FALLBACK;

    if (!settings.enabled) {
        context.setExtensionPrompt(MODULE_NAME, '', types.IN_CHAT ?? 1, 0, false, roles.SYSTEM ?? 0);
        return;
    }

    const position = types[settings.injectPosition] ?? types.IN_CHAT ?? 1;
    const role = roles[settings.injectRole] ?? roles.SYSTEM ?? 0;
    const depth = Number.isFinite(Number(settings.injectDepth)) ? Number(settings.injectDepth) : 0;

    context.setExtensionPrompt(MODULE_NAME, buildPromptText(), position, depth, false, role);
}

// ================= 解析 =================

function parseOutfitString(str) {
    return String(str || '')
        .split(/[;；]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(pair => {
            const m = pair.match(/^([^=＝:：]+)\s*[=＝:：]\s*(.+)$/);
            if (m) return { name: m[1].trim(), desc: m[2].trim() };
            return { name: '', desc: pair };
        });
}

function normalizeDateKey(dateRaw) {
    const raw = String(dateRaw || '').trim();
    const m = raw.match(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/** 全量扫描当前聊天，刷新所有状态 */
function scanChat() {
    const context = getContext();
    const chat = context.chat || [];

    lastInfo = null;
    lastLocation = '';
    lastOutfits = [];
    lastChapter = null;
    parsedTodos = [];
    parsedTrigger = null;

    const todoSeen = new Set();

    // 从后往前找"最后一条"的时间/地点/着装/章节摘要
    for (let i = chat.length - 1; i >= 0; i--) {
        const mes = chat[i];
        if (!mes || typeof mes.mes !== 'string') continue;
        const text = mes.mes;

        if (!lastInfo) {
            const m = text.match(INFO_REGEX);
            if (m) {
                lastInfo = { date: m[1].trim(), time: m[2].trim(), weather: m[3].trim(), index: i };
            }
        }
        if (!lastLocation) {
            const m = text.match(LOCATION_REGEX);
            if (m) lastLocation = m[1].trim();
        }
        if (!lastOutfits.length) {
            const m = text.match(OUTFIT_REGEX);
            if (m) lastOutfits = parseOutfitString(m[1]);
        }
        if (!lastChapter) {
            // 同一条消息内若有多个章节标记，取最后出现的那个
            CHAPTER_REGEX_G.lastIndex = 0;
            let cm, found = null;
            while ((cm = CHAPTER_REGEX_G.exec(text)) !== null) {
                found = { num: Number(cm[1]), text: cm[2].trim(), index: i };
            }
            if (found) lastChapter = found;
        }
        if (lastInfo && lastLocation && lastOutfits.length && lastChapter) break;
    }

    // 待办需要全量累积（是历史清单，不是状态快照）
    for (let i = 0; i < chat.length; i++) {
        const mes = chat[i];
        if (!mes || typeof mes.mes !== 'string') continue;
        const text = mes.mes;

        TODO_REGEX_G.lastIndex = 0;
        let tm;
        while ((tm = TODO_REGEX_G.exec(text)) !== null) {
            const dateKey = normalizeDateKey(tm[1]);
            const tag = tm[2].trim();
            const content = tm[3].trim();
            if (!dateKey || !content) continue;
            const key = todoKey(dateKey, content);
            if (todoSeen.has(key)) continue;
            todoSeen.add(key);
            parsedTodos.push({ date: dateKey, tag, text: content, source: 'ai', done: false });
        }

        // [导火索: 日期 | 说明] —— 只保留最新一条（后面的覆盖前面的）
        const trm = TRIGGER_REGEX.exec(text);
        if (trm) {
            const d = normalizeDateKey(trm[1]);
            const desc = String(trm[2] || '').trim();
            if (d && desc) parsedTrigger = { date: d, text: desc };
        }
    }
}

function rescanAndUpdate() {
    scanChat();
    // 月历默认定位到剧情当前日期所在月份
    const key = lastInfo ? normalizeDateKey(lastInfo.date) : '';
    if (key) {
        const [y, m] = key.split('-').map(Number);
        if (!calendarCursor) calendarCursor = { year: y, month: m - 1 };
        if (!selectedDay) selectedDay = key;
    }
    if (!calendarCursor) {
        const now = new Date();
        calendarCursor = { year: now.getFullYear(), month: now.getMonth() };
    }
    updatePanelDisplay();
    renderDrawerContent();
    applyInjection();
    if (getSettings().hideMarkers) scheduleHideMarkers();
}

// ================= 显示层：隐藏正文标记 =================

function hideMarkersInDom() {
    if (!getSettings().hideMarkers) return;
    document.querySelectorAll('.mes_text').forEach((el) => {
        if (el.dataset.dtHudCleaned === '1') return;
        let html = el.innerHTML;
        if (!/日期|地点|着装|待办|Chapter|scene_data/i.test(html)) {
            el.dataset.dtHudCleaned = '1';
            return;
        }
        let changed = false;
        for (const re of HIDE_PATTERNS) {
            re.lastIndex = 0;
            const next = html.replace(re, '');
            if (next !== html) { html = next; changed = true; }
        }
        if (changed) {
            // 清掉因删除内容而空掉的段落
            html = html.replace(/<p>\s*<\/p>/g, '').replace(/(<br\s*\/?>\s*){2,}$/i, '');
            el.innerHTML = html;
        }
        el.dataset.dtHudCleaned = '1';
    });
}

let hideTimer = null;
function scheduleHideMarkers() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideMarkersInDom, 60);
}

function resetHideFlags() {
    document.querySelectorAll('.mes_text[data-dt-hud-cleaned]').forEach(el => {
        delete el.dataset.dtHudCleaned;
    });
}

// ================= 悬浮窗数据格式化 =================

const WEATHER_ICONS = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 17h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7.1 8.5 4 4 0 0 0 7 17z"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M7 13h9a3.8 3.8 0 0 0 .4-7.58A5.2 5.2 0 0 0 7.2 4.9 3.8 3.8 0 0 0 7 13z"/><path d="M8 17l-1 2.5M12 17l-1 2.5M16 17l-1 2.5"/></svg>',
    snow: '<svg viewBox="0 0 24 24"><path d="M7 12h9a3.8 3.8 0 0 0 .4-7.58A5.2 5.2 0 0 0 7.2 3.9 3.8 3.8 0 0 0 7 12z"/><path d="M9 16v6M6 18l6 2M12 18l-6 2M15 16v6M13 18l4 2M17 18l-4 2"/></svg>',
    thunder: '<svg viewBox="0 0 24 24"><path d="M7 13h9a3.8 3.8 0 0 0 .4-7.58A5.2 5.2 0 0 0 7.2 4.9 3.8 3.8 0 0 0 7 13z"/><path d="M13 15l-3 5h3l-2 4"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><path d="M4 9h13M4 13h16M6 17h12"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M18 13.5A7 7 0 0 1 9.5 5 7.5 7.5 0 1 0 18 13.5z"/></svg>',
    default: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.4"/></svg>',
};

function pickWeatherIcon(weatherText) {
    const t = String(weatherText || '');
    if (/雷|thunder/i.test(t)) return WEATHER_ICONS.thunder;
    if (/雪|snow/i.test(t)) return WEATHER_ICONS.snow;
    if (/雨|rain|drizzle/i.test(t)) return WEATHER_ICONS.rain;
    if (/雾|霾|haze|fog|mist/i.test(t)) return WEATHER_ICONS.fog;
    if (/夜|月|night/i.test(t)) return WEATHER_ICONS.moon;
    if (/云|阴|overcast|cloud/i.test(t)) return WEATHER_ICONS.cloud;
    if (/晴|clear|sun/i.test(t)) return WEATHER_ICONS.sun;
    return WEATHER_ICONS.default;
}

function splitWeatherAndTemp(weatherRaw) {
    const raw = String(weatherRaw || '').trim();
    const tempMatch = raw.match(/(-?\d{1,3})\s*°?\s*([CcFf])?/);
    const hasDegreeMark = /°/.test(raw) && tempMatch;
    if (hasDegreeMark) {
        const num = tempMatch[1];
        const unit = (tempMatch[2] || 'C').toUpperCase();
        const text = raw.replace(tempMatch[0], '').replace(/[,，\s]+$/, '').trim();
        return { text: text || raw, temp: `${num}°${unit}` };
    }
    return { text: raw, temp: '' };
}

function normalizeDateDisplay(dateRaw) {
    const key = normalizeDateKey(dateRaw);
    return key ? key.replace(/-/g, '.') : String(dateRaw || '').trim();
}

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

function computeWeekday(dateRaw) {
    const key = normalizeDateKey(dateRaw);
    if (!key) return '';
    const [y, m, d] = key.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return Number.isNaN(dateObj.getTime()) ? '' : WEEKDAY_CN[dateObj.getDay()];
}

function splitTimeParts(timeRaw) {
    const raw = String(timeRaw || '').trim();
    const parts = raw.split(/[:：]/);
    if (parts.length >= 2) {
        return {
            hour: parts[0].trim().padStart(2, '0').slice(-2),
            minute: parts[1].trim().padStart(2, '0').slice(0, 2),
        };
    }
    return { hour: '--', minute: '--' };
}

// ================= 悬浮窗 UI =================

function ensurePanelExists() {
    if (document.getElementById('dt_weather_hud_panel')) return;

    const panelHtml = `
        <div id="dt_weather_hud_panel">
            <div class="dt-hud-corner dt-hud-corner-tl"></div>
            <div class="dt-hud-corner dt-hud-corner-br"></div>

            <div class="dt-hud-main" id="dt_weather_hud_main">
                <div class="dt-hud-time-row">
                    <span class="dt-hud-hour dt-hud-empty" id="dt_hud_hour">--</span>
                    <span class="dt-hud-colon">:</span>
                    <span class="dt-hud-minute dt-hud-empty" id="dt_hud_minute">--</span>
                </div>

                <div class="dt-hud-date-row">
                    <span class="dt-hud-empty" id="dt_hud_date">----.--.--</span>
                    <span class="dt-hud-sep">/</span>
                    <span class="dt-hud-empty" id="dt_hud_weekday">----</span>
                </div>

                <div class="dt-hud-weather-row">
                    <span class="dt-hud-weather-icon" id="dt_hud_weather_icon">${WEATHER_ICONS.default}</span>
                    <span class="dt-hud-empty" id="dt_hud_weather_text">暂无数据</span>
                    <span class="dt-hud-temp" id="dt_hud_temp"></span>
                </div>
            </div>

            <div class="dt-hud-drawer" id="dt_hud_drawer">
                <div class="dt-hud-drawer-inner">
                    <div class="dt-hud-tabs">
                        <div class="dt-hud-tab active" data-tab="calendar">日历</div>
                        <div class="dt-hud-tab" data-tab="scene">场景</div>
                        <div class="dt-hud-tab" data-tab="summary">摘要</div>
                    </div>

                    <div class="dt-hud-tab-page active" data-page="calendar">
                        <div class="dt-hud-cal-head">
                            <span class="dt-hud-cal-nav" id="dt_hud_cal_prev">‹</span>
                            <span class="dt-hud-cal-title" id="dt_hud_cal_title">----.--</span>
                            <span class="dt-hud-cal-nav" id="dt_hud_cal_next">›</span>
                        </div>
                        <div class="dt-hud-cal-grid" id="dt_hud_cal_grid"></div>
                        <div class="dt-hud-todo-head">
                            <span id="dt_hud_todo_date">选择日期</span>
                            <span class="dt-hud-todo-add" id="dt_hud_todo_add" title="添加待办">＋</span>
                        </div>
                        <div class="dt-hud-todo-list" id="dt_hud_todo_list"></div>
                    </div>

                    <div class="dt-hud-tab-page" data-page="scene">
                        <div class="dt-hud-ego-block" id="dt_hud_ego_block" style="display:none;">
                            <div class="dt-hud-section-title">
                                当前剧情事件
                                <span class="dt-hud-ego-open" id="dt_hud_ego_open" title="打开 Ego 小助手">Ego ↗</span>
                            </div>
                            <div class="dt-hud-ego-event" id="dt_hud_ego_event"></div>
                            <div class="dt-hud-section-title" id="dt_hud_fore_title" style="display:none;">未回收伏笔</div>
                            <div class="dt-hud-fore-list" id="dt_hud_fore_list"></div>
                        </div>
                        <div class="dt-hud-section-title">当前地点</div>
                        <div class="dt-hud-location" id="dt_hud_location_text">暂无数据</div>
                        <div class="dt-hud-section-title">主要人物着装</div>
                        <div class="dt-hud-outfit-list" id="dt_hud_outfit_list"></div>
                    </div>

                    <div class="dt-hud-tab-page" data-page="summary">
                        <div class="dt-hud-section-title">章节摘要</div>
                        <div class="dt-hud-chapter-list" id="dt_hud_chapter_list"></div>
                    </div>
                </div>
            </div>

            <div class="dt-hud-ego-busy" id="dt_hud_ego_busy" style="display:none;"></div>
            <div class="dt-hud-collapse-btn" id="dt_weather_hud_collapse_btn" title="折叠/展开时间">︿</div>
        </div>
    `;
    $('body').append(panelHtml);

    $('#dt_weather_hud_collapse_btn').on('click', (e) => {
        e.stopPropagation();
        const settings = getSettings();
        settings.panelCollapsed = !settings.panelCollapsed;
        saveSettings();
        applyCollapsedState();
    });

    bindDrawerEvents();
    makePanelDraggable();
    applyPanelPosition();
    applyCollapsedState();
    applyPanelVisibility();
    applyDrawerSide();
}

function applyCollapsedState() {
    const settings = getSettings();
    $('#dt_weather_hud_panel').toggleClass('dt-hud-collapsed', !!settings.panelCollapsed);
}

function applyPanelVisibility() {
    $('#dt_weather_hud_panel').toggle(!!getSettings().panelVisible);
}

function applyDrawerSide() {
    const settings = getSettings();
    $('#dt_weather_hud_panel')
        .toggleClass('dt-hud-drawer-left', settings.drawerSide === 'left')
        .toggleClass('dt-hud-drawer-right', settings.drawerSide === 'right');
}

function applyPanelPosition() {
    const settings = getSettings();
    const $panel = $('#dt_weather_hud_panel');
    if (!$panel.length) return;
    if (typeof settings.panelX === 'number' && typeof settings.panelY === 'number') {
        $panel.css({ left: settings.panelX + 'px', top: settings.panelY + 'px', right: 'auto' });
    }
}

function toggleDrawer(force) {
    drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
    $('#dt_weather_hud_panel').toggleClass('dt-hud-drawer-open', drawerOpen);
    if (drawerOpen) renderDrawerContent();
}

function makePanelDraggable() {
    const panel = document.getElementById('dt_weather_hud_panel');
    const handle = document.getElementById('dt_weather_hud_main');
    if (!panel || !handle) return;

    let dragging = false, moved = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#dt_weather_hud_collapse_btn')) return;
        dragging = true;
        moved = false;
        panel.classList.add('dt-hud-dragging');
        const rect = panel.getBoundingClientRect();
        originLeft = rect.left; originTop = rect.top;
        startX = e.clientX; startY = e.clientY;
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        if (!moved) return;

        let newLeft = originLeft + dx;
        let newTop = originTop + dy;
        newLeft = Math.max(4, Math.min(newLeft, window.innerWidth - panel.offsetWidth - 4));
        newTop = Math.max(4, Math.min(newTop, window.innerHeight - 40));
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
    });

    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dt-hud-dragging');
        if (moved) {
            const settings = getSettings();
            const rect = panel.getBoundingClientRect();
            settings.panelX = Math.round(rect.left);
            settings.panelY = Math.round(rect.top);
            saveSettings();
        } else {
            // 未移动 = 视为点击，切换侧栏
            toggleDrawer();
        }
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}

function updatePanelDisplay() {
    ensurePanelExists();
    const $hour = $('#dt_hud_hour');
    const $minute = $('#dt_hud_minute');
    const $date = $('#dt_hud_date');
    const $weekday = $('#dt_hud_weekday');
    const $icon = $('#dt_hud_weather_icon');
    const $wtext = $('#dt_hud_weather_text');
    const $temp = $('#dt_hud_temp');

    if (lastInfo) {
        const { hour, minute } = splitTimeParts(lastInfo.time);
        const { text, temp } = splitWeatherAndTemp(lastInfo.weather);
        $hour.text(hour).removeClass('dt-hud-empty');
        $minute.text(minute).removeClass('dt-hud-empty');
        $date.text(normalizeDateDisplay(lastInfo.date)).removeClass('dt-hud-empty');
        $weekday.text(computeWeekday(lastInfo.date) || '').removeClass('dt-hud-empty');
        $icon.html(pickWeatherIcon(lastInfo.weather));
        $wtext.text(text).removeClass('dt-hud-empty');
        $temp.text(temp);
    } else {
        $hour.text('--').addClass('dt-hud-empty');
        $minute.text('--').addClass('dt-hud-empty');
        $date.text('----.--.--').addClass('dt-hud-empty');
        $weekday.text('----').addClass('dt-hud-empty');
        $icon.html(WEATHER_ICONS.default);
        $wtext.text('暂无数据').addClass('dt-hud-empty');
        $temp.text('');
    }
}

// ================= 侧栏内容渲染 =================

function renderDrawerContent() {
    if (!document.getElementById('dt_hud_drawer')) return;
    renderCalendar();
    renderTodoList();
    renderScene();
    renderChapters();
    renderEgoBlock();
}

/** 剧情事件 + 未回收伏笔（数据来自 Ego，纯读取） */
function renderEgoBlock() {
    const $block = $('#dt_hud_ego_block');
    if (!$block.length) return;
    if (getSettings().egoIntegration === false || !isEgoInstalled()) { $block.hide(); return; }
    $block.show();

    const ev = getEgoCurrentEvent();
    const $ev = $('#dt_hud_ego_event');
    if (!ev) {
        $ev.html('<div class="dt-hud-todo-empty">暂无进行中的事件</div>');
    } else {
        const dead = getEgoData()?.plot?.deadBranches?.[ev.id] || [];
        const branches = (ev.branches || [])
            .map(b => {
                const off = dead.includes(b.key);
                return `<div class="dt-hud-ego-branch${off ? ' dt-off' : ''}">
                    <b>${escapeHtml(b.key)}</b> ${escapeHtml(b.condition || '')}</div>`;
            }).join('');
        $ev.html(`
            <div class="dt-hud-ego-title">[${escapeHtml(ev.id)}] ${escapeHtml(ev.title || '')}</div>
            ${ev.core ? `<div class="dt-hud-ego-core">${escapeHtml(ev.core)}</div>` : ''}
            ${branches}`);
    }

    const fore = getEgoTable('foreshadowTable').filter(r => !/已回收/.test(String(r.status || '')));
    $('#dt_hud_fore_title').toggle(fore.length > 0);
    $('#dt_hud_fore_list').html(fore.length
        ? fore.map(r => `<div class="dt-hud-fore-item">${escapeHtml(r.content || r.tag || '')}</div>`).join('')
        : '');
}

function renderCalendar() {
    if (!calendarCursor) {
        const now = new Date();
        calendarCursor = { year: now.getFullYear(), month: now.getMonth() };
    }
    const { year, month } = calendarCursor;
    $('#dt_hud_cal_title').text(`${year}.${String(month + 1).padStart(2, '0')}`);

    const todos = getAllTodos();
    const byDate = {};
    for (const t of todos) {
        if (!byDate[t.date]) byDate[t.date] = [];
        byDate[t.date].push(t);
    }

    const storyKey = lastInfo ? normalizeDateKey(lastInfo.date) : '';
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '';
    for (const w of WEEKDAY_SHORT) {
        html += `<div class="dt-hud-cal-cell dt-hud-cal-weekday">${w}</div>`;
    }
    for (let i = 0; i < firstDay; i++) {
        html += '<div class="dt-hud-cal-cell dt-hud-cal-blank"></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayTodos = byDate[key] || [];
        const classes = ['dt-hud-cal-cell', 'dt-hud-cal-day'];
        if (key === storyKey) classes.push('is-story-today');
        if (key === selectedDay) classes.push('is-selected');
        if (dayTodos.length) classes.push('has-todo');

        // 最多显示 3 个颜色圆点
        const dots = dayTodos.slice(0, 3)
            .map(t => `<i style="background:${resolveTagColor(t.tag)}"></i>`)
            .join('');

        html += `<div class="${classes.join(' ')}" data-date="${key}">
            <span class="dt-hud-cal-num">${d}</span>
            <span class="dt-hud-cal-dots">${dots}</span>
        </div>`;
    }
    $('#dt_hud_cal_grid').html(html);
}

function renderTodoList() {
    const $head = $('#dt_hud_todo_date');
    const $list = $('#dt_hud_todo_list');
    if (!selectedDay) {
        $head.text('选择日期');
        $list.html('<div class="dt-hud-todo-empty">点击月历中的日期查看待办</div>');
        return;
    }
    $head.text(selectedDay.replace(/-/g, '.'));

    const items = getAllTodos()
        .filter(t => t.date === selectedDay)
        .sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));

    if (!items.length) {
        $list.html('<div class="dt-hud-todo-empty">当日暂无待办</div>');
        return;
    }

    const html = items.map((t, idx) => `
        <div class="dt-hud-todo-item ${t.done ? 'is-done' : ''}" data-source="${escapeHtml(t.source || 'ai')}" data-key="${escapeHtml(t.date + '||' + t.text)}">
            <span class="dt-hud-todo-dot" style="background:${resolveTagColor(t.tag)}"></span>
            <span class="dt-hud-todo-text"${t.title ? ` title="${escapeHtml(t.title)}"` : ''}>${escapeHtml(t.text)}${t.vague ? '<span class="dt-hud-todo-vague" title="日期由模糊描述推断，仅供参考">?</span>' : ''}</span>
            <span class="dt-hud-todo-src">${
                t.source === 'manual' ? '手动'
                : t.source === 'ego-plot' ? '剧情'
                : t.source === 'ego-todo' ? 'Ego待办'
                : t.source === 'ego-schedule' ? 'Ego日程'
                : t.source === 'ego-trigger' ? '剧情导火索'
                : '剧情'}</span>
            ${t.source === 'manual' ? '<span class="dt-hud-todo-del" title="删除">×</span>' : ''}
        </div>
    `).join('');
    $list.html(html);
}

function openEgoAssistant() {
    // Ego 的入口挂在酒馆"魔法棒"菜单里，直接触发它自己的按钮
    const btn = document.querySelector('#ow_menu_button');
    if (btn) { $(btn).trigger('click'); return true; }
    toastr?.info?.('没找到 Ego 小助手，请确认已安装并启用');
    return false;
}

function renderScene() {
    $('#dt_hud_location_text')
        .text(lastLocation || '暂无数据')
        .toggleClass('dt-hud-empty', !lastLocation);

    const $list = $('#dt_hud_outfit_list');
    if (!lastOutfits.length) {
        $list.html('<div class="dt-hud-todo-empty">暂无数据</div>');
        return;
    }
    $list.html(lastOutfits.map(o => `
        <div class="dt-hud-outfit-item">
            <div class="dt-hud-outfit-name">${escapeHtml(o.name || '—')}</div>
            <div class="dt-hud-outfit-desc">${escapeHtml(o.desc)}</div>
        </div>
    `).join(''));
}

function renderChapters() {
    const $list = $('#dt_hud_chapter_list');
    if (!lastChapter) {
        $list.html('<div class="dt-hud-todo-empty">暂无章节摘要</div>');
        return;
    }
    $list.html(`
        <div class="dt-hud-chapter-item">
            <div class="dt-hud-chapter-num">CHAPTER ${lastChapter.num}</div>
            <div class="dt-hud-chapter-text">${escapeHtml(lastChapter.text)}</div>
        </div>
    `);
}

// ================= 侧栏交互 =================

function bindDrawerEvents() {
    const $drawer = $('#dt_hud_drawer');

    // 阻止侧栏内部点击冒泡触发拖动/关闭
    $drawer.on('pointerdown click', (e) => e.stopPropagation());

    // 标签页切换
    $drawer.on('click', '#dt_hud_ego_open', (e) => { e.stopPropagation(); openEgoAssistant(); });

    $drawer.on('click', '.dt-hud-tab', function () {
        const tab = $(this).data('tab');
        $drawer.find('.dt-hud-tab').removeClass('active');
        $(this).addClass('active');
        $drawer.find('.dt-hud-tab-page').removeClass('active');
        $drawer.find(`.dt-hud-tab-page[data-page="${tab}"]`).addClass('active');
    });

    // 月份翻页
    $drawer.on('click', '#dt_hud_cal_prev', () => {
        calendarCursor.month -= 1;
        if (calendarCursor.month < 0) { calendarCursor.month = 11; calendarCursor.year -= 1; }
        renderCalendar();
    });
    $drawer.on('click', '#dt_hud_cal_next', () => {
        calendarCursor.month += 1;
        if (calendarCursor.month > 11) { calendarCursor.month = 0; calendarCursor.year += 1; }
        renderCalendar();
    });

    // 点击日期
    $drawer.on('click', '.dt-hud-cal-day', function () {
        selectedDay = $(this).data('date');
        renderCalendar();
        renderTodoList();
    });

    // 添加待办
    $drawer.on('click', '#dt_hud_todo_add', async () => {
        if (!selectedDay) {
            toastr.info('请先在月历中选择一个日期', '待办');
            return;
        }
        const text = await promptText('输入待办内容：');
        if (!text) return;
        const tag = await promptTag();
        const todos = getManualTodos();
        todos.push({ date: selectedDay, tag: tag || '蓝', text, done: false });
        saveManualTodos();
        renderCalendar();
        renderTodoList();
    });

    // 勾选完成 / 删除
    $drawer.on('click', '.dt-hud-todo-del', function (e) {
        e.stopPropagation();
        const key = $(this).closest('.dt-hud-todo-item').data('key');
        const [date, text] = String(key).split('||');
        const todos = getManualTodos();
        const idx = todos.findIndex(t => t.date === date && t.text === text);
        if (idx >= 0) {
            todos.splice(idx, 1);
            saveManualTodos();
            renderCalendar();
            renderTodoList();
        }
    });

    $drawer.on('click', '.dt-hud-todo-item', function () {
        const key = $(this).data('key');
        const [date, text] = String(key).split('||');
        const todos = getManualTodos();
        const item = todos.find(t => t.date === date && t.text === text);
        if (item) {
            item.done = !item.done;
            saveManualTodos();
            renderTodoList();
        } else {
            // 剧情解析出的待办：完成状态记录在 metadata 的独立列表里
            const ctx = getContext();
            if (!ctx.chatMetadata[MODULE_NAME]) ctx.chatMetadata[MODULE_NAME] = {};
            const doneSet = ctx.chatMetadata[MODULE_NAME].doneAi || (ctx.chatMetadata[MODULE_NAME].doneAi = []);
            const k = `${date}||${text}`;
            const i = doneSet.indexOf(k);
            if (i >= 0) doneSet.splice(i, 1); else doneSet.push(k);
            saveManualTodos();
            applyAiDoneFlags();
            renderTodoList();
        }
    });
}

function applyAiDoneFlags() {
    const ctx = getContext();
    const doneSet = (ctx.chatMetadata?.[MODULE_NAME]?.doneAi) || [];
    for (const t of parsedTodos) {
        t.done = doneSet.includes(`${t.date}||${t.text}`);
    }
}

/** 简易输入框（优先使用 ST 的弹窗，回退到原生 prompt） */
async function promptText(message) {
    const ctx = getContext();
    if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
        const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, '');
        return result ? String(result).trim() : '';
    }
    const result = window.prompt(message, '');
    return result ? result.trim() : '';
}

async function promptTag() {
    const ctx = getContext();
    const options = TAG_PICKER_ORDER.join(' / ');
    if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
        const result = await ctx.callGenericPopup(`选择颜色标签（${options}）：`, ctx.POPUP_TYPE.INPUT, '蓝');
        return result ? String(result).trim() : '蓝';
    }
    const result = window.prompt(`选择颜色标签（${options}）：`, '蓝');
    return result ? result.trim() : '蓝';
}

// ================= 自定义 CSS =================

function applyCustomCss() {
    const settings = getSettings();
    let styleTag = document.getElementById('dt_weather_hud_custom_style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'dt_weather_hud_custom_style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = (settings.useCustomCss && settings.customCss) ? settings.customCss : '';
}

// ================= 后台设置面板 =================

function buildSettingsHtml() {
    return `
    <div class="dt-hud-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>剧情时间天气悬浮窗</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <label class="checkbox_label" for="dt_hud_ego_integration">
                    <input id="dt_hud_ego_integration" type="checkbox" />
                    <span>读取 Ego 小助手数据（日程 / 待办 / 剧情事件 / 伏笔）</span>
                </label>
                <label class="checkbox_label" for="dt_hud_ego_trigger">
                    <input id="dt_hud_ego_trigger" type="checkbox" />
                    <span>为当前事件的导火索排一个具体日期（落到月历）</span>
                </label>
                <label class="checkbox_label" for="dt_hud_ego_toast">
                    <input id="dt_hud_ego_toast" type="checkbox" />
                    <span>Ego 生成开始 / 结束时弹提示</span>
                </label>
                <div class="dt-hud-hint" style="opacity:.65;font-size:11px;margin:2px 0 8px;">
                    纯读取同一聊天的存档数据，不发任何请求、不消耗 token。未安装 Ego 时自动隐藏相关内容。
                </div>

                <label class="checkbox_label" for="dt_hud_enabled">
                    <input id="dt_hud_enabled" type="checkbox" />
                    <span>启用提示词注入</span>
                </label>
                <label class="checkbox_label" for="dt_hud_panel_visible">
                    <input id="dt_hud_panel_visible" type="checkbox" />
                    <span>显示悬浮窗</span>
                </label>
                <label class="checkbox_label" for="dt_hud_hide_markers">
                    <input id="dt_hud_hide_markers" type="checkbox" />
                    <span>自动隐藏正文中的数据块（仅影响显示，不修改聊天记录）</span>
                </label>

                <hr>
                <h4>注入内容模块</h4>
                <div class="dt-hud-hint">按需勾选，未勾选的模块不会写进提示词，也不会要求模型输出。</div>
                <label class="checkbox_label" for="dt_hud_inject_weather">
                    <input id="dt_hud_inject_weather" type="checkbox" /><span>日期 / 时间 / 天气</span>
                </label>
                <label class="checkbox_label" for="dt_hud_inject_location">
                    <input id="dt_hud_inject_location" type="checkbox" /><span>当前地点</span>
                </label>
                <label class="checkbox_label" for="dt_hud_inject_outfit">
                    <input id="dt_hud_inject_outfit" type="checkbox" /><span>主要人物着装</span>
                </label>
                <label class="checkbox_label" for="dt_hud_inject_todo">
                    <input id="dt_hud_inject_todo" type="checkbox" /><span>待办事项（带颜色标签，显示在月历上）</span>
                </label>
                <label class="checkbox_label" for="dt_hud_inject_summary">
                    <input id="dt_hud_inject_summary" type="checkbox" /><span>章节摘要（上帝监控视角，50-100 字）</span>
                </label>

                <hr>
                <h4>注入位置</h4>
                <label for="dt_hud_position">位置</label>
                <select id="dt_hud_position" class="text_pole">
                    <option value="IN_CHAT">聊天中（按深度插入，类似作者注释）</option>
                    <option value="BEFORE_PROMPT">提示词最前（Before Prompt）</option>
                    <option value="IN_PROMPT">提示词固定位（兼容旧版）</option>
                </select>
                <label for="dt_hud_depth">插入深度（仅"聊天中"模式生效，0 = 最新消息之后）</label>
                <input id="dt_hud_depth" type="number" class="text_pole" min="0" step="1" value="0" />
                <label for="dt_hud_role">注入角色</label>
                <select id="dt_hud_role" class="text_pole">
                    <option value="SYSTEM">系统 (System)</option>
                    <option value="USER">用户 (User)</option>
                    <option value="ASSISTANT">助手 (Assistant)</option>
                </select>

                <hr>
                <h4>外观</h4>
                <label for="dt_hud_drawer_side">侧栏展开方向</label>
                <select id="dt_hud_drawer_side" class="text_pole">
                    <option value="left">向左展开</option>
                    <option value="right">向右展开</option>
                </select>

                <label class="checkbox_label" for="dt_hud_use_custom_css">
                    <input id="dt_hud_use_custom_css" type="checkbox" />
                    <span>启用自定义 CSS</span>
                </label>
                <label for="dt_hud_custom_css">自定义 CSS 内容</label>
                <textarea id="dt_hud_custom_css" class="text_pole" placeholder="#dt_weather_hud_panel { --dt-hud-time-size: 90px; }"></textarea>
                <div class="dt-hud-hint">可覆盖 #dt_weather_hud_panel（容器）/ .dt-hud-time-row .dt-hud-hour .dt-hud-minute .dt-hud-colon（时间）/ .dt-hud-date-row .dt-hud-weather-row（日期天气）/ .dt-hud-drawer（侧栏）/ .dt-hud-cal-grid（月历）/ .dt-hud-corner-tl .dt-hud-corner-br（角框）等选择器。</div>

                <div class="dt-hud-btn-row">
                    <div id="dt_hud_rescan_btn" class="menu_button">重新扫描当前聊天</div>
                    <div id="dt_hud_reset_pos_btn" class="menu_button">重置悬浮窗位置</div>
                    <div id="dt_hud_reset_css_btn" class="menu_button">清空自定义 CSS</div>
                </div>

            </div>
        </div>
    </div>
    `;
}

function bindSettingsEvents() {
    const settings = getSettings();

    const checkboxes = {
        dt_hud_ego_integration: 'egoIntegration',
        dt_hud_ego_trigger: 'egoScheduleTrigger',
        dt_hud_ego_toast: 'egoToast',
        dt_hud_enabled: 'enabled',
        dt_hud_panel_visible: 'panelVisible',
        dt_hud_hide_markers: 'hideMarkers',
        dt_hud_inject_weather: 'injectWeather',
        dt_hud_inject_location: 'injectLocation',
        dt_hud_inject_outfit: 'injectOutfit',
        dt_hud_inject_todo: 'injectTodo',
        dt_hud_inject_summary: 'injectSummary',
        dt_hud_use_custom_css: 'useCustomCss',
    };

    for (const [id, key] of Object.entries(checkboxes)) {
        $(`#${id}`).prop('checked', !!settings[key]);
        $(`#${id}`).on('change', function () {
            settings[key] = $(this).prop('checked');
            saveSettings();
            if (key === 'panelVisible') applyPanelVisibility();
            else if (key === 'useCustomCss') applyCustomCss();
            else if (key === 'hideMarkers') {
                resetHideFlags();
                if (settings.hideMarkers) scheduleHideMarkers();
                else toastr.info('已关闭隐藏，刷新页面或切换聊天后正文会恢复显示', '场景信息');
            } else applyInjection();
        });
    }

    $('#dt_hud_position').val(settings.injectPosition).on('change', function () {
        settings.injectPosition = $(this).val(); saveSettings(); applyInjection();
    });
    $('#dt_hud_depth').val(settings.injectDepth).on('input', function () {
        const v = Number($(this).val());
        settings.injectDepth = Number.isFinite(v) && v >= 0 ? v : 0;
        saveSettings(); applyInjection();
    });
    $('#dt_hud_role').val(settings.injectRole).on('change', function () {
        settings.injectRole = $(this).val(); saveSettings(); applyInjection();
    });
    $('#dt_hud_drawer_side').val(settings.drawerSide).on('change', function () {
        settings.drawerSide = $(this).val(); saveSettings(); applyDrawerSide();
    });
    $('#dt_hud_custom_css').val(settings.customCss).on('input', function () {
        settings.customCss = $(this).val(); saveSettings(); applyCustomCss();
    });

    $('#dt_hud_rescan_btn').on('click', () => {
        resetHideFlags();
        rescanAndUpdate();
        toastr.info('已重新扫描当前聊天记录', '场景信息');
    });
    $('#dt_hud_reset_pos_btn').on('click', () => {
        settings.panelX = null; settings.panelY = null; saveSettings();
        $('#dt_weather_hud_panel').css({ left: 'auto', top: '60px', right: '40px' });
    });
    $('#dt_hud_reset_css_btn').on('click', () => {
        settings.customCss = ''; $('#dt_hud_custom_css').val(''); saveSettings(); applyCustomCss();
    });
}

function injectSettingsPanel() {
    if ($('#dt_weather_hud_settings_root').length) return;
    const html = `<div id="dt_weather_hud_settings_root">${buildSettingsHtml()}</div>`;
    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $target.append(html);
    bindSettingsEvents();
}

// ================= 初始化 =================

function onChatChanged() {
    // 切换聊天：重置侧栏选中状态与日历定位，重新扫描
    calendarCursor = null;
    selectedDay = null;
    resetHideFlags();
    rescanAndUpdate();
    applyAiDoneFlags();
    renderDrawerContent();
}

function registerEventListeners() {
    const { eventSource, event_types } = getContext();

    const onUpdate = () => {
        rescanAndUpdate();
        applyAiDoneFlags();
    };

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onUpdate);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUpdate);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onUpdate);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onUpdate);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onUpdate);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 消息列表滚动加载旧消息时，补做一次隐藏处理
    if (event_types.MORE_MESSAGES_LOADED) {
        eventSource.on(event_types.MORE_MESSAGES_LOADED, scheduleHideMarkers);
    }
}

function init() {
    ensurePanelExists();
    applyCustomCss();
    injectSettingsPanel();
    registerEventListeners();
    bindEgoEvents();
    rescanAndUpdate();
    applyAiDoneFlags();
    renderDrawerContent();
}

jQuery(async () => {
    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.APP_READY, init);
});
