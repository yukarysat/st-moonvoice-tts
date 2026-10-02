"""Breeze TTS 2 sidecar for the SillyTavern plugin ST-MoonVoice.

Responsibilities
  * voice library on disk        voices/<id>.wav + voices/<id>.json
  * transcript CRUD              (manual entry, per design decision)
  * loudness check on upload     (shouty references ruin every output)
  * serialised forwarding        to the audio.cpp Breeze server (single-concurrency)
  * manage page                  GET /

Backend: audio.cpp Breeze on 127.0.0.1:7870. Omitting `stream_format` makes it
return a ready WAV, which is what the plugin expects as a binary blob.

Run:  <breeze-venv>\\Scripts\\python.exe breeze_api.py [--data-dir <voices 与 pjy 的父目录>]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import ipaddress
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote, urlsplit
from dataclasses import dataclass, asdict, field
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

def _is_frozen() -> bool:
    """是否运行在 PyInstaller 打出来的 exe 里。"""
    return bool(getattr(sys, "frozen", False))


def _asset_dir() -> Path:
    """资源目录：webui.html / manage.html 这类随代码分发的文件在这里找。

    PyInstaller 单文件模式下 __file__ 指向临时解包目录（sys._MEIPASS），
    所以必须走 _MEIPASS，不能靠 __file__ 的父目录。
    """
    if _is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def _exe_dir() -> Path:
    """程序自身所在目录：数据目录的默认值。

    冻结后必须用 sys.executable 的父目录 —— 那是用户解压出来的真实位置。
    若沿用 _MEIPASS，voices/ 与 pjy/ 会被写进临时目录，程序一退出就没了。
    """
    if _is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


HERE = _asset_dir()
DATA_DEFAULT = _exe_dir()


def _resolve_data_dir() -> Path:
    """数据目录（voices/ 与 pjy/ 的父目录）。

    优先级：--data-dir 参数 > 环境变量 BREEZE_DATA_DIR > 程序所在目录。
    不传参数时就是程序所在目录，与旧行为一致。

    必须在模块加载期就解析出来：VOICES_DIR / SCENE_AUDIO_DIR 是模块级常量，
    下面有几十处引用它们，等到 main() 里再解析就太晚了。
    """
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--data-dir" and i + 1 < len(argv):
            return Path(argv[i + 1]).expanduser().resolve()
        if arg.startswith("--data-dir="):
            return Path(arg.split("=", 1)[1]).expanduser().resolve()
    env = os.environ.get("BREEZE_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return DATA_DEFAULT


DATA_DIR = _resolve_data_dir()
VOICES_DIR = DATA_DIR / "voices"
# 临时参考音频：工作台「合成」页拖进来那一段，只给本次合成用。
# 刻意放在 voices/ 之外 —— 它是「试一下」，不是音色库成员，不该出现在 /voices
# 列表里、也不该被 NPC 自动分配挑中。按内容哈希命名：ASCII 安全、同内容天然去重。
# 整个目录随时可以删，不影响音色库与场景音效。
REFS_DIR = DATA_DIR / "refs"
# 场景音效目录。插件按「场景标签名」找 <名字>.<后缀>，所以文件名必须与提示词里的
# 场景标签完全一致（含大小写）。原版 IndexTTS 的 api.py 也是放在脚本旁边的 pjy/。
SCENE_AUDIO_DIR = DATA_DIR / "pjy"
# 四个子文件夹决定播放行为（提示词无需为此改动，模型照常写标签）：
#   环境音效    -> 循环、顶替上一段、带淡入淡出（旧行为，永不被事件打断）
#   环境音效01  -> 第二条循环轨：与环境音效**并存**，可被事件音效01 打断
#   事件音效    -> 只播一次、叠在循环轨之上（旧行为，每次出现都响）
#   事件音效01  -> 场景名变化时响一次，且**有打断能力**（停掉 环境音效01；同名不打断）
#
# 这两组"01"文件夹是给同一场景叠加多层音效用的：把 房间底噪 / BGM / 开门声
# 分别命名成同一个名字（如 室内_房间）放进不同文件夹，模型写 [室内_房间] 时
# 三处会一起播。轨道 id 与插件的 scene-mixer.js 里 TRACK_RULES 的 id 必须一致。
AMBIENT_SUBDIR = "环境音效"
AMBIENT1_SUBDIR = "环境音效01"
EVENT_SUBDIR = "事件音效"
EVENT1_SUBDIR = "事件音效01"
# 轨道 id -> 文件夹名。根目录的文件也算 ambient（兼容旧布局）。
SCENE_TRACKS = {
    "ambient": AMBIENT_SUBDIR,
    "ambient1": AMBIENT1_SUBDIR,
    "event": EVENT_SUBDIR,
    "event1": EVENT1_SUBDIR,
}
DEFAULT_BACKEND = "http://127.0.0.1:7870"
DEFAULT_MODEL = "breeze-tts-2"

# --------------------------------------------------------------------------- 署名
# 这套东西是谁做的、基于什么。放在 /health 与两个页面里，让「这个包从哪来的」一眼可查。
#
# 刻意**只写声明性信息**（名称、作者、仓库、上游），不写任何用户或机器相关的标识：
# 那会变成追踪个人，既不合规也没必要。想在输出音频里嵌元数据这类「水印」也是同理 ——
# 拦不住决心要去掉的人，真正管用的是 AGPL 本身的署名义务。
#
# 版本号与仓库根目录 manifest.json 保持一致，改版本时两处一起改。
SOFTWARE_NAME = "月声 MoonVoice"
SOFTWARE_VERSION = "1.2.7-moonvoice.5"
SOFTWARE_AUTHOR = "古木兆月"
SOFTWARE_REPO = "https://github.com/yukarysat/st-moonvoice-tts"
SOFTWARE_UPSTREAM = "Breeze TTS 2（breezeblue-ai/breeze-tts）· audio.cpp 运行时"
SOFTWARE_LICENSE = "AGPL-3.0（侧车与插件）· Apache-2.0（audio.cpp 运行时）"

# References louder than this are almost certainly shouting; Breeze inherits that energy.
LOUD_RMS_DBFS = -14.0
# Below this the reference is too quiet to clone reliably.
QUIET_RMS_DBFS = -30.0

# 能当参考音频的格式（按 libsndfile 1.2 的能力；m4a/aac 读不了，会明确报错）
REF_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".aiff", ".aif", ".au", ".w64"}
# 参考音频通常几秒到几十秒，给足余量，同时挡住误传的大文件
MAX_REF_BYTES = 40 * 1024 * 1024

_BACKEND = DEFAULT_BACKEND
_MODEL = DEFAULT_MODEL
_LOCK = threading.Lock()  # Breeze is single-concurrency; serialise every request

# NPC 音色标签。子文件夹用这些名字命名，音色即被归入该标签。
VOICE_TAGS = [
    "男-儿童", "男-少年", "男-青年", "男-中年", "男-老年",
    "女-儿童", "女-少年", "女-青年", "女-中年", "女-老年",
    "中性-未定",
]


# --------------------------------------------------------------------------- models

@dataclass
class Voice:
    id: str                      # relative POSIX path, e.g. "xingmi02.wav" or "男-中年/车夫.wav"
    name: str = ""
    ref_text: str = ""           # must match the audio exactly
    language: str = "zh"
    default_instruction: str = ""  # used when a line carries no emotion description
    guidance_scale: float = 4.0
    rms_dbfs: float = 0.0
    duration_s: float = 0.0
    sample_rate: int = 0
    tag: str = ""                # NPC 标签，由文件夹名推导（根目录音色可手填）
    created: float = field(default_factory=time.time)

    @property
    def wav_path(self) -> Path:
        return VOICES_DIR / self.id

    @property
    def json_path(self) -> Path:
        # 必须保留子目录：voices/男-中年/车夫.wav -> voices/男-中年/车夫.json
        return self.wav_path.with_suffix(".json")

    @property
    def txt_path(self) -> Path:
        return self.wav_path.with_suffix(".txt")

    @property
    def ready(self) -> bool:
        return bool(self.ref_text.strip())


def ensure_tag_folders() -> None:
    """建好 11 个标签文件夹，方便用户直接往里丢音频。"""
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for tag in VOICE_TAGS:
        (VOICES_DIR / tag).mkdir(exist_ok=True)


def _rel_id(wav: Path) -> str:
    return wav.relative_to(VOICES_DIR).as_posix()


def _load_meta(wav: Path) -> Voice:
    meta = Voice(id=_rel_id(wav), name=wav.stem)
    side = wav.with_suffix(".json")
    data: dict = {}
    if side.is_file():
        try:
            data = json.loads(side.read_text(encoding="utf-8"))
            for key, value in data.items():
                if hasattr(meta, key) and key not in ("id", "tag"):
                    setattr(meta, key, value)
        except Exception:
            pass

    # 逐字稿：同名 .txt 优先于 JSON（方便批量放文件时直接写 txt）
    txt = wav.with_suffix(".txt")
    if txt.is_file():
        try:
            text = txt.read_text(encoding="utf-8").lstrip("\ufeff").strip()
            if text:
                meta.ref_text = text
        except Exception:
            pass

    # 标签：文件夹名优先，其次 JSON 里的 tag 字段
    folder = wav.parent.name
    if wav.parent != VOICES_DIR and folder in VOICE_TAGS:
        meta.tag = folder
    else:
        raw_tag = str(data.get("tag", "") or "").strip()
        meta.tag = raw_tag if raw_tag in VOICE_TAGS else ""

    meta.id = _rel_id(wav)
    return meta


def _save_meta(voice: Voice) -> None:
    payload = asdict(voice)
    payload.pop("id", None)
    voice.json_path.parent.mkdir(parents=True, exist_ok=True)
    voice.json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _sync_transcript(voice: Voice) -> None:
    """让 .txt 与 JSON 里的 ref_text 保持一致。

    读取时 .txt **优先于** JSON（见 _load_meta），所以只写 JSON 是不够的：库里若留着
    一个旧的 .txt，用户改的逐字稿会被它盖回去，界面上看就是「改了没生效」「清空无效」。
    文本为空时删掉 .txt，否则「清空逐字稿」同样无效。

    这个 .txt 是给批量放文件用的另一种写法（放进同名 txt 即可，不必手写 JSON），
    所以只有**真的动了 ref_text** 的路径才调用它 —— 别的路径调用会凭空生成一堆 txt。
    """
    text = (voice.ref_text or "").strip()
    if text:
        voice.txt_path.write_text(text, encoding="utf-8", newline="")
    else:
        voice.txt_path.unlink(missing_ok=True)


def list_voices() -> list[Voice]:
    """根目录 + 一层标签子目录里的所有 wav。"""
    if not VOICES_DIR.is_dir():
        return []
    found: list[Path] = list(VOICES_DIR.glob("*.wav"))
    for sub in sorted(x for x in VOICES_DIR.iterdir() if x.is_dir()):
        found.extend(sub.glob("*.wav"))
    return [_load_meta(w) for w in sorted(found, key=_rel_id)]


def find_voice(voice_id: str) -> Voice:
    """接受 'xingmi02'、'xingmi02.wav'、'男-中年/车夫.wav'（斜杠或反斜杠皆可）。"""
    raw = str(voice_id).strip().replace("\\", "/").lstrip("/")
    if not raw:
        raise HTTPException(status_code=400, detail="音色名为空")
    stem = raw[:-4] if raw.lower().endswith(".wav") else raw
    # 只认 <stem>.wav。早先这里还有一个「原样当路径」的候选，于是同目录的 .txt / .json
    # 也能被解析成「音色」：DELETE 留下的孤儿 .txt 会被 /voices/<名字>.txt/audio 当作音频
    # 吐出来（174 的 H 组据此报过一条"注意"），PUT/DELETE 也能对着一个 .txt 操作。
    # 音色库本来就只收 wav（list_voices 只扫 *.wav）。
    path = (VOICES_DIR / f"{stem}.wav").resolve()
    try:
        path.relative_to(VOICES_DIR.resolve())     # 防目录穿越
    except ValueError:
        path = None
    if path is not None and path.is_file():
        return _load_meta(path)
    # 退化：只给文件名时在子目录里找同名
    base = Path(raw).name
    for w in list_voices():
        if Path(w.id).name == base or Path(w.id).stem == base:
            return w
    raise HTTPException(status_code=404, detail=f"未知音色: {voice_id}")


# --------------------------------------------------------------------------- helpers

def probe_audio(path: Path) -> tuple[float, float, int]:
    """Return (rms_dbfs, duration_s, sample_rate)."""
    audio, rate = sf.read(path, always_2d=True, dtype="float32")
    mono = audio.mean(axis=1)
    rms = float(np.sqrt(np.mean(mono**2))) if mono.size else 0.0
    dbfs = 20.0 * float(np.log10(rms)) if rms > 1e-9 else -120.0
    return round(dbfs, 2), round(len(mono) / rate, 3), int(rate)


def normalize_reference(payload: bytes, filename: str) -> bytes:
    """把上传的参考音频统一转成 16bit PCM WAV 字节。

    为什么非转不可：音色库与后端之间只传**文件路径**，后端按路径自己解码。
    旧行为是把上传内容原样写进 `<名字>.wav` —— 传 mp3 时会得到一个名字像 WAV、
    内容却是 mp3 的文件，克隆当场失败，而报错完全看不出原因。这里用 libsndfile
    现场解码再写成真正的 WAV，顺带把位深统一成 16bit。

    参考音频都很短，不存在大文件下 soundfile 栈溢出那个已知问题。
    """
    ext = Path(filename or "").suffix.lower()
    if ext and ext not in REF_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的音频格式 {ext}（支持：{'、'.join(sorted(REF_EXTS))}）",
        )
    try:
        audio, rate = sf.read(io.BytesIO(payload), dtype="int16", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"无法解析音频: {exc}") from exc
    if not audio.size:
        raise HTTPException(status_code=400, detail="音频内容为空")
    buf = io.BytesIO()
    sf.write(buf, audio, int(rate), format="WAV", subtype="PCM_16")
    return buf.getvalue()


def loudness_warning(dbfs: float) -> str | None:
    if dbfs > LOUD_RMS_DBFS:
        return (
            f"参考音频偏响（{dbfs} dBFS > {LOUD_RMS_DBFS}）：输出会继承这种能量，"
            "可能显得像在喊。建议换一段平静的参考。"
        )
    if dbfs < QUIET_RMS_DBFS:
        return f"参考音频偏轻（{dbfs} dBFS）：克隆效果可能不稳定。"
    return None


def backend_health() -> dict:
    try:
        with urllib.request.urlopen(_BACKEND + "/health", timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"status": "unreachable", "error": f"{type(exc).__name__}: {exc}"}


_ASCII_REF_DIR = Path(tempfile.gettempdir()) / "breeze_refs"


def ascii_safe_path(src: Path) -> Path:
    """Return a path the Breeze runtime can actually open.

    audio.cpp 是 C++ 实现，在 Windows 上按 ANSI 代码页打开文件，路径里含中文等
    非 ASCII 字符时会失败，报 “could not open WAV input”（注意是 open 不是 parse，
    音频本身完全合法——实测同一文件改成 ASCII 名就能正常合成）。
    这里对这类文件准备一份 ASCII 路径的副本，用户仍可用中文音色名。

    音色库里的音色与工作台临时拖进来的参考音频都走这里 —— 两者都可能是
    「中文标签文件夹 + 中文文件名」，也都可能整个数据目录就在中文路径下。
    """
    # 必须检查**整个路径**：标签文件夹名（男-中年）本身就是中文，
    # 只看 src.name 会漏掉这一层，导致所有文件夹音色都打不开。
    try:
        str(src).encode("ascii")
        return src
    except UnicodeEncodeError:
        pass

    _ASCII_REF_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(str(src).encode("utf-8")).hexdigest()[:12]
    dst = _ASCII_REF_DIR / f"{key}{src.suffix.lower() or '.wav'}"
    # 源文件更新（重新上传同一音色）后需要重新拷贝
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)
    return dst


def resolve_ref_path(voice: Voice) -> Path:
    """音色库里某个音色的参考音频路径（必要时转成 ASCII 安全的副本）。"""
    return ascii_safe_path(voice.wav_path)


def synth_wav(voice: Voice | None, text: str, instruction: str, guidance_scale: float,
              seed: int, model: str | None = None) -> bytes:
    """voice=None 时走「声音设计」：只给描述，不给参考音频。"""
    if voice is None:
        return synth_wav_ref(None, "", text, instruction, guidance_scale, seed, model)
    return synth_wav_ref(voice.wav_path, voice.ref_text, text, instruction,
                         guidance_scale, seed, model)


def synth_wav_ref(ref_path: Path | None, ref_text: str, text: str, instruction: str,
                  guidance_scale: float, seed: int, model: str | None = None) -> bytes:
    """用一段参考音频克隆。ref_path=None 则退化成纯「声音设计」。"""
    payload = {
        "model": (model or _MODEL),
        "input": text,
        "options": {"guidance_scale": guidance_scale, "seed": seed},
    }
    if ref_path is not None:
        payload["voice_ref"] = str(ascii_safe_path(ref_path))
        payload["reference_text"] = ref_text
    if instruction.strip():
        payload["options"]["instruction"] = instruction.strip()

    request = urllib.request.Request(
        _BACKEND + "/v1/audio/speech",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=3600) as response:
        return response.read()


# --------------------------------------------------------------------------- app

app = FastAPI(title=f"{SOFTWARE_NAME} sidecar", version=SOFTWARE_VERSION)

# SillyTavern 与 sidecar 不同源，插件的 /tts 请求带 Content-Type: application/json，
# 属于非简单请求 -> 浏览器必发预检 OPTIONS。没有这个中间件时预检返回 405，
# 合成请求会在浏览器层直接失败（curl 不校验 CORS，所以本地测试发现不了）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Breeze-Voice", "X-Breeze-Guidance", "X-Breeze-Seed",
                    "X-Breeze-Wall-Ms", "X-Breeze-Ref-Warning"],
)


# --------------------------------------------------------------------------- 来源校验
# 侧车**没有任何鉴权**（本机工具，刻意如此）。但"无鉴权 + allow_origins=*"叠在一起，
# 意味着用户浏览器里访问的**任意网页**都能跨站调用改写类接口：实测带
# `Origin: https://evil.example` 发 DELETE /voices/{id} 能真的删掉音色库里的文件，
# POST /api/v1/upload 的预检也放行。所以这里给浏览器发起的改写请求加一道闸：
#
#   · 没有 Origin 头的请求一律放行 —— curl、脚本、服务端调用，以及 <audio src> 这类
#     非 CORS 请求都不带 Origin，挡了会把正常用法一起挡掉
#   · Origin 是本机（localhost / 127.0.0.1 / ::1）或私有网段（10./172.16-31./192.168./
#     169.254./100.64-127. 等，含 Tailscale）放行 —— 插件跑在酒馆页面上，来源就是这些
#   · 其余一律 403（含 `Origin: null`，即 file:// 页面与沙箱 iframe）
#
# 它**不改变**"服务本身没有鉴权"这件事：同网段的人直接用 curl 依然能调（他们本来就能，
# 因为你把服务开给了整个网段）；这道闸专门针对"浏览器里的第三方页面"。
# 默认只挡改写类（mutating）；`--origin-guard all` 连读取也挡，`off` 关闭本机制。
ORIGIN_GUARD_CHOICES = ("off", "mutating", "all")
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_origin_guard = "mutating"
_extra_origins: set[str] = set()

# 100.64.0.0/10 是运营商级 NAT 的保留网段，Tailscale 等组网工具用的就是它。
# 注意 ipaddress 的 is_private 并**不**包含它（实测 py3.12 返回 False），所以必须自己列，
# 否则走 Tailscale 地址打开酒馆的用户会被自己的防护挡住上传。
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")


def _origin_allowed(origin: str) -> bool:
    if not origin:
        return True                     # 没有 Origin 头 = 非浏览器 / 非 CORS 请求
    if origin in _extra_origins:
        return True
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False                    # 挡掉 "null" 与各种自定义 scheme
    host = (parts.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False                    # 域名默认不放行；确实需要时用 --allow-origin 显式加
    if ip.version == 4 and ip in _SHARED_ADDRESS_SPACE:
        return True                     # Tailscale / CGNAT
    return ip.is_private or ip.is_loopback or ip.is_link_local


@app.middleware("http")
async def _origin_guard_middleware(request: Request, call_next):
    if _origin_guard != "off":
        guarded = request.method in _MUTATING_METHODS or _origin_guard == "all"
        if guarded:
            origin = request.headers.get("origin", "")
            if not _origin_allowed(origin):
                # 先把请求体读掉再拒绝。直接在客户端还在发 body 时关连接，Windows 会回
                # RST，客户端拿到的是 ConnectionAborted（WinError 10053）而不是 403 ——
                # 时好时坏，取决于响应和剩余 body 谁先到。体积过大的不读：拒绝一次
                # 跨站上传没必要把几十 MB 收进内存。
                try:
                    if int(request.headers.get("content-length") or 0) <= 1_048_576:
                        await request.body()
                except (ValueError, RuntimeError):
                    pass
                print(f"[origin] 已拒绝 {request.method} {request.url.path} —— "
                      f"Origin={origin!r} 不是本机或局域网地址", flush=True)
                return JSONResponse(
                    status_code=403,
                    content={"detail":
                             "跨站改写请求已被拒绝：本服务只接受来自本机或局域网地址的 "
                             "POST/PUT/DELETE。用脚本调用请不带 Origin 头；"
                             "若你确实是从别的地址打开酒馆（例如域名），"
                             "用 --allow-origin 显式放行该来源。"},
                )
    return await call_next(request)

# 场景音效的静态托管。插件会用 <baseUrl>/pjy/<文件名> 直接作为 <audio> 的 src，
# 所以这里必须挂载成静态目录，不能只在 /api/v1/scene_audios 里列名字。
SCENE_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
# 四个子目录都建出来。README 一直写着"侧车会自动创建"，但代码里从来没做过 ——
# 用户拿到手只看到一个空的 pjy/，不知道该往哪放、也不知道有几种播放方式。
for _sub in SCENE_TRACKS.values():
    (SCENE_AUDIO_DIR / _sub).mkdir(exist_ok=True)
app.mount("/pjy", StaticFiles(directory=str(SCENE_AUDIO_DIR)), name="pjy")


@app.get("/api/v1/scene_audios")
def get_scene_audios() -> dict:
    """场景音效清单。插件靠它判断某个场景标签有没有文件、以及该按哪种方式播放。

    按子文件夹区分播放行为（文件夹名见 SCENE_TRACKS），**提示词不需要为此改动**：
    模型只需要照常写 `[敲门]` 这样的标签，类型判断发生在下游。

    返回里有两套字段：

      · `tracks` / `track_counts` —— 新：四个轨道各自的「名字 -> 相对路径」。
        同名文件可以分布在多个轨道里，插件会把它们**一起**播（房间底噪 + BGM + 开门声）。
      · `scenes` / `events` / `paths` —— 旧：两分类视图，供**老版本插件**继续工作。
        新轨道里的文件也会并进去（老插件会当成普通环境音/事件音播，属于尽力兼容）。

    注意插件的匹配是**大小写敏感**的，所以 `.MP3` 这种大写后缀不会被匹配到。
    重名时优先级：环境音效（含根目录）> 环境音效01 > 事件音效 > 事件音效01。
    """
    audio_extensions = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac")

    def scan(subdir: str) -> list[tuple[str, str]]:
        """返回 [(文件名, 相对 pjy 的路径)]，按文件名排序。"""
        d = SCENE_AUDIO_DIR / subdir if subdir else SCENE_AUDIO_DIR
        if not d.is_dir():
            return []
        out = []
        for f in sorted(d.iterdir(), key=lambda p: p.name):
            if f.is_file() and f.suffix.lower() in audio_extensions:
                rel = f"{subdir}/{f.name}" if subdir else f.name
                out.append((f.name, rel))
        return out

    # 根目录也当环境音：兼容旧布局，也符合「没分类的就是背景环境」的直觉
    root = scan("")
    tracks: dict[str, dict[str, str]] = {}
    for track_id, subdir in SCENE_TRACKS.items():
        # 环境音轨还包含 pjy 根目录。重名时**子目录优先**：与旧实现一致
        # （旧代码先收根目录、再让 环境音效/ 覆盖同名项），所以这里把子目录放前面。
        found = scan(subdir) + list(root) if track_id == "ambient" else scan(subdir)
        per_track: dict[str, str] = {}
        for name, rel in found:
            per_track.setdefault(name, rel)
        tracks[track_id] = per_track

    # 旧字段：按优先级合成的两分类视图（先放低优先级的，再被高优先级的覆盖）
    priority = ["event1", "event", "ambient1", "ambient"]
    paths: dict[str, str] = {}
    for track_id in priority:
        for name, rel in tracks[track_id].items():
            paths[name] = rel

    return {
        # ---- 新字段 ----
        "tracks": tracks,                                  # 轨道 id -> { 名字: 相对路径 }
        "track_counts": {k: len(v) for k, v in tracks.items()},
        # ---- 旧字段（老插件继续可用）----
        "scenes": sorted({n for tid in ("ambient", "ambient1") for n in tracks[tid]}),
        "events": sorted({n for tid in ("event", "event1") for n in tracks[tid]}),
        "paths": paths,
        "ambient_dir": AMBIENT_SUBDIR,
        "event_dir": EVENT_SUBDIR,
        "count": len(paths),
    }


@app.get("/health")
def health() -> JSONResponse:
    b = backend_health()
    return JSONResponse({
        "status": "ok",
        "backend": _BACKEND,
        "backend_ok": b.get("status") == "ok",
        "backend_detail": b,
        "voices": len(list_voices()),
        "loud_rms_dbfs": LOUD_RMS_DBFS,
        # 署名：谁做的、基于什么、源码在哪。给人和别的程序一个「这包从哪来」的答案。
        "about": {
            "name": SOFTWARE_NAME,
            "version": SOFTWARE_VERSION,
            "author": SOFTWARE_AUTHOR,
            "repo": SOFTWARE_REPO,
            "upstream": SOFTWARE_UPSTREAM,
            "license": SOFTWARE_LICENSE,
        },
    })


@app.get("/voices")
def get_voices() -> dict:
    """Shape matches what the plugin parses: {voices:[{filename,name,...}]}."""
    out = []
    for v in list_voices():
        out.append({
            "filename": v.id,
            "name": v.name or Path(v.id).stem,
            "ref_text": v.ref_text,
            "default_instruction": v.default_instruction,
            "guidance_scale": v.guidance_scale,
            "rms_dbfs": v.rms_dbfs,
            "duration_s": v.duration_s,
            "tag": v.tag,                     # NPC 标签（来自文件夹名）
            "folder": str(Path(v.id).parent) if "/" in v.id else "",
            "ready": v.ready,
        })
    return {"voices": out, "count": len(out), "directory": str(VOICES_DIR)}


@app.post("/api/v1/upload")
async def upload(file: UploadFile = File(...),
                 tag: str = Form(""),
                 name: str = Form(""),
                 ref_text: str = Form("")) -> dict:
    """上传参考音频。可选：归入某个标签文件夹、重命名、同时写入逐字稿。"""
    tag = (tag or "").strip()
    if tag and tag not in VOICE_TAGS:
        raise HTTPException(status_code=400, detail=f"非法标签: {tag}")

    raw_name = (name or "").strip() or Path(file.filename or "voice.wav").name
    stem = Path(raw_name).stem
    stem = "".join(ch for ch in stem if ch not in '\\/:*?"<>|').strip() or "voice"
    filename = stem + ".wav"

    dst_dir = (VOICES_DIR / tag) if tag else VOICES_DIR
    dst_dir.mkdir(parents=True, exist_ok=True)
    target = dst_dir / filename
    if target.exists():
        target = dst_dir / f"{stem}_{uuid.uuid4().hex[:6]}.wav"

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(payload) > MAX_REF_BYTES:
        raise HTTPException(status_code=400,
                            detail=f"音频过大（{len(payload) / 1048576:.1f} MB，"
                                   f"上限 {MAX_REF_BYTES // 1048576} MB）")
    # 统一转成真 WAV：见 normalize_reference 的说明（旧行为会把 mp3 原样存成 .wav）
    target.write_bytes(normalize_reference(payload, file.filename or ""))

    try:
        dbfs, duration, rate = probe_audio(target)
    except Exception as exc:  # noqa: BLE001
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"无法解析音频: {exc}") from exc

    voice = Voice(
        id=(f"{tag}/" if tag else "") + target.name,
        name=target.stem, tag=tag,
        rms_dbfs=dbfs, duration_s=duration, sample_rate=rate,
        ref_text=(ref_text or "").strip(),
    )
    _save_meta(voice)
    # 同步而不是直接写 .txt：同名重新上传且**不填**逐字稿时，这一步会清掉可能残留的
    # 旧 .txt。否则 delete 遗留的孤儿 txt 会被新音色静默继承，克隆时用错逐字稿。
    _sync_transcript(voice)
    text = voice.ref_text

    return {
        "filename": voice.id,
        "tag": tag,
        "rms_dbfs": dbfs,
        "duration_s": duration,
        "sample_rate": rate,
        "warning": loudness_warning(dbfs),
        "has_transcript": bool(text),
        "note": "" if text else "尚未填写逐字稿，无法用于克隆。",
    }


@app.post("/design")
def design(payload: dict) -> Response:
    """声音设计：只给描述生成音色，不需要参考音频。"""
    text = (payload.get("text") or "").strip()
    instruction = (payload.get("instruction") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if not instruction:
        raise HTTPException(status_code=400, detail="请填写声音描述（instruction）")
    try:
        gs = float(payload.get("guidance_scale", 4.0))
    except (TypeError, ValueError):
        gs = 4.0
    seed = int(payload.get("seed", 42))
    started = time.perf_counter()
    with _LOCK:
        try:
            wav = synth_wav(None, text, instruction, gs, seed)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise HTTPException(status_code=502, detail=f"Breeze 后端错误 {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"无法连接 Breeze 后端: {exc}") from exc
    elapsed = time.perf_counter() - started
    return Response(content=wav, media_type="audio/wav",
                    headers={"X-Breeze-Wall-Ms": f"{elapsed * 1000:.0f}"})


@app.get("/api/v1/tags")
def get_tags() -> dict:
    """标签列表与每个标签下的音色数量。"""
    ensure_tag_folders()
    counts = {t: len(list((VOICES_DIR / t).glob("*.wav"))) for t in VOICE_TAGS}
    root_count = len(list(VOICES_DIR.glob("*.wav")))
    return {"tags": VOICE_TAGS, "counts": counts, "root": root_count}


@app.post("/voices/{voice_id:path}/move")
def move_voice(voice_id: str, payload: dict) -> dict:
    """把音色移到另一个标签文件夹（空标签 = 根目录）。

    注意：文件夹名优先于 JSON 的 tag 字段，所以改 JSON 不会真的搬家，
    必须物理移动 wav / txt / json 三个文件。
    """
    voice = find_voice(voice_id)
    tag = str(payload.get("tag", "") or "").strip()
    if tag and tag not in VOICE_TAGS:
        raise HTTPException(status_code=400, detail=f"非法标签: {tag}")

    dst_dir = (VOICES_DIR / tag) if tag else VOICES_DIR
    dst_dir.mkdir(parents=True, exist_ok=True)
    if dst_dir == voice.wav_path.parent:
        return {"ok": True, "id": voice.id, "tag": tag, "moved": False}

    new_wav = dst_dir / voice.wav_path.name
    if new_wav.exists():
        raise HTTPException(status_code=409, detail=f"目标位置已有同名文件: {new_wav.name}")

    for src in (voice.wav_path, voice.txt_path, voice.json_path):
        if src.is_file():
            shutil.move(str(src), str(dst_dir / src.name))
    new_id = (f"{tag}/" if tag else "") + voice.wav_path.name
    return {"ok": True, "id": new_id, "tag": tag, "moved": True}


@app.get("/voices/{voice_id:path}/audio")
def voice_audio(voice_id: str) -> FileResponse:
    voice = find_voice(voice_id)
    return FileResponse(voice.wav_path, media_type="audio/wav")


@app.put("/voices/{voice_id:path}")
async def update_voice(voice_id: str, payload: dict) -> dict:
    voice = find_voice(voice_id)
    for key in ("name", "ref_text", "language", "default_instruction", "guidance_scale", "tag"):
        if key in payload:
            setattr(voice, key, payload[key])
    try:
        voice.guidance_scale = float(voice.guidance_scale)
    except (TypeError, ValueError):
        voice.guidance_scale = 4.0
    _save_meta(voice)
    if "ref_text" in payload:
        # 改了逐字稿就要连 .txt 一起改：读取时 .txt 优先，留着旧 txt 会让这次修改
        # 「保存成功但没生效」，而报错信息一个都不会有。
        _sync_transcript(voice)
    return {"ok": True, "voice": asdict(voice) | {"filename": voice.id, "ready": voice.ready}}


@app.delete("/voices/{voice_id:path}")
def delete_voice(voice_id: str) -> dict:
    voice = find_voice(voice_id)
    voice.wav_path.unlink(missing_ok=True)
    voice.json_path.unlink(missing_ok=True)
    # 逐字稿也要删。留着的话，之后同名重新上传（且不填逐字稿）会**静默继承**这份旧稿，
    # 克隆出来的声音和文本对不上，且看不出原因。
    voice.txt_path.unlink(missing_ok=True)
    return {"ok": True, "deleted": voice.id}


@app.post("/tts")
def tts(payload: dict) -> Response:
    """Plugin entrypoint. Returns a WAV body (same as the IndexTTS sidecar did).

    刻意用同步 def：合成走阻塞式 urlopen，若写成 async def 会把事件循环卡住
    （实测合成期间 /health 延迟 7 秒，管理页如同卡死）。同步端点由 FastAPI
    丢进线程池执行，再由 _LOCK 串行化，事件循环保持畅通。
    """
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    voice_id = payload.get("prompt_audio") or payload.get("voice") or ""
    if not voice_id:
        voices = list_voices()
        if not voices:
            raise HTTPException(status_code=400, detail="音色库为空")
        voice = voices[0]
    else:
        voice = find_voice(voice_id)

    if not voice.ready:
        raise HTTPException(
            status_code=400,
            detail=f"音色 {voice.id} 还没有逐字稿，克隆会失效。请在管理页填写。",
        )

    instruction = (payload.get("instruction") or "").strip()
    if not instruction:
        instruction = voice.default_instruction or ""
    try:
        guidance_scale = float(payload.get("guidance_scale", voice.guidance_scale))
    except (TypeError, ValueError):
        guidance_scale = voice.guidance_scale
    seed = int(payload.get("seed", 42))
    # 面板里的「模型」设置（settings.model）会随请求带过来；不传则用 sidecar 默认。
    model = (payload.get("model") or "").strip() or None

    started = time.perf_counter()
    # Serialise: Breeze handles one request at a time.
    with _LOCK:
        try:
            wav = synth_wav(voice, text, instruction, guidance_scale, seed, model)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise HTTPException(status_code=502, detail=f"Breeze 后端错误 {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"无法连接 Breeze 后端: {exc}") from exc

    elapsed = time.perf_counter() - started
    return _wav_response(wav, elapsed, voice.id, guidance_scale, seed)


@app.post("/tts_ref")
async def tts_ref(file: UploadFile = File(...),
                  text: str = Form(""),
                  ref_text: str = Form(""),
                  instruction: str = Form(""),
                  guidance_scale: float = Form(4.0),
                  seed: int = Form(42)) -> Response:
    """工作台「合成」页里临时拖进来的参考音频：只给本次合成用，不进音色库。

    与 /tts 分成两个端点，而不是给 /tts 加文件参数：/tts 是插件用的 JSON 接口，
    这里要收 multipart 文件，混在一个端点里会让插件的调用方也得跟着改。

    逐字稿同样是硬性要求 —— Breeze 靠「参考音频 + 逐字稿」对齐音素，
    缺了它克隆会失效，与其让它悄悄变差，不如当场拒绝。
    """
    text = (text or "").strip()
    ref_text = (ref_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if not ref_text:
        raise HTTPException(
            status_code=400,
            detail="缺少逐字稿。Breeze 靠「参考音频 + 逐字稿」对齐音素，"
                   "没有逐字稿的参考音频克隆会失效。",
        )

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(payload) > MAX_REF_BYTES:
        raise HTTPException(status_code=400,
                            detail=f"音频过大（{len(payload) / 1048576:.1f} MB，"
                                   f"上限 {MAX_REF_BYTES // 1048576} MB）")
    wav_bytes = normalize_reference(payload, file.filename or "")

    REFS_DIR.mkdir(parents=True, exist_ok=True)
    # 按内容哈希命名：同一段音频反复拖进来只占一份，路径也天然是 ASCII
    target = REFS_DIR / (hashlib.sha1(wav_bytes).hexdigest()[:16] + ".wav")
    if not target.is_file():
        target.write_bytes(wav_bytes)

    try:
        dbfs, _duration, _rate = probe_audio(target)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"无法解析音频: {exc}") from exc

    started = time.perf_counter()
    with _LOCK:
        try:
            wav = synth_wav_ref(target, ref_text, text, instruction, guidance_scale, seed)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise HTTPException(status_code=502, detail=f"Breeze 后端错误 {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"无法连接 Breeze 后端: {exc}") from exc

    elapsed = time.perf_counter() - started
    return _wav_response(wav, elapsed, "临时参考：" + (file.filename or target.name),
                         guidance_scale, seed, loudness_warning(dbfs))


def _wav_response(wav: bytes, elapsed: float, label: str,
                  guidance_scale: float, seed: int,
                  ref_warning: str | None = None) -> Response:
    # CORS 头由 CORSMiddleware 统一注入，这里不再重复设置以免出现重复头。
    # 注意：HTTP 头必须能按 latin-1 编码，中文音色名（如「旁白.wav」）直接塞进去会抛
    # UnicodeEncodeError -> 500。这里做 URL 编码。
    headers = {
        "X-Breeze-Voice": quote(label, safe=""),
        "X-Breeze-Guidance": str(guidance_scale),
        "X-Breeze-Seed": str(seed),
        "X-Breeze-Wall-Ms": f"{elapsed * 1000:.0f}",
    }
    # 只有临时参考那条路会带这个：音色库里的音色在管理页已经标过响度了
    if ref_warning:
        headers["X-Breeze-Ref-Warning"] = quote(ref_warning, safe="")
    return Response(content=wav, media_type="audio/wav", headers=headers)


@app.get("/", response_class=HTMLResponse)
def webui_page() -> str:
    page = HERE / "webui.html"
    if page.is_file():
        return page.read_text(encoding="utf-8")
    return _manage_page()


@app.get("/manage", response_class=HTMLResponse)
def _manage_route() -> str:
    return _manage_page()


def _manage_page() -> str:
    page = HERE / "manage.html"
    if page.is_file():
        return page.read_text(encoding="utf-8")
    return "<h1>manage.html 缺失</h1>"


def main() -> None:
    global _BACKEND, _MODEL, _origin_guard
    parser = argparse.ArgumentParser(description="Breeze TTS 2 sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7881)
    parser.add_argument("--backend", default=os.environ.get("BREEZE_BACKEND", DEFAULT_BACKEND))
    parser.add_argument("--model", default=os.environ.get("BREEZE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--data-dir", default=str(DATA_DIR),
                        help="voices/ 与 pjy/ 的父目录。默认与脚本同级；"
                             "也可用环境变量 BREEZE_DATA_DIR 指定")
    parser.add_argument("--origin-guard", choices=ORIGIN_GUARD_CHOICES,
                        default=os.environ.get("BREEZE_ORIGIN_GUARD", "mutating"),
                        help="浏览器来源校验：mutating（默认）=只挡跨站的 POST/PUT/DELETE；"
                             "all=连 GET 也挡；off=关闭。没有 Origin 头的请求始终放行")
    parser.add_argument("--allow-origin", action="append", default=[],
                        metavar="ORIGIN",
                        help="额外放行的来源，可重复。给「把酒馆放在域名后面」这类少数场景用，"
                             "例如 --allow-origin https://st.example.com")
    args = parser.parse_args()

    _BACKEND = args.backend.rstrip("/")
    _MODEL = args.model
    _origin_guard = args.origin_guard
    for o in args.allow_origin:
        _extra_origins.add(o.strip().rstrip("/"))
    ensure_tag_folders()
    print(f"tag folders: {len(VOICE_TAGS)} 个（{VOICES_DIR}）")

    print(f"code dir   : {HERE}")
    print(f"data dir   : {DATA_DIR}")
    print(f"voices dir : {VOICES_DIR}")
    print(f"scene dir  : {SCENE_AUDIO_DIR}")
    print(f"backend    : {_BACKEND}  (model={_MODEL})")
    print(f"origin guard: {_origin_guard}"
          + (f"（额外放行 {sorted(_extra_origins)}）" if _extra_origins else ""))
    print(f"manage page: http://{args.host}:{args.port}/")
    print(f"health     : {backend_health()}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
