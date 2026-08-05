// ==========================================================
// 剧情时间天气悬浮窗 (SillyTavern Extension)
// ----------------------------------------------------------
// 原理：
// 1. 通过 setExtensionPrompt 注入固定格式指令，要求模型每次回复正文
//    结束后附加一行「[日期: ... | 时间: ... | 天气: ...]」信息。
// 2. 监听消息渲染 / 切换聊天等事件，用正则扫描聊天记录中"最后一条"
//    符合固定格式的消息，提取日期、时间、天气。
// 3. 将提取结果渲染到页面悬浮窗（可拖动、可折叠、可自定义 CSS）。
// ==========================================================

const MODULE_NAME = 'dt_weather_hud';

// ---------- 固定格式定义 ----------
// 示例： [日期: 2025-08-06 | 时间: 21:40 | 天气: 小雨转多云]
const INFO_REGEX = /\[\s*日期\s*[:：]\s*([^|\]]+?)\s*\|\s*时间\s*[:：]\s*([^|\]]+?)\s*\|\s*天气\s*[:：]\s*([^\]]+?)\s*\]/;

// ---------- 默认设置 ----------
const defaultSettings = Object.freeze({
    enabled: true,               // 是否启用提示词注入
    panelVisible: true,          // 悬浮窗是否显示
    panelCollapsed: false,       // 悬浮窗是否折叠
    injectPosition: 'IN_CHAT',   // 注入位置: IN_CHAT / BEFORE_PROMPT / IN_PROMPT
    injectDepth: 0,              // IN_CHAT 模式下的深度
    injectRole: 'SYSTEM',        // 注入角色: SYSTEM / USER / ASSISTANT
    useCustomCss: false,         // 是否启用自定义 CSS
    customCss: '',               // 自定义 CSS 内容
    panelX: null,                // 悬浮窗保存的位置 (px, 相对 right/top 已转换为 left/top)
    panelY: null,
});

// 位置 / 角色 名称与 SillyTavern 常量的映射（做了本地兜底，防止版本差异导致 undefined）
const POSITION_FALLBACK = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const ROLE_FALLBACK = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

let lastInfo = null; // 最近一次扫描到的 {date, time, weather, index}

// ---------- 工具函数 ----------

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // 补全新增字段，兼容旧版本设置
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.prototype.hasOwnProperty.call(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = getContext();
    context.saveSettingsDebounced();
}

// ---------- 提示词注入 ----------

function buildPromptText() {
    const now = new Date();
    const fallbackDate = now.toISOString().slice(0, 10);

    let continuityHint = '';
    if (lastInfo) {
        continuityHint = `当前已知的剧情时间参考为：日期 ${lastInfo.date}，时间 ${lastInfo.time}，天气 ${lastInfo.weather}。请在此基础上，结合剧情实际发展合理推进（可以是几分钟后，也可以是跨天），不要无故大幅跳跃或倒退，除非剧情明确需要。`;
    } else {
        continuityHint = `当前没有已知的剧情时间参考，请你根据剧情设定自行设定一个合理的初始日期（可参考现实日期 ${fallbackDate}）、时间与天气。`;
    }

    return [
        '【系统指令：场景时间与天气标记】',
        continuityHint,
        '在你每次回复的正文完全结束之后，另起一行，严格按照下面的固定格式追加一行场景信息，不要有任何多余文字、不要加粗、不要放进对话或引号中：',
        '[日期: YYYY-MM-DD | 时间: HH:MM | 天气: 天气状况]',
        '要求：',
        '1. 方括号、竖线、冒号等符号必须与示例完全一致，方便程序识别；',
        '2. 日期格式为 YYYY-MM-DD，时间格式为 24 小时制 HH:MM；',
        '3. 天气用简短词语描述（如：晴、多云、小雨、雷阵雨转晴等）；',
        '4. 每次回复都必须包含且只包含一行这样的标记，并且必须放在正文最后；',
        '5. 这一行是幕后场景记录，角色本身不会"读到"它，无需在剧情中提及。',
    ].join('\n');
}

function applyInjection() {
    const context = getContext();
    const settings = getSettings();

    const extensionPromptTypes = context.extension_prompt_types || POSITION_FALLBACK;
    const extensionPromptRoles = context.extension_prompt_roles || ROLE_FALLBACK;

    if (!settings.enabled) {
        // 清空注入内容
        context.setExtensionPrompt(MODULE_NAME, '', extensionPromptTypes.IN_CHAT ?? 1, 0, false, extensionPromptRoles.SYSTEM ?? 0);
        return;
    }

    const position = extensionPromptTypes[settings.injectPosition] ?? extensionPromptTypes.IN_CHAT ?? 1;
    const role = extensionPromptRoles[settings.injectRole] ?? extensionPromptRoles.SYSTEM ?? 0;
    const depth = Number.isFinite(Number(settings.injectDepth)) ? Number(settings.injectDepth) : 0;
    const promptText = buildPromptText();

    context.setExtensionPrompt(MODULE_NAME, promptText, position, depth, false, role);
}

// ---------- 消息扫描 ----------

function extractInfoFromText(text) {
    if (typeof text !== 'string') return null;
    const match = text.match(INFO_REGEX);
    if (!match) return null;
    return {
        date: match[1].trim(),
        time: match[2].trim(),
        weather: match[3].trim(),
    };
}

/**
 * 从当前聊天记录中，从后往前查找最后一条包含固定格式的消息
 */
function scanChatForLastInfo() {
    const context = getContext();
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const mes = chat[i];
        if (!mes || typeof mes.mes !== 'string') continue;
        const info = extractInfoFromText(mes.mes);
        if (info) {
            return { ...info, index: i };
        }
    }
    return null;
}

function rescanAndUpdate() {
    const found = scanChatForLastInfo();
    lastInfo = found; // 允许为 null（表示当前聊天暂无匹配记录）
    updatePanelDisplay();
    // 用最新扫描结果刷新注入的连续性提示
    applyInjection();
}

// ---------- 悬浮窗 UI ----------

// 极简线性天气图标（SVG，不使用 emoji / 位图），24x24 viewBox，纯描边
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

/**
 * 根据天气文字关键词选择合适的线性图标
 */
function pickWeatherIcon(weatherText) {
    const t = String(weatherText || '');
    if (/雷|thunder/i.test(t)) return WEATHER_ICONS.thunder;
    if (/雪|snow/i.test(t)) return WEATHER_ICONS.snow;
    if (/雨|rain|drizzle/i.test(t)) return WEATHER_ICONS.rain;
    if (/雾|霾|haze|fog|mist/i.test(t)) return WEATHER_ICONS.fog;
    if (/夜|月|night|clear night/i.test(t)) return WEATHER_ICONS.moon;
    if (/云|阴|overcast|cloud/i.test(t)) return WEATHER_ICONS.cloud;
    if (/晴|clear|sun/i.test(t)) return WEATHER_ICONS.sun;
    return WEATHER_ICONS.default;
}

/**
 * 从天气描述中拆出温度部分（如 "小雨 15°C" -> {text:"小雨", temp:"15°C"}）
 * 找不到温度则 temp 为空字符串。
 */
function splitWeatherAndTemp(weatherRaw) {
    const raw = String(weatherRaw || '').trim();
    const tempMatch = raw.match(/(-?\d{1,3})\s*°?\s*([CcFf])?/);
    // 只有当匹配到的数字后面确实带 ° 或 C/F 字样时才当作温度处理，避免误伤纯文字天气描述
    const hasDegreeMark = /°|°C|°F/i.test(raw) && tempMatch;
    if (hasDegreeMark) {
        const num = tempMatch[1];
        const unit = (tempMatch[2] || 'C').toUpperCase();
        const text = raw.replace(tempMatch[0], '').replace(/[,，\s]+$/, '').trim();
        return { text: text || raw, temp: `${num}°${unit}` };
    }
    return { text: raw, temp: '' };
}

/**
 * 将各种可能的日期分隔符统一显示为 YYYY.MM.DD
 */
function normalizeDateDisplay(dateRaw) {
    const raw = String(dateRaw || '').trim();
    const m = raw.match(/^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/);
    if (!m) return raw;
    const [, y, mo, d] = m;
    return `${y}.${mo.padStart(2, '0')}.${d.padStart(2, '0')}`;
}

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/**
 * 从日期字符串推算星期几（中文），无法解析时返回空字符串
 */
function computeWeekday(dateRaw) {
    const raw = String(dateRaw || '').trim();
    const m = raw.match(/^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/);
    if (!m) return '';
    const [, y, mo, d] = m;
    const dateObj = new Date(Number(y), Number(mo) - 1, Number(d));
    if (Number.isNaN(dateObj.getTime())) return '';
    return WEEKDAY_CN[dateObj.getDay()];
}

/**
 * 把 "HH:MM" 或 "HH:MM:SS" 拆成 { hour, minute }，解析失败时返回占位符
 */
function splitTimeParts(timeRaw) {
    const raw = String(timeRaw || '').trim();
    const parts = raw.split(':');
    if (parts.length >= 2) {
        const hour = parts[0].padStart(2, '0').slice(-2);
        const minute = parts[1].padStart(2, '0').slice(0, 2);
        return { hour, minute };
    }
    return { hour: '--', minute: '--' };
}

function ensurePanelExists() {
    if (document.getElementById('dt_weather_hud_panel')) return;

    const panelHtml = `
        <div id="dt_weather_hud_panel">
            <div class="dt-hud-corner dt-hud-corner-tl"></div>
            <div class="dt-hud-corner dt-hud-corner-br"></div>

            <div class="dt-hud-time-row" id="dt_weather_hud_drag_handle">
                <span class="dt-hud-hour dt-hud-empty" id="dt_hud_hour">--</span>
                <span class="dt-hud-colon">:</span>
                <span class="dt-hud-minute dt-hud-empty" id="dt_hud_minute">--</span>
            </div>

            <div class="dt-hud-date-row" id="dt_hud_date_row">
                <span class="dt-hud-empty" id="dt_hud_date">----.--.--</span>
                <span class="dt-hud-sep">/</span>
                <span class="dt-hud-empty" id="dt_hud_weekday">----</span>
            </div>

            <div class="dt-hud-weather-row" id="dt_hud_weather_row">
                <span class="dt-hud-weather-icon" id="dt_hud_weather_icon">${WEATHER_ICONS.default}</span>
                <span class="dt-hud-empty" id="dt_hud_weather_text">暂无数据</span>
                <span class="dt-hud-temp" id="dt_hud_temp"></span>
            </div>

            <div class="dt-hud-collapse-btn" id="dt_weather_hud_collapse_btn" title="折叠/展开">︿</div>
        </div>
    `;
    $('body').append(panelHtml);

    // 折叠/展开
    $('#dt_weather_hud_collapse_btn').on('click', (e) => {
        e.stopPropagation();
        const settings = getSettings();
        settings.panelCollapsed = !settings.panelCollapsed;
        saveSettings();
        applyCollapsedState();
    });

    makePanelDraggable();
    applyPanelPosition();
    applyCollapsedState();
    applyPanelVisibility();
}

function applyCollapsedState() {
    const settings = getSettings();
    const $panel = $('#dt_weather_hud_panel');
    const $btn = $('#dt_weather_hud_collapse_btn');
    $panel.toggleClass('dt-hud-collapsed', !!settings.panelCollapsed);
    $btn.toggleClass('collapsed', !!settings.panelCollapsed);
}

function applyPanelVisibility() {
    const settings = getSettings();
    $('#dt_weather_hud_panel').toggle(!!settings.panelVisible);
}

function applyPanelPosition() {
    const settings = getSettings();
    const $panel = $('#dt_weather_hud_panel');
    if (!$panel.length) return;
    if (typeof settings.panelX === 'number' && typeof settings.panelY === 'number') {
        $panel.css({
            left: settings.panelX + 'px',
            top: settings.panelY + 'px',
            right: 'auto',
        });
    }
}

function makePanelDraggable() {
    const panel = document.getElementById('dt_weather_hud_panel');
    // 整个面板都可拖动（折叠按钮除外），提供更接近桌面小组件的交互
    const handle = panel;
    if (!panel || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#dt_weather_hud_collapse_btn')) return;
        dragging = true;
        panel.classList.add('dt-hud-dragging');
        const rect = panel.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newLeft = originLeft + dx;
        let newTop = originTop + dy;

        // 限制在视口内
        const maxLeft = window.innerWidth - panel.offsetWidth - 4;
        const maxTop = window.innerHeight - 30;
        newLeft = Math.max(4, Math.min(newLeft, maxLeft));
        newTop = Math.max(4, Math.min(newTop, maxTop));

        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dt-hud-dragging');
        const settings = getSettings();
        const rect = panel.getBoundingClientRect();
        settings.panelX = Math.round(rect.left);
        settings.panelY = Math.round(rect.top);
        saveSettings();
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
    const $weatherIcon = $('#dt_hud_weather_icon');
    const $weatherText = $('#dt_hud_weather_text');
    const $temp = $('#dt_hud_temp');

    if (lastInfo) {
        const { hour, minute } = splitTimeParts(lastInfo.time);
        const dateDisplay = normalizeDateDisplay(lastInfo.date);
        const weekday = computeWeekday(lastInfo.date);
        const { text: weatherText, temp } = splitWeatherAndTemp(lastInfo.weather);

        $hour.text(hour).removeClass('dt-hud-empty');
        $minute.text(minute).removeClass('dt-hud-empty');
        $date.text(dateDisplay).removeClass('dt-hud-empty');
        $weekday.text(weekday || '').removeClass('dt-hud-empty');
        $weatherIcon.html(pickWeatherIcon(lastInfo.weather));
        $weatherText.text(weatherText).removeClass('dt-hud-empty');
        $temp.text(temp);
    } else {
        $hour.text('--').addClass('dt-hud-empty');
        $minute.text('--').addClass('dt-hud-empty');
        $date.text('----.--.--').addClass('dt-hud-empty');
        $weekday.text('----').addClass('dt-hud-empty');
        $weatherIcon.html(WEATHER_ICONS.default);
        $weatherText.text('暂无数据').addClass('dt-hud-empty');
        $temp.text('');
    }
}

// ---------- 自定义 CSS ----------

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

// ---------- 设置面板 (显示在扩展面板 / 下方扩展按钮 抽屉中) ----------

function buildSettingsHtml() {
    return `
    <div class="dt-hud-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🕰️ 剧情时间天气悬浮窗</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <label class="checkbox_label" for="dt_hud_enabled">
                    <input id="dt_hud_enabled" type="checkbox" />
                    <span>启用提示词注入（生成回复时要求附加日期/时间/天气标记）</span>
                </label>

                <label class="checkbox_label" for="dt_hud_panel_visible">
                    <input id="dt_hud_panel_visible" type="checkbox" />
                    <span>显示悬浮窗</span>
                </label>

                <hr>
                <h4>注入设置</h4>
                <div class="dt-hud-hint">选择提示词注入到上下文中的位置和角色，深度仅在"聊天中(按深度)"模式下生效。</div>

                <label for="dt_hud_position">注入位置</label>
                <select id="dt_hud_position" class="text_pole">
                    <option value="IN_CHAT">聊天中（按深度插入，类似作者注释）</option>
                    <option value="BEFORE_PROMPT">提示词最前（Before Prompt）</option>
                    <option value="IN_PROMPT">提示词固定位（兼容旧版位置）</option>
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
                <h4>悬浮窗外观</h4>

                <label class="checkbox_label" for="dt_hud_use_custom_css">
                    <input id="dt_hud_use_custom_css" type="checkbox" />
                    <span>启用自定义 CSS（不勾选则使用默认透明现代风格）</span>
                </label>

                <label for="dt_hud_custom_css">自定义 CSS 内容</label>
                <textarea id="dt_hud_custom_css" class="text_pole" placeholder="#dt_weather_hud_panel { background: rgba(0,0,0,0.5); }"></textarea>
                <div class="dt-hud-hint">可覆盖 #dt_weather_hud_panel（容器）/ .dt-hud-time-row .dt-hud-hour .dt-hud-minute .dt-hud-colon（时间）/ .dt-hud-date-row .dt-hud-weather-row（日期天气）/ .dt-hud-corner-tl .dt-hud-corner-br（角框）等选择器。</div>

                <div class="dt-hud-btn-row">
                    <div id="dt_hud_rescan_btn" class="menu_button">🔍 重新扫描当前聊天</div>
                    <div id="dt_hud_reset_pos_btn" class="menu_button">📍 重置悬浮窗位置</div>
                    <div id="dt_hud_reset_css_btn" class="menu_button">♻️ 清空自定义 CSS</div>
                </div>

            </div>
        </div>
    </div>
    `;
}

function bindSettingsEvents() {
    const settings = getSettings();

    // 初始化控件值
    $('#dt_hud_enabled').prop('checked', settings.enabled);
    $('#dt_hud_panel_visible').prop('checked', settings.panelVisible);
    $('#dt_hud_position').val(settings.injectPosition);
    $('#dt_hud_depth').val(settings.injectDepth);
    $('#dt_hud_role').val(settings.injectRole);
    $('#dt_hud_use_custom_css').prop('checked', settings.useCustomCss);
    $('#dt_hud_custom_css').val(settings.customCss);

    $('#dt_hud_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettings();
        applyInjection();
    });

    $('#dt_hud_panel_visible').on('change', function () {
        settings.panelVisible = $(this).prop('checked');
        saveSettings();
        applyPanelVisibility();
    });

    $('#dt_hud_position').on('change', function () {
        settings.injectPosition = $(this).val();
        saveSettings();
        applyInjection();
    });

    $('#dt_hud_depth').on('input', function () {
        const val = Number($(this).val());
        settings.injectDepth = Number.isFinite(val) && val >= 0 ? val : 0;
        saveSettings();
        applyInjection();
    });

    $('#dt_hud_role').on('change', function () {
        settings.injectRole = $(this).val();
        saveSettings();
        applyInjection();
    });

    $('#dt_hud_use_custom_css').on('change', function () {
        settings.useCustomCss = $(this).prop('checked');
        saveSettings();
        applyCustomCss();
    });

    $('#dt_hud_custom_css').on('input', function () {
        settings.customCss = $(this).val();
        saveSettings();
        applyCustomCss();
    });

    $('#dt_hud_rescan_btn').on('click', function () {
        rescanAndUpdate();
        toastr.info('已重新扫描当前聊天记录', '场景信息悬浮窗');
    });

    $('#dt_hud_reset_pos_btn').on('click', function () {
        settings.panelX = null;
        settings.panelY = null;
        saveSettings();
        const $panel = $('#dt_weather_hud_panel');
        $panel.css({ left: 'auto', top: '60px', right: '40px' });
    });

    $('#dt_hud_reset_css_btn').on('click', function () {
        settings.customCss = '';
        $('#dt_hud_custom_css').val('');
        saveSettings();
        applyCustomCss();
    });
}

function injectSettingsPanel() {
    // 后台设置入口显示在扩展面板（下方扩展程序按钮弹出的抽屉）中
    if ($('#dt_weather_hud_settings_root').length) return;
    const html = `<div id="dt_weather_hud_settings_root">${buildSettingsHtml()}</div>`;
    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $target.append(html);
    bindSettingsEvents();
}

// ---------- 初始化 ----------

function registerEventListeners() {
    const context = getContext();
    const { eventSource, event_types } = context;

    // 新消息渲染完成后扫描
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, rescanAndUpdate);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, rescanAndUpdate);

    // 消息被编辑/删除/重新生成时也需要重新扫描
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, rescanAndUpdate);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, rescanAndUpdate);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, rescanAndUpdate);

    // 切换到新聊天时，重新扫描该聊天中最后一条符合格式的消息
    eventSource.on(event_types.CHAT_CHANGED, rescanAndUpdate);
}

function init() {
    ensurePanelExists();
    applyCustomCss();
    injectSettingsPanel();
    registerEventListeners();
    applyInjection();
    rescanAndUpdate();
}

jQuery(async () => {
    const context = getContext();
    const { eventSource, event_types } = context;

    // APP_READY 若已经触发过，监听器仍会自动补触发一次
    eventSource.on(event_types.APP_READY, init);
});
