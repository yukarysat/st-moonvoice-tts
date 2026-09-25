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
    # 场景音效刻意不带，只放说明
    "data/pjy/_说明.txt",
    "data/pjy/环境音效",
    "data/pjy/事件音效",
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


PJY_NOTE = _note("""场景音效放在这里（本整合包刻意不附带任何音效）
================================================================

这个文件夹是空的，是有意为之 —— 请你自行放入有明确授权的音频。


为什么不自带
----------------------------------------------------------------
制作整合包时检查过手头可用的素材，发现其中含有商业版权内容
（有一个音效文件的版权字段明确写着 Sony Pictures Entertainment）。
这类文件在所谓"免费音效"站点上很常见，但版权仍归原权利人，
随包分发会构成侵权。

其余文件虽然查不出处，但同样无法证明可以自由分发。
所以本整合包一律不附带音效，把这个选择留给你。


怎么放
----------------------------------------------------------------
    pjy\\环境音效\\    循环播放，换场景时淡入淡出
    pjy\\事件音效\\    只响一次，叠在环境音之上（敲门、干杯这类）

文件名必须和大模型在台词第三个方括号里写的名字一模一样，
例如台词写 [雨声]，文件名就叫 雨声.wav。写 [] 就是停止环境音。

支持 .mp3 / .wav / .ogg / .m4a / .aac / .flac
名字对不上不会报错，只是那一段不播声音。


去哪里找能自由使用的音效
----------------------------------------------------------------
* freesound.org   —— 筛选 License 为 Creative Commons 0 (CC0)，可自由使用
* 自己录         —— 手机录一段环境声即可，完全没有版权问题
* 用 CC-BY 素材时记得在发布物里署名（CC0 不需要）

这里放的文件只在本机使用，插件和整合包都不会把它们上传到任何地方。
""")


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
    if TARGET.exists():
        print(f"  清理旧的 {TARGET.name}\\ ...")
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)

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
    voices_src = DEPLOY / "plugin" / "voices"
    n_samples = 0
    for f in sorted(voices_src.rglob("*")):
        if not f.is_file():
            continue
        if f.name in ("_说明.md", "_说明.txt"):
            continue
        rel = f.relative_to(voices_src)
        dst = TARGET / "data" / "voices" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        # 复制而不是硬链接：让整合包里的样例与开发库互相独立，
        # 避免用户在包里改动（或删除）时影响到开发库。
        shutil.copy2(f, dst)
        n_samples += 1
    (TARGET / "data" / "voices" / "_说明.txt").write_bytes(VOICES_NOTE)
    print(f"  附带 {n_samples} 个音色文件 + 说明")

    print("--- 7) 场景音效：刻意不附带 ---")
    (TARGET / "data" / "pjy" / "_说明.txt").write_bytes(PJY_NOTE)
    print("  已放入说明（不附带任何音效文件）")

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
