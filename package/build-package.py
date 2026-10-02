"""组装「月声整合包」（默认到 package\\MoonVoice\\，可用 --target 指到别处）。

用法：
    set MOONVOICE_SRC=D:\\path\\to\\your\\deploy      # 第三方大件的来源目录，必填
    python build-package.py                 # 硬链接大文件（几乎不占额外空间）
    python build-package.py --no-link       # 老老实实复制（跨盘或想要完全独立时用）
    python build-package.py --zip           # 顺便打成 MoonVoice-<版本>.zip
    python build-package.py --reset-data    # 重铺 data\\（会清掉用户在工作台存的音色）
    python build-package.py --target E:\\deepseekHarness\\BreezeTTS2\\MoonVoice
                                            # 装到别处（环境变量 MOONVOICE_TARGET 同效）
    python build-package.py --no-model      # 产出无模型包
    python build-package.py --model <gguf>  # 指定放入哪一档模型

**不要把组装目录留在本仓库里**（它就在酒馆的 public\\ 下面）：酒馆会把这些文件当
静态资源对外提供，路径也深。作者本机用 --target 指到工作区里一个又浅又纯 ASCII 的目录，
方便随时双击启动器测新版。目标路径含非 ASCII 字符时脚本会直接警告 —— 那是"解压后
起不来"的头号原因，能在打包阶段拦住就别留给用户。

`--src` / 环境变量 `MOONVOICE_SRC` 指向的目录不在本仓库里（体积 GB 级、模型另有
许可），需要自己准备，结构见下面 DEPLOY 那一段的注释。`--ffmpeg` / 环境变量
`FFMPEG` 用于指定 ffmpeg：**组装目录被删掉后重建时一定要给**，因为那会用 ffmpeg
重新转码场景音效（目录里已有转好的 OGG 时才会跳过）。

为什么 staging 目录必须叫 MoonVoice（纯 ASCII）：
    Breeze 后端是 C++ 程序，在 Windows 上按 ANSI 代码页打开文件，路径含中文
    时读不到模型。压缩包解压出来的顶层目录名就是这个路径的第一段，
    所以它必须是可以直接解压使用的 ASCII 名。
    说明文档与启动脚本也会检查解压后的路径，含中文时给出明确提示。

为什么**压缩包文件名**也必须是 ASCII：
    解压工具默认会建一个与压缩包同名的文件夹放在旁边（7-Zip 的
    「解压到 <压缩包名>\\」、WinRAR 的「解压到 <压缩包名>\\」都是这个行为）。
    所以压缩包叫 月声整合包.zip，最常见的那个操作就会得到
    D:\\下载\\月声整合包\\MoonVoice\\ —— 路径里有中文，后端照样读不到模型。
    光把顶层目录定成 ASCII 是不够的，文件名同样会变成路径的一段。
    （实际就这么踩过一次：自己解出来验证命名时才发现。）

体积构成：
    backend\\runtime      1.01 GB   硬链接自 <SRC>\\audiocpp\\runtime（187 个文件）
    backend\\models\\...   6.84 GB   硬链接自 <SRC>\\audiocpp\\models
    sidecar\\*.exe         35 MB    复制自仓库 server\\dist
    data\\                 31 MB    22 个样例音色 + 9 段样例场景音效
    文档\\                   小

**程序目录必须用 ASCII 名（backend / sidecar / data）**：
    后端是 C++ 程序，按 ANSI 代码页打开文件。早期版本把目录命名为
    「后端」「侧车」，结果模型路径含中文，gguf_init_from_file 直接失败。
    文档目录不参与程序读写，保留中文名以便用户查找。
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# 第三方大件的来源目录。这些**不在本仓库里**（体积 GB 级、模型另有许可），
# 需要自己准备一份，目录结构要求：
#
#     <SRC>/
#     ├─ audiocpp/
#     │   ├─ runtime/           audio.cpp 发布包解出来的运行时
#     │   ├─ models/Breeze-TTS-2-GGUF/breeze-tts-2-bf16.gguf
#     │   └─ server.json
#     ├─ breeze-tts-2/LICENSE   模型许可原文（上游仓库里的那个）
#     └─ plugin/                可选：随包样例音色的来源
#         ├─ voices/            22 个示例音色（wav + 同名 txt 逐字稿）
#         └─ pjy/{环境音效,事件音效}/   随包场景音效的源 WAV
#
# 用环境变量 MOONVOICE_SRC 或命令行 --src 指定。
SRC_ENV = "MOONVOICE_SRC"
TARGET_ENV = "MOONVOICE_TARGET"
DEPLOY: Path | None = Path(os.environ[SRC_ENV]).expanduser() if os.environ.get(SRC_ENV) else None
AUDIOCPP: Path = Path()
MODEL_LICENSE_SRC: Path = Path()


def set_deploy(path: Path) -> None:
    """设定第三方大件来源目录（--src 会调它）。"""
    global DEPLOY, AUDIOCPP, MODEL_LICENSE_SRC
    DEPLOY = path.expanduser().resolve()
    AUDIOCPP = DEPLOY / "audiocpp"
    MODEL_LICENSE_SRC = DEPLOY / "breeze-tts-2" / "LICENSE"


if DEPLOY is not None:
    set_deploy(DEPLOY)

# --ffmpeg 解析出来的值，在 main() 里填；find_ffmpeg() 会优先用它。
FFMPEG_ARG = ""

MODEL_REL = Path("models") / "Breeze-TTS-2-GGUF" / "breeze-tts-2-bf16.gguf"
SIDECAR_EXE = REPO / "server" / "dist" / "moonvoice-sidecar.exe"

# 随包分发的场景音效（源：作者音效库里的 WAV）。
# 显式列清单而不是"扫描目录里的 wav"，这样作者以后往库里加东西不会被误打包，
# 也让"哪些素材以什么依据分发"一目了然。
# 全部出自 SONNISS #gameaudiogdc 免费音效包 —— 授权允许用于自有项目（含商用、
# 免署名）并允许修改，禁止的是原样当素材库再分发。故分发前折叠为立体声并
# 转码为 OGG，使其成为本项目的素材而非原始素材文件。
# 不含任何 mp3：出处与授权无法确认的素材一律不附带。
SCENE_SAMPLES = [
    ("环境音效", "乡村_傍晚.wav"),
    ("环境音效", "森林.wav"),
    ("环境音效", "森林_清晨.wav"),
    ("环境音效", "森林_起风.wav"),
    ("环境音效", "沙滩_海浪.wav"),
    ("环境音效", "瀑布.wav"),
    ("环境音效", "雨声.wav"),
    ("环境音效", "雨声_室内.wav"),
    ("事件音效", "房间_开门.wav"),
]

# 随包分发的 22 个样例音色（源：<SRC>/plugin/voices 里用「语音设计」生成的那一批）。
#
# **必须显式列清单，不能扫描整个 voices 目录。** 那是使用者的开发音色库：
# 里面有他自己录的、克隆的、乃至私人用途的音色。扫描式拷贝会把它们
# 静默打进分发包——一次不容易被发现的隐私泄漏。SCENE_SAMPLES 当初就是
# 出于同样的理由写成清单的，这里遵循同一原则。
#
# 这 22 个由 Breeze TTS 2 的「声音设计」生成，不是真人录音，
# 逐字稿统一为一句话（见下面的 SAMPLE_VOICE_TEXT）。
SAMPLE_VOICES = [
    ("中性-未定", "中性01"), ("中性-未定", "中性02"),
    ("女-儿童", "女童01"), ("女-儿童", "女童02"),
    ("女-少年", "女少02"), ("女-少年", "女少03"),
    ("女-青年", "女青01"), ("女-青年", "女青02"),
    ("女-中年", "女中01"), ("女-中年", "女中02"),
    ("女-老年", "女老01"), ("女-老年", "女老02"),
    ("男-儿童", "男童01"), ("男-儿童", "男童03"),
    ("男-少年", "男少01"), ("男-少年", "男少04"),
    ("男-青年", "男青01"), ("男-青年", "男青02"),
    ("男-中年", "男中01"), ("男-中年", "男中02"),
    ("男-老年", "男老02"), ("男-老年", "男老03"),
]

# 组装目标目录。main() 里可被 --target / 环境变量 MOONVOICE_TARGET 覆盖。
# 默认放在脚本旁边（= 酒馆的 public\ 下），但那种位置不合适：酒馆会把它当静态资源
# 对外提供，路径也深。作者本机一律用 --target 指到工作区。
TARGET = HERE / "MoonVoice"


def sidecar_version() -> str:
    """从侧车源码里取版本号，用来给发布包命名。

    名字必须是纯 ASCII（理由见文件开头），带上版本号还能让用户一眼看出自己下的是哪版。
    取不到就退回不带版本号的名字，不因为读不到版本号而让打包失败。
    """
    try:
        text = (REPO / "server" / "breeze_api.py").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r'^SOFTWARE_VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else ""


_VER = sidecar_version()
# 下面这几个在 main() 里按产物形态（含模型 / 无模型 / 指定档位）确定
MODEL_SRC: Path | None = None          # 要放进包的模型源文件；None = 无模型包
MODEL_DST_REL: Path | None = None      # 它在包内的相对路径
MODEL_REQUIRED = ""                    # 校验必需文件时用（无模型包为空）
ZIP_NAME = ""
ZIP_PATH = HERE / "MoonVoice.zip"

REQUIRED = [
    "readme.txt",
    "启动webui.cmd",
    "启动局域网服务.cmd",
    "启动后端.cmd",
    "停止全部.cmd",
    "放行防火墙.cmd",
    "_moonvoice.cmd",
    "_firewall.ps1",
    "_checkfw.ps1",
    "_helper.ps1",
    # 程序目录一律 ASCII。后端是 C++ 程序，按 ANSI 代码页打开文件，
    # 路径里出现中文时连模型都读不到（实测：gguf_init_from_file 失败）。
    "backend/runtime/audiocpp_server.exe",
    "backend/runtime/audiocpp_cli.exe",
    "backend/server.json",
    # 模型不在这个固定清单里：含模型 / 无模型两种形态由 MODEL_REQUIRED 决定
    "sidecar/moonvoice-sidecar.exe",
    # 随包样例音色：解压就有声音可用
    "data/voices/_说明.txt",
    "data/voices/女-少年/女少03.wav",
    "data/voices/女-少年/女少03.txt",
    "data/voices/男-青年/男青01.wav",
    # 场景音效：9 个 WAV 折叠立体声 + 转码 OGG 后随包（清单见 SCENE_SAMPLES）
    "data/pjy/_说明.txt",
    "data/pjy/环境音效/雨声.ogg",
    "data/pjy/环境音效/森林.ogg",
    "data/pjy/环境音效/沙滩_海浪.ogg",
    "data/pjy/事件音效/房间_开门.ogg",
    "文档/使用说明.md",
    "文档/NOTICE",
    "文档/LICENSE-Breeze-TTS-2",
]


def _note(text: str) -> bytes:
    """面向用户的说明文件：UTF-8 带 BOM + CRLF，记事本双击即可正确显示。"""
    body = text.replace("\r\n", "\n").replace("\n", "\r\n")
    return b"\xef\xbb\xbf" + body.encode("utf-8")


VOICES_NOTE = _note("""这个文件夹是音色库（含开箱样例）
================================================================

11 个子文件夹对应 11 个「性别-年龄段」标签，共附带 22 个样例音色。
它们是随整合包一起提供的，方便你解压后立刻就能听到声音，
不必先自己录一段参考音频。

这些样例由 Breeze TTS 2 以「语音设计」方式生成，不是真人录音。


你可以做的事
----------------------------------------------------------------

* 直接用：在「合成」页的音色下拉里选它，写好台词就能生成
* 换成你自己的声音：把参考音频放进对应标签的文件夹，文件名随意
* 加自己的音色：参考音频 + 同名 .txt 逐字稿
* 删掉样例：直接删文件即可，不影响运行


逐字稿是硬性要求
----------------------------------------------------------------
Breeze 靠「参考音频 + 逐字稿」来克隆音色，没有逐字稿的音色无法使用。
样例音色都已经配好同名 .txt，你自己加音色时别忘了一起放。

逐字稿的内容必须和音频里说的话逐字一致（含语气词），
差一个字都会明显拉低相似度。


标签的含义
----------------------------------------------------------------
    男-儿童 / 男-少年 / 男-青年 / 男-中年 / 男-老年
    女-儿童 / 女-少年 / 女-青年 / 女-中年 / 女-老年
    中性-未定

大模型写台词时会标注角色属于哪一类，插件按标签自动挑音色。
放在根目录（也就是本文件夹下）的音色没有标签，不参与自动分配，
只供你在配音面板里手动绑定。

详细规则见  文档\\使用说明.md
""")


PJY_NOTE = _note("""场景音效放在这里
================================================================

这里已经附带 9 个氛围音效（转码为 OGG，体积很小）：

    pjy\\环境音效\\   乡村_傍晚、森林、森林_清晨、森林_起风、
                     沙滩_海浪、瀑布、雨声、雨声_室内
    pjy\\事件音效\\   房间_开门

它们出自 SONNISS 的 #gameaudiogdc 免费音效包。那份授权允许在个人与
商业项目中使用、可修改、无需署名；随包前我们把多声道折叠为立体声并
转码成 OGG，作为本项目的素材一并提供。版权仍归各家原始权利人。


取材原则
----------------------------------------------------------------
这里只放出处与授权都能确认的音效：上面这 9 个来自 SONNISS 音效包，
授权明确，可放心用在作品里。

来源不明的素材一律不带 —— 网络上流传的所谓"免费音效"合集大多属于
这一类，版权仍归原权利人，随手分发就有侵权风险。想扩充的话，请用
下面推荐的来源。


想加更多音效
----------------------------------------------------------------
四个文件夹 = 四条轨，播放方式各不相同：

    pjy\\环境音效\\     循环播放，换场景时淡入淡出。永不被事件音打断
    pjy\\环境音效01\\   也是循环，可与上一条**同时播放**（适合放 BGM）。
                        会被 事件音效01 打断
    pjy\\事件音效\\     只响一次，叠在循环音之上。每次出现都响（旧行为）
    pjy\\事件音效01\\   只响一次，且只在**场景名变化时**响（同名重复的
                        台词不会反复响）；触发时打断 环境音效01

**同名跨文件夹会一起播**：把 房间底噪 / BGM / 开门声 都命名为 室内_房间，
分别放进 环境音效\\、环境音效01\\、事件音效01\\，大模型写 [室内_房间] 时
三处同时响。提示词不用区分文件夹，照常写一个名字即可。

打断的例子：环境音效01\\车辆引擎声.ogg（引擎）+ 事件音效01\\刹车.ogg（刹车）。
台词写 [车辆引擎声] 起引擎，某句写 [刹车] 就刹车响一次、引擎停掉；之后**再写
[车辆引擎声] 会重新起播**（同名就重启）—— 想让车一直停着，台词就别再写那个名字。
（环境名建议起得明确些：车辆引擎声，而不是含糊的 车辆_行驶。）

文件名必须和大模型在台词第三个方括号里写的名字一模一样（不含扩展名），
例如台词写 [雨声]，文件名就叫 雨声.ogg（或 .wav）。
写 [] 或者省略那个方括号就是停止全部循环音。

支持 .mp3 / .wav / .ogg / .m4a / .aac / .flac（后缀大小写不敏感）
名字对不上不会报错，只是那一段不播声音。

推荐来源：
  · https://sonniss.com/gameaudiogdc
    免费、每年一届、体积很大（几十 GB）。自己下载即成为被授权人，
    之后可随意用在作品里，含商用、免署名。
  · freesound.org
    把 License 筛成 "Creative Commons 0"（CC0），这类素材允许自由
    使用与再分发。CC-BY 的需要署名，别筛错。
  · 自己录
    手机录一段雨声、街道声就够用，完全没有版权问题。

这里放的文件只在本机使用，插件和整合包都不会把它们上传到任何地方。
""")


def find_ffmpeg() -> str:
    """找一个可用的 ffmpeg。

    只认三处（按优先级）：`--ffmpeg` 参数、环境变量 FFMPEG、PATH 里的 ffmpeg。
    刻意不内置任何本机绝对路径——那会把开发者的目录结构带进公开仓库。
    Windows 上装一份（winget install Gyan.FFmpeg，或从 gyan.dev 下载）
    再把它加进 PATH，或者用上面两种方式指过去即可。

    候选列表在这里现场拼，不在模块层做常量——否则 --ffmpeg 在导入时
    就已经被固化，命令行参数会失效。
    """
    candidates = [FFMPEG_ARG, os.environ.get("FFMPEG", ""), "ffmpeg"]
    for cand in candidates:
        if not cand:
            continue
        if cand == "ffmpeg" or Path(cand).is_file():
            try:
                r = subprocess.run([cand, "-hide_banner", "-version"],
                                   capture_output=True, timeout=30)
                if r.returncode == 0:
                    return cand
            except (OSError, subprocess.SubprocessError):
                continue
    raise SystemExit(
        "[中止] 找不到 ffmpeg。转码场景音效需要它。\n"
        "        三种指定方式，任选其一：\n"
        "          build-package.py --ffmpeg D:\\ffmpeg\\bin\\ffmpeg.exe\n"
        "          set FFMPEG=D:\\ffmpeg\\bin\\ffmpeg.exe\n"
        "          把它加进 PATH\n"
        "        下载：https://www.gyan.dev/ffmpeg/builds/ （需要含 libvorbis）")


def transcode_scene_audio(force: bool = False) -> int:
    r"""把随包分发的场景音效用 ffmpeg 转成 OGG 写进整合包。

    来源：作者音效库里的 9 个 WAV，出自 SONNISS #gameaudiogdc 免费音效包
    （文件内嵌的 BWF 元数据可佐证：Pole Position Production、Just Sound
    Effects、PMSFX 等都是该音效包的供应商）。该授权允许在自有项目中
    使用（含商用、免署名）并明文允许修改；它禁止的是把音效原样当素材库
    再分发。所以这里做三件事，让它们明确成为"本项目的素材"：

      * -ac 2          三个文件是 4.0 quad（fmt 块的 channel_mask=0x33 即
                       FL+FR+BL+BR），折叠为立体声，ffmpeg 用的是标准折叠。
      * -vn            丢掉 WAV 里内嵌的封面图。不加这一项时 ffmpeg 会把
                       封面编成 theora 视频流塞进 ogg（实测过）。
      * -map_metadata -1  清空元数据，避免把供应商的版权字段原样带进包里；
                       出处统一写在 说明文件 与 文档\NOTICE 里。
      * 转码为 OGG。原始 WAV 是 24bit / 48~96kHz / 最多 4 声道，合计
        581.7 MB（单个最大 164 MB）；转码后只占十几 MB。

    为什么不用 Python 的 soundfile：实测对 121 秒以上的文件，无论一次性写
    还是分块写、甚至全流式读写，都会以 STATUS_STACK_OVERFLOW (0xC00000FD)
    硬崩。ffmpeg 没有这个问题，7 秒就能转完 125 MB 的文件。

    不包含任何 mp3：出处与授权无法确认的素材一律不附带。
    """
    total_src = 0
    total_dst = 0
    n = 0
    todo: list[tuple[Path, Path, str, str]] = []
    for sub, name in SCENE_SAMPLES:
        src = DEPLOY / "plugin" / "pjy" / sub / name
        if not src.is_file():
            raise SystemExit(f"[中止] 找不到场景音效源文件：{src}")
        dst = TARGET / "data" / "pjy" / sub / (src.stem + ".ogg")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.is_file() and not force:
            # 已存在就不重转：可能用户自己换过这一条，也省得每次重跑 ffmpeg
            total_src += src.stat().st_size
            total_dst += dst.stat().st_size
            n += 1
            print(f"    {sub}\\{name:<20} -> {dst.name:<20}   已存在，跳过")
            continue
        todo.append((src, dst, sub, name))

    # ffmpeg 只在真的要转码时才去找：整包都转好之后重建不应再依赖它
    ff = find_ffmpeg() if todo else ""

    for src, dst, sub, name in todo:
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(src),
               "-vn",                      # 去掉内嵌封面（否则会多出一条 theora 视频流）
               "-map_metadata", "-1",      # 清空元数据
               "-ac", "2",                 # 4.0 quad -> 立体声
               "-c:a", "libvorbis", "-q:a", "6",
               # 让转码结果**逐字节可复现**：Ogg 页头里的比特流序列号默认每次随机生成，
               # 页 CRC 随之全变。实测同一个文件连转两次，音频完全相同（解码后的 PCM
               # 哈希一致）却有 0.03% 的字节不同 —— 结果是"什么都没改，重建一次 zip 的
               # 哈希也会变"，发布时容易让人以为包里内容动过。
               # 固定 serial_offset 并走 bitexact，两次转码即逐字节相同（已验证），
               # 且解码后的音频与不加这两个开关时完全一致。
               "-serial_offset", "0", "-fflags", "+bitexact", "-flags:a", "+bitexact",
               str(dst)]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0 or not dst.is_file():
            err = r.stderr.decode("utf-8", "replace").strip()[:300]
            raise SystemExit(f"[中止] ffmpeg 转码失败：{src.name}\n        {err}")

        total_src += src.stat().st_size
        total_dst += dst.stat().st_size
        n += 1
        print(f"    {sub}\\{name:<20} -> {dst.name:<20}"
              f"{src.stat().st_size / 1048576:>7.1f} MB -> {dst.stat().st_size / 1048576:>6.2f} MB")

    print(f"  共 {n} 个：{total_src / 1048576:.1f} MB -> {total_dst / 1048576:.2f} MB "
          f"（压到 {total_dst / total_src * 100:.1f}%）")
    return n


def place(src: Path, dst: Path, link: bool, log: list[str]) -> None:
    """把 src 放到 dst。同卷时用硬链接（不占额外空间），否则复制。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        if dst.is_dir():
            shutil.rmtree(dst)
        else:
            dst.unlink()
    if link:
        try:
            os.link(src, dst)
            log.append(f"  link  {dst.relative_to(TARGET)}")
            return
        except OSError:
            pass  # 跨卷等情况，退回复制
    shutil.copy2(src, dst)
    log.append(f"  copy  {dst.relative_to(TARGET)}")


def place_tree(src_dir: Path, dst_dir: Path, link: bool) -> int:
    n = 0
    for root, _dirs, files in os.walk(src_dir):
        rel = Path(root).relative_to(src_dir)
        (dst_dir / rel).mkdir(parents=True, exist_ok=True)
        for f in files:
            s = Path(root) / f
            d = dst_dir / rel / f
            if d.exists():
                d.unlink()
            if link:
                try:
                    os.link(s, d)
                    n += 1
                    continue
                except OSError:
                    pass
            shutil.copy2(s, d)
            n += 1
    return n


def dir_size(p: Path) -> int:
    total = 0
    for root, _d, files in os.walk(p):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", metavar="DIR",
                    help=f"第三方大件的来源目录（audio.cpp 运行时 / 模型 / 模型许可）。"
                         f"也可以用环境变量 {SRC_ENV}。")
    ap.add_argument("--ffmpeg", metavar="EXE", default="",
                    help="ffmpeg 可执行文件路径。也可以用环境变量 FFMPEG，或放进 PATH。")
    ap.add_argument("--no-link", action="store_true", help="复制而不是硬链接")
    ap.add_argument("--zip", action="store_true", help="顺便打成 zip")
    ap.add_argument("--reset-data", action="store_true",
                    help="清空 data\\ 并重新铺样例音色与场景音效。"
                         "默认保留 data\\ —— 用户在工作台里保存的音色就在那里，"
                         "重建包不能把它删掉。")
    ap.add_argument("--strict-samples", action="store_true",
                    help="data\\voices 里的音色必须**恰好**是 SAMPLE_VOICES 登记的那 22 个，"
                         "多一个少一个都中止。发布前建议加上。")
    ap.add_argument("--no-model", action="store_true",
                    help="不放入任何模型，产出「无模型整合包」：用户自己下载某一档 .gguf 放进 "
                         "backend\\models\\Breeze-TTS-2-GGUF\\，启动器会按显存自动挑。")
    ap.add_argument("--model", metavar="GGUF", default="",
                    help="放入指定的 .gguf（默认用来源目录里的 bf16）。"
                         "配合 --zip-name 产出「代码 + 指定档位」的整合包。")
    ap.add_argument("--zip-name", metavar="NAME", default="",
                    help="zip 文件名（不含目录）。默认：含 bf16 时用 MoonVoice-<版本>.zip；"
                         "--no-model 时加 -nomodel 后缀。")
    ap.add_argument("--target", metavar="DIR", default="",
                    help="组装到哪个目录（默认 package\\MoonVoice，也可以用环境变量 "
                         f"{TARGET_ENV}）。建议指到酒馆外面一个又浅又纯 ASCII 的路径，"
                         "别留在 public\\ 下。")
    args = ap.parse_args()
    link = not args.no_link

    global FFMPEG_ARG
    FFMPEG_ARG = args.ffmpeg

    if args.src:
        set_deploy(Path(args.src))
    if DEPLOY is None:
        raise SystemExit(
            "[中止] 没指定第三方大件的来源目录。\n"
            f"        用 --src <DIR> 或环境变量 {SRC_ENV}=<DIR>。\n"
            "        该目录下应有 audiocpp\\、breeze-tts-2\\LICENSE，"
            "（可选）plugin\\voices 与 plugin\\pjy。\n"
            "        详见本文件顶部注释。")
    if not AUDIOCPP.is_dir():
        raise SystemExit(f"[中止] {AUDIOCPP} 不存在。--src 指错了吗？")

    # ---- 组装目标目录 ----
    global TARGET
    want_target = args.target or os.environ.get(TARGET_ENV, "")
    if want_target:
        TARGET = Path(want_target).expanduser().resolve()
    bad_ascii = [c for c in str(TARGET) if ord(c) > 126]
    if bad_ascii:
        # 这不是洁癖：后端按 ANSI 代码页打开文件，路径含中文时连模型都读不到，
        # 整包一定起不来。能在打包阶段拦住，就别等用户来报。
        print(f"  [警告] 目标路径含非 ASCII 字符：{''.join(sorted(set(bad_ascii)))}")
        print(f"         {TARGET}")
        print("         后端按 ANSI 代码页打开文件，这种路径下读不到模型，包一定起不来。")
        print("         请换一个纯 ASCII 路径（例如 E:\\deepseekHarness\\BreezeTTS2\\MoonVoice）。")
    parts_lower = [p.lower() for p in TARGET.parts]
    if "public" in parts_lower:
        print("  [提示] 目标目录在酒馆的 public\\ 下面：酒馆会把这些文件当静态资源对外提供，")
        print("         路径也深不好找。建议用 --target 指到酒馆外面（例如工作区里）。")

    # ---- 产物形态：含模型 / 无模型 ----
    global MODEL_SRC, MODEL_DST_REL, ZIP_NAME, ZIP_PATH, MODEL_REQUIRED
    if args.no_model:
        MODEL_SRC, MODEL_DST_REL = None, None
        ZIP_NAME = args.zip_name or (f"MoonVoice-{_VER}-nomodel.zip" if _VER else "MoonVoice-nomodel.zip")
    else:
        MODEL_SRC = Path(args.model).expanduser().resolve() if args.model else (AUDIOCPP / MODEL_REL)
        if not MODEL_SRC.is_file():
            raise SystemExit(f"[中止] 找不到模型文件：{MODEL_SRC}")
        # 目标文件名沿用源文件名：这样 --model 换成任何一档，包内路径都是对的
        MODEL_DST_REL = Path("models") / "Breeze-TTS-2-GGUF" / MODEL_SRC.name
        ZIP_NAME = args.zip_name or (f"MoonVoice-{_VER}.zip" if _VER else "MoonVoice.zip")
    # MODEL_DST_REL 是**相对 backend\** 的（server.json 里就要这个形式），
    # 而必需文件检查是相对包根目录的，所以这里必须补上 backend/ 前缀。
    MODEL_REQUIRED = (f"backend/{MODEL_DST_REL.as_posix()}" if MODEL_DST_REL else "")
    ZIP_PATH = HERE / ZIP_NAME

    print("=" * 62)
    print("  组装 月声整合包")
    print(f"  形态: {'无模型（用户自行下载）' if MODEL_SRC is None else MODEL_SRC.name}"
          + (f"    zip: {ZIP_NAME}" if args.zip else ""))
    print("=" * 62)
    print(f"  目标: {TARGET}")
    print(f"  来源: {DEPLOY}")
    print(f"  大文件: {'硬链接（省空间）' if link else '复制'}")
    print()

    # ---- 前置检查 ----
    missing = []
    precheck_paths = [AUDIOCPP / "runtime" / "audiocpp_server.exe",
                      AUDIOCPP / "server.json",
                      MODEL_LICENSE_SRC,
                      SIDECAR_EXE,
                      HERE / "readme.txt",
                      HERE / "launchers" / "_moonvoice.cmd",
                      HERE / "docs" / "使用说明.md",
                      HERE / "docs" / "NOTICE"]
    if MODEL_SRC is not None:
        precheck_paths.insert(1, MODEL_SRC)
    for p in precheck_paths:
        if not p.exists():
            missing.append(str(p))
    if missing:
        print("[中止] 缺少以下文件：")
        for m in missing:
            print(f"    {m}")
        print("\n提示：侧车 exe 需要先构建（server\\build-exe.cmd）；")
        print("      launchers\\ 需要先生成（python make-launchers.py）。")
        return 1

    # ---- 目标目录 ----
    # 刻意不做 shutil.rmtree(TARGET)，只删本脚本负责生成的那些子目录与文件。
    # 原因有两个，都是踩过的坑：
    #   1) 启动器窗口按设计会一直开着（等用户按键）。如果它把工作目录停在包
    #      根目录，整个目录会被 Windows 占用，rmtree 会以 WinError 32 失败。
    #      只删子目录就不受这个影响。
    #   2) data\ 是**用户数据** —— 他在工作台里设计并保存的音色、自己加进去的
    #      场景音效都在那儿。重建包时顺手删掉它是不可接受的。默认保留，
    #      只有显式 --reset-data 才清空。
    reset = args.reset_data
    TARGET.mkdir(parents=True, exist_ok=True)
    print(f"  清理旧的程序目录（保留 data\\{'，并按 --reset-data 一并清空' if reset else ''}）...")
    for sub in ("backend", "sidecar", "文档"):
        p = TARGET / sub
        if p.exists():
            shutil.rmtree(p)
    for pattern in ("*.cmd", "*.ps1", "readme.txt"):
        for f in TARGET.glob(pattern):
            f.unlink()
    if reset and (TARGET / "data").exists():
        shutil.rmtree(TARGET / "data")
        print("  data\\ 已按要求清空")

    print("\n--- 1) 后端运行时 ---")
    n = place_tree(AUDIOCPP / "runtime", TARGET / "backend" / "runtime", link)

    print("--- 2) 模型 ---")
    if MODEL_SRC is None:
        print("    无模型包：跳过。用户按 readme.txt 的「模型」一节自行下载一档放进")
        print(f"    {TARGET / 'backend' / 'models' / 'Breeze-TTS-2-GGUF'}")
        (TARGET / "backend" / "models" / "Breeze-TTS-2-GGUF").mkdir(parents=True, exist_ok=True)
    else:
        place(MODEL_SRC, TARGET / "backend" / MODEL_DST_REL, link, [])

    print("--- 3) 后端配置与第三方许可 ---")
    place(AUDIOCPP / "server.json", TARGET / "backend" / "server.json", False, [])
    # audio.cpp 运行时自带 LICENSE（Apache-2.0 / ShugoAI LLC），已随 runtime 一起过去

    print("--- 4) 侧车 ---")
    place(SIDECAR_EXE, TARGET / "sidecar" / SIDECAR_EXE.name, False, [])

    print("--- 5) data：目录骨架 ---")
    for d in ("data/voices", "data/pjy/环境音效", "data/pjy/环境音效01",
              "data/pjy/事件音效", "data/pjy/事件音效01"):
        (TARGET / d).mkdir(parents=True, exist_ok=True)

    print("--- 6) 样例音色（随包附带，让用户解压就能听到声音） ---")
    voices_dir = TARGET / "data" / "voices"
    already = sorted(v for v in voices_dir.rglob("*.wav")) if voices_dir.is_dir() else []
    if already and not reset:
        # 用户可能已经在工作台里设计并保存了自己的音色，绝不能覆盖或删除
        print(f"  data\\voices 已有 {len(already)} 个音色，保留不动"
              f"（要重新铺样例请加 --reset-data）")
        n_samples = 0
    else:
        voices_src = DEPLOY / "plugin" / "voices"
        n_samples = 0
        for tag, stem in SAMPLE_VOICES:
            for ext in (".wav", ".txt"):
                f = voices_src / tag / (stem + ext)
                if not f.is_file():
                    raise SystemExit(
                        f"[中止] 找不到样例音色源文件：{f}\n"
                        f"        随包样例是 SAMPLE_VOICES 里显式列出的这 "
                        f"{len(SAMPLE_VOICES)} 个，需要你自己准备一份放在 "
                        f"<SRC>/plugin/voices/<标签>/ 下。")
                dst = voices_dir / tag / f.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                # 复制而不是硬链接：让整合包里的样例与开发库互相独立，
                # 避免用户在包里改动（或删除）时影响到开发库。
                shutil.copy2(f, dst)
                n_samples += 1
        print(f"  附带 {n_samples} 个音色文件（{len(SAMPLE_VOICES)} 个样例 × wav+txt）")
    (voices_dir / "_说明.txt").write_bytes(VOICES_NOTE)

    print("--- 7) 场景音效：折叠立体声 + 转码 OGG 后随包 ---")
    n_scene = transcode_scene_audio(force=reset)
    (TARGET / "data" / "pjy" / "_说明.txt").write_bytes(PJY_NOTE)
    print(f"  共放入 {n_scene} 个音效 + 说明")

    print("--- 8) 文档 ---")
    DOCS = TARGET / "文档"
    DOCS.mkdir(exist_ok=True)
    shutil.copy2(HERE / "docs" / "使用说明.md", DOCS / "使用说明.md")
    shutil.copy2(HERE / "docs" / "NOTICE", DOCS / "NOTICE")
    shutil.copy2(MODEL_LICENSE_SRC, DOCS / "LICENSE-Breeze-TTS-2")

    print("--- 9) 启动脚本与说明（放到根目录，方便双击） ---")
    for f in sorted((HERE / "launchers").iterdir()):
        shutil.copy2(f, TARGET / f.name)
    shutil.copy2(HERE / "readme.txt", TARGET / "readme.txt")

    # ---- 校验 ----
    print("\n--- 10) 校验必需文件 ---")
    required = list(REQUIRED)
    if MODEL_REQUIRED:
        required.append(MODEL_REQUIRED)
    bad = [r for r in required if not (TARGET / r).exists()]
    if bad:
        print("  [失败] 缺少：")
        for b in bad:
            print(f"    {b}")
        return 1
    print(f"  全部 {len(required)} 项就位 [OK]")
    if not MODEL_REQUIRED:
        print("  无模型包：backend/models 下不会有 .gguf（由用户自行放入）")

    # ---- 反向校验：随包音色必须"恰好"是 SAMPLE_VOICES 那 22 个 ----
    # 只查「必需文件在不在」是不够的。踩过的坑：验收套件里的 17-test-sidecar.py 会把
    # 测试音色上传到 127.0.0.1:7881，如果那时 7881 上跑的是**整合包实例**而不是开发实例，
    # 这些音色就落进了这里的 data/voices —— 结果作者自己的私有音色被一起发出去
    # （实测：诗雨04 / 星弥02 各一对 wav+json，其中还没有逐字稿）。
    # 所以组装完要反过来点名：多出来的东西会随包分发，必须让打包的人看见。
    voices_dir = TARGET / "data" / "voices"
    expected = {stem for _, stem in SAMPLE_VOICES}
    found_wavs = {p.stem: p for p in voices_dir.rglob("*.wav")}
    extra = sorted(set(found_wavs) - expected)
    samples_missing = sorted(expected - set(found_wavs))
    if extra or samples_missing:
        print()
        print("  " + "!" * 62)
        if samples_missing:
            print(f"  !! 少了 {len(samples_missing)} 个样例音色：{'、'.join(samples_missing)}")
        if extra:
            print(f"  !! data/voices 里有 {len(extra)} 个不在 SAMPLE_VOICES 里的音色，"
                  f"它们**会随包一起发出去**：")
            for stem in extra:
                wav = found_wavs[stem]
                has_txt = wav.with_suffix(".txt").is_file()
                print(f"       {wav.relative_to(TARGET)}"
                      f"{'（有逐字稿）' if has_txt else '（没有逐字稿 → 用户会看到“缺稿”）'}")
            print("     如果这些是你自己的音色，删掉它们或改用 --reset-data 重铺样例；")
            print("     如果确实要随包分发，请先在 SAMPLE_VOICES 里登记，并确认有权分发。")
        print("  " + "!" * 62)
        if args.strict_samples:
            print("  [失败] --strict-samples：样例集不符合预期，中止。")
            return 1
        print("  （继续组装；加 --strict-samples 可让这种情况直接失败）")
    else:
        print(f"  data/voices 恰好是 {len(expected)} 个登记样例 [OK]")

    # ---- 体积 ----
    print("\n--- 11) 体积 ---")
    for d in ("backend/runtime", "backend/models", "sidecar", "data/voices", "data/pjy", "文档"):
        p = TARGET / d
        if p.exists():
            print(f"  {d:22} {dir_size(p) / 1048576:10.1f} MB")
    total = dir_size(TARGET)
    print(f"  {'合计':22} {total / 1073741824:10.2f} GB")

    # ---- 可选打 zip ----
    if args.zip:
        print(f"\n--- 12) 打包 {ZIP_PATH.name} ---")
        if ZIP_PATH.exists():
            ZIP_PATH.unlink()
        with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for root, dirs, files in os.walk(TARGET):
                # 目录也要作为条目写进去。zip 默认只存文件，空目录（例如上游布局里的
                # backend\runtime\models）解压后就消失了 —— 那样解压出来的结构与这里
                # 校验过的组装目录不一致，以后真有一个必需的空目录就会被静默丢掉。
                for d in dirs:
                    arc = (Path(root) / d).relative_to(TARGET.parent).as_posix() + "/"
                    info = zipfile.ZipInfo(arc)
                    info.external_attr = (0o40755 << 16) | 0x10      # 目录位
                    z.writestr(info, b"")
                for f in files:
                    full = Path(root) / f
                    z.write(full, full.relative_to(TARGET.parent))
        print(f"  完成 {ZIP_PATH.name}  {ZIP_PATH.stat().st_size / 1073741824:.2f} GB")

    print("\n" + "=" * 62)
    print("  组装完成")
    print("=" * 62)
    print(f"  测试：直接双击 {TARGET}\\启动webui.cmd")
    print("  分发：把整个 MoonVoice 文件夹打成 zip，或加 --zip 让本脚本代劳")
    print("        提醒用户解压到纯英文路径（如 D:\\MoonVoice\\）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
