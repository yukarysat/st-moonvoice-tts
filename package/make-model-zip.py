"""把单个 .gguf 打成「拖进整合包根目录就能用」的独立模型包。

用法:
    python make-model-zip.py <gguf> <输出.zip> [--license <LICENSE 路径>] [--note <短说明>]

zip 内部结构（故意与整合包同构，这样解压出来的 backend\\ 可以直接拖进包根目录合并）:

    backend/models/Breeze-TTS-2-GGUF/<名字>.gguf
    backend/models/Breeze-TTS-2-GGUF/_这一档是什么.txt
    文档/LICENSE-Breeze-TTS-2

为什么带上许可：模型（含量化变体）的许可要求分发时随附许可原文；模型包是
独立分发单元，不能只依赖整合包里那份。
"""
from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL_DIR = "backend/models/Breeze-TTS-2-GGUF"

NOTE_TMPL = """这一档是什么
================================================================

    {name}
    文件大小 {size_gib:.2f} GiB

它要放的位置就是当前目录。整合包里的启动器会自动发现它：

    · 目录里只有一个 .gguf  —— 直接用它
    · 有多个 .gguf          —— 读显卡显存，自动挑最好的一档
    · 想固定用这一档        —— 只留这一个文件即可

需要的显存约 {need_mib} MiB（= 文件大小 + 约 250 MiB 的激活开销），
另外要给桌面留 1 GB 左右。

{extra}

模型许可（非商业）原文在  文档\\LICENSE-Breeze-TTS-2
出处与量化说明见          文档\\NOTICE
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("gguf")
    ap.add_argument("out")
    ap.add_argument("--license", default="", help="模型许可原文（放进 文档\\）")
    ap.add_argument("--extra", default="", help="写进 _这一档是什么.txt 的补充说明")
    ap.add_argument("--delete-source", action="store_true",
                    help="打包成功后删除源 .gguf（它是可再生的，用于腾空间）")
    args = ap.parse_args()

    src = Path(args.gguf).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()
    if not src.is_file():
        raise SystemExit(f"[中止] 找不到 {src}")
    if src.suffix.lower() != ".gguf":
        raise SystemExit(f"[中止] 不是 .gguf：{src}")

    size = src.stat().st_size
    need = int(size / 1048576) + 250
    note = NOTE_TMPL.format(name=src.name, size_gib=size / 1073741824,
                            need_mib=need, extra=args.extra).replace("\n", "\r\n")

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    print(f"打包 {src.name}")
    print(f"  -> {out.name}")
    print(f"     模型 {size / 1073741824:.3f} GiB，需要约 {need} MiB 显存")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        # 目录条目也写进去（与 build-package.py 一致：解压后结构与预期相符）
        for d in ("backend/", "backend/models/", MODEL_DIR + "/", "文档/"):
            info = zipfile.ZipInfo(d)
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        z.write(src, f"{MODEL_DIR}/{src.name}")
        z.writestr(f"{MODEL_DIR}/_这一档是什么.txt", note.encode("utf-8"))
        if args.license:
            lic = Path(args.license).expanduser().resolve()
            if lic.is_file():
                z.write(lic, "文档/LICENSE-Breeze-TTS-2")
            else:
                print(f"     [警告] 找不到许可文件 {lic}，模型包里将没有许可原文")
    print(f"     完成 {out.stat().st_size / 1073741824:.2f} GiB"
          f"（压到 {out.stat().st_size / size * 100:.1f}%）")

    if args.delete_source:
        src.unlink()
        print(f"     已删除源文件腾空间：{src}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
