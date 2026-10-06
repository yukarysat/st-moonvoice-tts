// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
//
// ============================================================================
//  聊天气泡的显示过滤：由插件托管一条「仅格式显示」的酒馆正则
// ============================================================================
//
// 目标：让 GAL 模式那种 [角色|性别][情感][场景]“台词” 在聊天里只看到台词，
// 而**聊天记录文件本身不变**（插件的 GAL/RP 解析读的是底层 chat[i].mes，所以配音不受影响）。
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
export const SCENE_TAG_HIDE_ID = 'moonvoice-hide-scene-tags';
export const SCENE_TAG_HIDE_NAME = '月声 · 隐藏场景标签';

/** 默认把方括号标签整段删掉（[角色|性别][情感][场景] 三个都删）。 */
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
        id: SCENE_TAG_HIDE_ID,
        scriptName: SCENE_TAG_HIDE_NAME,
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

/** 用托管脚本替换列表里同 id 的那条（原地替换，保持位置）；没有就追加。返回新数组。 */
export function upsertScript(list, script) {
    const out = Array.isArray(list) ? list.slice() : [];
    const idx = out.findIndex(s => s && s.id === SCENE_TAG_HIDE_ID);
    if (idx >= 0) out[idx] = script;
    else out.push(script);
    return out;
}

/** 删掉托管脚本；**其它条目原样保留**。返回新数组。 */
export function removeScript(list) {
    const out = Array.isArray(list) ? list.slice() : [];
    const idx = out.findIndex(s => s && s.id === SCENE_TAG_HIDE_ID);
    if (idx >= 0) out.splice(idx, 1);
    return out;
}

/** 列表里有没有托管脚本（供面板显示状态）。 */
export function findScript(list) {
    return (Array.isArray(list) ? list : []).find(s => s && s.id === SCENE_TAG_HIDE_ID) || null;
}

/** 面板上给用户抄的两个现成模式。 */
export const PATTERN_PRESETS = [
    { label: '隐藏全部方括号标签', pattern: DEFAULT_PATTERN,
      note: '[角色|性别][情感][场景] 三段都藏掉，只留台词' },
    { label: '只隐藏场景标签', pattern: '\\[[^\\]\\n]*\\](?=\\s*[「"“『])',
      note: '只藏引号前那一段（即 [场景]），角色与情感标签保留' },
];
