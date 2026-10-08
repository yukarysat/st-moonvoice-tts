// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
//
// ============================================================================
//  聊天气泡的显示过滤：由插件托管一条「仅格式显示」的酒馆正则
// ============================================================================
//
// 目标：让 GAL 格式那串 [角色|性别][情感描述][场景] 在聊天里只看到台词，
// 而**聊天记录文件本身不变**（插件的 GAL/RP 解析读的是底层 chat[i].mes，所以配音不受影响）。
//
// 注意作用范围：默认正则删的是**方括号标签整体**（角色/情感/场景三段都算），
// 不只是场景那一段 —— 所以设置项叫「隐藏方括号标签」，放在「聊天显示」模块里，
// 而不是塞进「场景音效」。想只删场景那一段，用 PATTERN_PRESETS 里的第二个模式。
//
// 为什么托管一条酒馆正则，而不是自己改 DOM：
//   酒馆的正则扩展本来就是这个用途，它有一条已经测好的显示管线（markdownOnly 只作用于
//   显示层、不写回聊天记录）。插件自己插 DOM 会在消息重渲染、编辑、swipe 时反复失效，
//   而且会跟酒馆的渲染抢方向盘。托管还有个好处：用户能在酒馆的正则面板里看见这条规则、
//   也能自己改。
//
// 契约（读自酒馆 public/scripts/extensions/regex/engine.js，2026-10 版本）：
//   · 脚本存在 extension_settings.regex（数组），**全局脚本总是生效**
//   · 要命中显示层：markdownOnly 必须为 true，且 placement.includes(传入的 placement)
//     显示管线传的是 1（USER_INPUT）/ 2（AI_OUTPUT），所以这里放 [1, 2]
//   · 只要 markdownOnly 为 true、promptOnly 为 false，就**不会**影响发给模型的提示词
//   · findRegex 存的是 "/模式/标志" 形式（与酒馆正则编辑器一致）
//   · regex_placement.MD_DISPLAY 已被酒馆标为 deprecated，别用
//
// 本文件是纯逻辑（不碰 DOM / ctx），所以能在 Node 里单测。

/** 托管脚本的固定 id：增删改都只认它，绝不碰用户自己的正则。 */
export const BRACKET_TAG_HIDE_ID = 'moonvoice-hide-bracket-tags';
export const BRACKET_TAG_HIDE_NAME = '月声 · 隐藏方括号标签';

/**
 * 早期版本的 id（那时这个设置叫「隐藏场景标签」）。留着是为了**清理**：
 * 启用或关闭时顺手把旧 id 那条也带走，免得用户的正则列表里留下一条没人管的规则。
 */
export const LEGACY_SCRIPT_IDS = ['moonvoice-hide-scene-tags'];

/** 默认把方括号标签整段删掉（[角色|性别][情感][场景] 三段都删）。 */
export const DEFAULT_PATTERN = '\\[[^\\]\\n]*\\]';
export const DEFAULT_FLAGS = 'g';

/** 显示管线实际会传的 placement：1=USER_INPUT，2=AI_OUTPUT。 */
export const DISPLAY_PLACEMENTS = [1, 2];

/** 酒馆正则脚本的完整字段集（与它自己编辑器产出的对象一致；测试会核对）。 */
export const SCRIPT_KEYS = [
    'id', 'scriptName', 'disabled', 'runOnEdit', 'findRegex', 'trimStrings', 'replaceString',
    'placement', 'substituteRegex', 'minDepth', 'maxDepth', 'markdownOnly', 'promptOnly',
];

/**
 * 规范化用户输入的正则。接受两种写法：
 *   "/\\[[^\\]]*\\]/gi"  —— 带斜杠与标志（酒馆正则编辑器里的写法）
 *   "\\[[^\\]]*\\]"       —— 只有模式，标志取默认值
 * @returns {{pattern: string, flags: string}}
 */
export function normalizeRegexInput(input, defaultFlags = DEFAULT_FLAGS) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) return { pattern: '', flags: defaultFlags };
    if (raw.startsWith('/')) {
        // 找最后一个未转义的 / 作为结束符
        let end = -1;
        for (let i = raw.length - 1; i > 0; i--) {
            if (raw[i] === '/' && raw[i - 1] !== '\\') { end = i; break; }
        }
        if (end > 0) {
            const flags = raw.slice(end + 1).replace(/[^gimsuy]/g, '');
            return { pattern: raw.slice(1, end), flags: flags || defaultFlags };
        }
    }
    return { pattern: raw, flags: defaultFlags };
}

/**
 * 校验模式能不能编译。返回错误信息或 null。
 */
export function validatePattern(pattern, flags) {
    if (!pattern) return '正则为空';
    try {
        new RegExp(pattern, flags);
        return null;
    } catch (e) {
        return String(e && e.message ? e.message : e);
    }
}

/**
 * 构造要写进 extension_settings.regex 的那条脚本。
 * 模式为空或编译不过时返回 null（调用方据此不安装，并把错误提示给用户）。
 *
 * @param {{enabled?: boolean, pattern?: string, flags?: string}} config
 */
export function buildSceneHideScript(config = {}) {
    const { pattern, flags } = normalizeRegexInput(
        config.pattern === undefined ? DEFAULT_PATTERN : config.pattern, DEFAULT_FLAGS);
    if (validatePattern(pattern, flags)) return null;
    return {
        id: BRACKET_TAG_HIDE_ID,
        scriptName: BRACKET_TAG_HIDE_NAME,
        disabled: config.enabled === false,
        // 编辑消息时**不**过滤：让人看到、也能改到原始的 [标签] 文本。
        // （酒馆正则编辑器的 "Run on Edit" 默认也是不勾。）
        runOnEdit: false,
        findRegex: `/${pattern}/${flags}`,
        trimStrings: [],
        replaceString: '',
        placement: [...DISPLAY_PLACEMENTS],
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        markdownOnly: true,     // ← 关键：只作用于显示层，聊天记录与提示词都不变
        promptOnly: false,
    };
}

/** 用托管脚本替换列表里同 id 的那条（原地替换，保持位置）；没有就追加。
 *  顺手丢掉旧 id 的历史条目，避免正则列表里留下没人管的规则。返回新数组。 */
export function upsertScript(list, script) {
    const out = (Array.isArray(list) ? list : [])
        .filter(s => !(s && LEGACY_SCRIPT_IDS.includes(s.id)));
    const idx = out.findIndex(s => s && s.id === BRACKET_TAG_HIDE_ID);
    if (idx >= 0) out[idx] = script;
    else out.push(script);
    return out;
}

/** 删掉托管脚本（含旧 id 的历史条目）；**其它条目原样保留**。返回新数组。 */
export function removeScript(list) {
    const out = Array.isArray(list) ? list.slice() : [];
    const kill = [BRACKET_TAG_HIDE_ID, ...LEGACY_SCRIPT_IDS];
    return out.filter(s => !(s && kill.includes(s.id)));
}

/** 列表里有没有托管脚本（只看当前 id；供面板显示状态）。 */
export function findScript(list) {
    return (Array.isArray(list) ? list : []).find(s => s && s.id === BRACKET_TAG_HIDE_ID) || null;
}

/**
 * 取「隐藏方括号标签」的配置，兼容早期键名 sceneTagHiding。
 *
 * 早期这个设置叫「隐藏场景标签」，键名是 sceneTagHiding —— 名字不准确（它删的是整个
 * 标签格式），所以改成 chatTagHiding。已经试过的用户不该因为改键名而丢设置。
 *
 * defaultEnabled 要与插件 defaultSettings 里的默认值一致（现在是**默认开启**：
 * GAL 那串标签读起来很吵，多数人只想看台词）。只有键缺失或值不是布尔时才用这个默认值。
 * @returns {{enabled: boolean, pattern: string}}
 */
export function pickTagHidingConfig(settings, defaultEnabled = true) {
    const cur = settings && settings.chatTagHiding;
    const old = settings && settings.sceneTagHiding;
    const src = (cur && typeof cur === 'object') ? cur : ((old && typeof old === 'object') ? old : {});
    return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : defaultEnabled,
        pattern: typeof src.pattern === 'string' && src.pattern ? src.pattern : DEFAULT_PATTERN,
    };
}

/** 面板上给用户抄的两个现成模式。 */
export const PATTERN_PRESETS = [
    { label: '隐藏全部方括号标签', pattern: DEFAULT_PATTERN,
      note: '默认；[角色|性别][情感][场景] 三段都藏掉，只留台词' },
    { label: '只隐藏场景标签', pattern: '\\[[^\\]\\n]*\\](?=\\s*[「"“『])',
      note: '只藏引号前那一段，角色与情感标签保留' },
];

/**
 * 算出「格式规范」应该插在请求里的哪个位置。
 *
 * depth 的语义是"从末尾往前数第几条"（depth=4 = 插在倒数第 4 条之前），与酒馆自己的扩展
 * 提示词一致。
 *
 * 短对话有个坑（实测踩到）：对话比 depth 还短时，早期实现把 index 夹成 0 —— 那等于把规范丢到
 * **角色卡之前**、离生成点最远。后果：新开的对话里既没有历史中的格式实例可模仿、规范又排在最
 * 前面，模型就干脆不写标签了（GAL 模式于是没台词可读、没有语音）。老对话看不出问题，是因为
 * 历史里的标签实例把格式撑住了。
 *
 * 现在的夹取规则：
 *   · 不越过第 1 条（角色卡等），最多夹到 index 1；
 *   · 短对话时紧贴末尾 —— 等价于 depth=1（插在最后一条之前，最后一条仍是用户消息，兼容那些
 *     要求"最后一条必须是 user"的后端）；
 *   · depth=0 仍按用户意愿插到最末尾。
 *
 * @param {number} length 请求里的消息条数（插入之前）
 * @param {number} depth  用户设置的注入深度
 * @returns {number} 插入位置
 */
export function planSpecInsertIndex(length, depth) {
    const len = Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0;
    const d = Number.isFinite(Number(depth)) ? Math.max(0, Math.trunc(Number(depth))) : 0;
    const minIndex = len > 1 ? 1 : 0;
    let index = len - d;
    if (index < minIndex) index = Math.max(minIndex, len - 1);
    if (index > len) index = len;
    return index;
}

// ============================================================================
//  发声事件（Vocal Events）—— 实验性
// ============================================================================
//
// Breeze TTS 2 支持在**正文里**内联写发声事件（[笑]、[叹气]…），模型会把它"演"出来而不是念出来。
// 但官方只给了 4 个示例，实际可用范围不明：作者实测发现不止这 4 个，可也不是随便写都行。
// 所以这个功能做成**实验性**的：默认关闭，允许用的清单由用户自己维护（实测有效再加），
// 提示词里只把这份清单给模型 —— 模型就不会自创无效的事件。
//
// 一个硬约束：事件必须写在**引号内**（台词正文里）。写在引号外会变成第 4 个方括号，
// 破坏 `[角色][情感][场景]“内容”` 的解析。

/** 官方文档给出的示例（默认白名单）。 */
export const DEFAULT_VOCAL_EVENTS = ['笑', '咳嗽', '清嗓子', '叹气'];

/**
 * 规范化用户维护的发声事件清单。
 * 接受逗号 / 顿号 / 空格 / 换行分隔；去掉方括号与首尾空白；去重；限制条数。
 * @returns {string[]}
 */
export function normalizeVocalEvents(input, max = 40) {
    let raw = [];
    if (Array.isArray(input)) raw = input.map(String);
    else if (typeof input === 'string') raw = input.split(/[,，、;；\s\n]+/);
    const out = [];
    for (let s of raw) {
        s = String(s).replace(/[[\]]/g, '').trim();
        if (!s || out.includes(s)) continue;
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * 生成要注入的发声事件说明段。
 *
 * 注意这里**不是白名单**：作者实测后决定让模型自由写 —— 事件本身就不稳定（同一句有时发声、
 * 有时不发声），所以"限定清单"并不能保证它一定响，反而牺牲表达力；而无效/不适配的事件会被
 * 静默跳过（实测：`[心情复杂]` 这类只会让时长多 0.16s，不破坏音频）。
 *
 * 真正有用的是**使用时机与位置**的指引（都来自实测）：
 *   · 放在句子中间最稳；放句首/句尾有时会被吞掉
 *   · 只在情绪与语境相符时才用 —— 不适配时效果会打折甚至完全不发声
 *   · 一句话最多一个
 *
 * events 只是"常见例子"，可以留空（留空时不给例子、但指引照旧）。
 */
export function buildVocalEventLine(events) {
    const list = normalizeVocalEvents(events);
    const lines = [
        '#### 发声事件',
        '可以在**台词正文（引号内）**写发声事件，模型会把它"演"出来，而不是念出这两个字。',
        '- **只在情绪与语境相符时才用**：和当下的语气对不上时，效果会打折、甚至完全不发声；不确定就别用',
        '- **尽量放在句子中间**：放在句首或句尾有时会被吞掉',
        '- 一句话最多一个事件',
        '参考写法：`“我真的……[哭]不想再失去一次了。”`',
    ];
    if (list.length) {
        lines.push(`一些常见的（只是参考，不限于此）：${list.join('、')}`);
    }
    return lines.join('\n');
}

// ============================================================================
//  喂给模型的那一份：把历史里的标签去掉（只留最近几条当示范）
// ============================================================================
//
// 为什么需要：酒馆发给模型的就是聊天记录原文，标签是正文的一部分。于是模型每轮都能看到
// 自己上一轮写的 [角色|性别][情感描述][场景] —— 而"上一条具体例子"比系统提示里的抽象要求
// 更有影响力，情感描述就会照着上一轮抄、越写越固定（自我锚定）。
//
// 别的插件是这么治的：把历史里的标签去掉，只靠提示词约束格式；万一格式漂了，就留最近一条
// 带标签的消息当活样板纠回来。这里照同一路子做，但有两点要注意：
//
//   1) **只动请求用的那一份**。插件在 CHAT_COMPLETION_PROMPT_READY 里拿到的 chat 是给这次
//      请求用的数组（现有的规范注入也在这个钩子里往它里面插消息）。聊天记录文件、显示、
//      以及插件自己读场景名做音效，读的都是底层原文，都不受影响。
//   0) **keep 建议至少留 1**。填 0 时历史里没有任何格式实例；如果模型依赖上下文里的实例
//      （很常见），就可能干脆不写标签，GAL 模式于是没台词可读。这条只是谨慎建议 —— 早先我们
//      曾把一次"新对话不写标签"归因于 keep=0，后来查明那次是注入失效导致的，所以这里不做
//      "实测结论"的断言。
//   2) **保留的那条不只是格式样板，它还带着"当前场景"**。全抹掉的话模型可能每句微调场景名
//      （雨声 / 雨声_室内 之间来回），那会让环境音反复重启、事件轨反复触发。留最近一条正好
//      把这个信息也留下了。
//
// 本文件仍是纯逻辑（不碰 DOM / ctx），所以能在 Node 里单测。

/**
 * 行首的标签前缀：1~4 组方括号，**且后面紧跟引号**才认。
 * 保守是故意的 —— 台词/正文里出现的方括号（比如「[笑声]」）不会被误伤。
 */
const TAG_PREFIX_RE = /^[ \t]*(?:\[[^\]\n]*\]){1,4}[ \t]*(?=[「“『"])/gm;

/** 这一行是不是以 [标签]“……” 开头的格式行。 */
export function hasFormatTags(text) {
    return typeof text === 'string'
        && /^[ \t]*(?:\[[^\]\n]*\]){1,4}[ \t]*(?=[「“『"])/m.test(text);
}

/** 去掉**行首**的标签，保留台词本体。正文里的方括号不动。 */
export function stripFormatTags(text) {
    return typeof text === 'string' ? text.replace(TAG_PREFIX_RE, '') : text;
}

/**
 * 算出「这次请求要发给模型的 chat」应该长什么样。
 *
 * @param {Array} messages  酒馆给的那份 {role, content}[]
 * @param {{enabled?: boolean, keep?: number}} config
 *        enabled=false 时原样返回；keep = 保留最近几条**带标签的助手消息**当示范（0 = 全去）
 * @returns {Array} 新数组（不改原数组；没变化的元素按原引用返回）
 */
/**
 * 原地版：把 planPromptTagStrip 的结果**逐个写回原数组**，保持数组对象不变。
 *
 * 为什么必须原地改（血泪教训）：酒馆有两条构建提示词的路径，行为不同 ——
 *   · script.js：emit 之后 `prompt = eventData.chat`，**会**读回我们赋的新数组；
 *   · openai.js：`const chat = chatCompletion.getChat(); const eventData = { chat }; emit(...);
 *     return [chat, ...]` —— **从不**读回，用的始终是最初那个数组对象。
 * 所以只要写成 `eventData.chat = planPromptTagStrip(...)`，在 openai 这条路径（绝大多数
 * 聊天补全用户）上，后续往 eventData.chat 里 splice 的"规范注入"就落在了被丢弃的数组上 ——
 * 规范根本没进请求，表现是"新对话里模型不写标签、GAL 模式没台词、没有语音"。
 *
 * @param {Array} messages 酒馆给的请求数组（会被就地修改）
 * @param {{enabled?: boolean, keep?: number}} config
 * @returns {number} 有多少条消息的标签被去掉
 */
export function applyPromptTagStripInPlace(messages, config = {}) {
    if (!Array.isArray(messages)) return 0;
    const planned = planPromptTagStrip(messages, config);
    if (planned.length !== messages.length) return 0;   // 长度异常时宁可不改
    let changed = 0;
    for (let i = 0; i < planned.length; i++) {
        if (planned[i] !== messages[i]) {
            messages[i] = planned[i];
            changed++;
        }
    }
    return changed;
}

export function planPromptTagStrip(messages, config = {}) {
    const out = Array.isArray(messages) ? messages.slice() : [];
    if (config.enabled === false) return out;
    const rawKeep = Number(config.keep);
    const keep = Number.isFinite(rawKeep) ? Math.max(0, Math.min(5, Math.trunc(rawKeep))) : 1;

    // 从尾部往前挑：最近 keep 条带标签的助手消息原样留着
    const demo = new Set();
    for (let i = out.length - 1; i >= 0 && demo.size < keep; i--) {
        const m = out[i];
        if (m && m.role === 'assistant' && hasFormatTags(m.content)) demo.add(i);
    }

    return out.map((m, i) => {
        // 只处理助手消息：标签只由模型产出，用户自己打的方括号不该被碰
        if (!m || m.role !== 'assistant' || typeof m.content !== 'string' || demo.has(i)) return m;
        const stripped = stripFormatTags(m.content);
        return stripped === m.content ? m : { ...m, content: stripped };
    });
}
