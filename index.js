// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.2.7

// 场景音效的混音规则（纯逻辑，可单测）—— 见 scene-mixer.js。
// 聊天气泡的显示过滤（托管一条酒馆正则）—— 见 chat-filter.js。
// 本文件由酒馆以 type="module" 加载，所以可以直接 import。
import { TRACK_RULES, createMixState, planScene, isEventName,
         catalogFromTracks, catalogFromLegacy, emptyCatalog } from './scene-mixer.js';
import {
         DEFAULT_PATTERN,
         DEFAULT_FLAGS,
         PATTERN_PRESETS,
         pickTagHidingConfig,
         planPromptTagStrip,
         applyPromptTagStripInPlace,
         planSpecInsertIndex,
         buildSceneHideScript,
         upsertScript,
         removeScript,
         findScript,
         listSchemes,
         matchSchemeName,
         addUserScheme,
         removeUserScheme,
         normalizeRegexInput,
         parseSchemeInput,
         formatSchemeInput,
         normalizeTagHidingSettings } from './chat-filter.js';
(function () {
    // 设置存储键：写进 SillyTavern 的 extension_settings，一旦改动用户配置就会丢，绝不可改
    const extensionName = "st-breezetts2";
    // 扩展目录名：必须与 manifest.json 的 name 以及实际文件夹名一致
    const extensionFolder = "ST-MoonVoice";
    const extensionFolderPath = (() => {
        try {
            const currentScript = document.currentScript;
            if (currentScript && currentScript.src) {
                return currentScript.src.replace(/\/[^\/]+$/, '/');
            }
        } catch (e) {}

        try {
            const links = document.querySelectorAll('link[rel="stylesheet"]');
            for (const link of links) {
                const href = link.href || '';
                if (href.includes(extensionFolder) || href.includes(extensionName)) {
                    return href.replace(/\/[^\/]+$/, '/');
                }
            }
        } catch (e) {}

        return `scripts/extensions/third-party/${extensionFolder}/`;
    })();

    // ==================== 默认设置 ====================
    const defaultSettings = {
        apiUrl: 'http://127.0.0.1:7881/tts',
        cloningUrl: 'http://127.0.0.1:7881/api/v1/breezetts2_cloning',
        voiceListUrl: 'http://127.0.0.1:7881/voices',
        model: 'breeze-tts-2',
        defaultVoice: '', // 留空则用音色库第一个；建议在面板里指定
        npcAutoVoice: true,   // 未绑定角色是否自动分配音色（大模型创造的新角色）
        npcVoicePool: [],     // NPC 音色池；留空 = 用音色库里所有已配逐字稿的音色,
        speed: 1.0,
        volume: 1.0,
        parsingMode: 'gal', // 'gal' | 'audiobook' | 'rp'
        enableInline: true,
        autoInference: true,
        autoPlay: false,
        streamingPlay: true,
        streamingSkipCount: 1,
        // 相邻音频之间的停顿（秒）。
        // 旧版是 rpSentenceDelay / galSentenceDelay 两个按模式分开的字段，默认留空等于不延迟，
        // 结果两句之间首尾相接，听起来像在抢话。现统一为全局设置（所有模式生效，含听书模式）。
        segmentGap: 0.25,
        // 换角色时在上述间隔之外再加的时间：同一角色连着说话只要很短换气，
        // 换人时也这么短就会糊成一片，加一点才像正常对话。
        speakerChangeGap: 0.35,
        showFloatingPlayer: true, 
        cacheImportPath: '\\\\SillyTavern\\\\data\\\\TTSsound',
        ambientSoundVolume: 0.4,
        // 环境音效01（第二条循环轨）的音量。默认比环境音低一点：这一轨通常放 BGM，
        // 它要垫在人声与环境音之下，跟环境音同音量容易糊成一片。
        ambient1SoundVolume: 0.3,
        ambientFadeDuration: 0,
        ambientLoopByScene: false,
        // 事件音（pjy/事件音效/ 与 pjy/事件音效01/ 下的文件）的音量。事件音不循环、
        // 不顶替循环轨，只是叠上去响一声，所以音量和环境音分开调。两个事件文件夹共用这一项。
        eventSoundVolume: 0.6,
        // 隐藏聊天气泡里的方括号标签（[角色|性别][情感][场景]）。由插件托管一条酒馆正则
        // （markdownOnly = 仅格式显示），所以**聊天记录文件与发给模型的提示词都不变**，
        // GAL/RP 模式的配音也不受影响（它读的是底层 chat[i].mes）。
        // **默认开启**：GAL 那串标签读起来很吵，多数人只想看台词；不喜欢的在
        // 「💬 聊天显示」里关掉即可。详细说明见 README 与 chat-filter.js。
        chatTagHiding: {
            enabled: true,
            pattern: DEFAULT_PATTERN,
            flags: DEFAULT_FLAGS,
            replace: '',
            userSchemes: [],   // 用户自己存的过滤方案（下拉里的「我的方案」）
        },
        voiceMap: {},
        promptInjection: {
            enabled: true,
            // 提示词分两块存，是这次结构调整的重点：
            //   body      —— 插件维护：格式规范、情感描述要求、格式示例，以及清单前的说明。
            //                默认跟随插件更新刷新（followUpdates）；想自己改正文就把它关掉。
            //   sceneList —— 你自己维护：可用音效清单那一节。插件**永不覆盖**它，
            //                所以增减环境音只需要改这里，不会被版本更新冲掉。
            // 注入时拼成 body + sceneList。
            body: '# 格式输出规范\n**描写任何角色（主要角色、NPC、路人、旁白）说话或叙述时，必须严格遵守格式，每句单开一行**\n\n## 格式：\n[角色名|性别-年龄段][情感描述][场景]“内容”\n\n### 角色名：\n当前说话的人物名称。**名字后面必须用竖线附上「性别-年龄段」标签**，从下列 11 个里选一个最贴切的：\n\n男-儿童 / 男-少年 / 男-青年 / 男-中年 / 男-老年\n女-儿童 / 女-少年 / 女-青年 / 女-中年 / 女-老年\n中性-未定\n\n- 旁白、环境描写、心理叙述固定写 `[旁白|中性-未定]`\n- 判断不了性别、非人类、群体，一律用 `中性-未定`\n- 标签必须来自上面的列表，不要自创\n- 名字里不要出现竖线以外的特殊符号\n\n### 情感描述：\n不要从固定词表中选择。请根据你对这段内容的理解，用一句自然语言描述这句话该怎么说（语气、情绪、语速、音色），写进方括号。\n\n要求：\n- 10~30 字，只描述“怎么说”，不要复述内容\n- 不要出现 ] 符号\n- 语言与内容保持一致（中文用中文描述，英文用英文）\n- **任何一行都不能省略情感描述**\n\n**旁白的情感描述**默认填：\n[平静客观的叙述语气，语速适中，吐字清晰，情绪平稳]\n可按当前场景气氛微调（如紧张场景写「压低声音，语速稍快，带着一丝不安」），但不可留空。\n\n### 内容：\n用「」或 “” 包裹台词或叙述内容。\n\n### 场景：\n用一两个词描述**这句话发生的地方或氛围**。\n\n**先有剧情，再填场景。** 是剧情决定场景，不是场景决定剧情。\n- 当前环境如果正好是文末【可用环境音】里列出的某一个，就照抄那个名字，插件会播对应背景音\n- 其他情况一律写空的方括号 `[]`。**不要为了用上某个音效，而改动剧情发生的地点、天气，或角色正在做的事**\n- NSFW 内容出现时，从【可用环境音】的 NSFW 组里选\n\n例：[小明|男-少年][语气平静，语速适中][]“我们到了。”\n\n## 格式示例：\n[小明|男-少年][语气轻快上扬，带着藏不住的笑意，语速偏快][]“今天的天气真好呢。”\n[旁白|中性-未定][平静客观的叙述语气，语速适中，吐字清晰，情绪平稳][]“他悠闲地在公园中漫步，看着来往的人群。”\n[小雪|女-少年][声音低沉缓慢，带着压抑的鼻音，像刚哭过][雨声]“我没事，真的没事。”\n[中年车夫|男-中年][语气粗粝，语速偏慢][]“客官，坐稳了。”\n[爱可丝|女-青年][慵懒满足，语速舒缓，尾音发软][]“这可是你说的哦，不许反悔。”\n\n---\n\n## 可用环境音\n\n**这一节只是资源清单，与剧情无关。** 它只说明「这些背景音是现成的」，\n**不代表故事应该往这些方向写**。不要为了让某个音效派上用场而改变角色所在的地点、\n天气或正在做的事。选不到合适的就写 `[]`，不会影响播放。\n\n',
            sceneList: '#### 正常场景列表：\n乡村_傍晚、森林、森林_清晨、森林_起风、沙滩_海浪、瀑布、雨声、雨声_室内、房间_开门\n#### NSFW场景列表：\n',
            followUpdates: true,
            depth: 4,
            role: "system"
        },
        // 喂给模型的那一份里，把历史消息上行首的 [角色|性别][情感][场景] 去掉，
        // 只留最近 keep 条当示范（见 chat-filter.js 的 planPromptTagStrip）。
        // 起因：模型每轮都能看到自己上一轮的标签，会照着上一轮的措辞写情感描述，
        // 越写越固定。去掉历史里的例子、把格式交给提示词约束；留最近一条既是格式样板，
        // 也顺带保住了"当前场景"（否则模型可能每句微调场景名 → 环境音反复重启）。
        // 只影响这次请求，聊天记录与显示都不变。
        stripHistoryTags: {
            enabled: true,
            keep: 1,
        },
        regexFilter: {
            enabled: false,
            pattern: ''
        }
    };

    // 提示词里「可用音效清单」那一节的起点：body 与 sceneList 就在这里切开，
    // 迁移旧的 content 时也靠它定位，所以两处共用一个常量。
    const SCENE_SECTION_MARK = '#### 正常场景列表：';

    // ==================== 工具函数 ====================
    /**
     * 将 HTML 转换为 Markdown 文本
     * 注意：保留换行符 \n，仅合并水平空白，以确保听书模式分段正则正常工作
     */
    function htmlToMarkdown(html) {
        let text = html;
        text = stripDecorativeBlocks(text);
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<\/p>/gi, '\n');
        text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n\n```\n$1\n```\n');
        text = text.replace(/<code[^>]*>([^<]*)<\/code>/gi, '`$1`');
        text = text.replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*');
        text = text.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*');
        text = text.replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**');
        text = text.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**');
        text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (match, content) => {
            const cleanContent = content.replace(/<[^>]+>/g, '');
            const level = match.match(/<h([1-6])/)[1];
            return '\n' + '#'.repeat(level) + ' ' + cleanContent + '\n';
        });
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/[ \t]+/g, ' ');
        text = text.replace(/\n{2,}/g, '\n');
        text = text.trim();
        return text;
    }

        // ==================== 设置管理 ====================
    function getContext() {
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern?.getContext) {
                return SillyTavern.getContext();
            }
            if (window.SillyTavern?.getContext) {
                return window.SillyTavern.getContext();
            }
        } catch (e) {
            console.warn('[MoonVoice] 获取上下文失败:', e);
        }
        return null;
    }

    function deepMergeDefaults(target, source) {
        // 注意：使用 JSON.parse(JSON.stringify) 进行深拷贝，未来若设置对象体积增大可考虑结构化克隆优化
        if (!source || typeof source !== 'object') return target;
        if (!target || typeof target !== 'object') return JSON.parse(JSON.stringify(source));
        for (const key of Object.keys(source)) {
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                target[key] = typeof source[key] === 'object' && source[key] !== null ? JSON.parse(JSON.stringify(source[key])) : source[key];
            } else if (
                typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
                typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])
            ) {
                deepMergeDefaults(target[key], source[key]);
            }
        }
        return target;
    }

    function getSettings() {
        const ctx = getContext();
        const contextStore = ctx?.extensionSettings;
        let root = null;
        if (contextStore && contextStore[extensionName] && typeof contextStore[extensionName] === 'object') {
            root = contextStore[extensionName];
        }
        if (!root || !root.presets) {
            const oldData = root && root.apiUrl ? root : null;
            const migratedPreset = oldData ? deepMergeDefaults(JSON.parse(JSON.stringify(oldData)), defaultSettings) : JSON.parse(JSON.stringify(defaultSettings));
            delete migratedPreset.selected_preset;
            delete migratedPreset.presets;
            root = { selected_preset: 'Default', presets: { 'Default': migratedPreset } };
        }
        if (contextStore) contextStore[extensionName] = root;
        if (!root.presets[root.selected_preset]) {
            root.selected_preset = Object.keys(root.presets)[0] || 'Default';
            if (!root.presets[root.selected_preset]) {
                root.presets['Default'] = JSON.parse(JSON.stringify(defaultSettings));
                root.selected_preset = 'Default';
            }
        }
        const active = root.presets[root.selected_preset];
        // 旧的按模式延迟（rpSentenceDelay / galSentenceDelay）已被统一的 segmentGap 取代。
        // 必须在 deepMergeDefaults 之前记录「用户是否已经设过 segmentGap」，
        // 否则合并会把缺失的键填成默认值，就再也分不清"没设过"和"设成了默认值"。
        const hadSegmentGap = active.segmentGap !== undefined;
        // 提示词迁移的判据**也必须取自合并之前**，理由同上：deepMergeDefaults 会把缺失的
        // body / sceneList 填成默认值，填过之后就再也分不清「还没迁移」和「已经迁移」了。
        // （第一版就是写成合并后再判断，结果迁移形同不存在，老用户改过的清单会被默认清单替换。）
        const injBefore = (active.promptInjection && typeof active.promptInjection === 'object')
            ? active.promptInjection : null;
        const hadPromptBody = !!injBefore && typeof injBefore.body === 'string';
        const legacyPromptContent = (injBefore && typeof injBefore.content === 'string')
            ? injBefore.content : '';
        deepMergeDefaults(active, defaultSettings);
        if (!hadSegmentGap) {
            const legacy = [active.galSentenceDelay, active.rpSentenceDelay]
                .map(v => parseFloat(v))
                .filter(v => !isNaN(v) && v > 0);
            if (legacy.length) {
                active.segmentGap = Math.max(...legacy);
                console.log(`[MoonVoice] 已把旧的按模式延迟迁移为音频间隔: ${active.segmentGap}s`);
            }
        }

        // 提示词存储结构：老版本是一整块 promptInjection.content；现在拆成
        //   body      —— 插件维护（格式规范 / 情感描述要求 / 格式示例）
        //   sceneList —— 用户维护（可用音效清单那一节），插件永不覆盖
        // 这里是**一次性**迁移；幂等判断用的是合并前抓下来的 hadPromptBody。
        try {
            const inj = active.promptInjection;
            if (inj && typeof inj === 'object' && !hadPromptBody) {
                const legacy = legacyPromptContent;
                // 「是不是一直在用插件的提示词」只在这里猜一次，猜完就落成显式设置，
                // 之后不再靠内容判断 —— 旧机制误伤用户自定义提示词，正是发生在这里。
                // 判据要**结构性**的（必须是小标题），不能只匹配这几个词：用户自己写的
                // 提示词里完全可能出现「格式输出规范」这类说法，那样会被误判成自己人。
                const OURS = ['# 格式输出规范', '### 情感描述', '### 角色名'];
                const ours = OURS.every(k => legacy.includes(k));
                if (legacy) {
                    const at = legacy.indexOf(SCENE_SECTION_MARK);
                    // 切出来的清单原样保住（用户可能已经增删过音效名）
                    inj.sceneList = at >= 0
                        ? legacy.slice(at).trim() + '\n'
                        : defaultSettings.promptInjection.sceneList;
                    inj.followUpdates = ours;
                    inj.body = ours ? defaultSettings.promptInjection.body : legacy;
                } else {
                    inj.body = defaultSettings.promptInjection.body;
                    inj.sceneList = defaultSettings.promptInjection.sceneList;
                    inj.followUpdates = true;
                }
                // 旧的 content 刻意保留不删：万一上面的切分没覆盖到用户写的某一段，
                // 它还在设置里，可以人工找回。插件此后不再读写它。
                console.log('[MoonVoice] 提示词已拆成 body + sceneList',
                            ours ? '（沿用插件的正文，继续跟随更新）'
                                 : '（检测到自写正文，已停止自动更新）');
            }
        } catch (e) { console.warn('[MoonVoice] 提示词迁移失败:', e); }

        // 跟随插件更新：开着的话正文每次读设置都刷到最新默认值 —— 提示词的改进因此
        // 能真正到达用户手里，而不是像旧机制那样只在「换标记」那一次生效。
        // 清单不在此列，它是用户的，任何情况下都不动。
        try {
            const inj = active.promptInjection;
            if (inj && typeof inj === 'object') {
                if (inj.followUpdates !== false && typeof inj.body === 'string'
                    && inj.body !== defaultSettings.promptInjection.body) {
                    inj.body = defaultSettings.promptInjection.body;
                    console.log('[MoonVoice] 提示词正文已同步到当前版本');
                }
                if (typeof inj.sceneList !== 'string') {
                    inj.sceneList = defaultSettings.promptInjection.sceneList;
                }
            }
        } catch (e) { console.warn('[MoonVoice] 提示词同步失败:', e); }
        if (typeof active.voiceMap !== 'object') active.voiceMap = {};
        if (!active.regexFilter || typeof active.regexFilter !== 'object') {
            active.regexFilter = { enabled: false, pattern: '' };
        }
        return active;
    }

    /**
     * 计算「上一句播完」到「下一句开始」之间该停顿多少秒。
     *
     * 同角色连续说话只需要一个短的换气停顿；换角色时如果也这么短，
     * 两句会糊在一起，听起来像两个人在抢话，所以换人时额外加 speakerChangeGap。
     *
     * @param {string} prevCharacter 刚播完那句的角色
     * @param {string} nextCharacter 即将播放那句的角色
     */
    function getSegmentGap(prevCharacter, nextCharacter) {
        const s = getSettings();
        const base = Math.max(0, parseFloat(s.segmentGap) || 0);
        const extra = Math.max(0, parseFloat(s.speakerChangeGap) || 0);
        const a = (prevCharacter === null || prevCharacter === undefined) ? '' : String(prevCharacter).trim();
        const b = (nextCharacter === null || nextCharacter === undefined) ? '' : String(nextCharacter).trim();
        // 任一侧角色未知时不加码，避免误判成"换人"而拖慢节奏
        const changed = a !== '' && b !== '' && a !== b;
        return base + (changed ? extra : 0);
    }

    // 最近一次实际播放的角色，用于跨消息续播时判断是否换了人
    let lastPlayedCharacter = null;

    /**
     * 统一入口：间隔到了再执行 next()。gap 为 0 时同步执行，避免无谓的异步跳步。
     */
    function runAfterSegmentGap(gapSeconds, next) {
        const ms = Math.max(0, gapSeconds * 1000);
        if (ms > 0) { setTimeout(next, ms); } else { next(); }
    }

    function getRootSettings() {
        getSettings();
        const ctx = getContext();
        if (ctx?.extensionSettings?.[extensionName]) return ctx.extensionSettings[extensionName];
        return null;
    }

    function saveSettings() {
        const ctx = getContext();
        if (!ctx) { console.warn('[MoonVoice] 保存设置失败: 上下文不可用'); return; }
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        const root = getRootSettings();
        if (!root) return;
        ctx.extensionSettings[extensionName] = root;
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        else if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
        else console.warn('[MoonVoice] 保存设置失败: 无保存函数');
    }

    function switchPreset(name) {
        const root = getRootSettings();
        if (!root.presets[name]) return;
        root.selected_preset = name;
        saveSettings();
        syncChatTagHiding();   // 这个设置是随预设走的，换预设要跟着换规则
        const settingsEl = document.getElementById('breezetts2-settings');
        if (settingsEl) { settingsEl.remove(); injectSettingsPanel(); }
        const modalEl = document.getElementById('breezetts2-modal');
        if (modalEl) { modalEl.remove(); showConfigPopup(); }
    }

    /**
     * 一次性迁移：这个设置最早叫「隐藏场景标签」（键名 sceneTagHiding），名字不准确
     * —— 它删的是**整个方括号标签格式**（角色/情感/场景），不只是场景那一段。
     * 改名为 chatTagHiding 时把老值搬过来，免得试过的人丢设置。
     */
    function migrateTagHidingKey() {
    const s = getSettings();
    // 每次加载都归一化并**写回**：既做旧键迁移，也做「旧默认模式 -> 新默认模式」的升级。
    // 只算不写会留下「托管正则已是新的、面板里还显示旧模式」的错位（用户实测报过）。
    const { config, changed, hadLegacy } = normalizeTagHidingSettings(s);
    if (hadLegacy) delete s.sceneTagHiding;
    if (!changed) return;
    s.chatTagHiding = config;
    saveSettings();
    console.log(hadLegacy
        ? '[MoonVoice] 已把旧的「隐藏场景标签」设置迁移为「隐藏方括号标签」'
        : '[MoonVoice] 已把「隐藏方括号标签」的设置归一化（旧默认模式升级为新默认）');
})();
