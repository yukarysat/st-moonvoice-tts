"""组装「月声整合包」到 package\\MoonVoice\\。

用法：
    python build-package.py                 # 硬链接大文件（几乎不占额外空间）
    python build-package.py --no-link       # 老老实实复制（跨盘或想要完全独立时用）
    python build-package.py --zip           # 顺便打成 月声整合包.zip

为什么 staging 目录必须叫 MoonVoice（纯 ASCII）：
    Breeze 后端是 C++ 程序，在 Windows 上按 ANSI 代码页打开文件，路径含中文
    时读不到模型。压缩包解压出来的顶层目录名就是这个路径的第一段，
    所以它必须是可以直接解压使用的 ASCII 名。
    ZIP 文件本身叫什么无所谓（月声整合包.zip 完全可以），
    但说明文档与启动脚本都会检查解压后的路径并在含中文时给出明确提示。

体积构成：
    backend\\runtime      1.01 GB   硬链接自 audiocpp\\runtime（187 个文件）
    backend\\models\\...   6.84 GB   硬链接自 audiocpp\\models
    sidecar\\*.exe         35 MB    复制自仓库 server\\dist
    data\\                   0        空目录，用户数据
    文档\\                   小

**程序目录必须用 ASCII 名（backend / sidecar / data）**：
    后端是 C++ 程序，按 ANSI 代码页打开文件。早期版本把目录命名为
    「后端」「侧车」，结果模型路径含中文，gguf_init_from_file 直接失败。
    文档目录不参与程序读写，保留中文名以便用户查找。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# 第三方大件（来自作者本机的部署目录）
DEPLOY = Path(r"E:\projects\BreezeTTS2")
AUDIOCPP = DEPLOY / "audiocpp"
MODEL_LICENSE_SRC = DEPLOY / "breeze-tts-2" / "LICENSE"

MODEL_REL = Path("models") / "Breeze-TTS-2-GGUF" / "breeze-tts-2-bf16.gguf"
SIDECAR_EXE = REPO / "server" / "dist" / "moonvoice-sidecar.exe"

# 随包分发的场景音效（源：作者音效库里的 WAV）。
# 显式列清单而不是"扫描目录里的 wav"，这样作者以后往库里加东西不会被误打包，
# 也让"哪些素材以什么依据分发"一目了然。
# 全部出自 SONNISS #gameaudiogdc 免费音效包 —— 授权允许用于自有项目（含商用、
# 免署名）并允许修改，禁止的是原样当素材库再分发。故分发前折叠为立体声并
# 转码为 OGG，使其成为本项目的素材而非原始素材文件。
# 不含任何 mp3：来源无法确认，其中一个 ID3 版权字段标注为 Sony Pictures。
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

TARGET = HERE / "MoonVoice"
ZIP_PATH = HERE / "月声整合包.zip"

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
    "backend/models/Breeze-TTS-2-GGUF/breeze-tts-2-bf16.gguf",
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

* 直接用：酒馆里不用配置任何东西就能出声
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


没带的那些
----------------------------------------------------------------
原本还有 16 个 mp3 氛围音（公园氛围、城镇闹市、厨房、海鸥……），
一个都没带。原因是来源无法确认：其中一个的 ID3 版权字段明确写着
Sony Pictures Entertainment，分发即构成侵权；其余文件也查不到出处。
这类文件在所谓"免费音效"站点上很常见，但版权仍归原权利人。


想加更多音效
----------------------------------------------------------------
    pjy\\环境音效\\    循环播放，换场景时淡入淡出
    pjy\\事件音效\\    只响一次，叠在环境音之上（敲门、干杯这类）

文件名必须和大模型在台词第三个方括号里写的名字一模一样，
例如台词写 [雨声]，文件名就叫 雨声.ogg（或 .wav）。
写 [] 就是停止环境音。

支持 .mp3 / .wav / .ogg / .m4a / .aac / .flac
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


FFMPEG_CANDIDATES = [
    os.environ.get("FFMPEG", ""),
    r"D:\tools\indextts2-env\ffmpeg.exe",
    r"D:\tools\indextts2-env\env\ffmpeg\bin\ffmpeg.exe",
    r"E:\projects\indextts2-windows\index-tts2-nvidia\ffmpeg.exe",
    "ffmpeg",
]


def find_ffmpeg() -> str:
    """找一个可用的 ffmpeg。可用环境变量 FFMPEG 指定。"""
    for cand in FFMPEG_CANDIDATES:
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
        "        可用环境变量指定：set FFMPEG=<ffmpeg.exe 的完整路径>")


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

    不包含任何 mp3：来源无法确认，其中一个的 ID3 版权字段标注为
    Sony Pictures Entertainment。
    """
    ff = find_ffmpeg()
    total_src = 0
    total_dst = 0
    n = 0
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

        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(src),
               "-vn",                      # 去掉内嵌封面（否则会多出一条 theora 视频流）
               "-map_metadata", "-1",      # 清空元数据
               "-ac", "2",                 # 4.0 quad -> 立体声
               "-c:a", "libvorbis", "-q:a", "6",
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
    ap.add_argument("--no-link", action="store_true", help="复制而不是硬链接")
    ap.add_argument("--zip", action="store_true", help="顺便打成 zip")
    ap.add_argument("--reset-data", action="store_true",
                    help="清空 data\\ 并重新铺样例音色与场景音效。"
                         "默认保留 data\\ —— 用户在工作台里保存的音色就在那里，"
                         "重建包不能把它删掉。")
    args = ap.parse_args()
    link = not args.no_link

    print("=" * 62)
    print("  组装 月声整合包")
    print("=" * 62)
    print(f"  目标: {TARGET}")
    print(f"  大文件: {'硬链接（省空间）' if link else '复制'}")
    print()

    # ---- 前置检查 ----
    missing = []
    for p in (AUDIOCPP / "runtime" / "audiocpp_server.exe",
              AUDIOCPP / MODEL_REL,
              AUDIOCPP / "server.json",
              MODEL_LICENSE_SRC,
              SIDECAR_EXE,
              HERE / "readme.txt",
              HERE / "launchers" / "_moonvoice.cmd",
              HERE / "docs" / "使用说明.md",
              HERE / "docs" / "NOTICE"):
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
    place(AUDIOCPP / MODEL_REL, TARGET / "backend" / MODEL_REL, link, [])

    print("--- 3) 后端配置与第三方许可 ---")
    place(AUDIOCPP / "server.json", TARGET / "backend" / "server.json", False, [])
    # audio.cpp 运行时自带 LICENSE（Apache-2.0 / ShugoAI LLC），已随 runtime 一起过去

    print("--- 4) 侧车 ---")
    place(SIDECAR_EXE, TARGET / "sidecar" / SIDECAR_EXE.name, False, [])

    print("--- 5) data：目录骨架 ---")
    for d in ("data/voices", "data/pjy/环境音效", "data/pjy/事件音效"):
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
        for f in sorted(voices_src.rglob("*")):
            if not f.is_file():
                continue
            if f.name in ("_说明.md", "_说明.txt"):
                continue
            rel = f.relative_to(voices_src)
            dst = voices_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            # 复制而不是硬链接：让整合包里的样例与开发库互相独立，
            # 避免用户在包里改动（或删除）时影响到开发库。
            shutil.copy2(f, dst)
            n_samples += 1
        print(f"  附带 {n_samples} 个音色文件")
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
    bad = [r for r in REQUIRED if not (TARGET / r).exists()]
    if bad:
        print("  [失败] 缺少：")
        for b in bad:
            print(f"    {b}")
        return 1
    print(f"  全部 {len(REQUIRED)} 项就位 [OK]")

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
            for root, _d, files in os.walk(TARGET):
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
