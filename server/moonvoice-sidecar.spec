# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：把侧车打成单文件 exe。

构建（在 server\\ 目录下）：
    pyinstaller moonvoice-sidecar.spec --noconfirm
或直接跑 build-exe.cmd。

产物：dist\\moonvoice-sidecar.exe（约 30-50 MB，自带 Python 解释器与全部依赖）

--------------------------------------------------------------------------
为什么下面这些必须显式声明
--------------------------------------------------------------------------
* `_soundfile_data` 里的 libsndfile_x64.dll **不是 Python 模块**，PyInstaller
  不会自动带上。soundfile 通过 `dirname(_soundfile_data.__file__)` 找它，
  所以必须落进同名的 `_soundfile_data/` 目录，否则 import soundfile 直接失败。
* `webui.html` / `manage.html` 是运行时按文件名读的资源。冻结后
  `HERE == sys._MEIPASS`，所以放进包根即可。
* uvicorn 大量使用动态导入（协议/事件循环/日志实现），必须显式声明，
  否则运行时报 ModuleNotFoundError 而不是构建时报错 —— 属于最难排查的一类。
"""

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# libsndfile_x64.dll + COPYING
datas = collect_data_files("_soundfile_data")

# 随代码分发的页面
datas += [
    ("webui.html", "."),
    ("manage.html", "."),
]

hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "anyio",
    "anyio._backends._asyncio",
]
hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    ["breeze_api.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 侧车不做推理。本项目的 venv 里装着 torch（约 5 GB），
        # 虽然没有任何 import 路径能碰到它，仍然显式排除以缩小体积、加快构建。
        "torch",
        "torchaudio",
        "torchvision",
        "triton",
        "scipy",
        "sklearn",
        "pandas",
        "matplotlib",
        "onnxruntime",
        "transformers",
        "tokenizers",
        "tkinter",
        "pytest",
        "IPython",
        "notebook",
        "PyInstaller",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="moonvoice-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # 不用 UPX：压缩后的 exe 更容易被杀毒软件误报，而这点体积不值得。
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    # 保留控制台：启动时会打印端口、数据目录和后端健康状态，
    # 出问题时这是用户唯一能看到的线索。启动脚本用 /min 把它最小化。
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
