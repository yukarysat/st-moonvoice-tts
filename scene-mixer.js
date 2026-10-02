// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
//
// ============================================================================
//  场景音效的混音规则（纯逻辑：不碰 DOM、不碰 Audio、不碰网络）
// ============================================================================
//
// 为什么单独成文件：这套规则不算少（四个文件夹、同名跨文件夹一起播、打断与解除、
// 两种触发时机），塞在 index.js 里就只能靠"真的开酒馆点一遍"来验证。抽成纯函数后，
// setup/228-test-scene-mixer.mjs 可以把每种情形在 Node 里直接跑一遍。
//
// 职责边界：
//   · **谁是哪个轨道** 由侧车决定（它是文件系统的权威），它返回 { 轨道 id: { 名字: 相对路径 } }
//   · **每个轨道怎么播** 由下面的 TRACK_RULES 决定（本文件是唯一改动点）
//   两边的轨道 id 必须一致，改一处要同时改另一处（侧车见 breeze_api.py 的 SCENE_TRACKS）。
//
// 文件名必须是 .js：侧车用 Python 的 StaticFiles 按扩展名给 MIME，.mjs 会变成
// application/octet-stream，浏览器拒绝执行模块。所以单测是把它复制成 .mjs 再 import。

/** 场景音效的轨道 id。顺序无关，但必须与侧车的 SCENE_TRACKS 一致。 */
export const TRACK_IDS = ['ambient', 'ambient1', 'event', 'event1'];

/**
 * 规则表 —— 整个功能的语义都在这张表里。
 *
 *   kind: 'ambient'  循环轨。同名保持、换名交叉淡入淡出、消息播完停。
 *   kind: 'event'    一次性音。不循环、叠在循环轨之上、自然响完。
 *
 *   volumeKey            取哪个设置的音量
 *   trigger              'every'         每次出现都响（旧行为）
 *                        'onSceneChange' 场景名变化时响一次（同一次播放内同名不重复）
 *   interruptible        该循环轨能否被事件停掉
 *   interrupts           该事件轨触发时要停掉哪些循环轨（同名不打断，见下）
 */
export const TRACK_RULES = [
    // pjy/ 根目录与 环境音效/ —— 旧世界原样不动：永远不被任何事件影响
    { id: 'ambient', kind: 'ambient', volumeKey: 'ambientSoundVolume', interruptible: false },

    // 环境音效01/ —— 第二条循环轨（BGM 这类可与环境音并存），**唯一会被事件打断的轨**
    { id: 'ambient1', kind: 'ambient', volumeKey: 'ambient1SoundVolume', interruptible: true },

    // 事件音效/ —— 旧行为：每次出现都响，不打断任何东西
    { id: 'event', kind: 'event', volumeKey: 'eventSoundVolume', trigger: 'every' },

    // 事件音效01/ —— 新行为：场景名变化时响一次；触发时打断 环境音效01
    //   为什么"变化时响一次"：GAL 格式要求每句都带场景标签，同一个场景名会在每一句
    //   重复出现。若沿用"每次出现都响"，把开门声与房间底噪同名放进来的话，
    //   每句台词都会开一次门。改成"名字变化时响一次"后，只在进入该场景时响一次。
    //   为什么"同名不打断"：同名意味着它们本就是同一场景的组成部分（房间底噪 + 开门声），
    //   不该自己人打断自己人。不同名才是"发生了别的事"（刹车 vs 车辆_行驶）→ 打断。
    { id: 'event1', kind: 'event', volumeKey: 'eventSoundVolume', trigger: 'onSceneChange', interrupts: ['ambient1'] },
];

const AMBIENT_RULES = TRACK_RULES.filter(r => r.kind === 'ambient');
const EVENT_RULES = TRACK_RULES.filter(r => r.kind === 'event');

/** 空目录：每个轨道都没有文件。 */
export function emptyCatalog() {
    const cat = {};
    for (const id of TRACK_IDS) cat[id] = {};
    return cat;
}

/**
 * 认识的后缀，**顺序即优先级**。
 *
 * 侧车返回的键是**完整文件名**（`雨声.ogg`），而标签里只有场景名（`雨声`），
 * 所以要把后缀去掉。同一个场景名有多个后缀时（`雨声.mp3` 与 `雨声.ogg` 并存），
 * 取这个数组里靠前的那个 —— 与旧版 _loadScene 的行为一致（它就是按这个顺序逐个试的）。
 * 大写后缀（`.MP3`）不在表里，匹配不上：插件一直是大小写敏感的，这里保持原样。
 */
export const SCENE_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

/** 拆出场景名与后缀；后缀不认识就返回 null。 */
export function splitExt(fileName, exts = SCENE_EXTS) {
    const lower = String(fileName).toLowerCase();
    for (const e of exts) {
        if (lower.endsWith(e) && lower.length > e.length) {
            return { stem: String(fileName).slice(0, -e.length), ext: e };
        }
    }
    return null;
}

/**
 * 把「{ 真实文件名: 相对路径 }」规范化进 target（{ 场景名: url }），并按优先级去重。
 * 就地修改 target。
 */
function normalizeInto(target, files, toUrl, exts) {
    const picked = new Map();   // 场景名 -> { ext, url }
    for (const [fileName, rel] of Object.entries(files || {})) {
        const sp = splitExt(fileName, exts);
        if (!sp) continue;
        const cur = picked.get(sp.stem);
        if (cur && exts.indexOf(cur.ext) <= exts.indexOf(sp.ext)) continue;  // 已有更高优先级的后缀
        picked.set(sp.stem, { ext: sp.ext, url: toUrl(rel) });
    }
    for (const [stem, v] of picked) target[stem] = v.url;
}

/**
 * 从侧车的新字段构造目录。
 * @param {Object} tracks  { 轨道 id: { 真实文件名: pjy 下的相对路径 } }
 * @param {(rel: string) => string} toUrl 相对路径 -> 可播放的 URL
 * @param {string[]} exts 后缀优先级表（一般不用改，测试会用到）
 */
export function catalogFromTracks(tracks, toUrl = rel => rel, exts = SCENE_EXTS) {
    const cat = emptyCatalog();
    for (const id of TRACK_IDS) normalizeInto(cat[id], tracks && tracks[id], toUrl, exts);
    return cat;
}

/**
 * 从**旧版侧车**的字段构造目录 —— 兼容用。
 *
 * 旧侧车只有 paths（文件名 -> 相对路径）与 events（哪些是事件音，存的是**文件名**），
 * 于是「不在 events 里的都是环境音」。这样新插件配旧侧车就退化成今天的行为：
 * 只有 ambient / event 两条轨有内容，两个"01"轨为空 —— 新规则不会凭空生效。
 */
export function catalogFromLegacy(data, toUrl = rel => rel, exts = SCENE_EXTS) {
    const cat = emptyCatalog();
    const paths = (data && data.paths) || {};
    const events = new Set((data && data.events) || []);
    if (Object.keys(paths).length) {
        const ambient = {}, event = {};
        for (const [fileName, rel] of Object.entries(paths)) {
            (events.has(fileName) ? event : ambient)[fileName] = rel;
        }
        normalizeInto(cat.ambient, ambient, toUrl, exts);
        normalizeInto(cat.event, event, toUrl, exts);
        return cat;
    }
    // 更老的侧车连 paths 都没有，只有 scenes（全是环境音、且都在根目录）
    for (const name of (data && data.scenes) || []) cat.ambient[name] = toUrl(name);
    return cat;
}

/**
 * 混音状态。**每次播放（一条播放队列）开始时用 createMixState() 重置** ——
 * 打断造成的静音不该跨消息留着，否则"重新播放"时车一直是熄火的。
 *
 *   name        该轨当前请求的名字（null = 已停）
 *   mutedName   该轨被打断时正在播的名字。同名的后续请求不再重启它，
 *               直到请求换成别的名字（或显式清空场景）才解除。
 *   lastName    事件轨上一次见到的场景名，用于 onSceneChange 判定。
 */
export function createMixState() {
    const st = { lastName: {} };
    for (const r of AMBIENT_RULES) {
        st[r.id] = { name: null, mutedName: null };
    }
    for (const r of EVENT_RULES) {
        st.lastName[r.id] = null;
    }
    return st;
}

function cloneState(state) {
    const next = { lastName: { ...(state.lastName || {}) } };
    for (const r of AMBIENT_RULES) {
        const s = state[r.id] || {};
        next[r.id] = { name: s.name ?? null, mutedName: s.mutedName ?? null };
    }
    return next;
}

/**
 * 算出"这一句的场景标签"该做什么。**不修改传入的 state**，返回新的状态。
 *
 * @param {Object} state    createMixState() 的结果（或上一次 planScene 返回的 state）
 * @param {string|null} rawName  场景标签内容；空字符串 / null 表示空方括号 `[]`
 * @param {Object} catalog  catalogFromTracks() / catalogFromLegacy() 的结果
 * @returns {{actions: Array, state: Object}}
 *
 * actions 三种：
 *   { kind:'ambient',      track, name, url }            播放该循环轨（同名由播放器保持不变）
 *   { kind:'ambient-stop', track, reason }              reason: 'cleared'（`[]`）| 'interrupted'（被事件打断）
 *   { kind:'event',        track, name, url }            一次性音，响一声
 */
export function planScene(state, rawName, catalog) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const next = cloneState(state);
    const actions = [];

    // ---- 空标签 `[]`：停掉全部循环轨 ----
    // 与旧行为一致（旧版 `[]` 就是停掉环境音），只是从一条轨扩到全部循环轨。
    // 顺便清掉打断造成的静音：作者明确要求"安静"之后，下一次请求应当能正常起播。
    if (!name) {
        for (const r of AMBIENT_RULES) {
            const st = next[r.id];
            if (st.name !== null || st.mutedName !== null) {
                actions.push({ kind: 'ambient-stop', track: r.id, reason: 'cleared' });
            }
            st.name = null;
            st.mutedName = null;
        }
        return { actions, state: next };
    }

    // ---- 1) 事件轨：先决定触发哪些事件（旧的事件音每次出现都响；01 只在名字变化时响）
    const interruptTargets = new Set();
    for (const r of EVENT_RULES) {
        const url = catalog[r.id]?.[name];
        const prev = next.lastName[r.id] ?? null;
        // 注意 lastName 要在**每次**都更新：这样 名字 A→B→A 时，第二次 A 会重新触发，
        // 因为它与"上一次见到的名字"不同。（只在真触发时更新会导致 A→B→A 时第二次 A 不响）
        next.lastName[r.id] = name;
        if (!url) continue;
        if (r.trigger === 'onSceneChange' && name === prev) continue;
        actions.push({ kind: 'event', track: r.id, name, url });
        for (const target of r.interrupts || []) interruptTargets.add(target);
    }

    // ---- 2) 循环轨：有同名文件就播，没有就**保持原样**（与旧版"没匹配到文件就什么都不做"一致）
    for (const r of AMBIENT_RULES) {
        const url = catalog[r.id]?.[name];
        if (!url) continue;
        const st = next[r.id];
        if (st.mutedName === name) {
            // 被打断后又在请求同一个名字 —— 说明场景没变，就让它安静着。
            // 这正是"刹车之后车一直停着"的实现方式。
            continue;
        }
        st.mutedName = null;   // 换成别的名字 = 新场景，解除静音
        st.name = name;
        actions.push({ kind: 'ambient', track: r.id, name, url });
    }

    // ---- 3) 打断：事件轨触发时停掉它负责的循环轨（同名不打断） ----
    for (const target of interruptTargets) {
        const st = next[target];
        const playing = st.name;
        if (!playing) continue;        // 本来就没在播，没什么可打断
        if (playing === name) continue; // 同名不打断自己人（房间底噪 + 开门声这种）
        actions.push({ kind: 'ambient-stop', track: target, reason: 'interrupted' });
        st.mutedName = playing;        // 记住是谁被停了：同名再来不重启，换名才重启
        st.name = null;
    }

    return { actions, state: next };
}

/**
 * 这个名字是不是"事件音"（属于任一事件轨）。播放列表分段时用它把事件行单独成段 ——
 * 事件音只是叠上去响一声，不该把正在播的循环轨切断重来。
 * 目录没加载时返回 false（按循环音处理，等同旧行为）。
 */
export function isEventName(catalog, name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || !catalog) return false;
    return EVENT_RULES.some(r => catalog[r.id]?.[n]);
}

/** 该名字在任一循环轨里有文件吗（调试/文档用）。 */
export function hasAmbient(catalog, name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || !catalog) return false;
    return AMBIENT_RULES.some(r => catalog[r.id]?.[n]);
}
