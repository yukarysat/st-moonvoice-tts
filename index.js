// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.2.7

// 场景音效的混音规则（纯逻辑，可单测）—— 见 scene-mixer.js。
// 聊天气泡的显示过滤（托管一条酒馆正则）—— 见 chat-filter.js。
// 本文件由酒馆以 type="module" 加载，所以可以直接 import。
import { TRACK_RULES, createMixState, planScene, isEventName,
         catalogFromTracks, catalogFromLegacy, emptyCatalog } from './scene-mixer.js';
import { DEFAULT_PATTERN, PATTERN_PRESETS, pickTagHidingConfig, planPromptTagStrip, planSpecInsertIndex,
         buildSceneHideScript, upsertScript, removeScript, findScript } from './chat-filter.js';
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
        const hasNew = s.chatTagHiding && typeof s.chatTagHiding === 'object';
        if (!hasNew && s.sceneTagHiding) {
            s.chatTagHiding = pickTagHidingConfig(s);
            delete s.sceneTagHiding;
            saveSettings();
            console.log('[MoonVoice] 已把旧的「隐藏场景标签」设置迁移为「隐藏方括号标签」');
        }
    }

    /**
     * 把「隐藏方括号标签」这个设置同步成一条**酒馆正则**（extension_settings.regex 里我们那条）。
     *
     * 为什么托管酒馆正则而不是自己改 DOM：酒馆的正则扩展本来就是这个用途，它有一条已经
     * 测好的显示管线（markdownOnly 只作用于显示层，不写回聊天记录、也不进提示词）。
     * 插件自己插 DOM 会在消息重渲染 / 编辑 / swipe 时反复失效，还会跟酒馆的渲染抢方向盘。
     * 托管还有个好处：用户能在酒馆的「正则」面板里看见这条规则、也能自己改。
     *
     * 只增删改 id 为 BRACKET_TAG_HIDE_ID 的那一条，**绝不碰用户自己的正则**。
     * @returns {'ok'|'removed'|'disabled-ext'|'bad-pattern'|'no-context'}
     */
    function syncChatTagHiding() {
        const ctx = getContext();
        if (!ctx || !ctx.extensionSettings) return 'no-context';
        const store = ctx.extensionSettings;
        const cfg = pickTagHidingConfig(getSettings());   // 兼容旧的 sceneTagHiding 键
        const list = Array.isArray(store.regex) ? store.regex : [];
        const existing = findScript(list);

        if (!cfg.enabled) {
            // 关掉时把托管的那条删掉，不留垃圾规则
            if (existing) {
                store.regex = removeScript(list);
                saveSettings();
                console.log('[MoonVoice] 已移除托管的「隐藏方括号标签」正则');
                return 'removed';
            }
            return 'removed';
        }
        // 酒馆的正则扩展被停用时规则不会生效，提前告诉用户（面板上也会提示）
        if (Array.isArray(ctx.disabledExtensions) && ctx.disabledExtensions.includes('regex')) {
            console.warn('[MoonVoice] 酒馆的正则扩展处于停用状态，「隐藏方括号标签」不会生效');
            return 'disabled-ext';
        }
        const script = buildSceneHideScript(cfg);
        if (!script) {
            console.warn('[MoonVoice] 隐藏方括号标签的正则非法，未写入:', cfg.pattern);
            return 'bad-pattern';
        }
        // 内容没变就不写：避免每次开面板都动一遍 extension_settings（也会白触发一次保存）
        if (existing && JSON.stringify(existing) === JSON.stringify(script)) return 'ok';
        store.regex = upsertScript(list, script);
        saveSettings();
        console.log('[MoonVoice] 已写入托管的「隐藏方括号标签」正则:', script.findRegex);
        return 'ok';
    }

    function getCardId() {
        try {
            const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
            if (ctx?.characterId !== undefined && ctx?.characterId !== null) return `char_${ctx.characterId}`;
            if (ctx?.groupId) return `group_${ctx.groupId}`;
        } catch (e) { console.error('[MoonVoice] 获取卡片ID失败:', e); }
        return 'default';
    }

    function getCardName() {
        try {
            const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
            if (ctx?.characterId !== undefined) return ctx.name || ctx.characters?.[ctx.characterId]?.name || '未知角色';
            if (ctx?.groupId) return ctx.groups?.find(g => g.id === ctx.groupId)?.name || '群组';
        } catch (e) { }
        return '默认';
    }

    function getVoiceMap() {
        const root = getRootSettings();
        if (!root) return {};
        if (!root.voiceMap) root.voiceMap = {};
        const cardId = getCardId();
        if (!root.voiceMap[cardId]) root.voiceMap[cardId] = {};
        return root.voiceMap[cardId];
    }

    function ensureWavSuffix(filename) {
        if (!filename) return filename;
        filename = filename.trim();
        if (!filename.toLowerCase().endsWith('.wav') && !filename.toLowerCase().endsWith('.mp3') && !filename.toLowerCase().endsWith('.ogg')) {
            return filename + '.wav';
        }
        return filename;
    }

    // ==================== 全局音频缓存 ====================
    const audioCache = {};
    function createPlaybackState() {
        return { audio: null, msg: null, mesId: null, index: -1, playlist: null, totalDuration: 0, controller: null, sessionId: null, stop: function () { if (this.audio) { try { this.audio.pause(); this.audio.onended = null; this.audio.onerror = null; } catch (e) { } } if (this.shouldRevoke && this.blobUrl) { try { URL.revokeObjectURL(this.blobUrl); } catch (e) { } } this.audio = null; } };
    }
    let currentPlayback = createPlaybackState();
    const inferenceLocks = new Set();

    function clearMemoryAudioCache() {
        try {
            Object.values(audioCache).forEach(list => {
                if (!Array.isArray(list)) return;
                list.forEach(item => { if (item && item.blobUrl) { try { URL.revokeObjectURL(item.blobUrl); } catch (e) { } } });
            });
        } catch (e) { console.warn('[MoonVoice] 清理内存缓存失败:', e); }
        Object.keys(audioCache).forEach(k => delete audioCache[k]);
        if (typeof currentPlayback.stop === 'function') {
            currentPlayback.stop(); // 复用 stop：顺带释放行内播放的临时 blobUrl（如有）
        } else if (currentPlayback.audio) {
            try { currentPlayback.audio.pause(); } catch (e) { }
        }
        currentPlayback = createPlaybackState();
    }

    function getMessageId(msg) {
        if (!msg) return null;
        let mesIdAttr = msg.getAttribute('mesid');
        if (!mesIdAttr) mesIdAttr = msg.dataset?.mesid;
        if (!mesIdAttr) mesIdAttr = msg.getAttribute('data-mesid');
        if (mesIdAttr) return String(mesIdAttr);
        // fallback：仅当元素仍在 DOM 中时才用 index，避免消息删除后索引漂移
        if (!document.contains(msg)) return null;
        const list = Array.from(document.querySelectorAll('.mes'));
        const idx = list.indexOf(msg);
        return idx >= 0 ? String(idx) : null;
    }

    function utf8ToBase64(str) { try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { console.warn('[MoonVoice] UTF8转Base64失败:', e); return ''; } }
    function base64ToUtf8(str) { try { return decodeURIComponent(escape(atob(str))); } catch (e) { console.warn('[MoonVoice] Base64转UTF8失败:', e); return ''; } }

    // ==================== IndexedDB 音频存储  ====================
    const AudioStorage = (function () {
        let dbPromise = null;
        function getDB() {
            if (dbPromise) return dbPromise;
            dbPromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) { console.warn('[MoonVoice] 浏览器不支持indexedDB，音频缓存已禁用'); resolve(null); return; }
                // 库名沿用改名前的老名字（BreezeTTS2），刻意不改：它是浏览器里的
                // 本地音频缓存库，改名等于让所有老用户的缓存凭空消失（会重新合成一遍）。
                // 与之同类被冻结的标识符还有插件设置键与 CSS 类前缀——两者都带改名前
                // 那个项目名的缩写，动了就是丢用户配置 / 样式失配，同样不能改。
                const request = window.indexedDB.open('BreezeTTS2_Store', 2);
                request.onerror = () => { console.error('[MoonVoice] indexedDB open error:', request.error); resolve(null); };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('audios')) { const store = db.createObjectStore('audios', { keyPath: 'hash' }); store.createIndex('timestamp', 'timestamp', { unique: false }); }
                    if (!db.objectStoreNames.contains('configs')) db.createObjectStore('configs');
                };
                request.onsuccess = () => { resolve(request.result); };
            });
            return dbPromise;
        }
        async function saveAudio(record) {
            const db = await getDB(); if (!db) return;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('audios', 'readwrite');
                const store = tx.objectStore('audios');
                const req = store.put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => { console.error('[MoonVoice] saveAudio error:', tx.error); reject(tx.error); };
                req.onerror = () => { console.error('[MoonVoice] saveAudio request error:', req.error); };
            });
        }
        async function getAudio(hash) {
            const db = await getDB(); if (!db) return null;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('audios', 'readonly');
                const store = tx.objectStore('audios');
                const req = store.get(hash);
                req.onsuccess = () => { resolve(req.result || null); };
                req.onerror = () => { console.error('[MoonVoice] getAudio error:', req.error); reject(req.error); };
            });
        }
        async function getAllAudios() {
            const db = await getDB(); if (!db) return [];
            return new Promise((resolve, reject) => {
                const tx = db.transaction('audios', 'readonly');
                const store = tx.objectStore('audios');
                const req = store.getAll();
                req.onsuccess = () => { resolve(req.result || []); };
                req.onerror = () => { console.error('[MoonVoice] getAllAudios error:', req.error); reject(req.error); };
            });
        }
        async function clearAllAudios() {
            const db = await getDB(); if (!db) return;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('audios', 'readwrite');
                const store = tx.objectStore('audios');
                const req = store.clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => { console.error('[MoonVoice] clearAllAudios error:', tx.error); reject(tx.error); };
                req.onerror = () => { console.error('[MoonVoice] clearAllAudios request error:', req.error); };
            });
        }
        async function saveConfig(key, value) {
            const db = await getDB(); if (!db) return;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('configs', 'readwrite');
                const store = tx.objectStore('configs');
                const req = store.put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                req.onerror = () => reject(req.error);
            });
        }
        async function getConfig(key) {
            const db = await getDB(); if (!db) return null;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('configs', 'readonly');
                const store = tx.objectStore('configs');
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return { saveAudio, getAudio, getAllAudios, clearAllAudios, saveConfig, getConfig };
    })();

    // ==================== 本地仓库管理 ====================
    const LocalRepo = (function () {
        let dirHandle = null;
        async function init() {
            try {
                const handle = await AudioStorage.getConfig('localDirHandle');
                if (handle) { dirHandle = handle; }
            } catch (e) { console.warn('[MoonVoice] 本地仓库初始化失败:', e); }
        }
        async function setHandle(handle) { if (!handle) return; dirHandle = handle; await AudioStorage.saveConfig('localDirHandle', handle); }
        function getHandle() { return dirHandle; }
        async function requestPermission() {
            if (!dirHandle) return false;
            const opts = { mode: 'readwrite' };
            try {
                if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
                if ((await dirHandle.requestPermission(opts)) === 'granted') return true;
            } catch (e) { console.warn('[MoonVoice] 权限请求失败', e); }
            return false;
        }
        return { init, setHandle, getHandle, requestPermission };
    })();

    // ==================== 场景音效播放 ====================
    // 规则（谁是谁的轨、谁打断谁、事件什么时候响）在 scene-mixer.js 里，本模块只负责
    // "取目录 + 按动作操作 Audio 元素"。这样那套规则能被单测覆盖，这里只留播放器该管的事：
    // 元素生命周期、淡入淡出、随台词暂停、异步请求先后。
    const AmbientPlayer = (function () {
        // ---------- 状态 ----------
        let dirHandle = null;
        // 目录：{ 轨道 id: { 场景名: url } }。去后缀与后缀优先级在 scene-mixer 里做完了。
        let catalog = null;
        // 引擎状态：每条循环轨当前请求的名字、被打断后要静音的名字、事件轨上次见到的名字。
        let mixState = createMixState();
        // 循环轨的运行态。事件音是 fire-and-forget，不在 playing 里登记。
        const playing = {};
        for (const r of TRACK_RULES) if (r.kind === 'ambient') playing[r.id] = { audio: null, name: null };
        // 事件音（一次性）：两个事件轨共用一个集合，靠自身 ended/error 收尾。
        const activeEvents = new Set();
        // 被"随台词暂停"停下的循环轨。只恢复我们自己暂停的那些，避免误播。
        const pausedByPlayback = new Set();
        let playSceneRequestId = 0; // 防异步错乱：被更新的请求取代时放弃本次

        function _ruleOf(trackId) { return TRACK_RULES.find(r => r.id === trackId); }
        function _getFadeDuration() { return parseInt(getSettings().ambientFadeDuration ?? 0) || 0; }
        function _trackVolume(trackId) {
            const key = _ruleOf(trackId)?.volumeKey || 'ambientSoundVolume';
            const v = parseFloat(getSettings()[key]);
            // 缺键时给个安全值：deepMergeDefaults 会补默认值，这里只是兜底不产生 NaN
            return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.4));
        }

        async function init() {
            _stopEvents();   // 兜底：清掉上一次初始化可能遗留的事件音元素
            for (const r of TRACK_RULES) {
                if (r.kind !== 'ambient') continue;
                playing[r.id] = { audio: null, name: null };
            }
            pausedByPlayback.clear();
            mixState = createMixState();
            try {
                const saved = await AudioStorage.getConfig('ambientDirHandle');
                if (saved) { dirHandle = saved; }
            } catch (e) { console.warn('[MoonVoice][Ambient] 初始化失败', e); }
            preloadScenes();
        }
        async function setDirHandle(handle) { if (!handle) return; dirHandle = handle; await AudioStorage.saveConfig('ambientDirHandle', handle); }
        function getDirHandle() { return dirHandle; }
        async function queryPermission() {
            if (!dirHandle) return false;
            try { return (await dirHandle.queryPermission({ mode: 'read' })) === 'granted'; } catch (e) { console.warn('[MoonVoice][Ambient] 查询权限失败r:', e); }
            return false;
        }
        async function requestPermission() {
            if (!dirHandle) return false;
            try {
                if ((await dirHandle.queryPermission({ mode: 'read' })) === 'granted') return true;
                if ((await dirHandle.requestPermission({ mode: 'read' })) === 'granted') return true;
            } catch (e) { console.warn('[MoonVoice][Ambient] 权限请求失败:', e); }
            return false;
        }

        // ---------- 淡入淡出 ----------
        // rAF 句柄必须挂在**音频元素自己**身上，不能用全局变量。全局单变量的三个后果：
        //   1) 新元素的 _fadeOut 会在 _cancelFadeOut 里把**上一个元素**还在跑的淡出取消掉，
        //      那个元素就既不会 pause() 也不会清 src —— 而它是 loop=true 的，
        //      于是永远以中间音量循环播放下去，且已不在插件管理范围内。
        //      （实测：三句各换一个场景、淡出 800ms，前两个全被搁置在音量 0.06。）
        //   2) _fadeOut 不会取消同一元素上还在跑的 _fadeIn，两个 rAF 循环会同时改 volume，互相打架。
        //   3) stopImmediate()/setVolume() 里的 _cancelFade() 会误伤无关元素的淡出。
        // 改成每个元素自己记后，这三个问题一起消失。现在有多条循环轨，这一点更关键。
        function _cancelFade(audioEl) {
            if (!audioEl) return;
            if (audioEl._bzFadeOut != null) { cancelAnimationFrame(audioEl._bzFadeOut); audioEl._bzFadeOut = null; }
            if (audioEl._bzFadeIn != null) { cancelAnimationFrame(audioEl._bzFadeIn); audioEl._bzFadeIn = null; }
        }

        function _fadeOut(audioEl, onDone) {
            _cancelFade(audioEl);
            const fadeDur = _getFadeDuration();
            if (!fadeDur) { audioEl.pause(); audioEl.src = ''; if (onDone) onDone(); return; }
            const start = performance.now();
            const startVol = audioEl.volume;
            function step(now) {
                const t = Math.max(0, Math.min(1, (now - start) / fadeDur));
                audioEl.volume = Math.max(0, Math.min(1, startVol * (1 - t)));
                if (t < 1) { audioEl._bzFadeOut = requestAnimationFrame(step); }
                else { audioEl.pause(); audioEl.src = ''; audioEl._bzFadeOut = null; if (onDone) onDone(); }
            }
            audioEl._bzFadeOut = requestAnimationFrame(step);
        }

        /** 淡入到 target。target 由调用方按**该轨的音量**给出 —— 两条循环轨音量可以不同。 */
        function _fadeIn(audioEl, target) {
            _cancelFade(audioEl);
            const fadeDur = _getFadeDuration();
            if (!fadeDur) { audioEl.volume = target; return; }
            audioEl.volume = 0;
            const start = performance.now();
            function step(now) {
                const t = Math.max(0, Math.min(1, (now - start) / fadeDur));
                audioEl.volume = Math.max(0, Math.min(1, target * t));
                if (t < 1) { audioEl._bzFadeIn = requestAnimationFrame(step); }
                else { audioEl._bzFadeIn = null; }
            }
            audioEl._bzFadeIn = requestAnimationFrame(step);
        }

        // ==================== 场景音目录 ====================
        // 侧车按子文件夹分轨道（见 scene-mixer.js 的 TRACK_RULES 与 breeze_api.py 的
        // SCENE_TRACKS，两边的 id 必须一致）：
        //   环境音效 / pjy 根目录   -> ambient   循环、顶替上一段（旧行为，永不被事件影响）
        //   环境音效01              -> ambient1  第二条循环轨，唯一会被事件打断的轨
        //   事件音效                -> event     只响一次，每次出现都响（旧行为）
        //   事件音效01              -> event1    场景名变化时响一次，触发时打断 ambient1
        // 旧版侧车没有 tracks 字段，此时退化成"环境音 + 事件音"两条轨（等同旧插件行为）。
        let catalogFetchTime = 0;
        let catalogPromise = null;
        const SCENE_LIST_TTL = 60000;

        function _baseUrl() {
            const raw = getSettings().apiUrl || 'http://127.0.0.1:7881';
            return (raw.match(/^(https?:\/\/[^\/]+)/i)?.[0] || 'http://127.0.0.1:7881').replace(/\/$/, '');
        }
        // 把「pjy 下的相对路径」转成可用的 URL：逐段编码，保留 / 作为分隔符
        function _sceneUrl(relPath) {
            const enc = relPath.split('/').map(s => encodeURIComponent(s)).join('/');
            return `${_baseUrl()}/pjy/${enc}`;
        }

        async function _getCatalog() {
            if (catalog && (Date.now() - catalogFetchTime < SCENE_LIST_TTL)) return catalog;
            if (catalogPromise) return catalogPromise;
            catalogPromise = fetchWithTimeout(`${_baseUrl()}/api/v1/scene_audios`)
                .then(res => res.json())
                .then(data => {
                    const toUrl = rel => _sceneUrl(rel);
                    catalog = (data && data.tracks)
                        ? catalogFromTracks(data.tracks, toUrl)
                        : catalogFromLegacy(data, toUrl);
                    catalogFetchTime = Date.now();
                    const counts = TRACK_RULES
                        .map(r => `${r.id} ${Object.keys(catalog[r.id] || {}).length}`).join(' / ');
                    console.log('[MoonVoice][Ambient] 场景音已加载：', counts);
                    return catalog;
                })
                .catch(e => {
                    // 失败不写进 catalog：下次调用会重试。返回空目录只是让本次调用安全返回。
                    console.warn('[MoonVoice][Ambient] 获取场景音列表失败，下次重试:', e);
                    return catalog || emptyCatalog();
                })
                .finally(() => { catalogPromise = null; });
            return catalogPromise;
        }

        async function preloadScenes() {
            try { await _getCatalog(); } catch (e) { console.warn('[MoonVoice][Ambient] preloadScenes failed:', e); }
        }

        /**
         * 同步判断这个名字是不是事件音 —— 只查已加载的目录，不发请求。
         * 播放列表分段时用它把事件音行单独成段：事件音只是叠上去响一声，
         * 不该把正在播的循环轨切断重来。目录没加载时返回 false（按循环音处理，等同旧行为）。
         */
        function isEventScene(sceneName) {
            return isEventName(catalog, sceneName);
        }

        // ==================== 循环轨 ====================
        function _playAmbient(trackId, name, url) {
            const st = playing[trackId];
            if (!st) return;
            // 同场景且正在播 -> 保持，不重新加载（旧行为）
            if (st.name === name && st.audio && !st.audio.paused) return;

            const oldAudio = st.audio;
            st.name = name;
            const audio = new Audio(url);
            audio.loop = true;
            audio.volume = 0;
            st.audio = audio;
            pausedByPlayback.delete(trackId);

            if (oldAudio && !oldAudio.paused) {
                _fadeOut(oldAudio, null);
            } else if (oldAudio) {
                // 已被暂停的旧音效：收掉它身上可能残留的 rAF，别再碰其他元素
                _cancelFade(oldAudio);
            }

            audio.play().then(() => {
                if (st.audio === audio) _fadeIn(audio, _trackVolume(trackId));
            }).catch(e => {
                console.warn(`[MoonVoice][Ambient] 播放错误（${trackId} / ${name}）:`, e);
                if (st.audio === audio) { st.audio = null; st.name = null; }
            });
        }

        /** 停掉一条循环轨。immediate=true 时不淡出（每句之间的场景转换用）。 */
        function _stopAmbient(trackId, immediate = false) {
            const st = playing[trackId];
            if (!st) return;
            const audio = st.audio;
            st.audio = null;
            st.name = null;
            pausedByPlayback.delete(trackId);
            if (!audio) return;
            if (immediate) { _cancelFade(audio); audio.pause(); audio.src = ''; }
            else { _fadeOut(audio, null); }
        }

        // ==================== 事件音（一次性） ====================
        // 循环轨之外的独立通道：不循环、不顶替循环轨（叠在它们之上）、放完自动消失。
        // 是否会打断某条循环轨，由规则表决定（目前只有 事件音效01 -> 环境音效01）。
        function _playEvent(trackId, url) {
            const vol = _trackVolume(trackId);
            const audio = new Audio(url);
            audio.loop = false;
            audio.volume = vol;
            activeEvents.add(audio);
            const cleanup = () => {
                activeEvents.delete(audio);
                try { audio.onended = null; audio.onerror = null; } catch (e) { /* 忽略 */ }
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(e => {
                cleanup();
                // 自动播放被拦截不算错误：等用户点过页面后自然会响
                if (e && e.name === 'NotAllowedError') { return; }
                console.warn('[MoonVoice][Ambient] 事件音播放失败:', e);
            });
        }

        function _stopEvents() {
            // 常规播放流程里不调用：事件音是 fire-and-forget，靠自身 ended/error 收尾。
            // 只在插件（重新）初始化时兜底清一次，防止上次遗留的元素还挂在集合里。
            activeEvents.forEach(a => {
                try { _cancelFade(a); a.pause(); a.src = ''; } catch (e) { /* 忽略 */ }
            });
            activeEvents.clear();
        }

        // ==================== 对外：按场景标签播放 ====================
        /**
         * 把"这一句的场景标签"交给规则引擎，再执行它给出的动作。
         *
         * 传入空字符串 / null 表示空方括号 `[]` —— 停掉全部循环轨（与旧行为一致）。
         * 目录还没加载好时会等一次（首次播放常见），期间若有更新的请求到来就放弃本次。
         */
        async function playScene(sceneName) {
            const requestId = ++playSceneRequestId;
            const cat = catalog || await _getCatalog();
            if (requestId !== playSceneRequestId) {
                console.log('[MoonVoice][Ambient] playScene: 请求已过期，放弃:', sceneName);
                return;
            }
            const { actions, state } = planScene(mixState, sceneName, cat);
            mixState = state;
            for (const a of actions) {
                if (a.kind === 'ambient') {
                    _playAmbient(a.track, a.name, a.url);
                } else if (a.kind === 'ambient-stop') {
                    console.log(`[MoonVoice][Ambient] 停掉 ${a.track}（${a.reason === 'interrupted' ? '被事件打断' : '清空场景'}）`);
                    _stopAmbient(a.track, false);
                } else if (a.kind === 'event') {
                    console.log(`[MoonVoice][Ambient] 事件音 ${a.track}: ${a.name}`);
                    _playEvent(a.track, a.url);
                }
            }
        }

        /** 停止全部循环轨并重置引擎状态（消息播完、或切换播放对象时用）。 */
        function stop() {
            playSceneRequestId++;
            for (const r of TRACK_RULES) if (r.kind === 'ambient') _stopAmbient(r.id, false);
            mixState = createMixState();
            pausedByPlayback.clear();
        }
        /**
         * 硬停全部循环轨，**不重置引擎状态**。
         *
         * 注意：不改 mixState 是有意的 —— 打断造成的静音要留着；若这里重置，
         * 每句之间被 stopImmediate 一清，"刹车之后车一直停着"就不成立了。
         */
        function stopImmediate() {
            playSceneRequestId++;
            for (const r of TRACK_RULES) if (r.kind === 'ambient') _stopAmbient(r.id, true);
            // 注意：**不**在这里清事件音。stopImmediate() 是每句之间的场景转换用的，
            // 清掉的话"电话铃"这种比台词长的音效会被下一句拦腰切断。
            // 事件音是 fire-and-forget，靠自身的 ended/error 收尾。
        }
        /** 随台词一起暂停。只作用于循环轨；事件音是短音，让它自然响完。 */
        function pause() {
            for (const r of TRACK_RULES) {
                if (r.kind !== 'ambient') continue;
                const st = playing[r.id];
                if (!st || !st.audio || st.audio.paused) continue;
                pausedByPlayback.add(r.id);
                try { st.audio.pause(); } catch (e) { /* 忽略 */ }
            }
            if (pausedByPlayback.size) console.log('[MoonVoice][Ambient] 循环轨随播放暂停:', [...pausedByPlayback].join(','));
        }
        /** 随台词一起恢复。只恢复确实是被我们暂停的那些，避免误播。 */
        function resume() {
            const ids = [...pausedByPlayback];
            pausedByPlayback.clear();
            for (const id of ids) {
                const st = playing[id];
                if (!st || !st.audio || !st.audio.paused) continue;
                try {
                    st.audio.play().catch(e => console.warn(`[MoonVoice][Ambient] 恢复 ${id} 失败:`, e));
                    console.log(`[MoonVoice][Ambient] 循环轨随播放恢复: ${id}`);
                } catch (e) { /* 忽略 */ }
            }
        }

        /**
         * 设置音量。
         *   setVolume(0.5)                 —— 旧签名：作用于环境音轨（播放器窗口的快捷按钮在用）
         *   setVolume('ambient1', 0.3)     —— 按轨道设置（设置面板用）
         */
        function setVolume(a, b) {
            const trackId = (typeof a === 'string') ? a : 'ambient';
            const raw = (typeof a === 'string') ? b : a;
            const v = Math.max(0, Math.min(1, parseFloat(raw) || 0));
            const s = getSettings();
            s[_ruleOf(trackId)?.volumeKey || 'ambientSoundVolume'] = v;
            saveSettings();
            const st = playing[trackId];
            if (st && st.audio && !st.audio.paused) { _cancelFade(st.audio); st.audio.volume = v; }
        }
        function getVolume(trackId = 'ambient') { return _trackVolume(trackId); }

        return { init, preloadScenes, setDirHandle, getDirHandle, requestPermission, playScene, stop, stopImmediate, setVolume, getVolume, isEventScene, pause, resume };
    })();

    function fetchWithTimeout(url, options = {}, timeout = 90000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        return fetch(url, { ...options, signal: controller.signal })
            .finally(() => clearTimeout(timeoutId));
    }

    // ==================== NPC 音色自动分配 ====================
    // 大模型会创造新角色，插件自动为它们建条目（音色为空）。原逻辑是所有未绑定角色
    // 共用同一个回退音色；这里改成按角色名确定性分配，让不同 NPC 拿到不同声音。
    let npcVoicePool = [];   // 缓存：可用于 NPC 的音色（已配逐字稿）

    async function refreshNpcVoicePool() {
        try {
            const s = getSettings();
            const url = s.voiceListUrl || 'http://127.0.0.1:7881/voices';
            const res = await fetchWithTimeout(url, { mode: 'cors' });
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.voices || []);
            npcVoicePool = list
                .filter(v => v && typeof v === 'object' && v.ready !== false)
                .map(v => ({ id: v.filename || v.name, tag: v.tag || '' }))
                .filter(v => v.id);
            npcResolvedCache = {};   // 池子变了，重新分配
            const tagged = npcVoicePool.filter(v => v.tag).length;
            console.log(`[MoonVoice] NPC 音色池已更新: 共 ${npcVoicePool.length} 个，其中有标签 ${tagged} 个`);
        } catch (e) {
            console.warn('[MoonVoice] 获取 NPC 音色池失败，沿用上次结果:', e);
        }
        return npcVoicePool;
    }

    // FNV-1a：同一个名字永远得到同一个下标，跨会话稳定
    function hashName(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    // 与 sidecar 的 VOICE_TAGS 保持一致
    const VOICE_TAGS = ['男-儿童', '男-少年', '男-青年', '男-中年', '男-老年',
                        '女-儿童', '女-少年', '女-青年', '女-中年', '女-老年', '中性-未定'];
    const AGE_ORDER = ['儿童', '少年', '青年', '中年', '老年'];

    let npcResolvedCache = {};   // 角色名 -> 音色 id，保证同一会话内同一角色永远同一音色

    function parseVoiceTag(tag) {
        const t = String(tag || '').trim();
        if (!VOICE_TAGS.includes(t)) return null;
        const parts = t.split('-');
        return { gender: parts[0], age: parts[1], raw: t };
    }

    // 角色名可能带标签： [中年车夫|男-中年]  ->  name="中年车夫", tag="男-中年"
    // 容错：没有竖线时整串当名字；标签非法时同样退回无标签
    function splitVoiceTag(raw) {
        const parts = String(raw || '').split('|').map(s => s.trim());
        const tag = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
        return { name: parts[0] || '', tag: tag };
    }

    /**
     * 给未绑定角色挑音色。
     *
     * 缓存键只用**角色名**（保证同一角色整篇声音稳定），但**只有带着有效标签做出的
     * 决定才写进缓存**。原因：无标签的调用会走「全池按名字哈希随机」那条兜底分支，
     * 一旦写进缓存，该角色的音色就被永久定死成这个不看标签的结果——之后播放时即使
     * 老老实实传了标签，也会在缓存第一行直接返回。
     *
     * @param {string} character 角色名（不含标签）
     * @param {string} [voiceTag] 来自 [角色名|性别-年龄段]
     * @param {{commit?: boolean}} [opts] commit=false 表示只查询、不写缓存（面板展示用）
     */
    function resolveNpcVoice(character, voiceTag, opts) {
        const s = getSettings();
        if (s.npcAutoVoice === false) return '';
        const key = String(character || '');
        if (!key) return '';
        // 缓存只认名字：模型偶尔漏写标签时，也不该让同一角色换声音
        if (npcResolvedCache[key]) return npcResolvedCache[key];

        const commit = !opts || opts.commit !== false;
        let picked = '';
        let decided = false;   // 这个决定是否值得记住
        const custom = Array.isArray(s.npcVoicePool) ? s.npcVoicePool.filter(Boolean) : [];
        if (custom.length) {
            // 用户显式指定了音色池，直接用（与标签无关，可以记）
            picked = custom[hashName(key) % custom.length];
            decided = true;
        } else {
            // 只把「有标签」的音色（标签文件夹里的）用于 NPC 分配；
            // 根目录音色没有标签，留给主角显式绑定，避免 NPC 抢主角的声音。
            const pool = (npcVoicePool || []).filter(v => v && v.tag);
            if (pool.length) {
                const want = parseVoiceTag(voiceTag);
                decided = !!want;   // 没有标签就是临时查询，别写缓存
                const exact = want ? pool.filter(v => v.tag === want.raw) : [];
                if (exact.length) {
                    picked = exact[hashName(key) % exact.length].id;
                } else if (want) {
                    // 没有同标签的，就在全池里打分挑最接近的
                    let best = -Infinity, bestList = [];
                    for (const v of pool) {
                        const vt = parseVoiceTag(v.tag);
                        let sc = 0;
                        if (vt) {
                            if (vt.gender === want.gender) sc += 2;
                            else if (vt.gender === '中性') sc += 1;
                            else sc -= 1;
                            const d = Math.abs(AGE_ORDER.indexOf(vt.age) - AGE_ORDER.indexOf(want.age));
                            if (d === 0) sc += 2;
                            else if (d === 1) sc += 1;
                            else sc -= 1;
                        }
                        if (sc > best) { best = sc; bestList = [v]; }
                        else if (sc === best) bestList.push(v);
                    }
                    picked = bestList[hashName(key) % bestList.length].id;
                } else {
                    picked = pool[hashName(key) % pool.length].id;
                }
            }
        }

        if (picked) {
            const cacheable = commit && decided;
            if (cacheable) npcResolvedCache[key] = picked;
            console.log(`[MoonVoice] NPC 分配: "${key}"${voiceTag ? '（' + voiceTag + '）' : '（无标签）'} -> ${picked}`
                + (cacheable ? '' : '（临时，不写缓存）'));
        }
        return picked;
    }

    // 逐字稿是 Breeze 的合成条件之一：改了稿子输出就变，必须换缓存键，
    // 否则旧音频（用错误逐字稿合成的）会被一直复用。这里按当前音色库实时取值。
    async function fetchVoiceTranscript(voiceId) {
        if (!voiceId) return '';
        try {
            const s = getSettings();
            const url = s.voiceListUrl || 'http://127.0.0.1:7881/voices';
            const res = await fetchWithTimeout(url, { mode: 'cors' });
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.voices || []);
            const hit = list.find(v => v && typeof v === 'object' && (v.filename || v.name) === voiceId);
            return hit ? (hit.ref_text || '') : '';
        } catch (e) {
            console.warn('[MoonVoice] 读取音色逐字稿失败（不影响合成，只是缓存键少一个维度）:', e);
            return '';
        }
    }

    async function generateHash(character, voiceId, text, speed, volume, emotion, voiceFp) {
        // emotion 现在是完整的情感描述（instruction），必须参与哈希，
        // 否则换一种情绪写法会命中旧音频。
        const emotionPart = emotion ? `|${emotion}` : '';
        // voiceFp = 该音色的逐字稿；改动它必须让缓存失效
        const voicePart = voiceFp ? `|v:${voiceFp}` : '';
        const input = `${character || ''}|${voiceId || ''}|${speed}|${volume}|${text || ''}${emotionPart}${voicePart}`;
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(input);
            if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
                const digest = await window.crypto.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(digest));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }
        } catch (e) { console.warn('[MoonVoice] SHA-256哈希失败，回退到简单哈希:', e); }
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const ch = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + ch;
            hash |= 0;
        }
        return `fallback_${hash.toString(16)}`;
    }

    // ==================== 音频转码 ====================
    async function convertToWav(file) {
        console.log(`[MoonVoice] Converting: ${file.name} (${file.type}, ${file.size} bytes)`);
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const arrayBuffer = reader.result;
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                    const wavBlob = audioBufferToWav(audioBuffer);
                    const base64 = await blobToBase64Pure(wavBlob);
                    await audioContext.close();
                    resolve(base64);
                } catch (e) { console.error('[MoonVoice] 音频转码失败:', e); reject(e); }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    function audioBufferToWav(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length * numChannels;
        const samples = new Int16Array(length);
        for (let ch = 0; ch < numChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < audioBuffer.length; i++) {
                const s = Math.max(-1, Math.min(1, data[i]));
                samples[i * numChannels + ch] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
        }
        const dataLen = samples.length * 2;
        const buffer = new ArrayBuffer(44 + dataLen);
        const view = new DataView(buffer);
        const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * numChannels * 2, true);
        view.setUint16(32, numChannels * 2, true); view.setUint16(34, 16, true); writeStr(36, 'data');
        view.setUint32(40, dataLen, true);
        for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
        return new Blob([buffer], { type: 'audio/wav' });
    }

    function blobToBase64Pure(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => { const result = reader.result; resolve(result.includes(',') ? result.split(',')[1] : result); };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // ==================== GAL/听书/RP模式解析 ====================
    // 原版此处有「情绪词 -> 8 维情感向量」映射表与 getEmotionVectorFromText()。
    // Breeze TTS 2 没有情感向量，改用自然语言 instruction，故整块移除。

    function parseVNLine(text) {
        try {
            const settings = getSettings();
            const mode = settings.parsingMode || 'gal';
            if (mode !== 'gal') return null;
            const trimmed = (text || '').trim().replace(/\s+/g, ' ').trim();
            if (!trimmed) return null;
            let emotion = null;
            // Breeze：第二对方括号里是自然语言的情感描述（由大模型生成），
            // 原样透传为合成指令，不再查表映射成 8 维向量。
            const applyTextEmotion = (label) => {
                if (!emotion && label && label.trim()) { emotion = label.trim(); }
            };

            // 格式1: [角色][表情][场景]「对话」 或 [角色][表情][场景] 对话（三重标签）
            // 第三个方括号用 * 而非 +：上游用 + 时，空场景 `[角色][情感][]“台词”` 匹配失败，
            // 会退到其它分支并把方括号混进台词（解析成 `[]“台词”`）。本插件提示词允许留空场景，故修正。
            const threeTagRegex = /^\s*\[([^\]\n]+)\]\s*\[([^\]\n]*)\]\s*\[([^\]\n]*)\]\s*:?\s*([「"“『](.*?)[」"”』]|.+)\s*$/;
            const m3 = trimmed.match(threeTagRegex);
            if (m3) {
                const _rc = splitVoiceTag((m3[1] || '').replace(/\s+/g, ' ').trim());
                const character = _rc.name;
                const voiceTag = _rc.tag;
                const expression = (m3[2] || '').replace(/\s+/g, ' ').trim();
                const scene = (m3[3] || '').replace(/\s+/g, ' ').trim();
                const rawContent = (m3[4] || '').trim();
                const quoteInner = m3[5];
                const inner = quoteInner !== undefined ? quoteInner.trim() : rawContent;
                if (character && inner) {
                    applyTextEmotion(expression);
                    const r3 = { character, scene, dialogue: inner, rawContent, quoted: rawContent, isQuoted: quoteInner !== undefined, emotion, voiceTag };
                    return r3;
                }
            }

            // 格式2: [角色][表情]「对话」 或 [角色][表情] 对话（两重标签）
            const pipeTagRegex = /^\s*\[([^\]\n]+)\]\s*(?:\|\s*)?\[([^\]]*)\]\s*:?\s*([「"“『](.*?)[」"”』]|.+)\s*$/;
            let match = trimmed.match(pipeTagRegex);
            if (match) {
                const _rc2 = splitVoiceTag((match[1] || '').replace(/\s+/g, ' ').trim());
                const character = _rc2.name;
                const voiceTag = _rc2.tag;
                const expression = (match[2] || '').replace(/\s+/g, ' ').trim();
                const rawContent = (match[3] || '').trim();
                const quoteInner = match[4];
                const inner = quoteInner !== undefined ? quoteInner.trim() : rawContent;
                if (character && inner) {
                    applyTextEmotion(expression);
                    return { character, dialogue: inner, rawContent, quoted: rawContent, isQuoted: quoteInner !== undefined, emotion, voiceTag };
                }
            }

            // 格式3 & 4: [角色]「对话」 或 [角色] 对话（无表情标签，允许无空格紧接引号）
            const bracketRegex = /^\s*\[([^\]]+)\](?:\[[\d.,\s-]*\])?\s*([「"“『](.*?)[」"”』]|.+)\s*$/;
            match = trimmed.match(bracketRegex);
            if (match) {
                const _rc3 = splitVoiceTag((match[1] || '').replace(/\s+/g, ' ').trim());
                const character = _rc3.name;
                const voiceTag = _rc3.tag;
                let content = (match[2] || '').trim();
                if (!character || !content) return null;
                const quoteMatch = content.match(/^[「"“『](.*?)[」"”』]\s*$/);
                const dialogue = quoteMatch ? quoteMatch[1].trim() : content;
                if (!dialogue) return null;
                return { character, dialogue, rawContent: content, quoted: content, isQuoted: !!quoteMatch, emotion, voiceTag };
            }

            // 格式5 & 6: [角色] 台词（无引号，允许无空格紧接内容）
            const noQuoteRegex = /^\s*\[([^\]]+)\]\s*(.+)\s*$/;
            match = trimmed.match(noQuoteRegex);
            if (match) {
                const _rc4 = splitVoiceTag((match[1] || '').replace(/\s+/g, ' ').trim());
                const character = _rc4.name;
                const voiceTag = _rc4.tag;
                const dialogue = (match[2] || '').trim();
                if (character && dialogue) {
                    return { character, dialogue, rawContent: dialogue, quoted: dialogue, isQuoted: false, emotion, voiceTag };
                }
            }
            return null;
        } catch (e) { console.error('[MoonVoice] parseVNLine error:', e); }
        return null;
    }

    /**
     * 剥离思考类标签（think/thinking/thought/summary/details）及其全部内容
     * 兼容两种形式：<think>...</think> 和被HTML转义的 &lt;think&gt;...&lt;/think&gt;
     */
    function stripThinkBlocks(text) {
        if (!text) return text;
        const before = text;
        // 原生形式
        text = text.replace(/<(think|thinking|thought|summary|details)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '');
        // 转义实体形式
        text = text.replace(/&lt;(think|thinking|thought|summary|details)(\s[^&>]*)?&gt;[\s\S]*?&lt;\/\1\s*&gt;/gi, '');
        if (before !== text) {
            console.log('[MoonVoice] 思考标签块已剥离');
        }
        return text;
    }
    
    /**
     * 剥离"仅影响显示"正则产生的装饰性 HTML 块
     * 特征：带 inline style 的 div/span，或非标准 HTML 标签（如 <status>）
     * 注意：只删"装饰块"，不碰普通格式标签（<b>、<em> 等）
     */
    function stripDecorativeBlocks(html) {
        if (!html) return html;
        let text = html;
        let prev;
        // 循环处理嵌套标签，直到扫不干净为止
        do {
            prev = text;
            // 1. 带 style 属性的 div/span → 整段删除（标签+内容一起删）;限制：只删带 style 的，避免误杀普通 div
            text = text.replace(/<div\b[^>]*?\bstyle\s*=[^>]*?>[\s\S]*?<\/div\s*>/gi, ' ');
            text = text.replace(/<span\b[^>]*?\bstyle\s*=[^>]*?>[\s\S]*?<\/span\s*>/gi, ' ');
            // 2. 非标准 HTML 标签（如 <status>、<card>、<think-block> 等）→ 整段删除
            const allowedTags = 'div|span|p|br|b|strong|em|i|u|s|strike|del|ins|code|pre|font|mark|small|big|sub|sup|center|q|cite|nobr|h[1-6]|a|img|ul|ol|li|blockquote|table|tr|td|th|thead|tbody|hr';
            text = text.replace(new RegExp(`<(?!/?(?:${allowedTags})\\b)[a-z][a-z0-9]*\\b[^>]*>[\\s\\S]*?</[a-z][a-z0-9]*\\s*>`, 'gi'), ' ');
        } while (text !== prev);
        return text;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * RP模式解析：提取各种引号内的内容，避免跨类型匹配
     * 支持：「」 "" 『』 “” ‘’
     */
    function parseRP(text) {
        const quoteRegex = /(「([^」]+)」|"([^"]+)"|『([^』]+)』|“([^”]+)”|‘([^’]+)’)/g;
        const matches = [];
        let match;
        while ((match = quoteRegex.exec(text)) !== null) {
            const dialogue = match[2] || match[3] || match[4] || match[5] || match[6];
            if (dialogue) {
                matches.push({ dialogue: dialogue.trim(), rawContent: match[0] });
            }
        }
        return matches;
    }

    /**
     * 收集当前聊天里出现过的角色，**连同它们的「性别-年龄段」标签一起返回**。
     *
     * 标签是 NPC 音色分配的唯一依据。这个函数以前只返回名字、把 parseVNLine 已经解析
     * 出来的 voiceTag 丢掉了，于是配音面板只能做无标签分配（全池哈希随机），
     * 还会把那个随机结果写进缓存，导致播放时标签失效。
     *
     * 同一角色在不同行可能带不同标签，取**首次出现的非空标签**（先出现的先定）。
     *
     * @returns {Array<{name: string, tag: string}>} 按名字排序
     */
    function getMergedCharacterList() {
        /** @type {Map<string, string>} 角色名 -> 标签（可能为空串） */
        const characters = new Map();
        const add = (name, tag) => {
            const n = String(name || '').trim();
            if (!n) return;
            const t = String(tag || '').trim();
            if (!characters.has(n)) characters.set(n, t);
            else if (!characters.get(n) && t) characters.set(n, t);   // 之前空着，这次补上
        };

        const ctx = getContext();
        // 真群聊：从群成员获取角色名（群成员没有台词标签信息）
        if (ctx?.groupId) {
            const group = ctx.groups?.find(g => g.id === ctx.groupId);
            if (group?.members) {
                for (const member of group.members) {
                    const character = ctx.characters?.find(char => char.avatar === member);
                    if (character?.name) add(character.name, '');
                }
            }
        } else {
            // 单角色/GAL模式：优先从底层聊天记录(chat数组)提取原始文本，绕过表层正则隐藏
            const chatArray = ctx?.chat || [];
            document.querySelectorAll('.mes[is_user="false"]').forEach(msgEl => {
                let mesIdAttr = msgEl.getAttribute('mesid') || msgEl.dataset?.mesid || msgEl.getAttribute('data-mesid');
                let rawText = '';
                const mesIdNum = Number(mesIdAttr);
                if (!isNaN(mesIdNum) && chatArray[mesIdNum]) {
                    rawText = chatArray[mesIdNum].mes || '';
                } else {
                    const mesText = msgEl.querySelector('.mes_text');
                    if (mesText) rawText = mesText.innerText || '';
                }
                if (rawText) {
                    rawText.split('\n').forEach(line => {
                        const parsed = parseVNLine(line.trim());
                        if (parsed?.character && !['旁白', 'Narrator'].includes(parsed.character)) {
                            add(parsed.character, parsed.voiceTag);
                        }
                    });
                }
            });
        }
        // 加上已绑定的角色（这些不需要自动分配，标签无关紧要）
        const voiceMap = getVoiceMap();
        Object.keys(voiceMap).forEach(k => add(k, ''));
        return Array.from(characters, ([name, tag]) => ({ name, tag }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ==================== TTS接口与缓存流程 ====================
    /**
     * 推理与缓存核心函数
     * 作用域重构：
     * 1. 自定义正则：全局生效，作为后处理第一步
     * 2. 听书模式：若未启用自定义正则，则执行内置硬过滤
     * 3. GAL/RP模式：不执行内置硬过滤，仅清理空白
     */
    async function ensureAudioRecord({ text, character, voice, allowFetch = true, emotion = null }) {
        if (!text?.trim()) return null;
        const settings = getSettings();
        const originalText = text;
        let processedText = text;

        // 1. 全局自定义正则过滤（所有模式生效）
        if (settings.regexFilter?.enabled && settings.regexFilter?.pattern) {
            try {
                const userRegex = new RegExp(settings.regexFilter.pattern, 'gm');
                const beforeUser = processedText;
                processedText = processedText.replace(userRegex, '');
                console.log('[MoonVoice] 用户正则过滤:', beforeUser, '->', processedText);
            } catch (e) {
                console.warn('[MoonVoice] 用户正则错误:', e);
            }
        }

        // 2. 听书模式内置硬过滤（若用户启用了自定义正则，则跳过内置硬过滤）
        if (settings.parsingMode === 'audiobook' && !(settings.regexFilter?.enabled)) {
            console.log('[MoonVoice] ===== 听书模式内置硬过滤开始 =====');
            console.log('[MoonVoice] 原始文本:', JSON.stringify(originalText));
            // 2.1 保护加粗内容（用占位符）
            const boldMap = new Map();
            let boldIndex = 0;
            processedText = processedText.replace(/\*\*([^*]+)\*\*/g, (match, content) => {
                const placeholder = `{{BOLD:${boldIndex}}}`;
                boldMap.set(placeholder, content);
                boldIndex++;
                console.log(`[MoonVoice] 加粗保护: ${match} ->${placeholder}`);
                return placeholder;
            });

            // 2.2 处理超链接（保留文字，删除链接部分，替换成空格避免粘连）
            processedText = processedText.replace(/\[([^\]]+)\]\([^\)]+\)/g, ' ');

            // 2.3 定义需要删除的整个格式（包括内部文字）
            const patterns = [
                { regex: /```[\s\S]*?```/g, name: '多行代码块' },
                { regex: /`[^`]*`/g, name: '行内代码' },
                { regex: /:[a-z_]+:/g, name: 'Emoji短代码' },
                { regex: /^[\-\+]\s+/gm, name: '列表符号' },
                { regex: /\*[^*]+\*/g, name: '*斜体*' },
                { regex: /[（(][^）)]*[）)]/g, name: '括号内容' },
                { regex: /<[^>]+>[\s\S]*?<\/[^>]+>/g, name: 'HTML/XML块' },
                { regex: /<[^>]+\/>/g, name: '自闭合标签' },
                { regex: /^#{1,6}\s+/gm, name: 'Markdown标题标记' },
                { regex: /[.#]?[a-zA-Z_-][a-zA-Z0-9_-]*\s*\{[^}]*\}/g, name: 'CSS块' },
                { regex: /https?:\/\/[^\s]+/g, name: 'URL' },
                { regex: /www\.[^\s]+/g, name: 'www链接' },
                { regex: /[\w\.-]+@[\w\.-]+\.\w+/g, name: '邮箱' },
                { regex: /ISBN[:\s]*[\d\-X]+/gi, name: 'ISBN' },
                { regex: /\[\d+\]/g, name: '方括号脚注' },
                { regex: /\(\d+\)/g, name: '圆括号脚注' },
                { regex: /(?<=[\u4e00-\u9fa5])\s*\/\s*(?=[\u4e00-\u9fa5])/g, name: '中文间斜杠' }
            ];
            patterns.forEach(({ regex, name }) => {
                const before = processedText;
                processedText = processedText.replace(regex, '');
                if (before !== processedText) {
                    console.log(`[MoonVoice] 删除${name}:${regex.source} -> 剩余: ${JSON.stringify(processedText)}`);
                }
            });

            // 2.4 还原加粗内容（先还原，再删符号，确保加粗内的引号/括号也被清理）
            boldMap.forEach((content, placeholder) => {
                processedText = processedText.split(placeholder).join(content);
            });
            console.log('[MoonVoice] 加粗还原完成');

            // 2.5 替换破折号为逗号
            processedText = processedText.replace(/—+/g, '，');

            // 2.6 仅删除特定标点符号，保留内部文字
            const symbolOnlyRegex = /["“”‘’「」『』\[\]【】{}|]/g;
            processedText = processedText.replace(symbolOnlyRegex, '');

            // 2.7 清理多余空白，并消除中文之间的空格，保留换行符以供后续分段使用
            processedText = processedText
                .replace(/[ \t]+/g, ' ')          // 合并水平空白
                .replace(/([\u4e00-\u9fa5，。！？、；：])\s+(?=[\u4e00-\u9fa5，。！？、；：])/g, '$1') // 去除中文及中文标点之间的空格
                .replace(/\n{2,}/g, '\n')          // 合并多余换行
                .trim();
            console.log('[MoonVoice] 过滤后文本:', JSON.stringify(processedText));
            console.log('[MoonVoice] ===== 文本处理结束 =====');
        } else {
            // GAL/RP 模式：只清理水平空白，保留格式符号和换行结构
            processedText = processedText.replace(/[ \t]+/g, ' ').trim();
        }

        text = processedText;

        // 缓存和 API 逻辑
        const normVoice = ensureWavSuffix(voice || settings.defaultVoice);
        const speed = parseFloat(settings.speed || 1.0) || 1.0;
        const volume = parseFloat(settings.volume || 1.0) || 1.0;
        const voiceFp = await fetchVoiceTranscript(normVoice);
        const hash = await generateHash(character || 'Unknown', normVoice, text, speed, volume, emotion, voiceFp);

        try {
            const cached = await AudioStorage.getAudio(hash);
            if (cached && cached.blob) {
                return { hash, blob: cached.blob, character, text, voice: normVoice, speed, volume, isCached: true };
            }
        } catch (e) { console.warn('[MoonVoice] 读取缓存失败:', e); }

        if (!allowFetch) {
            return null;
        }

        // Breeze sidecar 契约：emotion 即大模型给出的自然语言情感描述，
        // 直接作为 instruction 透传。缺省时由 sidecar 回退到该音色的默认指令。
        const payload = {
            text: text,
            prompt_audio: normVoice,
        };
        if (emotion && String(emotion).trim()) {
            payload.instruction = String(emotion).trim();
        }

        try {
            const res = await fetchWithTimeout(settings.apiUrl, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}${errText || ''}`);
            }
            const blob = await res.blob();
            const record = { hash, blob, character, text, voice: normVoice, speed, volume, timestamp: Date.now(), isCached: false };
            AudioStorage.saveAudio(record).catch(e => { console.warn('[MoonVoice] 保存缓存失败:', e); });
            return record;
        } catch (e) {
            console.error('[MoonVoice] TTS API Error:', e);
            if (e instanceof TypeError || (e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')))) {
                console.warn('后端离线，仅使用本地缓存');
                return null;
            }
            throw e;
        }
    }

    async function playSingleLine(text, voiceFile, character, context) {
        if (!text?.trim()) return;
        const ctx = context || {};
        const allowFetch = ctx.autoInfer === false ? false : true;
        const emotion = ctx.emotion || null;
        const scene = ctx.scene || null;
        let msg = ctx.msg || null;
        const encT = ctx.encT || utf8ToBase64(text);
        const encC = ctx.encC || utf8ToBase64(character || '');

        let finalVoice = voiceFile;
        if (!finalVoice) {
            const voiceMap = getVoiceMap();
            if (character && voiceMap[character]) {
                finalVoice = voiceMap[character];
                console.log(`[MoonVoice] 使用绑定语音: 角色="${character}" -> "${finalVoice}"`);
            } else {
                // 旁白或未绑定角色：先尝试 NPC 自动分配，再回退到卡片首个音频
                // ctx.voiceTag 由行内 span 的 data-g 带过来（见 injectInlineButtons）
                const npcVoice = resolveNpcVoice(character, ctx.voiceTag);
                const cardVoices = Object.values(voiceMap).filter(Boolean);
                if (npcVoice) {
                    finalVoice = npcVoice;
                    console.log(`[MoonVoice] 角色 "${character}" 未绑定 -> 自动分配: "${finalVoice}"`);
                } else if (cardVoices.length > 0) {
                    finalVoice = cardVoices[0];
                    console.log(`[MoonVoice] 角色 "${character}" 未绑定，回退到卡片首个音频: "${finalVoice}"`);
                } else {
                    // 卡片完全没绑定任何音频，才使用默认语音
                    finalVoice = getSettings().defaultVoice;
                    console.log(`[MoonVoice] 当前卡片无任何绑定音频，使用全局默认: "${finalVoice}"`);
                }
            }
        } else {
        }

        const mesId = ctx.mesId || (msg ? getMessageId(msg) : null);
        if (mesId && audioCache[mesId]) {
            const cleanText = text.trim();
            const recordInCache = audioCache[mesId].find(r => r.text === cleanText);
            if (recordInCache && recordInCache.blobUrl) {
                playAudioFromRecord({ blobUrl: recordInCache.blobUrl, msg, encT, encC, character, text: cleanText, volume: ctx.volume, scene });
                return;
            }
        }

        let record;
        try {
            record = await ensureAudioRecord({ text, character, voice: finalVoice, allowFetch, emotion });
            if (!record) return;
        } catch (e) {
            if (window.toastr) window.toastr.error('TTS失败: ' + e.message);
            return;
        }
        const url = URL.createObjectURL(record.blob);
        playAudioFromRecord({ blobUrl: url, msg, encT, encC, character, text, volume: record.volume, shouldRevoke: true, scene });
    }

    async function playAudioFromRecord({ blobUrl, msg, encT, encC, character, text, volume, shouldRevoke = false, scene = null }) {
        const audio = new Audio(blobUrl);
        const settings = getSettings();
        let vol = isNaN(volume) ? (settings.volume || 1.0) : volume;
        vol = Math.max(0, Math.min(1.0, vol));// 强制限制在 0 ~ 1.0 之间，防止 HTMLMediaElement 报错
        audio.volume = vol;
        if (msg) { clearPlayingInMessage(msg); setLinePlayingByEncoded(msg, encT, encC, true); }
        if (typeof currentPlayback.stop === 'function') {
            currentPlayback.stop(); // 中断旧播放：暂停、清事件、释放其临时 blobUrl（如有）
        } else if (currentPlayback.audio) {
            try {
                currentPlayback.audio.pause();
            } catch (e) {
            }
        }
        if (currentPlayback.msg && currentPlayback.msg !== msg) {
            clearPlayingInMessage(currentPlayback.msg); // 清除旧消息上残留的播放高亮
        }
        currentPlayback = { audio, msg, mesId: msg ? getMessageId(msg) : null, blobUrl, shouldRevoke, index: -1, playlist: null, totalDuration: 0, controller: null, stop: function () { if (this.audio) { try { this.audio.pause(); this.audio.onended = null; this.audio.onerror = null; } catch (e) { } } if (this.shouldRevoke && this.blobUrl) { try { URL.revokeObjectURL(this.blobUrl); } catch (e) { } } this.audio = null; } };

        attachBottomProgress(audio);
        AmbientPlayer.playScene(scene || null);
        const cleanup = () => {
            if (shouldRevoke) URL.revokeObjectURL(blobUrl);
            if (msg) { setLinePlayingByEncoded(msg, encT, encC, false); }
            AmbientPlayer.stop();
        };
        audio.onended = cleanup;
        audio.onerror = cleanup;
        try {
            await audio.play();
        } catch (e) {
            cleanup();
            console.error('[MoonVoice] 音频播放失败:', e);
            if (e.name === 'NotAllowedError') {
                if (window.toastr) window.toastr.warning('浏览器已拦截自动播放，请先点击页面任意处，或手动点击播放按钮');
            } else {
                if (window.toastr) window.toastr.error('播放失败: ' + e.message);
            }
        }
    }

    async function playTTS(text, voiceFile) { return playSingleLine(text, voiceFile, '', {}); }

    // ==================== 音声克隆 ====================
    async function cloneVoice(characterName, base64Audio, originalFileName) {
        const settings = getSettings();
        console.log(`[MoonVoice] Clone: ${characterName}, base64 len=${base64Audio.length}`);
        try {
            const byteString = atob(base64Audio);
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
            const blob = new Blob([ab], { type: 'audio/wav' });
            const uploadFileName = originalFileName || (characterName + '.wav');
            const formData = new FormData();
            formData.append('file', blob, uploadFileName);
            const baseUrl = (settings.cloningUrl || 'http://127.0.0.1:7881/api/v1/breezetts2_cloning').replace(/\/api\/v1\/breezetts2_cloning.*$/ , '').replace(/\/+$/, '');
            const uploadUrl = baseUrl + '/api/v1/upload';
            console.log(`[MoonVoice] Uploading to: ${uploadUrl}, filename:${uploadFileName}`);
            const res = await fetchWithTimeout(uploadUrl, { method: 'POST', mode: 'cors', body: formData });
            const text = await res.text();
            if (!res.ok) { if (window.toastr) window.toastr.error(`上传失败 HTTP ${res.status}:${text}`); return null; }
            const data = JSON.parse(text);
            const id = data.filename || data.id || data.voice_id || data.name;
            if (id) { if (window.toastr) window.toastr.success(`参考音频上传成功: ${id}`); return id; }
            return null;
        } catch (e) {
            console.error('[MoonVoice] 克隆失败:', e);
            if (window.toastr) window.toastr.error('上传失败: ' + e.message);
            return null;
        }
    }

    // ==================== 配音配置面板 ====================
    function showConfigPopup() {
        const cardId = getCardId();
        const cardName = getCardName();
        const settings = getSettings();
        const voiceMap = getVoiceMap();

        const renderListResults = () => {
            const characters = getMergedCharacterList();
            const container = document.getElementById('breezetts2-char-list-container');
            if (!container) return;
            let rowsHtml = characters.length === 0 ? '<div class="breezetts2-empty">未检测到角色 [角色|...]|「对话」</div>' : characters.map(entry => {
                const char = entry.name;
                const voice = voiceMap[char];
                // 面板只是"看一眼会分到谁"，所以按标签算但不写缓存（commit:false）——
                // 查看配置这个动作不该改变实际分配结果。
                const autoNpc = voice ? '' : resolveNpcVoice(char, entry.tag, { commit: false });
                const taggedCount = (npcVoicePool || []).filter(v => v && v.tag).length;
                return `
                <div class="breezetts2-char-row" data-char="${char}">
                    <div class="breezetts2-char-name" title="${char}">${char}</div>
                    <div class="breezetts2-char-audio">
                        <select class="breezetts2-voice-select text_pole" data-char="${char}">
                            <option value="">-- 加载中... --</option>
                        </select>
                        <input type="text" class="breezetts2-voice-input text_pole" data-char="${char}" value="${voice || ''}" placeholder="文件名.wav">
                        <div class="breezetts2-del-btn" data-char="${char}" title="删除配置"><i class="fa-solid fa-trash"></i></div>
                    </div>
                    <textarea class="breezetts2-voice-text text_pole" data-char="${char}" rows="2"
                        placeholder="先选择参考音频"></textarea>
                    ${autoNpc ? `<div class="breezetts2-npc-hint">未绑定 → 按台词里的性别-年龄标签自动分配（当前 ${taggedCount} 个带标签音色）</div>` : ''}
                </div>
            `}).join('');
            container.innerHTML = `<div class="breezetts2-list-header"><span>角色</span><span>参考音频 / 逐字稿</span></div>${rowsHtml}`;
            bindRowEvents(container);
        };

        const modal = document.createElement('div');
        modal.id = 'breezetts2-modal';
        modal.className = 'breezetts2-modal-overlay';
        modal.innerHTML = `
            <div class="breezetts2-modal-box">
                <div class="breezetts2-popup-header"><h3>🎙️ 配音配置 - ${cardName}</h3></div>
                <div class="breezetts2-preset-bar-popup">
                    <select id="breezetts2-popup-preset-select" class="text_pole"></select>
                    <input type="text" id="breezetts2-popup-preset-name" class="text_pole" placeholder="预设名称">
                    <div id="breezetts2-popup-preset-save" class="menu_button" title="保存/新建预设"><i class="fa-solid fa-floppy-disk"></i></div>
                    <div id="breezetts2-popup-preset-delete" class="menu_button" title="删除预设"><i class="fa-solid fa-trash-can"></i></div>
                </div>
                <div class="breezetts2-add-container">
                    <input type="text" id="breezetts2-new-char" class="text_pole" placeholder="输入新角色名">
                    <button class="menu_button" id="breezetts2-add-btn"><i class="fa-solid fa-plus"></i> 添加</button>
                </div>
                <div class="breezetts2-npc-bar">
                    <label class="breezetts2-npc-auto">
                        <input type="checkbox" id="breezetts2-npc-auto"${settings.npcAutoVoice !== false ? ' checked' : ''}>
                        未绑定角色自动分配音色
                    </label>
                    <input type="text" id="breezetts2-npc-pool" class="text_pole"
                        placeholder="NPC 音色池（留空 = 音色库全部已配逐字稿的音色，逗号分隔文件名）"
                        value="${(Array.isArray(settings.npcVoicePool) ? settings.npcVoicePool : []).join(',')}">
                </div>
                <div class="breezetts2-quick-actions">
                    <button class="menu_button" id="breezetts2-import"><i class="fa-solid fa-file-import"></i> 导入全部</button>
                    <button class="menu_button" id="breezetts2-export"><i class="fa-solid fa-file-export"></i> 导出全部</button>
                </div>
                <div class="breezetts2-char-list" id="breezetts2-char-list-container"></div>
                <div class="breezetts2-popup-footer">
                    <button class="menu_button" id="breezetts2-cancel">取消</button>
                    <button class="menu_button menu_button_icon" id="breezetts2-save">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        renderListResults();

        const populatePopupPresetUI = () => {
            const root = getRootSettings();
            const selectEl = modal.querySelector('#breezetts2-popup-preset-select');
            const nameEl = modal.querySelector('#breezetts2-popup-preset-name');
            if (!selectEl || !nameEl) return;
            selectEl.innerHTML = Object.keys(root.presets).map(name => `<option value="${name}"${name === root.selected_preset ? ' selected' : ''}>${name}</option>`).join('');
            nameEl.value = root.selected_preset;
        };
        populatePopupPresetUI();

        const popupPresetSelect = modal.querySelector('#breezetts2-popup-preset-select');
        if (popupPresetSelect) { popupPresetSelect.onchange = () => { switchPreset(popupPresetSelect.value); }; }
        const popupPresetSave = modal.querySelector('#breezetts2-popup-preset-save');
        if (popupPresetSave) {
            popupPresetSave.onclick = () => {
                const root = getRootSettings();
                const nameEl = modal.querySelector('#breezetts2-popup-preset-name');
                const name = (nameEl?.value || '').trim();
                if (!name) { if (window.toastr) window.toastr.warning('请输入预设名称'); return; }
                root.presets[name] = JSON.parse(JSON.stringify(getSettings()));
                root.selected_preset = name;
                saveSettings();
                populatePopupPresetUI();
                if (window.toastr) window.toastr.success(`预设 "${name}" 已保存`);
            };
        }
        const popupPresetDel = modal.querySelector('#breezetts2-popup-preset-delete');
        if (popupPresetDel) {
            popupPresetDel.onclick = () => {
                const root = getRootSettings();
                const keys = Object.keys(root.presets);
                if (keys.length <= 1) { if (window.toastr) window.toastr.warning('至少需要保留一个预设'); return; }
                const current = root.selected_preset;
                if (!confirm(`确定要删除预设 "${current}" 吗？`)) return;
                delete root.presets[current];
                switchPreset(Object.keys(root.presets)[0]);
                if (window.toastr) window.toastr.success(`已删除预设 "${current}"`);
            };
        }

        modal.onclick = e => { if (e.target === modal) modal.remove(); };
        modal.querySelector('#breezetts2-cancel').onclick = () => modal.remove();

        const addBtn = modal.querySelector('#breezetts2-add-btn');
        const addInput = modal.querySelector('#breezetts2-new-char');
        const doAdd = () => {
            const name = addInput.value.trim();
            if (name) { if (!voiceMap[name]) { voiceMap[name] = ""; } saveSettings(); addInput.value = ''; renderListResults(); }
        };
        const npcAutoEl = modal.querySelector('#breezetts2-npc-auto');
        if (npcAutoEl) npcAutoEl.onchange = () => {
            getSettings().npcAutoVoice = npcAutoEl.checked;
            saveSettings();
            renderListResults();   // 立即刷新行内的“自动分配”提示
        };
        const npcPoolEl = modal.querySelector('#breezetts2-npc-pool');
        if (npcPoolEl) npcPoolEl.onchange = () => {
            getSettings().npcVoicePool = npcPoolEl.value.split(',').map(s => s.trim()).filter(Boolean);
            saveSettings();
            renderListResults();
        };
        refreshNpcVoicePool().then(() => renderListResults());

        addBtn.onclick = doAdd;
        addInput.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); };

        modal.querySelector('#breezetts2-save').onclick = () => {
            modal.querySelectorAll('.breezetts2-voice-input').forEach(input => {
                const char = input.dataset.char;
                let val = input.value.trim();
                voiceMap[char] = val ? ensureWavSuffix(val) : "";
            });
            saveSettings();
            if (window.toastr) window.toastr.success('已保存');
            modal.remove();
            refreshAllMessages();
        };

        modal.querySelector('#breezetts2-export').onclick = () => {
            const allData = JSON.parse(JSON.stringify(settings.voiceMap));
            const json = JSON.stringify(allData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${getCardName()}_配音配置.json`;
            a.click();
            if (window.toastr) window.toastr.success('已导出全部配置');
        };

        modal.querySelector('#breezetts2-import').onclick = () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.json';
            input.onchange = async () => {
                const file = input.files[0];
                if (!file) return;
                try {
                    const data = JSON.parse(await file.text());
                    Object.entries(data).forEach(([cid, charMap]) => {
                        if (!settings.voiceMap[cid]) settings.voiceMap[cid] = {};
                        Object.assign(settings.voiceMap[cid], charMap);
                    });
                    saveSettings();
                    if (window.toastr) window.toastr.success('已导入');
                    modal.remove();
                    showConfigPopup();
                } catch (e) { if (window.toastr) window.toastr.error('导入失败'); }
            };
            input.click();
        };

        function bindRowEvents(container) {
            container.querySelectorAll('.breezetts2-del-btn').forEach(btn => {
                btn.onclick = () => {
                    const char = btn.dataset.char;
                    if (confirm(`确定要移除角色 "${char}" 的配置吗？`)) {
                        delete voiceMap[char]; saveSettings(); renderListResults();
                    }
                };
            });
            container.querySelectorAll('.breezetts2-voice-input').forEach(input => {
                input.onchange = () => {
                    const char = input.dataset.char;
                    voiceMap[char] = input.value.trim();
                    const sel = container.querySelector(`.breezetts2-voice-select[data-char="${char}"]`);
                    if (sel) {
                        const opt = [...sel.options].find(o => o.value === input.value.trim());
                        if (opt) sel.value = opt.value;
                    }
                    saveSettings();
                };
            });

            const settings = getSettings();
            const voiceListUrl = settings.voiceListUrl || 'http://127.0.0.1:7881/voices' ;
            fetchWithTimeout(voiceListUrl, { mode: 'cors' })
                .then(r => r.json())
                .then(data => {
                    const voices = Array.isArray(data) ? data : (data.voices || []);

                    // 逐字稿属于「音色」而非「角色」，以 sidecar 音色库为唯一数据源
                    const voiceRef = {};
                    voices.forEach(v => {
                        if (v && typeof v === 'object') voiceRef[v.filename || v.name] = v.ref_text || '';
                    });
                    const sidecarBase = (settings.voiceListUrl || 'http://127.0.0.1:7881/voices')
                        .replace(/\/+$/, '').replace(/\/voices$/, '');
                    const saveTranscript = async (voiceId, text) => {
                        try {
                            const res = await fetchWithTimeout(sidecarBase + '/voices/' + encodeURIComponent(voiceId), {
                                method: 'PUT', mode: 'cors',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ref_text: text }),
                            });
                            if (!res.ok) throw new Error('HTTP ' + res.status);
                            if (window.toastr) window.toastr.success('逐字稿已保存：' + voiceId);
                        } catch (e) {
                            if (window.toastr) window.toastr.error('逐字稿保存失败：' + e.message);
                        }
                    };
                    const syncText = (char) => {
                        const ta = container.querySelector(`.breezetts2-voice-text[data-char="${char}"]`);
                        if (!ta) return;
                        const vid = voiceMap[char] || '';
                        ta.dataset.voice = vid;
                        ta.value = voiceRef[vid] || '';
                        ta.placeholder = vid
                            ? '该音色的逐字稿：Breeze 克隆必需，须与参考音频内容完全一致'
                            : '先选择参考音频';
                        ta.classList.toggle('missing', !!vid && !(voiceRef[vid] || '').trim());
                    };

                    container.querySelectorAll('.breezetts2-voice-text').forEach(ta => {
                        const char = ta.dataset.char;
                        syncText(char);
                        ta.onchange = async () => {
                            const vid = ta.dataset.voice || voiceMap[char] || '';
                            if (!vid) {
                                if (window.toastr) window.toastr.warning('请先为该角色选择参考音频');
                                ta.value = '';
                                return;
                            }
                            voiceRef[vid] = ta.value;
                            await saveTranscript(vid, ta.value);
                            ta.classList.toggle('missing', !ta.value.trim());
                        };
                    });

                    container.querySelectorAll('.breezetts2-voice-select').forEach(sel => {
                        const char = sel.dataset.char;
                        const currentVoice = voiceMap[char] || '';
                        sel.innerHTML = '<option value="">-- 请选择参考音频 --</option>' + voices.map(v => {
                            const name = typeof v === 'string' ? v : (v.filename || v.name || v);
                            return `<option value="${name}"${name === currentVoice ? ' selected' : ''}>${name}</option>`;
                        }).join('');
                        if (currentVoice && !voices.some(v => (typeof v === 'string' ? v : (v.filename || v.name)) === currentVoice)) {
                            sel.innerHTML += `<option value="${currentVoice}" selected>${currentVoice} (手动)</option>`;
                        }
                        sel.onchange = () => {
                            const val = sel.value;
                            voiceMap[char] = val;
                            const voiceInput = container.querySelector(`.breezetts2-voice-input[data-char="${char}"]`);
                            if (voiceInput) voiceInput.value = val;
                            syncText(char);
                            saveSettings();
                        };
                    });
                })
                .catch(() => {
                    container.querySelectorAll('.breezetts2-voice-select').forEach(sel => {
                        const char = sel.dataset.char;
                        const currentVoice = voiceMap[char] || '';
                        sel.innerHTML = `<option value="" disabled>⚠ 无法获取列表</option>` + (currentVoice ? `<option value="${currentVoice}" selected>${currentVoice}</option>` : '');
                    });
                });
        }
    }

    async function handleUpload(char, file, dropText, voiceInput) {
        if (dropText) { dropText.textContent = '转码并克隆中...'; dropText.className = 'breezetts2-drop-text cloning'; }
        try {
            const base64 = await convertToWav(file);
            const id = await cloneVoice(char, base64, file.name);
            if (id) {
                const finalId = ensureWavSuffix(id);
                if (dropText) { dropText.textContent = finalId; dropText.className = 'breezetts2-drop-text success'; }
                if (voiceInput) voiceInput.value = finalId;
            } else {
                if (dropText) { dropText.textContent = '失败'; dropText.className = 'breezetts2-drop-text error'; }
            }
        } catch (e) {
            if (dropText) { dropText.textContent = '错误'; dropText.className = 'breezetts2-drop-text error'; }
        }
    }

    // ==================== M消息界面注入 ====================
    function injectMessageButtons(msg) {
        if (msg.querySelector('.breezetts2-msg-btns')) return;
        const btns = msg.querySelector('.mes_buttons');
        if (!btns) return;
        const group = document.createElement('div');
        group.className = 'breezetts2-msg-btns mes_button_row';
        group.innerHTML = `
            <div class="mes_button breezetts2-play" title="播放整楼层"><i class="fa-solid fa-volume-high"></i></div>
            <div class="mes_button breezetts2-infer" title="先推理后播放"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <div class="mes_button breezetts2-cfg" title="配置"><i class="fa-solid fa-cog"></i></div>
        `;
        const playBtn = group.querySelector('.breezetts2-play');
        const inferBtn = group.querySelector('.breezetts2-infer');
        if (playBtn) { playBtn.onclick = e => { e.stopPropagation(); playMessageQueue(msg, playBtn); }; }
        if (inferBtn) { inferBtn.onclick = e => { e.stopPropagation(); inferMessageAudios(msg, inferBtn); }; }
        group.querySelector('.breezetts2-cfg').onclick = e => { e.stopPropagation(); showConfigPopup(); };
        btns.appendChild(group);
    }

    function injectInlineButtons(msg, force = false) {
        const mesText = msg.querySelector('.mes_text');
        if (!mesText) return;
        const settings = getSettings();
        if (settings.enableInline === false) { mesText.dataset.breezetts2Injected = 'true'; return; }

        const mode = settings.parsingMode || 'gal';
        // 听书模式和RP模式不注入行内按钮
        if (mode === 'audiobook' || mode === 'rp') {
            mesText.dataset.breezetts2Injected = 'true';
            return;
        }

        if (!force && mesText.dataset.breezetts2Injected === 'true') {
            if (mesText.querySelector('.breezetts2-inline-play')) return;
        }

        const voiceMap = getVoiceMap();
        
        // GAL 模式：优先读取底层原始数据,保留换行结构提取
        let textContent = '';
        const mesIdForBtn = getMessageId(msg);
        const ctxForBtn = getContext();
        const messageDataForBtn = mesIdForBtn ? ctxForBtn?.chat?.[parseInt(mesIdForBtn)] : null;
        if (messageDataForBtn && messageDataForBtn.mes) {
            textContent = messageDataForBtn.mes;
        } else {
            // 如果底层不可用，则从 DOM 提取
            try {
                const clone = mesText.cloneNode(true);
                clone.querySelectorAll('.breezetts2-inline-play, .breezetts2-dialogue').forEach(el => {
                    if (el.classList.contains('breezetts2-dialogue')) el.replaceWith(...el.childNodes);
                    else el.remove();
                });
                textContent = clone.innerText || '';
            } catch (e) {
                textContent = mesText.innerText || '';
            }
        }

        const lines = textContent.split('\n');
        const vnLines = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = parseVNLine(trimmed);
            if (parsed) {
                vnLines.push({ original: trimmed, parsed: parsed, voice: voiceMap[parsed.character], scene: parsed.scene || null });
            }
        }

        if (vnLines.length === 0) { mesText.dataset.breezetts2Injected = 'true'; return; }

        // 防嵌套：若 DOM 中残留旧的注入标签（外部渲染异常等导致），先解除包裹再重新注入
        mesText.querySelectorAll('.breezetts2-dialogue').forEach(el => el.replaceWith(...el.childNodes));
        mesText.querySelectorAll('.breezetts2-inline-play').forEach(el => el.remove());

        let html = mesText.innerHTML;
        let modified = false;
        for (const vn of vnLines) {
            const enc = utf8ToBase64(vn.parsed.dialogue);
            const charEnc = utf8ToBase64(vn.parsed.character);
            // 标签也要带到行内 span 上：playSingleLine 靠它给未绑定角色挑音色。
            // 以前只带了角色名，于是行内点击播放会做无标签分配、并把结果写进缓存，
            // 让之后所有自动分配都丢掉标签。
            const tagEnc = vn.parsed.voiceTag ? utf8ToBase64(vn.parsed.voiceTag) : '';
            const emotionEnc = vn.parsed.emotion || '';
            const dialogueContent = vn.parsed.rawContent;
            if (!dialogueContent) continue;

            const escapedDialogue = dialogueContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const dialogueRegex = new RegExp(`(${escapedDialogue})(?![^<]*breezetts2-dialogue)`, 'g');
            html = html.replace(dialogueRegex, (match) => {
                if (match.includes('breezetts2-dialogue')) return match;
                modified = true;
                return `<span class="breezetts2-dialogue" data-t="${enc}" data-v="${vn.voice || ''}" data-c="${charEnc}" data-g="${tagEnc}" data-e="${emotionEnc}" data-s="${(vn.scene || '').replace(/"/g, '&quot;')}" title="点击播放">${match}</span><span class="breezetts2-inline-play" data-t="${enc}" data-v="${vn.voice || ''}" data-c="${charEnc}" data-g="${tagEnc}" data-e="${emotionEnc}" data-s="${(vn.scene || '').replace(/"/g, '&quot;')}" title="播放"><i class="fa-solid fa-play fa-xs"></i></span>`;
            });
        }

        if (modified) {
            mesText.innerHTML = html;
            mesText.querySelectorAll('.breezetts2-dialogue').forEach(span => {
                if (span.dataset.bound) return;
                span.dataset.bound = 'true';
                span.onclick = e => {
                    e.stopPropagation();
                    const text = base64ToUtf8(span.dataset.t);
                    const voice = span.dataset.v;
                    const character = base64ToUtf8(span.dataset.c || '');
                    const voiceTag = span.dataset.g ? base64ToUtf8(span.dataset.g) : '';
                    const emotion = span.dataset.e || null;
                    const msgEl = span.closest('.mes');
                    playSingleLine(text, voice, character, { msg: msgEl, encT: span.dataset.t, encC: span.dataset.c, emotion, scene: span.dataset.s || null, voiceTag });
                };
            });
            mesText.querySelectorAll('.breezetts2-inline-play').forEach(btn => {
                if (btn.dataset.bound) return;
                btn.dataset.bound = 'true';
                btn.onclick = e => {
                    e.stopPropagation();
                    const text = base64ToUtf8(btn.dataset.t);
                    const voice = btn.dataset.v;
                    const character = base64ToUtf8(btn.dataset.c || '');
                    const voiceTag = btn.dataset.g ? base64ToUtf8(btn.dataset.g) : '';
                    const emotion = btn.dataset.e || null;
                    const msgEl = btn.closest('.mes');
                    playSingleLine(text, voice, character, { msg: msgEl, encT: btn.dataset.t, encC: btn.dataset.c, emotion, scene: btn.dataset.s || null, voiceTag });
                };
            });
        }
        mesText.dataset.breezetts2Injected = 'true';
    }

    /**
     * 从消息中收集需要推理的文本行
     * 架构重组：文本提取 -> 角色路由 -> 解析模式分发 -> 分段处理
     */
    function collectVNLinesFromMessage(msg) {
        const result = [];
        if (!msg) return result;
        const mesText = msg.querySelector('.mes_text');
        if (!mesText) return result;
        const voiceMap = getVoiceMap();
        const settings = getSettings();
        const mode = settings.parsingMode || 'gal';

        // 提前获取底层原始数据，以供 GAL/RP 模式使用
        const mesId = getMessageId(msg);
        const ctx = getContext();
        const messageData = mesId ? ctx?.chat?.[parseInt(mesId)] : null;

        // 1. 文本提取路径分离
        let textContent = '';
        if (mode === 'audiobook') {
            // 听书模式：当原始消息中存在思考标签时走"剥离+重渲染"路径；若无直接转Markdown，使用 HTML 转 MD，捕捉所有符号，但保留换行符
            const rawMes = messageData && messageData.mes ? messageData.mes : null;
            const hasThinkTags = rawMes && /(<|&lt;)(think|thinking|thought|summary|details)[\s>&]/i.test(rawMes);
            let renderedHtml = null;
            if (hasThinkTags && typeof ctx?.messageFormatting === 'function') {
                try {
                    renderedHtml = ctx.messageFormatting(
                        stripThinkBlocks(rawMes),
                        messageData.name || '',
                        !!messageData.is_system,
                        false,
                        parseInt(mesId)
                    );
                } catch (e) {
                    console.warn('[MoonVoice] messageFormatting 重渲染失败，回退到DOM剥离:', e);
                    renderedHtml = null;
                }
            }
            if (renderedHtml === null) {
                renderedHtml = stripThinkBlocks(mesText.innerHTML);
            }
            textContent = htmlToMarkdown(renderedHtml);
        } else {
            // GAL/RP 模式：优先读取底层原始数据(messageData.mes)
            if (messageData && messageData.mes) {
                textContent = messageData.mes;
            } else {
                // Fallback: 如果底层不可用，则从 DOM 提取
                try {
                    const clone = mesText.cloneNode(true);
                    clone.querySelectorAll('.breezetts2-inline-play, .breezetts2-dialogue').forEach(el => {
                        if (el.classList.contains('breezetts2-dialogue')) el.replaceWith(...el.childNodes);
                        else el.remove();
                    });
                    textContent = clone.innerText || '';
                } catch (e) {
                    textContent = mesText.innerText || '';
                }
            }
        }

        if (!textContent) return result;
        textContent = textContent.replace(/\r/g, '\n');
        textContent = stripThinkBlocks(textContent);


        // 2. 角色路由判定（底层逻辑）
        const isGroupChat = !!ctx?.groupId;
        let speakerName, speakerVoice;

        if (isGroupChat && messageData?.name && !messageData.is_user) {
            // 真群聊：用消息里的角色名
            speakerName = messageData.name;
            speakerVoice = voiceMap[speakerName] || settings.defaultVoice;
        } else {
            // 单人模式：用当前角色卡名
            speakerName = ctx?.name2 || getCardName();
            const voices = Object.values(voiceMap);
            const fallbackVoice = voices.length > 0 ? voices[0] : settings.defaultVoice;
            speakerVoice = voiceMap[speakerName] || fallbackVoice;
        }
        if (!window._breezetts2_logged_routes) window._breezetts2_logged_routes = new Set();
        const routeKey = `${speakerName}_${speakerVoice}`;
        if (!window._breezetts2_logged_routes.has(routeKey)) {
            console.log(`[MoonVoice] 角色路由: speaker="${speakerName}", voice="${speakerVoice}"`);
            window._breezetts2_logged_routes.add(routeKey);
        }


        // 3. 解析模式分发（顶层逻辑）
        if (mode === 'rp') {
            // RP模式：提取引号内容；若消息含有代码则剥离代码块，避免念出代码中的引号内容
            const textForParse = textContent
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`[^`\n]*`/g, ' ')
                .replace(/<([a-z][a-z0-9]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
                .replace(/<[^>]+>/g, ' ');
            const quotes = parseRP(textForParse);
            if (quotes.length > 0) {
                for (const q of quotes) {
                    result.push({ text: q.dialogue, character: speakerName, voice: speakerVoice, emotion: null, scene: null });
                }
            } else {
                // 无引号，整句朗读（使用剥离代码块后的文本，避免念出代码本身）
                const fallback = textForParse.replace(/\s+/g, ' ').trim();
                if (fallback) {
                    result.push({ text: fallback, character: speakerName, voice: speakerVoice, emotion: null, scene: null });
                }
            }
            return result;
        }

        if (mode === 'audiobook') {
            // 听书模式：全文朗读
            result.push({ text: textContent.trim(), character: speakerName, voice: speakerVoice, emotion: null, scene: null });
            return splitResult(result); // 听书必须分段
        }

        // GAL 模式逻辑
        const hasVNMarkers = /\[[^\]]+\]/.test(textContent);
        if (!hasVNMarkers) {
            // 无 GAL 标记，回退到单人朗读
            const trimmed = textContent.trim();
            if (trimmed) {
                result.push({ text: trimmed, character: speakerName, voice: speakerVoice, emotion: null, scene: null });
            }
            
            return result; // GAL 模式不分段
        }

        // GAL 格式解析
        for (const line of textContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = parseVNLine(trimmed);
            if (parsed) {
                let voice = voiceMap[parsed.character];
                if (!voice) {
                    const npcVoice = resolveNpcVoice(parsed.character, parsed.voiceTag);
                    if (npcVoice) {
                        voice = npcVoice;
                        console.log(`[MoonVoice] 角色 "${parsed.character}" 未绑定 -> 自动分配: ${npcVoice}`);
                    } else {
                        voice = speakerVoice;
                        console.warn(`[MoonVoice] 角色 "${parsed.character}" 未绑定，回退到:${voice}`);
                    }
                }
                result.push({
                    text: parsed.dialogue,
                    character: parsed.character,
                    scene: parsed.scene || null,
                    voice: voice,
                    emotion: parsed.emotion || null,
                    voiceTag: parsed.voiceTag || null,
                });
            }
        }

        if (result.length === 0) {
            const trimmed = textContent.trim();
            if (trimmed) {
                result.push({ text: trimmed, character: speakerName, voice: speakerVoice, emotion: null, scene: null });
            }
        }
        return result; // GAL 模式不分段
    }

    /**
     * 分段函数
     * 仅听书模式会调用此函数
     */
    function splitResult(result) {
        if (result.length !== 1) return result;
        const settings = getSettings();
        const mode = settings.parsingMode || 'gal';
        // GAL 模式不分段（虽然理论上不会走到这里，作为双保险保留）
        if (mode === 'gal') return result;

        const originalText = result[0].text;
        // 保护所有会被过滤的内容：替换成无标点的占位符
        let protectedText = originalText;
        const protectMap = new Map();
        let protectIndex = 0;

        function protect(regex) {
            protectedText = protectedText.replace(regex, (match) => {
                const placeholder = `§P${protectIndex}§`;
                protectMap.set(placeholder, match);
                protectIndex++;
                return placeholder;
            });
        }

        // 按顺序保护（先保护长的，再保护短的，避免冲突）
        protect(/```[\s\S]*?```/g); // 多行代码块
        protect(/[（(][^）)]*[）)]/g); // 括号内容
        protect(/(?<!\*)\*[^*]+\*(?!\*)/g); // 斜体
        protect(/`[^`]*`/g); // 行内代码
        protect(/<[^>]+>[\s\S]*?<\/[^>]+>/g); // HTML/XML块
        protect(/<[^>]+\/>/g); // 自闭合标签
        protect(/\[[^\]]+\]\([^\)]+\)/g); // 超链接
        protect(/https?:\/\/[^\s]+/g); // URL
        protect(/www\.[^\s]+/g); // www链接
        protect(/[\w\.-]+@[\w\.-]+\.\w+/g); // 邮箱
        protect(/ISBN[:\s]*[\d\-X]+/gi); // ISBN
        protect(/\[\d+\]/g); // 方括号脚注
        protect(/\(\d+\)/g); // 圆括号脚注
        protect(/:[a-z_]+:/g); // Emoji短代码

        // 粗略过滤：用于判断是否分段（基于 protectedText，占位符很短）
        let roughText = protectedText
            .replace(/^[\*\-\+]\s+/gm, '')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/["“”‘’「」『』\[\]【】{}|/]/g, '')
            .replace(/—+/g, '，') 
            .replace(/([\u4e00-\u9fa5，。！？、；：])\s+(?=[\u4e00-\u9fa5，。！？、；：])/g, '$1')
            .trim();

        // 用粗略过滤后的字数判断是否分段
        if (roughText.length <= 32) return result;

        // 分段逻辑（保留 \n 作为分割点）
        const sentences = protectedText.match(/[^。！？\n~]+[。！？\n~]?/g) || [protectedText];
        if (sentences.length > 1) {
            const base = result[0];
            const merged = [];
            let current = '';
            for (const sentence of sentences) {
                const s = sentence.trim();
                if (!s) continue;
                // 如果当前句太短（< 12 字），和下一句合并
                if (current.length < 12) {
                    current += s;
                } else {
                    if (current) merged.push(current);
                    current = s;
                }
            }
            if (current) merged.push(current);

            // 如果合并后还是只有一句，就不分了
            if (merged.length <= 1) return result;

            result.length = 0;
            for (const item of merged) {
                // 还原所有占位符
                let restored = item;
                protectMap.forEach((original, placeholder) => {
                    restored = restored.split(placeholder).join(original);
                });
                result.push({ ...base, text: restored });
            }
            if (getSettings().parsingMode === 'audiobook') {
                console.log(`[MoonVoice] 自动分段: ${merged.length} 句 (过滤后${roughText.length}字)`);
            }
        }
        return result;
    }

    function clearPlayingInMessage(msg) {
        if (!msg) return;
        msg.querySelectorAll('.breezetts2-dialogue.playing, .breezetts2-inline-play.playing').forEach(el => { el.classList.remove('playing'); });
    }

    function setLinePlayingByEncoded(msg, encT, encC, isPlaying) {
        if (!msg || !encT) return;
        const selectorDialogue = `.breezetts2-dialogue[data-t="${encT}"]` + (encC ? `[data-c="${encC}"]` : '');
        const selectorBtn = `.breezetts2-inline-play[data-t="${encT}"]` + (encC ? `[data-c="${encC}"]` : '');
        msg.querySelectorAll(`${selectorDialogue},${selectorBtn}`).forEach(el => {
            if (isPlaying) { el.classList.add('playing'); } else { el.classList.remove('playing'); }
        });
    }

    // ==================== 底部播放进度发光条 ====================
    // 播放音频时，在页面底部显示一条从左到右推进的发光进度线。
    // 单句模式（流式播放）：透明度跟随进度变化——前段淡入、60%起渐隐，句尾时已接近全透明，下一句归零重新开始时视觉上无跳变，
    // 整层模式（播缓存）：全程不透明连续推进，延迟等待时停在原地。
    let bottomProgressEl = null;
    let bottomBoundAudio = null;

    function ensureBottomProgress() {
        if (bottomProgressEl) return;
        bottomProgressEl = document.createElement('div');
        bottomProgressEl.id = 'breezetts2-bottom-progress';
        document.body.appendChild(bottomProgressEl);
    }

    /**
     * 绑定音频到底部进度条（每次播放新的音频会自动解除上一个的绑定）
     * @param {HTMLAudioElement|null} audio 要跟踪的音频；传 null 清空进度条
     * @param {Function} [getProgress] 可选，返回 [当前秒数, 总秒数]。
     *   提供时为"整层模式"：进度跨句连续，延迟等待时停在原地，全程不透明；
     *   不提供时为"单句模式"：前段淡入、60%后渐隐，句与句之间无跳变。
     */
    function attachBottomProgress(audio, getProgress) {
        ensureBottomProgress();
        if (bottomBoundAudio && bottomBoundAudio._breezetts2BottomUpdate) {
            bottomBoundAudio.removeEventListener('timeupdate', bottomBoundAudio._breezetts2BottomUpdate);
            delete bottomBoundAudio._breezetts2BottomUpdate;
        }
        bottomBoundAudio = audio || null;
        if (!audio) {
            // 清空进度条：保持当前宽度淡出，随后无动画归零，避免"从右端带着动画缩回"的观感（与单句模式的渐隐收尾观感一致）
            bottomProgressEl.style.opacity = '0';
            setTimeout(() => {
                if (bottomBoundAudio || !bottomProgressEl) return; 
                bottomProgressEl.style.transition = 'none';
                bottomProgressEl.style.width = '0%';
                bottomProgressEl.style.opacity = '1';
                requestAnimationFrame(() => {
                    if (bottomProgressEl) bottomProgressEl.style.transition = '';
                });
            }, 350);
            return;
        }
        const playlistMode = typeof getProgress === 'function';
        const update = () => {
            if (!bottomProgressEl || bottomBoundAudio !== audio) return;
            let elapsed, total;
            if (playlistMode) {
                [elapsed, total] = getProgress();
            } else {
                elapsed = audio.currentTime;
                total = audio.duration;
            }
            if (!isFinite(total) || total <= 0 || !isFinite(elapsed)) {
                bottomProgressEl.style.width = '0%';
                return;
            }
            const pct = Math.min(1, Math.max(0, elapsed / total));
            bottomProgressEl.style.width = `${pct * 100}%`;
            let opacity = 1;
            if (!playlistMode) {
                // 单句模式透明度曲线：前 15% 淡入，60% 起线性渐隐至句尾接近透明
                const fadeIn = Math.min(1, pct / 0.15);
                const fadeOut = pct < 0.6 ? 1 : Math.max(0, 1 - (pct - 0.6) / 0.4);
                opacity = fadeIn * fadeOut;
            }
            bottomProgressEl.style.opacity = opacity.toFixed(3);
        };
        audio._breezetts2BottomUpdate = update;
        audio.addEventListener('timeupdate', update);
        update();
    }

    // ==================== 悬浮播放器 ====================
    const TTSPlayerWindow = (() => {
        let container = null; let elements = {};
        let dragInfo = { isDragging: false, startX: 0, startY: 0, initialLeft: 0, initialTop: 0 };
        let currentTotalDuration = 0; let globalController = null; let lastVolume = 1.0; let lastAmbientVolume = 0.4; let hideTimer = null;
        const speedCycle = [0.25, 0.5, 1.0, 1.25, 1.5, 2.0, 3.0];

        function init() {
            if (container) return;
            container = document.createElement('div');
            container.className = 'breezetts2-player-window';
            container.innerHTML = `
                <div class="breezetts2-player-top" style="cursor: move;">
                    <div class="breezetts2-player-cover">
                        <img id="breezetts2-player-avatar" src="" alt="avatar" style="display:none;" onerror="this.style.display='none'; if(!this.parentElement.querySelector('i')) { this.parentElement.insertAdjacentHTML('afterbegin', '<i class=\\'fa-solid fa-music\\'></i>'); }">
                    </div>
                    <div class="breezetts2-player-info">
                        <div class="breezetts2-player-charname" id="breezetts2-player-name">Name</div>
                        <div class="breezetts2-player-text">
                            <span class="breezetts2-player-text-inner" id="breezetts2-player-currtext">...</span>
                        </div>
                    </div>
                    <div class="breezetts2-player-speed-area">
                        <div class="breezetts2-player-speed-btn" id="breezetts2-player-speed-disp" title="右键原位编辑\n左键循环倍速\n悬停滑块细调">1.0x</div>
                        <div class="breezetts2-player-speed-popup">
                            <input type="range" class="breezetts2-speed-slider" id="breezetts2-player-speed-slider" min="0.1" max="3" step="0.1" value="1.0" orient="vertical">
                        </div>
                    </div>
                    <div class="breezetts2-player-volume-area">
                        <div class="breezetts2-player-volume-btn" id="breezetts2-player-volume-icon" title="右键原位编辑\n左键静音及恢复\n悬停滑块细调"><i class="fa-solid fa-volume-high"></i></div>
                        <div class="breezetts2-player-volume-popup">
                            <input type="range" class="breezetts2-volume-slider" id="breezetts2-player-volume-slider" min="0" max="2" step="0.05" value="1.0" orient="vertical">
                        </div>
                    </div>
                    <div class="breezetts2-player-ambient-area">
                        <div class="breezetts2-player-ambient-btn" id="breezetts2-player-ambient-icon" title="环境音（独立于人声，点击静音）\n右键原位编辑\n左键静音及恢复\n悬停滑块细调"><i class="fa-solid fa-music"></i></div>
                        <div class="breezetts2-player-ambient-popup">
                            <input type="range" class="breezetts2-volume-slider" id="breezetts2-player-ambient-slider" min="0" max="1" step="0.05" value="0.4" orient="vertical">
                        </div>
                    </div>
                    <div class="breezetts2-player-controls">
                        <button class="breezetts2-ctrl-btn" id="breezetts2-player-prev" title="上一楼层"><i class="fa-solid fa-backward-step"></i></button>
                        <button class="breezetts2-ctrl-btn play-btn" id="breezetts2-player-play"><i class="fa-solid fa-play"></i></button>
                        <button class="breezetts2-ctrl-btn" id="breezetts2-player-next" title="下一楼层"><i class="fa-solid fa-forward-step"></i></button>
                    </div>
                    <button class="breezetts2-player-close" id="breezetts2-player-close" title="退出全文朗读"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="breezetts2-player-bottom">
                    <input type="range" class="breezetts2-player-progress" id="breezetts2-player-progress" min="0" max="1000" value="0">
                    <div class="breezetts2-player-time">
                        <span id="breezetts2-player-time-curr">0:00</span>
                        <span id="breezetts2-player-time-left">-0:00</span>
                    </div>
                </div>
            `;
            document.body.appendChild(container);
            elements = {
                avatar: container.querySelector('#breezetts2-player-avatar'),
                name: container.querySelector('#breezetts2-player-name'),
                currText: container.querySelector('#breezetts2-player-currtext'),
                speedBtn: container.querySelector('#breezetts2-player-speed-disp'),
                speedSlider: container.querySelector('#breezetts2-player-speed-slider'),
                speedPopup: container.querySelector('.breezetts2-player-speed-popup'),
                volumeBtn: container.querySelector('#breezetts2-player-volume-icon'),
                volumeSlider: container.querySelector('#breezetts2-player-volume-slider'),
                volumePopup: container.querySelector('.breezetts2-player-volume-popup'),
                ambientBtn: container.querySelector('#breezetts2-player-ambient-icon'),
                ambientSlider: container.querySelector('#breezetts2-player-ambient-slider'),
                ambientPopup: container.querySelector('.breezetts2-player-ambient-popup'),
                btnPrev: container.querySelector('#breezetts2-player-prev'),
                btnPlay: container.querySelector('#breezetts2-player-play'),
                btnNext: container.querySelector('#breezetts2-player-next'),
                btnClose: container.querySelector('#breezetts2-player-close'),
                progress: container.querySelector('#breezetts2-player-progress'),
                timeCurr: container.querySelector('#breezetts2-player-time-curr'),
                timeLeft: container.querySelector('#breezetts2-player-time-left'),
                topArea: container.querySelector('.breezetts2-player-top')
            };

            // 移除 HTML 内联的 onerror，改由 JS 安全绑定，防止破坏 DOM 结构导致显示一半
            if (elements.avatar) {
                elements.avatar.removeAttribute('onerror');
            }

            elements.btnClose.addEventListener('click', hide);
            elements.btnPlay.addEventListener('click', () => {
                if (!globalController) return;
                const icon = elements.btnPlay.querySelector('i');
                if (icon.classList.contains('fa-pause')) { globalController.pause(); } else { globalController.play(); }
            });
            elements.progress.addEventListener('input', (e) => {
                if (!globalController) return;
                const percent = parseInt(e.target.value, 10) / 1000;
                globalController.seek(percent);
            });

            const updateSpeed = (val) => {
                val = parseFloat(val); if (isNaN(val)) return;
                val = Math.max(0.1, Math.min(3.0, val));
                elements.speedBtn.textContent = val.toFixed(1) + 'x';
                elements.speedSlider.value = val;
                const s = getSettings(); s.speed = val; saveSettings();
                if (currentPlayback.audio) { currentPlayback.audio.playbackRate = val; }
            };
            elements.speedBtn.addEventListener('click', () => {
                const current = parseFloat(getSettings().speed || 1.0);
                let next = speedCycle[0];
                for (let i = 0; i < speedCycle.length; i++) { if (speedCycle[i] > current + 0.01) { next = speedCycle[i]; break; } }
                updateSpeed(next);
            });
            elements.speedSlider.addEventListener('input', (e) => updateSpeed(e.target.value));

            const updateVolume = (val, save = true) => {
                val = parseFloat(val); if (isNaN(val)) return;
                val = Math.max(0, Math.min(2.0, val));
                elements.volumeSlider.value = val;
                const icon = elements.volumeBtn.querySelector('i');
                if (icon) {
                    if (val === 0) icon.className = 'fa-solid fa-volume-xmark';
                    else if (val < 0.5) icon.className = 'fa-solid fa-volume-low';
                    else icon.className = 'fa-solid fa-volume-high';
                }
                if (save) { const s = getSettings(); s.volume = val; saveSettings(); if (val > 0) lastVolume = val; }
                if (currentPlayback.audio) { currentPlayback.audio.volume = Math.min(1.0, val); }
            };
            elements.volumeBtn.addEventListener('click', () => {
                const s = getSettings();
                if (parseFloat(s.volume) > 0) { lastVolume = parseFloat(s.volume); updateVolume(0); } else { updateVolume(lastVolume || 1.0); }
            });
            elements.volumeSlider.addEventListener('input', (e) => updateVolume(e.target.value));

            // 环境音音量：独立于人声。环境音是循环的，所以这里点静音就等于「关掉环境音」，
            // 不用再跑去设置面板。（事件音很短，不给它单独的悬浮控件。）
            const updateAmbientVolume = (val, save = true) => {
                val = parseFloat(val); if (isNaN(val)) return;
                val = Math.max(0, Math.min(1.0, val));
                elements.ambientSlider.value = val;
                const icon = elements.ambientBtn.querySelector('i');
                if (icon) icon.className = val === 0 ? 'fa-solid fa-ban' : 'fa-solid fa-music';
                if (save) {
                    AmbientPlayer.setVolume(val);   // 会写进 settings 并立即作用于正在播的环境音
                    if (val > 0) lastAmbientVolume = val;
                }
            };
            elements.ambientBtn.addEventListener('click', () => {
                const s = getSettings();
                if (parseFloat(s.ambientSoundVolume ?? 0.4) > 0) {
                    lastAmbientVolume = parseFloat(s.ambientSoundVolume ?? 0.4);
                    updateAmbientVolume(0);
                } else { updateAmbientVolume(lastAmbientVolume || 0.4); }
            });
            elements.ambientSlider.addEventListener('input', (e) => updateAmbientVolume(e.target.value));

            const setupInlineEdit = (btnEl, currentValueGetter, valSetter) => {
                btnEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (btnEl.querySelector('input')) return;
                    const originalHTML = btnEl.innerHTML;
                    const input = document.createElement('input');
                    input.type = 'number'; input.className = 'breezetts2-inline-edit-input';
                    input.value = currentValueGetter(); input.step = '0.1';
                    btnEl.innerHTML = ''; btnEl.appendChild(input);
                    input.focus(); input.select();
                    const finishEdit = (save) => {
                        btnEl.innerHTML = originalHTML;
                        if (save) {
                            let val = parseFloat(input.value);
                            if (btnEl === elements.volumeBtn && val > 2.0) { val = val / 100.0; }
                            valSetter(val);
                        }
                    };
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
                        if (e.key === 'Escape') finishEdit(false);
                    });
                    input.addEventListener('blur', () => finishEdit(false));
                });
            };
            setupInlineEdit(elements.speedBtn, () => parseFloat(getSettings().speed || 1.0), updateSpeed);
            setupInlineEdit(elements.volumeBtn, () => parseFloat(getSettings().volume || 1.0), updateVolume);
            setupInlineEdit(elements.ambientBtn, () => parseFloat(getSettings().ambientSoundVolume ?? 0.4), updateAmbientVolume);

            const setupPopup = (areaClass, popupEl) => {
                const area = container.querySelector(`.${areaClass}`);
                const show = () => {
                    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
                    // 三个弹窗同时只留一个
                    [elements.speedPopup, elements.volumePopup, elements.ambientPopup]
                        .forEach(p => { if (p && p !== popupEl) p.classList.remove('visible'); });
                    popupEl.classList.add('visible');
                };
                const hide = () => { hideTimer = setTimeout(() => { popupEl.classList.remove('visible'); }, 500); };
                area.addEventListener('mouseenter', show);
                area.addEventListener('mouseleave', hide);
                popupEl.addEventListener('mouseenter', show);
                popupEl.addEventListener('mouseleave', hide);
            };
            setupPopup('breezetts2-player-speed-area', elements.speedPopup);
            setupPopup('breezetts2-player-volume-area', elements.volumePopup);
            setupPopup('breezetts2-player-ambient-area', elements.ambientPopup);

            elements.topArea.addEventListener('mousedown', (e) => {
                if (e.target.closest('.breezetts2-ctrl-btn') || e.target.closest('.breezetts2-player-close') || e.target.closest('.breezetts2-player-speed-area') || e.target.closest('.breezetts2-player-volume-area') || e.target.closest('.breezetts2-player-ambient-area')) return;
                dragInfo.isDragging = true; dragInfo.startX = e.clientX; dragInfo.startY = e.clientY;
                const rect = container.getBoundingClientRect();
                dragInfo.initialLeft = rect.left; dragInfo.initialTop = rect.top;
                container.style.transform = 'none';
                container.style.left = dragInfo.initialLeft + 'px';
                container.style.top = dragInfo.initialTop + 'px';
                container.style.bottom = 'auto';
                container.style.right = 'auto';
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragInfo.isDragging) return;
                const dx = e.clientX - dragInfo.startX;
                const dy = e.clientY - dragInfo.startY;
                container.style.left = (dragInfo.initialLeft + dx) + 'px';
                container.style.top = (dragInfo.initialTop + dy) + 'px';
            });
            document.addEventListener('mouseup', () => { dragInfo.isDragging = false; });

            elements.btnPrev.addEventListener('click', () => navigateFloor(-1));
            elements.btnNext.addEventListener('click', () => navigateFloor(1));
        }

        function formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        }

        function updateProgress(elapsed, total) {
            if (!container || !container.classList.contains('visible')) return;
            currentTotalDuration = total;
            const percent = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
            elements.progress.value = Math.floor(percent * 1000);
            elements.progress.style.setProperty('--value', `${percent * 100}%`);
            elements.timeCurr.textContent = formatTime(elapsed);
            elements.timeLeft.textContent = '-' + formatTime(total - elapsed);
        }

        function updatePlayState(isPlaying) {
            if (!container) return;
            elements.btnPlay.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
        }

        function updateInfo(data) {
            if (!container) return;
            if (data.name) elements.name.textContent = data.name;
            if (data.text) {
                const text = data.text;
                elements.currText.textContent = text;
                elements.currText.classList.remove('marquee');
                elements.currText.style.animationDuration = '0s';
                setTimeout(() => {
                    const parent = elements.currText.parentElement;
                    if (elements.currText.scrollWidth > parent.clientWidth + 5) {
                    const safeText = escapeHtml(text);
                    elements.currText.innerHTML = `${safeText} <span style="margin-right:50px;"></span>${safeText}`;
                        elements.currText.classList.add('marquee');
                        const duration = Math.max(10, Math.floor(elements.currText.scrollWidth / 40));
                        elements.currText.style.animationDuration = `${duration}s`;
                    }
                }, 50);
            }
            if (data.avatarUrl) {
                const cover = container.querySelector('.breezetts2-player-cover');
                if (cover) {
                    // 如果 img 被之前的 onerror 挤出 DOM，重新放回去
                    if (!cover.contains(elements.avatar)) {
                        cover.innerHTML = '';
                        cover.appendChild(elements.avatar);
                    }
                    // 用 JS 安全绑定 onerror
                    elements.avatar.onerror = () => {
                        elements.avatar.style.display = 'none';
                        cover.innerHTML = '<i class="fa-solid fa-music"></i>';
                    };
                    elements.avatar.src = data.avatarUrl;
                    elements.avatar.style.display = 'block';
                }
            }
        }

        function navigateFloor(direction) {
            if (!currentPlayback.msg) return;
            const currentMsg = currentPlayback.msg;
            const allMes = Array.from(document.querySelectorAll('.mes[is_user="false"]'));
            const currentIndex = allMes.indexOf(currentMsg);
            if (currentIndex === -1) return;
            let targetMsg = null;
            let iterIndex = currentIndex + direction;
            while (iterIndex >= 0 && iterIndex < allMes.length) {
                const tempMsg = allMes[iterIndex];
                if (tempMsg.querySelector('.breezetts2-play')) { targetMsg = tempMsg; break; }
                iterIndex += direction;
            }
            if (targetMsg) {
                const btn = targetMsg.querySelector('.breezetts2-play');
                if (btn) btn.click();
            } else {
                if (window.toastr) window.toastr.info(direction === 1 ? '已经是最后一个有效楼层' : '已经是第一个有效楼层');
            }
        }

        function show(msg, controller) {
            init();
            const settings = getSettings();
            if (settings.showFloatingPlayer === false) {
                globalController = controller; // 仍然保存控制器以便外部控制
                return; // 不显示 UI
            }
            globalController = controller;
            const speed = parseFloat(settings.speed || 1.0);
            const volume = parseFloat(settings.volume || 1.0);
            elements.speedBtn.textContent = speed.toFixed(1) + 'x';
            elements.speedSlider.value = speed;
            elements.volumeSlider.value = volume;
            lastVolume = volume > 0 ? volume : (lastVolume || 1.0);
            const vIcon = elements.volumeBtn.querySelector('i');
            if (vIcon) {
                if (volume === 0) vIcon.className = 'fa-solid fa-volume-xmark';
                else if (volume < 0.5) vIcon.className = 'fa-solid fa-volume-low';
                else vIcon.className = 'fa-solid fa-volume-high';
            }
            // 环境音按钮状态也要跟着设置同步（可能刚在设置面板里改过）
            const ambientVolume = Math.max(0, Math.min(1, parseFloat(settings.ambientSoundVolume ?? 0.4)));
            elements.ambientSlider.value = ambientVolume;
            if (ambientVolume > 0) lastAmbientVolume = ambientVolume;
            const aIcon = elements.ambientBtn.querySelector('i');
            if (aIcon) aIcon.className = ambientVolume === 0 ? 'fa-solid fa-ban' : 'fa-solid fa-music';
            const nameEl = msg.querySelector('.ch_name');
            const avatarEl = msg.querySelector('.avatar img');
            updateInfo({ name: nameEl ? nameEl.textContent.trim() : 'Unknown', avatarUrl: avatarEl ? avatarEl.src : null, text: '正在缓冲...' });
            container.classList.add('visible');
        }

        function hide() {
            if (container) {
                container.classList.remove('visible');
                if (globalController) { globalController.pause(); }
                globalController = null;
            }
        }

        return { show, hide, updateProgress, updatePlayState, updateInfo };
    })();

    async function streamInferAndPlay(msg, lines, triggerBtn, isSilent) {
        const settings = getSettings();
        const mesId = getMessageId(msg);
        if (!mesId) return [];
        const list = [];
        const skipCount = settings.streamingSkipCount || 1;
        let currentInferIndex = 0; let currentPlayIndex = 0;
        let isPlaying = false; let currentAudio = null;
        let inferDone = false;
        let streamCompletedDuration = 0; // 已播完句子的累计时长
        // 语音事件间隔用：上一句播完的时刻与角色。
        // pendingGapFrom 为 null 表示「不需要施加间隔」（首次播放、拖动进度等）。
        let pendingGapFrom = null;
        let pendingGapPrevChar = null;
        const sessionId = Date.now();

        const playNextAudio = async () => {
            const waitForContent = () => {
                return new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (currentPlayback.sessionId !== sessionId) { clearInterval(checkInterval); resolve('aborted'); }
                        else if (currentPlayIndex < list.length) { clearInterval(checkInterval); resolve(); }
                        else if (inferDone) { clearInterval(checkInterval); resolve('done'); }
                    }, 50);
                });
            };
            const waitResult = await waitForContent();
            if (waitResult === 'aborted') {
                return;
            }
            if (waitResult === 'done' || currentPlayIndex >= list.length) {
                AmbientPlayer.stop();
                if (typeof currentPlayback.stop === 'function') currentPlayback.stop();
                clearPlayingInMessage(msg);
                attachBottomProgress(null);
                return;
            }

            // 间隔在这里施加，而不是在上一句的 onended 里：流式推理时下一句
            // 可能还没合成好，那时拿不到下一句的角色，间隔会被整个跳过。
            if (pendingGapFrom !== null) {
                const prevChar = pendingGapPrevChar;
                const endedAt = pendingGapFrom;
                pendingGapFrom = null; pendingGapPrevChar = null;
                const cur = list[currentPlayIndex];
                const gapSec = getSegmentGap(prevChar, cur && cur.character);
                if (gapSec > 0) {
                    // 等待下一句合成的时间本身已经算作停顿了，不要叠加，
                    // 否则推理慢的时候会出现「等合成 + 再等间隔」的双重空档。
                    const alreadyWaitedSec = (performance.now() - endedAt) / 1000;
                    const waitMs = Math.max(0, (gapSec - alreadyWaitedSec) * 1000);
                    if (waitMs > 0) {
                        await new Promise(r => setTimeout(r, waitMs));
                        if (currentPlayback.sessionId !== sessionId) { return; } // 等待期间被中断/切走
                    }
                }
            }

            const item = list[currentPlayIndex];
            if (!item) {
                console.warn('[MoonVoice] Streaming: invalid item at index', currentPlayIndex);
                currentPlayIndex++; playNextAudio(); return;
            }
            if (currentAudio) { currentAudio.pause(); currentAudio.onended = null; currentAudio.onerror = null; currentAudio.src = ''; }
            currentAudio = new Audio(item.blobUrl);
            currentPlayback.audio = currentAudio;
            currentPlayback.msg = msg; currentPlayback.mesId = mesId;
            currentPlayback.index = currentPlayIndex; currentPlayback.sessionId = sessionId;
            lastPlayedCharacter = item.character || null;
            const vol = parseFloat(settings.volume || 1.0);
            currentAudio.volume = Math.max(0, Math.min(1, vol));
            currentAudio.playbackRate = parseFloat(settings.speed || 1.0);
            const encT = utf8ToBase64(item.text);
            const encC = utf8ToBase64(item.character || '');
            clearPlayingInMessage(msg);
            setLinePlayingByEncoded(msg, encT, encC, true);
            const avatarEl = msg.querySelector('.avatar img');
            let displayChar = item.character || 'Unknown';
            if (displayChar.toLowerCase() === 'narrator' && avatarEl) {
                const nameEl = msg.querySelector('.ch_name');
                if (nameEl) displayChar = nameEl.textContent.trim();
            }
            TTSPlayerWindow.updateInfo({ name: displayChar, text: item.text, avatarUrl: avatarEl ? avatarEl.src : null });
            attachBottomProgress(currentAudio);
            AmbientPlayer.playScene(item.scene || null);
            currentAudio.onended = () => {
                if (isFinite(currentAudio.duration) && currentAudio.duration > 0) streamCompletedDuration += currentAudio.duration;        
                setLinePlayingByEncoded(msg, encT, encC, false);
                
                const mySessionId = sessionId; // 捕获当前会话ID
                if (currentPlayback.sessionId === mySessionId) {
                    // 间隔不在这里等。流式推理时下一句往往还没合成好，
                    // 此刻 list[currentPlayIndex + 1] 是 undefined（角色未知），
                    // 间隔会被整个跳过。改为记下播完的时刻，交给 playNextAudio
                    // 在下一句真正就绪之后再等（并把合成耗时算进间隔里）。
                    pendingGapFrom = performance.now();
                    pendingGapPrevChar = item.character || null;
                    currentPlayIndex++;
                    playNextAudio();
                }
            };
            currentAudio.onerror = () => {
                console.error('[MoonVoice] Streaming track error at index:', currentPlayIndex);
                setLinePlayingByEncoded(msg, encT, encC, false);

                currentPlayIndex++; playNextAudio();
            };
            
            currentAudio.addEventListener('timeupdate', () => {
                if (isFinite(currentAudio.duration) && currentAudio.duration > 0) {
                    TTSPlayerWindow.updateProgress(streamCompletedDuration + currentAudio.currentTime, streamCompletedDuration + currentAudio.duration);
                }
            });
            
            try { await currentAudio.play(); } catch (e) {
                if (e.name === 'NotAllowedError') { if (window.toastr) window.toastr.warning('浏览器已拦截自动播放，请先点击页面任意处'); return; }
                currentPlayIndex++; playNextAudio();
            }
        };

        const inferLoop = async () => {
            while (currentInferIndex < lines.length) {
                if (isPlaying && currentPlayback.sessionId !== sessionId) {
                    return;
                }
                const line = lines[currentInferIndex];
                if (!line.voice) { currentInferIndex++; continue; }
                try {
                    const record = await ensureAudioRecord({ text: line.text, character: line.character, voice: line.voice, emotion: line.emotion });
                    if (!record) { currentInferIndex++; continue; }
                    const blobUrl = URL.createObjectURL(record.blob);
                    const newItem = { text: line.text, character: line.character, scene: line.scene || null, voice: line.voice, hash: record.hash, blobUrl };
                    list.push(newItem);
                    audioCache[mesId] = list;
                    if (window.toastr && !isSilent) {
                        const progress = Math.round(((currentInferIndex + 1) / lines.length) * 100);
                        const msg = `推理进度: ${currentInferIndex + 1}/${lines.length} (${progress}%)`;
                        try { window.toastr.info(msg); } catch (e) { console.warn('[MoonVoice] 弹窗通知失败:', e); }
                    }
                    if (list.length >= skipCount && !isPlaying) {
                        isPlaying = true; currentPlayIndex = 0; currentPlayback.sessionId = sessionId;
                        currentPlayback.controller = {
                            pause: () => { if (currentAudio) currentAudio.pause(); AmbientPlayer.pause(); },
                            play: () => { if (currentAudio) currentAudio.play(); AmbientPlayer.resume(); },
                            seek: (percent) => {
                                const targetTime = list.length * percent;
                                const targetIndex = Math.min(Math.floor(targetTime), list.length - 1);
                                if (targetIndex === currentPlayIndex && currentAudio) { currentAudio.currentTime = targetTime - targetIndex; }
                                else { currentPlayIndex = targetIndex; playNextAudio(); }
                            }
                        };
                        TTSPlayerWindow.show(msg, currentPlayback.controller);
                        playNextAudio();
                    }
                } catch (e) { console.error('[MoonVoice] 流式推理失败:', e); }
                currentInferIndex++;
                if (currentInferIndex >= lines.length && !isPlaying && list.length > 0) {
                    inferDone = true; isPlaying = true; currentPlayIndex = 0; currentPlayback.sessionId = sessionId;
                    currentPlayback.controller = {
                        pause: () => { if (currentAudio) currentAudio.pause(); AmbientPlayer.pause(); },
                        play: () => { if (currentAudio) currentAudio.play(); AmbientPlayer.resume(); },
                        seek: (percent) => {
                            const targetTime = list.length * percent;
                            const targetIndex = Math.min(Math.floor(targetTime), list.length - 1);
                            if (targetIndex === currentPlayIndex && currentAudio) { currentAudio.currentTime = targetTime - targetIndex; }
                            else { currentPlayIndex = targetIndex; playNextAudio(); }
                        }
                    };
                    TTSPlayerWindow.show(msg, currentPlayback.controller);
                    playNextAudio();
                }
            }
            inferDone = true;
        };
        inferLoop();
        return list;
    }

    async function inferMessageAudios(msg, triggerBtn, isSilent = false) {
        if (!msg) return;
        const mesId = getMessageId(msg);
        if (!mesId) return;
        if (audioCache[mesId] && audioCache[mesId].length) {
            const settings = getSettings();
            if (settings.streamingPlay) {
                audioCache[mesId].forEach(item => { if (item.blobUrl) URL.revokeObjectURL(item.blobUrl); });
                delete audioCache[mesId];
            } else { return audioCache[mesId]; }
        }
        if (inferenceLocks.has(mesId)) {
            return audioCache[mesId] || [];
        }
        inferenceLocks.add(mesId);
        let iconEl = null; let originalIconClass = '';
        if (triggerBtn) {
            triggerBtn.classList.add('disabled');
            iconEl = triggerBtn.querySelector('i');
            if (iconEl) { originalIconClass = iconEl.className; iconEl.className = 'fa-solid fa-spinner fa-spin'; }
        } else {
            const inferBtn = msg.querySelector('.breezetts2-infer');
            if (inferBtn) inferBtn.classList.add('breezetts2-inferring');
        }
        const settings = getSettings();
        try {
            const lines = collectVNLinesFromMessage(msg);
            const list = [];
            const unvoicedCount = lines.filter(l => !l.voice).length;
            if (!lines.length) {
                if (!isSilent && window.toastr) {
                    const modeHint = settings.parsingMode === 'rp' ? '未发现引号对话内容，请检查RP模式及消息文本'
                        : settings.parsingMode === 'audiobook' ? '未发现可朗读的文本内容'
                        : '未在消息中发现符合格式的 [角色] 文本，请检查是否为 GAL 模式及剧本格式';
                    window.toastr.warning(modeHint);
                }
                return [];
            } else if (unvoicedCount === lines.length) {
                if (!isSilent && window.toastr) window.toastr.warning('发现角色对话但均未在配置表格中关联配音，请先点击配置绑定音色');
                return [];
            }
            if (settings.streamingPlay) {
                const skipCount = settings.streamingSkipCount || 1;
                if (window.toastr && !isSilent) { window.toastr.info(`流式推理播放模式已启用（每推理 ${skipCount} 句后开始播放）`); }
                return await streamInferAndPlay(msg, lines, triggerBtn, isSilent);
            }

            for (const line of lines) {
                try {
                    if (!line.voice) continue;
                    const record = await ensureAudioRecord({ text: line.text, character: line.character, voice: line.voice, emotion: line.emotion });
                    if (!record) continue;
                    const blobUrl = URL.createObjectURL(record.blob);
                    list.push({ text: line.text, character: line.character, scene: line.scene || null, voice: line.voice, hash: record.hash, blobUrl });
                } catch (e) { console.error('[MoonVoice] 单句推理失败:', e); }
            }
            audioCache[mesId] = list;
            return list;
        } finally {
            inferenceLocks.delete(mesId);
            if (triggerBtn) {
                triggerBtn.classList.remove('disabled');
                if (iconEl && originalIconClass) { iconEl.className = originalIconClass; }
            } else {
                const inferBtn = msg.querySelector('.breezetts2-infer');
                if (inferBtn) inferBtn.classList.remove('breezetts2-inferring');
            }
        }
    }

    function playMessageQueue(msg, triggerBtn) {
        if (!msg) return;
        const mesId = getMessageId(msg);
        if (!mesId) return;
        if (inferenceLocks.has(mesId)) { return; }

        (async () => {
            let queue = audioCache[mesId] || [];
            if (!queue.length) {
                await inferMessageAudios(msg, null, true);
                queue = audioCache[mesId] || [];
                if (!queue.length) { return; }
            }
            if (typeof currentPlayback.stop === 'function') { currentPlayback.stop(); } else if (currentPlayback.audio) { try { currentPlayback.audio.pause(); } catch (e) { } }
            clearPlayingInMessage(currentPlayback.msg);

            const playlist = [];
            let totalDuration = 0;
            const loadDuration = (blobUrl) => new Promise((resolve) => {
                const a = new Audio(blobUrl);
                a.onloadedmetadata = () => resolve(a.duration);
                a.onerror = () => resolve(0);
                setTimeout(() => resolve(0), 1000);
            });
            // 并行获取所有句子的时长（blob 均为本地资源，无带宽压力），避免逐句串行等待
            const durations = await Promise.all(queue.map(item => loadDuration(item.blobUrl)));
            for (let i = 0; i < queue.length; i++) {
                const item = queue[i];
                const dur = durations[i];
                playlist.push({ ...item, index: i, duration: dur, startOffset: totalDuration });
                totalDuration += dur;
            }

            if (totalDuration === 0) { if (window.toastr) window.toastr.error('音频时长获取失败'); return; }
            const settings = getSettings();
            let currentIndex = 0; let currentAudio = null;
            const currentQueueId = Date.now();
            currentPlayback.sessionId = currentQueueId;

            (function buildSceneSegments() {
                // 分段只针对环境音。事件音是"过客"，对分段透明——否则中间夹一行
                // [敲门] 会把「乡村清晨…乡村清晨」切成两段，环境音在事件前后会被
                // 停掉再重新淡入。事件音越密，环境音重启越频繁。
                let i = 0;
                while (i < playlist.length) {
                    if (AmbientPlayer.isEventScene(playlist[i].scene)) {
                        // 事件音不该"起一段"，给它一个只含自己的空段即可
                        playlist[i].sceneSegStart = i;
                        playlist[i].sceneSegEnd = i;
                        i++;
                        continue;
                    }
                    const scene = playlist[i].scene;
                    let j = i;
                    while (j < playlist.length
                           && (playlist[j].scene === scene || AmbientPlayer.isEventScene(playlist[j].scene))) j++;
                    for (let k = i; k < j; k++) { playlist[k].sceneSegStart = i; playlist[k].sceneSegEnd = j - 1; }
                    i = j;
                }
            })();

            const playTrack = (index, seekTime = 0) => {
                if (currentPlayback.sessionId !== currentQueueId) return;
                if (index >= playlist.length) {
                    currentPlayback.stop();
                    clearPlayingInMessage(msg);
                    attachBottomProgress(null);
                    return;
                }
                currentIndex = index;
                const item = playlist[index];
                if (currentAudio) { currentAudio.pause(); currentAudio.onended = null; currentAudio.onerror = null; currentAudio.src = ''; }
                const audio = new Audio(item.blobUrl);
                currentAudio = audio;
                currentPlayback.audio = audio;
                currentPlayback.msg = msg; currentPlayback.mesId = mesId;
                currentPlayback.index = index; currentPlayback.playlist = playlist;
                currentPlayback.totalDuration = totalDuration;
                lastPlayedCharacter = item.character || null;
                const vol = parseFloat(settings.volume || 1.0);
                audio.volume = Math.max(0, Math.min(1, vol));
                audio.playbackRate = parseFloat(settings.speed || 1.0);
                if (AmbientPlayer.isEventScene(item.scene)) {
                    // 事件音每次出现都要触发，与"分段起点"无关——它只是一次性的叠音
                    AmbientPlayer.playScene(item.scene || null);
                } else if (getSettings().ambientLoopByScene) {
                    if (index === item.sceneSegStart) {
                        console.log('[MoonVoice][Ambient] LoopByScene: START scene=' + item.scene + ' seg=[' + item.sceneSegStart + ',' + item.sceneSegEnd + ']');
                        AmbientPlayer.playScene(item.scene || null);
                    }
                } else { AmbientPlayer.playScene(item.scene || null); }

                if (seekTime > 0) { audio.currentTime = seekTime; }
                const encT = utf8ToBase64(item.text);
                const encC = utf8ToBase64(item.character || '');
                clearPlayingInMessage(msg);
                setLinePlayingByEncoded(msg, encT, encC, true);
                const avatarEl = msg.querySelector('.avatar img');
                let displayChar = item.character || 'Unknown';
                if (displayChar.toLowerCase() === 'narrator' && avatarEl) { const nameEl = msg.querySelector('.ch_name'); if (nameEl) displayChar = nameEl.textContent.trim(); }
                TTSPlayerWindow.updateInfo({ name: displayChar, text: item.text, avatarUrl: avatarEl ? avatarEl.src : null });
                attachBottomProgress(audio, () => [item.startOffset + audio.currentTime, totalDuration]);


                audio.addEventListener('timeupdate', () => {
                    const elapsed = item.startOffset + audio.currentTime;
                    TTSPlayerWindow.updateProgress(elapsed, totalDuration);
                });
                audio.addEventListener('play', () => TTSPlayerWindow.updatePlayState(true));
                audio.addEventListener('pause', () => TTSPlayerWindow.updatePlayState(false));

                audio.onended = () => {
                    setLinePlayingByEncoded(msg, encT, encC, false);
                    if (getSettings().ambientLoopByScene) {
                        const isLastInSeg = (index === item.sceneSegEnd);
                        const isLastTrack = (index + 1 >= playlist.length);
                        if (isLastInSeg || isLastTrack) { AmbientPlayer.stop(); }
                    } else {
                        if (index + 1 >= playlist.length) { AmbientPlayer.stop(); } else { AmbientPlayer.stopImmediate(); }
                    }
                    
                    const myQueueId = currentQueueId; // 捕获当前队列ID
                    const nextItem = playlist[index + 1];
                    // 最后一句之后不加间隔：后面要么是播放结束，要么由消息续播自己控制节奏
                    const gap = nextItem ? getSegmentGap(item.character, nextItem.character) : 0;
                    runAfterSegmentGap(gap, () => {
                        if (currentPlayback.sessionId === myQueueId) { // 确保还是同一个播放队列
                            playTrack(index + 1);
                        }
                    });
                };
                audio.onerror = () => { console.error('[MoonVoice] 音频轨道错误'); playTrack(index + 1); };
                audio.play().catch(e => {
                    console.error('[MoonVoice] 自动播放被阻止', e);
                    if (e.name === 'NotAllowedError') {
                        if (window.toastr) window.toastr.warning('浏览器已拦截自动播放，请先点击页面任意处，或手动点击播放按钮');
                        return;
                    }
                    playTrack(index + 1);
                });
            };

            const controller = {
                seek: (percent) => {
                    const targetTime = totalDuration * percent;
                    let targetIndex = 0; let offsetInTrack = 0;
                    for (let i = 0; i < playlist.length; i++) {
                        const track = playlist[i];
                        if (targetTime >= track.startOffset && targetTime < (track.startOffset + track.duration)) {
                            targetIndex = i; offsetInTrack = targetTime - track.startOffset; break;
                        }
                    }
                    if (percent >= 0.99) { targetIndex = playlist.length - 1; offsetInTrack = playlist[targetIndex].duration - 0.1; }
                    if (targetIndex === currentIndex && currentAudio) { currentAudio.currentTime = offsetInTrack; } else { playTrack(targetIndex, offsetInTrack); }
                },
                pause: () => { if (currentAudio) currentAudio.pause(); AmbientPlayer.pause(); },
                play: () => { if (currentAudio) currentAudio.play(); AmbientPlayer.resume(); }
            };
            currentPlayback.controller = controller;
            TTSPlayerWindow.show(msg, controller);
            playTrack(0);
        })().catch(e => {
            console.error('[MoonVoice] playMessageQueue error:', e);
            if (window.toastr) window.toastr.error('播放队列出错: ' + e.message);
        });
    }

    async function autoPlayMessage(msg) {
        if (!msg) return;
        const mesId = getMessageId(msg);
        if (!mesId) return;
        if (currentPlayback.audio && !currentPlayback.audio.paused) { return; }
        const queue = audioCache[mesId] || [];
        if (!queue.length) { return; }
        // 跨消息续播也走同一套间隔：上一条消息的最后一句与这一条的第一句之间同样要停顿，
        // 否则连着两条消息会读成一整段没有断句的独白。
        const gap = getSegmentGap(lastPlayedCharacter, queue[0] && queue[0].character);
        runAfterSegmentGap(gap, () => {
            try { playMessageQueue(msg, null); } catch (e) { console.warn('[MoonVoice] AutoPlay: playMessageQueue threw synchronously:', e); }
        });
    }

    function refreshAllMessages() {
        document.querySelectorAll('.mes[is_user="false"]').forEach(msg => {
            const mesText = msg.querySelector('.mes_text');
            if (mesText) {
                mesText.querySelectorAll('.breezetts2-inline-play, .breezetts2-dialogue').forEach(el => {
                    if (el.classList.contains('breezetts2-dialogue')) { el.replaceWith(...el.childNodes); } else { el.remove(); }
                });
                delete mesText.dataset.breezetts2Injected;
            }
            injectMessageButtons(msg);
            injectInlineButtons(msg, true);
        });
    }

    // ==================== 更新检查 ====================
    const UPDATE_CHECKER = (() => {
        // 本 fork 不跟上游比对版本：上游仓库是 IndexTTS 插件，
        // 若保留该地址会提示"有新版本"并把本插件更新成 IndexTTS。故禁用。
        const REMOTE_MANIFEST_URL = null;
        const CHECK_INTERVAL_HOURS = 24;
        let hasUpdate = false;
        let remoteVersion = null;
        let currentVersion = null;

        async function getCurrentVersion() {
            if (currentVersion) return currentVersion;
            try {
                const response = await fetchWithTimeout(`${extensionFolderPath}manifest.json`, { cache: 'no-cache' });
                if (response.ok) {
                    const data = await response.json();
                    currentVersion = data.version || '1.0.0';
                } else {
                    currentVersion = '1.0.0';  
                }
            } catch (e) {
                currentVersion = '1.0.0';
            }
            return currentVersion;
        }

        async function checkUpdate(retryCount = 1) {
            if (!REMOTE_MANIFEST_URL) return;  // 更新检查已禁用（见上）
            try {
                const lastCheck = localStorage.getItem('breezetts2_last_update_check');
                const now = Date.now();
                if (lastCheck && (now - parseInt(lastCheck)) < CHECK_INTERVAL_HOURS * 3600 * 1000) {
                    const cachedResult = localStorage.getItem('breezetts2_update_available');
                    if (cachedResult === 'true') {
                        hasUpdate = true;
                        remoteVersion = localStorage.getItem('breezetts2_remote_version');
                        await getCurrentVersion(); 
                        updateUI();
                    }
                    return;
                }

                const [localVer, response] = await Promise.all([
                    getCurrentVersion(),
                    fetchWithTimeout(REMOTE_MANIFEST_URL, { method: 'GET', cache: 'no-cache' })
                ]);
                
                if (!response.ok) return;
                const data = await response.json();
                if (!data.version) return;
                
                remoteVersion = data.version;
                localStorage.setItem('breezetts2_last_update_check', String(now));
                localStorage.setItem('breezetts2_remote_version', remoteVersion);

                const currentParts = localVer.split('.').map(Number);
                const remoteParts = remoteVersion.split('.').map(Number);
                
                let isNewer = false;
                const maxLen = Math.max(currentParts.length, remoteParts.length);
                for (let i = 0; i < maxLen; i++) {
                    const c = currentParts[i] || 0;
                    const r = remoteParts[i] || 0;
                    if (r > c) { isNewer = true; break; }
                    if (r < c) { break; }
                }
                
                hasUpdate = isNewer;
                localStorage.setItem('breezetts2_update_available', String(hasUpdate));
                
                if (currentVersion) {
                    localStorage.setItem('breezetts2_local_version', currentVersion);
                }                

                if (hasUpdate) {
                    console.log('[MoonVoice] 发现新版本:', remoteVersion, '当前:', localVer);
                    updateUI();
                }
            } catch (e) {
                if (retryCount > 0 && e.message !== 'Request timeout') {
                    setTimeout(() => checkUpdate(retryCount - 1), 1000);
                    return;
                }
                console.warn('[MoonVoice] 更新检查失败:', e);
            }
        }

        function updateUI() {
            if (!hasUpdate) return;
            const drawerToggle = document.querySelector('#breezetts2-settings .inline-drawer-toggle');
            if (drawerToggle && !drawerToggle.querySelector('.breezetts2-update-badge')) {
                const badge = document.createElement('span');
                badge.className = 'breezetts2-update-badge';
                badge.textContent = 'New!';
                badge.title = `有新版本 ${remoteVersion} 可用，请前往github下载更新`;
                badge.style.cssText = `
                    display: inline-block;
                    margin-left: 8px;
                    color: #ff4444;
                    font-size: 14px;
                    font-weight: normal;
                    vertical-align: middle;
                `;
                const titleB = drawerToggle.querySelector('b');
                if (titleB) {
                    titleB.insertAdjacentElement('afterend', badge);
                } else {
                    drawerToggle.appendChild(badge);
                }
            }

            // 弹窗提醒（每个浏览器会话只弹一次）
            if (!sessionStorage.getItem('breezetts2_update_notified')) {
                sessionStorage.setItem('breezetts2_update_notified', 'true');
                setTimeout(() => {
                    const localVerDisplay = currentVersion || localStorage.getItem('breezetts2_local_version') || '未知';
                    const msg = `月声 发现新版本！\n\n当前版本：${localVerDisplay}\n最新版本：${remoteVersion}\n\n请前往 GitHub下载更新。`;
                    if (window.toastr) {
                        window.toastr.info(msg, '更新提示', { timeOut: 7000, closeButton: true });
                    } else {
                        alert(msg);
                    }
                }, 1200);
            }
        }

        function scheduleCheck() {
            setTimeout(checkUpdate, 5000);
        }

        return { checkUpdate, scheduleCheck, hasUpdate: () => hasUpdate };
    })();   
    // ==================== 插件设置面板 ====================
    function injectSettingsPanel() {
        if (document.getElementById('breezetts2-settings')) {
            const settings = getSettings();
            const urlInput = document.getElementById('breezetts2-url');
            if (urlInput && urlInput.value !== settings.apiUrl) urlInput.value = settings.apiUrl;
            const pathMsg = settings.cacheImportPath || '未设置本地目录';
            const pathInput = document.getElementById('breezetts2-local-path');
            if (pathInput && pathInput.value !== pathMsg) pathInput.value = pathMsg;
            return;
        }
        const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings_container');
        if (!container) return;
        const settings = getSettings();
        const volumeVal = typeof settings.volume === 'number' ? settings.volume : 1.0;
        let pathDisplay = settings.cacheImportPath || '未设置本地目录';
        const handle = LocalRepo.getHandle();
        if (handle && handle.name) { pathDisplay = handle.name; }

        const html = `
            <div id="breezetts2-settings" class="extension_settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>月声 播放器</b>
                        <i class="inline-drawer-icon fa-solid fa-circle-chevron-down"></i>
                    </div>
                    <div class="inline-drawer-content" style="display:none;">
                        <!-- 预设管理 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">⚙️ 预设管理</div>
                            <div class="breezetts2-preset-bar">
                                <select id="breezetts2-preset-select" class="text_pole"></select>
                                <input type="text" id="breezetts2-preset-name" class="text_pole" placeholder="预设名称">
                                <div id="breezetts2-preset-save" class="menu_button" title="保存/新建预设"><i class="fa-solid fa-floppy-disk"></i></div>
                                <div id="breezetts2-preset-delete" class="menu_button" title="删除预设"><i class="fa-solid fa-trash-can"></i></div>
                            </div>
                        </div>
                        <!-- 模块1：服务配置 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">🔌 服务配置</div>
                            <div class="breezetts2-setting-row"><label>TTS 服务地址</label><input type="text" id="breezetts2-url" class="text_pole" value="${settings.apiUrl}"></div>
                            <div class="breezetts2-setting-row"><label>音色克隆地址</label><input type="text" id="breezetts2-clone-url" class="text_pole" value="${settings.cloningUrl}"></div>
                            <div class="breezetts2-setting-row"><label>音频列表地址</label><input type="text" id="breezetts2-voice-list-url" class="text_pole" value="${settings.voiceListUrl || 'http://127.0.0.1:7881/voices'}"></div>
                            <div class="breezetts2-setting-row"><label>推理模型名称</label><input type="text" id="breezetts2-model" class="text_pole" value="${settings.model}"></div>
                        </div>
                        <!-- 模块：提示词管理 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">📝 提示词管理</div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-prompt-enable">启用提示词注入</label><input type="checkbox" id="breezetts2-prompt-enable"${settings.promptInjection?.enabled ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-prompt-follow">正文跟随插件更新</label><input type="checkbox" id="breezetts2-prompt-follow"${settings.promptInjection?.followUpdates !== false ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">提示词分两块：<strong>正文</strong>（格式规范、情感描述要求、示例）跟随插件更新，每次加载都刷成最新版；<strong>可用音效清单</strong>永远归你，插件不会动它。想在正文里写自己的东西，就把上面这个开关关掉。</div>
                            <div class="breezetts2-setting-row"><label>注入深度</label><input type="number" id="breezetts2-prompt-depth" class="text_pole" value="${settings.promptInjection?.depth ?? 4}" min="0"></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">数字是"从末尾往前数第几条"：4 = 插在倒数第 4 条之前。<b>对话很短（比如刚开的新对话）时不会再被挤到最前面</b>，会紧贴末尾；想让它始终贴着生成点就填 1（0 = 插到最后）。</div>
                            <div class="breezetts2-setting-row"><label>角色</label><select id="breezetts2-prompt-role" class="text_pole"><option value="system"${settings.promptInjection?.role === 'system' ? ' selected' : ''}>System</option><option value="user"${settings.promptInjection?.role === 'user' ? ' selected' : ''}>User</option><option value="assistant"${settings.promptInjection?.role === 'assistant' ? ' selected' : ''}>Assistant</option></select></div>
                            <!-- 喂给模型的历史里去掉标签：逻辑在 chat-filter.js 的 planPromptTagStrip -->
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-strip-history-tags">注入时去掉历史里的标签</label><input type="checkbox" id="breezetts2-strip-history-tags" ${settings.stripHistoryTags?.enabled !== false ? 'checked' : ''}></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">发给模型的历史里，把行首的 <code>[角色|性别][情感][场景]</code> 去掉（<b>聊天记录与显示都不变</b>），免得情感描述照着上一轮抄、越写越固定。格式由提示词约束。</div>
                            <div class="breezetts2-setting-row" id="breezetts2-strip-keep-row" style="${settings.stripHistoryTags?.enabled !== false ? '' : 'display: none;'}"><label>保留示范条数</label><input type="number" id="breezetts2-strip-keep" class="text_pole" min="0" max="5" value="${settings.stripHistoryTags?.keep ?? 1}" style="width: 80px;"><span style="font-size:0.85em; opacity:0.7;">条（留最近几条做格式示范）<b>0 不推荐</b>：历史里一条标签实例都不剩时，模型可能干脆不写标签 —— GAL 模式就没台词可读了</span></div>
                            <div class="breezetts2-setting-row" style="flex-direction:column; align-items:flex-start;"><label style="margin-bottom:5px;">提示词正文<span id="breezetts2-prompt-body-note" style="font-weight:normal; opacity:0.7;"></span></label><textarea id="breezetts2-prompt-body" class="text_pole" rows="6" placeholder="提示词正文...">${settings.promptInjection?.body || ''}</textarea></div>
                            <div class="breezetts2-setting-row" style="flex-direction:column; align-items:flex-start;"><label style="margin-bottom:5px;">可用音效清单（你的，插件不会改它）</label><textarea id="breezetts2-prompt-scenelist" class="text_pole" rows="5" placeholder="#### 正常场景列表：&#10;雨声、森林&#10;#### NSFW场景列表：">${settings.promptInjection?.sceneList || ''}</textarea></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;" id="breezetts2-prompt-names-hint"></div>
                        </div>
                        <!-- 模块2：播放与自动化 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">▶️ 播放与自动化</div>
                            <div class="breezetts2-setting-row">
                                <label>解析模式</label>
                                <select id="breezetts2-parsing-mode" class="text_pole">
                                    <option value="gal"${settings.parsingMode === 'gal' ? ' selected' : ''}>GAL 模式（仅朗读台词）</option>
                                    <option value="audiobook"${settings.parsingMode === 'audiobook' ? ' selected' : ''}>听书模式（全文朗读）</option>
                                    <option value="rp"${settings.parsingMode === 'rp' ? ' selected' : ''}>RP 模式（仅朗读引号内）</option>
                                </select>
                            </div>
                            <div class="breezetts2-setting-row">
                                <label>音频间隔 <span style="font-size:0.85em; opacity:0.7;">(秒，相邻两句之间)</span></label>
                                <input type="number" id="breezetts2-segment-gap" class="text_pole" value="${settings.segmentGap ?? 0.25}" min="0" max="10" step="0.05" style="width: 80px;">
                            </div>
                            <div class="breezetts2-setting-row">
                                <label>换角色额外间隔 <span style="font-size:0.85em; opacity:0.7;">(秒，换人时再加)</span></label>
                                <input type="number" id="breezetts2-speaker-change-gap" class="text_pole" value="${settings.speakerChangeGap ?? 0.35}" min="0" max="10" step="0.05" style="width: 80px;">
                            </div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-enable-inline">启用行内增强渲染</label><input type="checkbox" id="breezetts2-enable-inline"${settings.enableInline !== false ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-show-floating">显示悬浮播放控制器</label><input type="checkbox" id="breezetts2-show-floating"${settings.showFloatingPlayer !== false ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-auto-inference">回复后自动推理</label><input type="checkbox" id="breezetts2-auto-inference"${settings.autoInference === true ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-auto-play">推理完毕后自动续播</label><input type="checkbox" id="breezetts2-auto-play"${settings.autoPlay === true ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-streaming-play">推理完N句后自动续播</label><input type="checkbox" id="breezetts2-streaming-play"${settings.streamingPlay === true ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row" id="breezetts2-streaming-skip-row" style="${settings.streamingPlay !== true ? 'display: none;' : ''}"><label for="breezetts2-streaming-skip-count">推理句数</label><div style="display: flex; align-items: center; gap: 8px;"><input type="number" id="breezetts2-streaming-skip-count" class="text_pole" min="1" max="50" value="${settings.streamingSkipCount || 1}" style="width: 80px;"><span style="font-size: 0.85em; opacity: 0.7;">句（1=即时播放，2=推理2句后播放...）</span></div></div>
                            <!-- 自定义正则过滤：开启后会**替代**听书模式的内置硬过滤（见 index.js:1223），
                                 名字不能叫「启用正则过滤」——那会让人以为不开就没有过滤。 -->
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-regex-enable">自定义正则过滤</label><input type="checkbox" id="breezetts2-regex-enable"${settings.regexFilter?.enabled ? ' checked' : ''}></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">插件本身带过滤（听书模式下会硬过滤 markdown 等装饰内容）。开启这一项就<strong>改用你自己的正则</strong>，内置过滤会被跳过。</div>
                            <div class="breezetts2-setting-row" id="breezetts2-regex-row" style="${settings.regexFilter?.enabled ? '' : 'display: none;'}"><label style="flex: 0 0 auto; margin-right: 8px;">正则表达式</label><input type="text" id="breezetts2-regex-pattern" class="text_pole" value="${settings.regexFilter?.pattern || ''}" placeholder="粘贴正则表达式" style="flex: 1;"><button class="menu_button" id="breezetts2-regex-test" title="测试正则">🧪</button></div>
                            <div class="breezetts2-setting-row" id="breezetts2-regex-preview-row" style="${settings.regexFilter?.enabled ? 'font-size: 0.85em; opacity: 0.8;' : 'display: none;'}"><span>过滤预览: </span><span id="breezetts2-regex-preview">无</span></div>
                            <div class="breezetts2-setting-row"><label>默认朗读音色</label><input type="text" id="breezetts2-voice" class="text_pole" value="${settings.defaultVoice}"></div>
                            <div class="breezetts2-setting-row"><label>默认速度: <span id="breezetts2-speed-val">${settings.speed}</span></label><input type="range" id="breezetts2-speed" min="0.5" max="2" step="0.1" value="${settings.speed}"></div>
                            <div class="breezetts2-setting-row"><label>全局音量: <span id="breezetts2-volume-val">${volumeVal.toFixed(2)}</span></label><input type="range" id="breezetts2-volume" min="0" max="1" step="0.05" value="${volumeVal}"></div>
                        </div>
                        <!-- 聊天显示：托管一条酒馆正则（仅格式显示），逻辑见 chat-filter.js。
                             作用范围是**整个方括号标签格式**（角色/情感/场景），不只是场景那一段；
                             面板上只留一句话，详细说明在 README。默认开启。 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">💬 聊天显示</div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-hide-tags">隐藏聊天里的方括号标签</label><input type="checkbox" id="breezetts2-hide-tags" ${settings.chatTagHiding?.enabled ? 'checked' : ''}></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">把 <code>[角色|性别][情感][场景]</code> 这串标签从气泡里藏掉，只留台词（只改显示，聊天记录与提示词不变）。</div>
                            <div class="breezetts2-setting-row" id="breezetts2-hide-tags-row" style="${settings.chatTagHiding?.enabled ? '' : 'display: none;'}"><label style="flex: 0 0 auto; margin-right: 8px;">过滤正则</label><input type="text" id="breezetts2-hide-tags-pattern" class="text_pole" value="${settings.chatTagHiding?.pattern || ''}" placeholder="\\[[^\\]\\n]*\\]" style="flex: 1;"></div>
                            <div class="breezetts2-setting-row" id="breezetts2-hide-tags-presets" style="font-size:0.85em; opacity:0.7; ${settings.chatTagHiding?.enabled ? '' : 'display: none;'}">现成的两个，直接抄进上面那栏：<br>${PATTERN_PRESETS.map(p => `　<code>${p.pattern}</code> —— ${p.label}（${p.note}）`).join('<br>')}</div>
                            <div class="breezetts2-setting-row" id="breezetts2-hide-tags-status" style="font-size:0.85em;"></div>
                        </div>
                        <!-- 场景音效：本模块只管音量 / 淡入淡出这类播放参数。
                             音效放在哪个文件夹、四个文件夹的区别，写在 README 与 data\pjy\_说明.txt 里。 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">🎵 场景音效</div>
                            <div class="breezetts2-setting-row"><label>环境音音量</label><input type="range" id="breezetts2-ambient-volume" class="breezetts2-slider" min="0" max="1" step="0.05" value="${settings.ambientSoundVolume ?? 0.4}"><span id="breezetts2-ambient-volume-val">${((settings.ambientSoundVolume ?? 0.4) * 100).toFixed(0)}%</span></div>
                            <div class="breezetts2-setting-row"><label>环境音效01 音量</label><input type="range" id="breezetts2-ambient1-volume" class="breezetts2-slider" min="0" max="1" step="0.05" value="${settings.ambient1SoundVolume ?? 0.3}"><span id="breezetts2-ambient1-volume-val">${((settings.ambient1SoundVolume ?? 0.3) * 100).toFixed(0)}%</span></div>
                            <div class="breezetts2-setting-row"><label>事件音音量</label><input type="range" id="breezetts2-event-volume" class="breezetts2-slider" min="0" max="1" step="0.05" value="${settings.eventSoundVolume ?? 0.6}"><span id="breezetts2-event-volume-val">${((settings.eventSoundVolume ?? 0.6) * 100).toFixed(0)}%</span></div>
                            <div class="breezetts2-setting-row"><label>淡入淡出</label><select id="breezetts2-ambient-fade" class="text_pole"><option value="0"${(settings.ambientFadeDuration ?? 0) == 0 ? ' selected' : ''}>关闭</option><option value="100"${(settings.ambientFadeDuration ?? 0) == 100 ? ' selected' : ''}>0.1 秒</option><option value="200"${(settings.ambientFadeDuration ?? 0) == 200 ? ' selected' : ''}>0.2 秒</option><option value="300"${(settings.ambientFadeDuration ?? 0) == 300 ? ' selected' : ''}>0.3 秒</option><option value="400"${(settings.ambientFadeDuration ?? 0) == 400 ? ' selected' : ''}>0.4 秒</option><option value="500"${(settings.ambientFadeDuration ?? 0) == 500 ? ' selected' : ''}>0.5 秒</option><option value="1000"${(settings.ambientFadeDuration ?? 0) == 1000 ? ' selected' : ''}>1 秒</option><option value="1500"${(settings.ambientFadeDuration ?? 0) == 1500 ? ' selected' : ''}>1.5 秒</option><option value="2000"${(settings.ambientFadeDuration ?? 0) == 2000 ? ' selected' : ''}>2 秒</option><option value="3000"${(settings.ambientFadeDuration ?? 0) == 3000 ? ' selected' : ''}>3 秒</option></select></div>
                            <div class="breezetts2-setting-row checkbox-row"><label for="breezetts2-ambient-loop-scene">同场景下循环播放场景音</label><input type="checkbox" id="breezetts2-ambient-loop-scene" ${settings.ambientLoopByScene ? 'checked' : ''}></div>
                            <div class="breezetts2-setting-row" style="font-size:0.85em; opacity:0.7;">音效放哪、怎么命名、四个文件夹的区别，见 README 的「场景音效的目录约定」或 <code>data\pjy\_说明.txt</code>。</div>
                        </div>
                        <!-- 模块3：缓存管理 -->
                        <div class="breezetts2-setting-module">
                            <div class="breezetts2-module-header">🎙️ 参考音频&缓存管理</div>
                            <div class="breezetts2-path-container"><input type="text" id="breezetts2-local-path" class="breezetts2-path-display" value="${pathDisplay}" readonly title="${pathDisplay}"><button class="menu_button" id="breezetts2-choose-folder" title="选择本地文件夹">📂 选择</button><button class="menu_button breezetts2-auth-btn" id="breezetts2-auth-btn" title="需授权读写权限" style="display:none;">🔄 授权</button></div>
                            <div class="breezetts2-audio-pool"><div>已缓存音频: <span id="breezetts2-cache-count">0</span> 条</div><div class="breezetts2-audio-pool-actions"><button class="menu_button" id="breezetts2-scan-import" title="扫描本地目录">📥 扫描导入</button><button class="menu_button" id="breezetts2-export-cache" title="导出备份">📂 导出备份</button><button class="menu_button" id="breezetts2-clear-cache" title="清空缓存">🗑️ 清空全部</button></div></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = html;
        container.appendChild(div.firstElementChild);
        const panel = document.getElementById('breezetts2-settings');

        const bindInput = (id, field) => { const el = panel.querySelector(id); if (el) { el.oninput = el.onchange = (e) => { const s = getSettings(); s[field] = e.target.value; saveSettings(); }; } };
        bindInput('#breezetts2-url', 'apiUrl'); bindInput('#breezetts2-clone-url', 'cloningUrl'); bindInput('#breezetts2-voice-list-url', 'voiceListUrl'); bindInput('#breezetts2-model', 'model');

        const parsingModeSelect = panel.querySelector('#breezetts2-parsing-mode');
        if (parsingModeSelect) {
            parsingModeSelect.onchange = (e) => {
                const s = getSettings();
                s.parsingMode = e.target.value;
                saveSettings();
                refreshAllMessages();
                // 音频间隔现在是全局设置（所有模式都生效），不再随解析模式显示/隐藏
            };
        }

        // 音频间隔：允许小数。输入过程中不做激进矫正，否则打 "0.5" 会在中途被截成 0。
        const bindGapInput = (id, field) => {
            const el = panel.querySelector(id);
            if (!el) return;
            el.oninput = (e) => {
                const s = getSettings();
                const v = parseFloat(e.target.value);
                s[field] = isNaN(v) ? 0 : Math.max(0, Math.min(10, v));
                saveSettings();
            };
        };
        bindGapInput('#breezetts2-segment-gap', 'segmentGap');
        bindGapInput('#breezetts2-speaker-change-gap', 'speakerChangeGap');

        const bindCheckbox = (id, field, needRefresh = false) => { const el = panel.querySelector(id); if (el) { el.onchange = (e) => { const s = getSettings(); s[field] = e.target.checked; saveSettings(); if (needRefresh) refreshAllMessages(); }; } };
        bindCheckbox('#breezetts2-enable-inline', 'enableInline', true);
        bindCheckbox('#breezetts2-auto-inference', 'autoInference', false);
        const showFloatingChk = panel.querySelector('#breezetts2-show-floating');
        if (showFloatingChk) {
            showFloatingChk.onchange = (e) => {
                const s = getSettings();
                s.showFloatingPlayer = e.target.checked;
                saveSettings();
                if (!e.target.checked) { TTSPlayerWindow.hide(); }
            };
        }
        bindCheckbox('#breezetts2-auto-play', 'autoPlay', false);
        bindCheckbox('#breezetts2-streaming-play', 'streamingPlay', false);

        const regexEnableChk = panel.querySelector('#breezetts2-regex-enable');
        const regexPatternInput = panel.querySelector('#breezetts2-regex-pattern');
        const regexTestBtn = panel.querySelector('#breezetts2-regex-test');
        const regexRow = panel.querySelector('#breezetts2-regex-row');
        const regexPreviewRow = panel.querySelector('#breezetts2-regex-preview-row');
        const updateRegexPreview = () => {
            const s = getSettings(); const previewEl = panel.querySelector('#breezetts2-regex-preview');
            if (!previewEl) return;
            if (!s.regexFilter?.enabled || !s.regexFilter?.pattern) { previewEl.textContent = '无'; return; }
            try {
                const testText = '测试文本 *星号* `代码` [括号] #标题';
                const regex = new RegExp(s.regexFilter.pattern, 'g');
                const filtered = testText.replace(regex, '');
                previewEl.textContent = `"${testText}" -> "${filtered}"`;
            } catch (e) { previewEl.textContent = '正则语法错误: ' + e.message; }
        };
        if (regexEnableChk) {
            regexEnableChk.onchange = (e) => {
                const s = getSettings(); if (!s.regexFilter) s.regexFilter = { enabled: false, pattern: '' };
                s.regexFilter.enabled = e.target.checked;
                if (regexRow) regexRow.style.display = e.target.checked ? '' : 'none';
                if (regexPreviewRow) regexPreviewRow.style.display = e.target.checked ? '' : 'none';
                saveSettings(); updateRegexPreview();
            };
        }
        if (regexPatternInput) {
            regexPatternInput.oninput = (e) => {
                const s = getSettings(); if (!s.regexFilter) s.regexFilter = { enabled: false, pattern: '' };
                s.regexFilter.pattern = e.target.value; saveSettings(); updateRegexPreview();
            };
        }
        if (regexTestBtn) {
            regexTestBtn.onclick = () => {
                const s = getSettings();
                if (!s.regexFilter?.pattern) { if (window.toastr) window.toastr.warning('请先输入正则表达式'); return; }
                try {
                    const testText = '测试文本 *星号* `代码` [括号] #标题';
                    const regex = new RegExp(s.regexFilter.pattern, 'g');
                    const filtered = testText.replace(regex, '');
                    if (window.toastr) window.toastr.success(`测试结果: "${testText}" -> "${filtered}"`);
                } catch (e) { if (window.toastr) window.toastr.error('正则语法错误: ' + e.message); }
            };
        }
        updateRegexPreview();

        const streamingSkipRow = panel.querySelector('#breezetts2-streaming-skip-row');
        const streamingSkipCount = panel.querySelector('#breezetts2-streaming-skip-count');
        const streamingPlayCheckbox = panel.querySelector('#breezetts2-streaming-play');
        const autoPlayCheckbox = panel.querySelector('#breezetts2-auto-play');
        if (streamingPlayCheckbox) {
            streamingPlayCheckbox.onchange = (e) => {
                const s = getSettings();
                if (e.target.checked) { s.streamingPlay = true; s.autoPlay = false; if (autoPlayCheckbox) autoPlayCheckbox.checked = false; if (streamingSkipRow) streamingSkipRow.style.display = ''; }
                else { s.streamingPlay = false; if (streamingSkipRow) streamingSkipRow.style.display = 'none'; }
                saveSettings();
            };
        }
        if (autoPlayCheckbox) {
            autoPlayCheckbox.onchange = (e) => {
                const s = getSettings();
                if (e.target.checked) { s.autoPlay = true; s.streamingPlay = false; if (streamingPlayCheckbox) streamingPlayCheckbox.checked = false; if (streamingSkipRow) streamingSkipRow.style.display = 'none'; }
                else { s.autoPlay = false; }
                saveSettings();
            };
        }
        if (streamingSkipCount) {
            streamingSkipCount.onchange = (e) => {
                const s = getSettings();
                const countVal = parseInt(e.target.value) || 1;
                s.streamingSkipCount = Math.max(1, Math.min(50, countVal));
                e.target.value = s.streamingSkipCount; saveSettings();
            };
        }
        const voiceInput = panel.querySelector('#breezetts2-voice');
        if (voiceInput) { voiceInput.onchange = (e) => { const s = getSettings(); s.defaultVoice = ensureWavSuffix(e.target.value); saveSettings(); }; }
        const speedInput = panel.querySelector('#breezetts2-speed');
        if (speedInput) { speedInput.oninput = (e) => { const val = parseFloat(e.target.value); document.getElementById('breezetts2-speed-val').textContent = val; const s = getSettings(); s.speed = val; saveSettings(); }; }
        const volInput = panel.querySelector('#breezetts2-volume');
        if (volInput) { volInput.oninput = (e) => { const val = parseFloat(e.target.value); document.getElementById('breezetts2-volume-val').textContent = val.toFixed(2); const s = getSettings(); s.volume = val; saveSettings(); }; }

        const bindPrompt = (id, field) => { const el = panel.querySelector(id); if (el) { el.oninput = el.onchange = (e) => { const s = getSettings(); if (!s.promptInjection || typeof s.promptInjection !== 'object') { s.promptInjection = JSON.parse(JSON.stringify(defaultSettings.promptInjection)); } s.promptInjection[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; saveSettings(); }; } };
        bindPrompt('#breezetts2-prompt-enable', 'enabled'); bindPrompt('#breezetts2-prompt-depth', 'depth'); bindPrompt('#breezetts2-prompt-role', 'role');
        bindPrompt('#breezetts2-prompt-body', 'body'); bindPrompt('#breezetts2-prompt-scenelist', 'sceneList');
        bindPrompt('#breezetts2-prompt-follow', 'followUpdates');

        // ---- 注入时去掉历史标签（见 chat-filter.js 的 planPromptTagStrip）----
        const stripChk = panel.querySelector('#breezetts2-strip-history-tags');
        const stripKeepRow = panel.querySelector('#breezetts2-strip-keep-row');
        const stripKeepInput = panel.querySelector('#breezetts2-strip-keep');
        const ensureStripCfg = () => {
            const s = getSettings();
            if (!s.stripHistoryTags || typeof s.stripHistoryTags !== 'object') {
                s.stripHistoryTags = { enabled: true, keep: 1 };
            }
            return s.stripHistoryTags;
        };
        if (stripChk) {
            stripChk.onchange = (e) => {
                const cfg = ensureStripCfg();
                cfg.enabled = e.target.checked;
                saveSettings();
                if (stripKeepRow) stripKeepRow.style.display = e.target.checked ? '' : 'none';
            };
        }
        if (stripKeepInput) {
            stripKeepInput.onchange = (e) => {
                const v = parseInt(e.target.value);
                ensureStripCfg().keep = Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : 1;
                e.target.value = ensureStripCfg().keep;
                saveSettings();
            };
        }

        // 跟随更新开着时，正文每次加载都会被刷成默认值，所以那个框设成只读并说明原因 ——
        // 否则用户敲进去的字会在下次读设置时凭空消失，像是编辑器坏了。
        const promptFollow = panel.querySelector('#breezetts2-prompt-follow');
        const promptBodyEl = panel.querySelector('#breezetts2-prompt-body');
        const promptBodyNote = panel.querySelector('#breezetts2-prompt-body-note');
        const syncPromptBodyState = () => {
            const following = !(promptFollow && !promptFollow.checked);
            if (promptBodyEl) {
                promptBodyEl.readOnly = following;
                promptBodyEl.style.opacity = following ? '0.75' : '1';
            }
            if (promptBodyNote) {
                promptBodyNote.textContent = following
                    ? '（跟随插件更新，只读；想自己写就关掉上面的开关）'
                    : '（已停用自动更新，这里由你维护）';
            }
        };
        if (promptFollow) promptFollow.onchange = (e) => { syncPromptBodyState(); };
        syncPromptBodyState();

        // 整合包自带的样例音效里，哪些名字没出现在用户的清单里 —— 只提示，不动内容。
        // 这就是「清单也能跟上更新」的实现方式：让用户看见，由他决定加不加。
        (() => {
            const hintEl = panel.querySelector('#breezetts2-prompt-names-hint');
            if (!hintEl) return;
            const list = (getSettings().promptInjection || {}).sceneList || '';
            const shipped = defaultSettings.promptInjection.sceneList;
            const names = shipped.split('\n')
                .filter(ln => !ln.trim().startsWith('#'))
                .join('、').split('、')
                .map(s => s.trim()).filter(Boolean);
            const missing = names.filter(n => !list.includes(n));
            if (!names.length) { hintEl.textContent = ''; return; }
            hintEl.textContent = missing.length
                ? `提示：整合包自带的这些音效名不在你的清单里 —— ${missing.join('、')}（要用就把它们补进上面的清单，并在 pjy/ 里放好对应文件）`
                : '你的清单已包含整合包自带的全部音效名。';
        })();

        const ambVolSlider = panel.querySelector('#breezetts2-ambient-volume');
        if (ambVolSlider) { ambVolSlider.oninput = (e) => { const v = parseFloat(e.target.value); AmbientPlayer.setVolume(v); const disp = panel.querySelector('#breezetts2-ambient-volume-val'); if (disp) disp.textContent = Math.round(v * 100) + '%'; }; }
        // 环境音效01 是第二条循环轨，音量单独可调（默认 0.3）。按轨道传参。
        const amb1VolSlider = panel.querySelector('#breezetts2-ambient1-volume');
        if (amb1VolSlider) { amb1VolSlider.oninput = (e) => { const v = parseFloat(e.target.value); AmbientPlayer.setVolume('ambient1', v); const disp = panel.querySelector('#breezetts2-ambient1-volume-val'); if (disp) disp.textContent = Math.round(v * 100) + '%'; }; }
        const evtVolSlider = panel.querySelector('#breezetts2-event-volume');
        if (evtVolSlider) {
            evtVolSlider.oninput = (e) => {
                const v = Math.max(0, Math.min(1, parseFloat(e.target.value)));
                const s = getSettings(); s.eventSoundVolume = v; saveSettings();
                const disp = panel.querySelector('#breezetts2-event-volume-val');
                if (disp) disp.textContent = Math.round(v * 100) + '%';
            };
        }
        const ambFadeSelect = panel.querySelector('#breezetts2-ambient-fade');
        if (ambFadeSelect) { ambFadeSelect.onchange = (e) => { const s = getSettings(); s.ambientFadeDuration = parseInt(e.target.value) || 0; saveSettings(); }; }
        const ambLoopSceneChk = panel.querySelector('#breezetts2-ambient-loop-scene');
        if (ambLoopSceneChk) { ambLoopSceneChk.onchange = (e) => { const s = getSettings(); s.ambientLoopByScene = e.target.checked; saveSettings(); }; }
        // ---- 隐藏方括号标签（托管一条酒馆正则，见 chat-filter.js）----
        const hideTagsChk = panel.querySelector('#breezetts2-hide-tags');
        const hideTagsRow = panel.querySelector('#breezetts2-hide-tags-row');
        const hideTagsPresets = panel.querySelector('#breezetts2-hide-tags-presets');
        const hideTagsInput = panel.querySelector('#breezetts2-hide-tags-pattern');
        const hideTagsStatus = panel.querySelector('#breezetts2-hide-tags-status');
        const hideTagsEnsureCfg = () => {
            const s = getSettings();
            if (!s.chatTagHiding || typeof s.chatTagHiding !== 'object') {
                s.chatTagHiding = { enabled: false, pattern: DEFAULT_PATTERN };
            }
            return s.chatTagHiding;
        };
        const updateHideTagsStatus = (result) => {
            if (!hideTagsStatus) return;
            const ctx = getContext();
            const extOff = Array.isArray(ctx?.disabledExtensions) && ctx.disabledExtensions.includes('regex');
            const cfg = hideTagsEnsureCfg();
            if (!cfg.enabled) { hideTagsStatus.textContent = ''; return; }
            if (result === 'bad-pattern') {
                hideTagsStatus.innerHTML = '<b>正则语法错误</b>，这条规则没有写进酒馆。请检查写法（直接写模式，或用 <code>/模式/标志</code>）。';
                return;
            }
            if (result === 'disabled-ext' || extOff) {
                hideTagsStatus.innerHTML = '⚠️ 酒馆的<b>正则扩展处于停用状态</b>，这条规则不会生效 —— 在上面的「扩展」里把「正则」启用即可。';
                return;
            }
            if (result === 'ok') {
                hideTagsStatus.textContent = '已生效。酒馆正则面板里可以看到「月声 · 隐藏方括号标签」这条规则。';
                return;
            }
            hideTagsStatus.textContent = '';
        };
        if (hideTagsChk) {
            hideTagsChk.onchange = (e) => {
                const cfg = hideTagsEnsureCfg();
                cfg.enabled = e.target.checked;
                saveSettings();
                if (hideTagsRow) hideTagsRow.style.display = e.target.checked ? '' : 'none';
                if (hideTagsPresets) hideTagsPresets.style.display = e.target.checked ? '' : 'none';
                updateHideTagsStatus(syncChatTagHiding());
                refreshAllMessages();   // 立即生效：让聊天按新规则重渲染
            };
        }
        if (hideTagsInput) {
            // 用 onchange 而不是 oninput：每敲一个字就重渲染整个聊天太重了
            hideTagsInput.onchange = (e) => {
                const cfg = hideTagsEnsureCfg();
                cfg.pattern = e.target.value;
                saveSettings();
                updateHideTagsStatus(syncChatTagHiding());
                refreshAllMessages();
            };
        }
        updateHideTagsStatus(syncChatTagHiding());

        const pathInputEl = panel.querySelector('#breezetts2-local-path');
        const authBtn = panel.querySelector('#breezetts2-auth-btn');
        const updatePathUI = async () => {
            const h = LocalRepo.getHandle(); const s = getSettings();
            let displayPath = '未设置本地目录';
            if (h && h.name) { displayPath = h.name; } else if (s.cacheImportPath) { displayPath = s.cacheImportPath; }
            if (pathInputEl) pathInputEl.value = displayPath;
            if (pathInputEl) pathInputEl.title = displayPath;
            if (h) {
                let hasPerm = false;
                try { if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') { hasPerm = true; } } catch (e) { }
                if (hasPerm) { authBtn.style.display = 'none'; } else { authBtn.style.display = 'inline-block'; }
            } else { authBtn.style.display = 'none'; }
        };
        const chooseBtn = panel.querySelector('#breezetts2-choose-folder');
        if (chooseBtn) {
            chooseBtn.onclick = async () => {
                if (!window.showDirectoryPicker) { if (window.toastr) window.toastr.error('浏览器不支持 File System Access API'); return; }
                try {
                    const h = await window.showDirectoryPicker();
                    if (h) { await LocalRepo.setHandle(h); const s = getSettings(); s.cacheImportPath = h.name; saveSettings(); await updatePathUI(); if (window.toastr) window.toastr.success(`已选定目录: ${h.name}`); }
                } catch (e) { if (e.name !== 'AbortError') console.error(e); }
            };
        }
        if (authBtn) {
            authBtn.onclick = async () => {
                const success = await LocalRepo.requestPermission();
                if (success) { if (window.toastr) window.toastr.success('已获授权'); await updatePathUI(); }
                else { if (window.toastr) window.toastr.warning('授权失败或被拒绝'); }
            };
        }
        const scanImportBtn = panel.querySelector('#breezetts2-scan-import');
        if (scanImportBtn) {
            scanImportBtn.onclick = async () => {
                const h = LocalRepo.getHandle();
                if (!h) { if (window.toastr) window.toastr.warning('请先点击【📂 选择】设置本地音频目录'); return; }
                const hasPerm = await LocalRepo.requestPermission();
                if (!hasPerm) { if (window.toastr) window.toastr.error('未获得读写权限，无法扫描'); await updatePathUI(); return; }
                await importFromLocalDirectory(h);
                await updateAudioPoolStats();
            };
        }
        const exportBtn = panel.querySelector('#breezetts2-export-cache');
        if (exportBtn) {
            exportBtn.onclick = async () => {
                const h = LocalRepo.getHandle();
                if (!h) { if (window.toastr) window.toastr.warning('请先点击【📂 选择】设置本地音频目录'); return; }
                const hasPerm = await LocalRepo.requestPermission();
                if (!hasPerm) { if (window.toastr) window.toastr.error('未获得读写权限，无法导出'); await updatePathUI(); return; }
                await exportAudioCacheToFolder(h);
                await updateAudioPoolStats();
            };
        }
        const clearBtn = panel.querySelector('#breezetts2-clear-cache');
        if (clearBtn) {
            clearBtn.onclick = async () => {
                if (!window.confirm || window.confirm('确定要清空所有缓存的音频吗？')) {
                    await AudioStorage.clearAllAudios().catch(() => { });
                    clearMemoryAudioCache();
                    if (window.toastr) window.toastr.success('已清空缓存池');
                    await updateAudioPoolStats();
                }
            };
        }

        const populatePresetUI = () => {
            const root = getRootSettings();
            const selectEl = panel.querySelector('#breezetts2-preset-select');
            const nameEl = panel.querySelector('#breezetts2-preset-name');
            if (!selectEl || !nameEl) return;
            selectEl.innerHTML = Object.keys(root.presets).map(name => `<option value="${name}"${name === root.selected_preset ? ' selected' : ''}>${name}</option>`).join('');
            nameEl.value = root.selected_preset;
        };
        populatePresetUI();

        const presetSelect = panel.querySelector('#breezetts2-preset-select');
        if (presetSelect) { presetSelect.onchange = () => { switchPreset(presetSelect.value); }; }
        const presetSaveBtn = panel.querySelector('#breezetts2-preset-save');
        if (presetSaveBtn) {
            presetSaveBtn.onclick = () => {
                const root = getRootSettings();
                const nameEl = panel.querySelector('#breezetts2-preset-name');
                const name = (nameEl?.value || '').trim();
                if (!name) { if (window.toastr) window.toastr.warning('请输入预设名称'); return; }
                root.presets[name] = JSON.parse(JSON.stringify(getSettings()));
                root.selected_preset = name;
                saveSettings(); populatePresetUI();
                if (window.toastr) window.toastr.success(`预设 "${name}" 已保存`);
            };
        }
        const presetDelBtn = panel.querySelector('#breezetts2-preset-delete');
        if (presetDelBtn) {
            presetDelBtn.onclick = () => {
                const root = getRootSettings();
                const keys = Object.keys(root.presets);
                if (keys.length <= 1) { if (window.toastr) window.toastr.warning('至少需要保留一个预设'); return; }
                const current = root.selected_preset;
                if (!confirm(`确定要删除预设 "${current}" 吗？`)) return;
                delete root.presets[current];
                switchPreset(Object.keys(root.presets)[0]);
                if (window.toastr) window.toastr.success(`已删除预设 "${current}"`);
            };
        }
        updatePathUI(); updateAudioPoolStats();

        // 预加载场景音列表，防止首次播放时异步延迟导致丢失
        AmbientPlayer.preloadScenes();
    }

    async function updateAudioPoolStats() {
        try {
            const list = await AudioStorage.getAllAudios();
            const countEl = document.getElementById('breezetts2-cache-count');
            if (countEl) { countEl.textContent = String(list.length || 0); }
        } catch (e) { console.warn('[MoonVoice] 更新缓存统计失败:', e); }
    }

    const IMPORT_FILENAME_REGEX = /^\[(.*?)\]_(.+)_([a-f0-9]{6,})\.(?:wav|mp3|ogg)$/i;

    async function getAllAudioFilesFromDir(dirHandle, list = []) {
        try {
            for await (const [name, handle] of dirHandle.entries()) {
                if (handle.kind === 'file') {
                    const n = name.toLowerCase();
                    if (n.endsWith('.wav') || n.endsWith('.mp3') || n.endsWith('.ogg')) list.push(handle);
                } else if (handle.kind === 'directory') { await getAllAudioFilesFromDir(handle, list); }
            }
        } catch (e) { console.warn('[MoonVoice] 扫描目录失败:', e); }
        return list;
    }

    async function importFromLocalDirectory(providedHandle) {
        if (!window.showDirectoryPicker) { if (window.toastr) window.toastr.error('当前浏览器不支持 File System Access API'); return; }
        try {
            const dirHandle = providedHandle || await window.showDirectoryPicker();
            const fileHandles = await getAllAudioFilesFromDir(dirHandle);
            if (!fileHandles.length) { if (window.toastr) window.toastr.info('该目录下未发现 .wav / .mp3 / .ogg 文件'); return; }
            let imported = 0; let skipped = 0;
            for (let i = 0; i < fileHandles.length; i++) {
                const f = fileHandles[i];
                try {
                    const file = await f.getFile();
                    const blob = file.slice(0, file.size, file.type || 'audio/wav');
                    const name = f.name;
                    const match = name.match(IMPORT_FILENAME_REGEX);
                    let character, text, hash;
                    if (match) {
                        character = (match[1] || '').trim() || 'Imported';
                        text = (match[2] || '').trim() || name;
                        hash = (match[3] || '').toLowerCase();
                    } else {
                        character = 'Imported';
                        text = name.replace(/\.(wav|mp3|ogg)$/i, '');
                        hash = await generateHash(character, 'imported', text, 1, 1);
                    }
                    const existing = await AudioStorage.getAudio(hash);
                    if (existing && existing.blob) { skipped++; }
                    else {
                        const record = { hash, blob, character, text, voice: '', speed: 1, volume: 1, timestamp: Date.now() };
                        await AudioStorage.saveAudio(record);
                        imported++;
                    }
                } catch (e) { console.warn('[MoonVoice] 导入文件失败:', f.name, e); }
                if (window.toastr && (i + 1) % 10 === 0) { window.toastr.info(`正在导入: ${i + 1}/${fileHandles.length}`); }
            }
            if (window.toastr) window.toastr.success(`同步完成：新增 ${imported} 条，跳过已存在${skipped} 条`);
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('[MoonVoice] 从本地目录导入出错:', e);
            if (window.toastr) window.toastr.error('导入失败: ' + e.message);
        }
    }

    async function exportAudioCacheToFolder(providedHandle) {
        if (!AudioStorage || !AudioStorage.getAllAudios) return;
        if (!window.showDirectoryPicker) { if (window.toastr) window.toastr.error('当前浏览器不支持 File System Access API'); return; }
        try {
            const records = await AudioStorage.getAllAudios();
            if (!records.length) { if (window.toastr) window.toastr.info('暂无可导出的缓存音频'); return; }
            const dirHandle = providedHandle || await window.showDirectoryPicker();
            let idx = 0;
            for (const rec of records) {
                idx++;
                const safeChar = (rec.character || 'voice').slice(0, 16);
                const previewText = (rec.text || '').slice(0, 10).replace(/\s+/g, '');
                const shortHash = (rec.hash || 'hash').slice(0, 6);
                const rawName = `[${safeChar}]_${previewText}_${shortHash}.wav`;
                const fileName = rawName.replace(/[\\/:*?"<>|]/g, '_');
                const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(rec.blob);
                await writable.close();
                if (window.toastr && idx % 5 === 0) { window.toastr.info(`导出进度: ${idx}/${records.length}`); }
            }
            if (window.toastr) window.toastr.success(`导出完成，共 ${records.length} 条`);
        } catch (e) {
            console.error('[MoonVoice] 导出音频缓存到文件夹出错:', e);
            if (window.toastr) window.toastr.error('导出失败: ' + e.message);
        }
    }

    // ==================== 事件监听 ====================
    function setupEventListeners() {
        try {
            const eventSource = window.eventSource || window.SillyTavern?.getContext?.()?.eventSource;
            const event_types = window.event_types || window.SillyTavern?.getContext?.()?.event_types;
            if (!eventSource || !event_types) {
                return;
            }

            if (event_types.MESSAGE_EDITED) {
                eventSource.on(event_types.MESSAGE_EDITED, (mesId) => {
                    setTimeout(() => {
                        const msg = document.querySelector(`.mes[mesid="${mesId}"]`);
                        if (msg) {
                            const mesText = msg.querySelector('.mes_text');
                            if (mesText) delete mesText.dataset.breezetts2Injected;
                            injectMessageButtons(msg);
                            injectInlineButtons(msg, true);
                        }
                    }, 100);
                });
            }
            if (event_types.CHARACTER_MESSAGE_RENDERED) {
                eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
                    setTimeout(() => polling(), 100);
                });
            }
            if (event_types.MESSAGE_RECEIVED) {
                eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
                    setTimeout(async () => {
                        polling();
                        const settings = getSettings();
                        if (settings.autoInference) {
                            let msg = null;
                            if (mesId) { msg = document.querySelector(`.mes[mesid="${mesId}"]`); }
                            if (!msg) { const all = document.querySelectorAll('.mes[is_user="false"]'); if (all.length) msg = all[all.length - 1]; }
                            if (msg) {
                                await inferMessageAudios(msg, null, true);
                                if (settings.autoPlay) { await autoPlayMessage(msg); }
                            }
                        }
                    }, 500);
                });
            }

            if (event_types.CHAT_COMPLETION_PROMPT_READY) {
                eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
                    const settings = getSettings();

                    // ---- 先去掉历史里的标签（只留最近几条当示范）----
                    // 为什么：模型每轮都能看到自己上一轮写的标签，而"上一条具体例子"比系统提示里的
                    // 抽象要求更有影响力 —— 情感描述会照着上一轮抄、越写越固定。去掉它们、格式交给
                    // 提示词约束；留最近一条带标签的消息当活样板，格式漂了能靠它纠回来，顺带把
                    // "当前场景"也留在了上下文里（否则模型可能每句微调场景名 → 环境音反复重启）。
                    // 只改这份请求用的副本：聊天记录、显示、以及插件自己读场景名做音效都不受影响。
                    try {
                        const stripCfg = settings.stripHistoryTags || {};
                        eventData.chat = planPromptTagStrip(eventData.chat, stripCfg);
                    } catch (e) {
                        console.warn('[MoonVoice] 处理历史标签时出错（本次不处理）:', e);
                    }

                    const config = settings.promptInjection;
                    if (config && config.enabled) {
                        // 注入的是「插件维护的正文」+「用户维护的清单」，两块分开存是为了
                        // 让正文能随版本更新，而用户增删音效名不会被冲掉。
                        const content = [config.body, config.sceneList]
                            .filter(s => typeof s === 'string' && s.trim())
                            .join('\n\n');
                        if (!content) return;
                        const depth = parseInt(config.depth) || 0;
                        const injection = { role: config.role || 'system', content };
                        // 插入位置交给 planSpecInsertIndex：它处理了短对话（新开的对话）这个坑
                        // —— 早期实现会把 index 夹成 0，等于把规范丢到角色卡之前、离生成点最远，
                        // 于是新对话里模型干脆不写标签（历史里没有实例可模仿时尤其明显）。
                        const index = planSpecInsertIndex(eventData.chat.length, depth);
                        eventData.chat.splice(index, 0, injection);
                    }
                });
            }
            // 切换聊天时清理播放状态：停掉旧聊天的音频/环境音、释放内存中的 blobUrl，并收起悬浮播放器和底部进度条
            if (event_types.CHAT_CHANGED) {
                eventSource.on(event_types.CHAT_CHANGED, () => {
                    clearMemoryAudioCache();
                    AmbientPlayer.stop();
                    TTSPlayerWindow.hide();
                    attachBottomProgress(null);
                    inferenceLocks.clear(); 
                });
            }            
        } catch (e) {
            console.error('[MoonVoice] Event listener setup error:', e);
        }
    }

    // ==================== MutationObserver 即时响应 ====================
    let observerSuppressed = false;
    let pollPending = false;
    let chatObserver = null;

    function polling() {
        observerSuppressed = true;
        try {
            injectSettingsPanel();
            document.querySelectorAll('.mes[is_user="false"]').forEach(msg => {
                injectMessageButtons(msg);
                const mesText = msg.querySelector('.mes_text');
                if (mesText && mesText.dataset.breezetts2Injected === 'true') {
                    if (!mesText.querySelector('.breezetts2-inline-play')) {
                        delete mesText.dataset.breezetts2Injected;
                    }
                }
                injectInlineButtons(msg);
            });
        } finally {
            setTimeout(() => {
                observerSuppressed = false;
            }, 0);
        }
    }

    function scheduleObserverPolling() {
        // 节流：变化风暴期间最多 300ms 触发一次全量 polling
        if (observerSuppressed || pollPending) return;
        pollPending = true;
        setTimeout(() => {
            pollPending = false;
            polling();
        }, 300);
    }

    function setupMutationObserver() {
        const target = document.getElementById('chat');
        if (!target) {
            // DOM 未就绪：5 秒后重试（最多 3 次），仍失败则放弃，退化为纯轮询
            if (!setupMutationObserver._retries) setupMutationObserver._retries = 0;
            if (setupMutationObserver._retries < 3) {
                setupMutationObserver._retries++;
                console.warn('[MoonVoice] #chat 未找到，5秒后重试 (', setupMutationObserver._retries, '/3 )');
                setTimeout(setupMutationObserver, 5000);
            } else {
                console.warn('[MoonVoice] #chat 持续未找到，放弃观察器，仅使用轮询');
            }
            return;
        }
        try {
            chatObserver = new MutationObserver(scheduleObserverPolling);
            chatObserver.observe(target, { childList: true, subtree: true });
            console.log('[MoonVoice] MutationObserver 已启用');
        } catch (e) {
            console.warn('[MoonVoice] MutationObserver 创建失败，继续使用轮询:', e);
        }
    }

    function init() {
        const loadedSettings = getSettings();
        LocalRepo.init();
        AmbientPlayer.init();
        migrateTagHidingKey();  // 旧键 sceneTagHiding -> chatTagHiding（一次性）
        syncChatTagHiding();   // 把「隐藏方括号标签」对齐成酒馆正则（用户可能在别处删过它）
        setupEventListeners();
        setInterval(polling, 15000); // 低频兜底：覆盖观察器盲区
        setupMutationObserver();
        polling();
        refreshNpcVoicePool();
        UPDATE_CHECKER.scheduleCheck();//检查更新
        updateAudioPoolStats();
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }

    window.BreezeTTS = {
        play: function (text, voice, character, context) {
            const ctx = context || {};
            if (ctx.source === 'kanon_frontend') {
                const iframes = document.querySelectorAll('iframe');
                for (const f of iframes) {
                    const msgEl = f.closest('.mes');
                    if (msgEl) { ctx.msg = msgEl; ctx.mesId = getMessageId(msgEl); break; }
                }
            }
            return playSingleLine(text, voice || null, character || '', ctx);
        },
        getSettings: getSettings,
        getVoiceMap: getVoiceMap,
        parseVNLine: parseVNLine,
        getCardId: getCardId,
    };
})();
