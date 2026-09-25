# ST-BreezeTTS-Player

A read-aloud extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern), adapted for **[Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts)**.

Character dialogue and narration are split into sentences, synthesised one by one, and played back gaplessly. **Emotion is not picked from a fixed word list** — the LLM describes in plain language how a line should be delivered, and that description is passed through verbatim as the synthesis instruction. The ceiling on expressiveness therefore goes from "a few dozen words" to "anything you can describe".

> ### About the lineage — please read
>
> This extension is **derived from [Thirteen-Moons/ST-indexTTS2-X-Player](https://github.com/Thirteen-Moons/ST-indexTTS2-X-Player) v1.2.7** (commit `aadc9ca`).
> That project in turn descends from **[kirara](https://github.com/bronie-honkai/st-indextts-player)**'s `st-indextts-player` (originally MIT),
> substantially modified by **xiaoxiongweihu** and later by **Thirteen-Moons**.
>
> This repository is the **fourth hand**: it ports the extension from the IndexTTS2 backend to Breeze TTS 2.
> The full attribution obligations are listed in [License & attribution](#license--attribution).

[中文说明 →](README.md)

---

## Features

- **Quote detection, sentence-by-sentence playback** — only dialogue and narration are synthesised; decorative prose is skipped
- **Inline playback** — click any line in the chat log to hear it, without waiting for the whole reply
- **Emotion as free-form natural language**, passed straight to Breeze as the `instruction`
- **Streaming playback** — starts synthesising while the reply is still being generated
- **Voice library with transcripts** — an uploaded reference clip must come with a transcript; the sidecar manages both and caches results
- **Automatic NPC voice assignment** — scored by a `gender-age` tag; deterministic per character name; never cached when the character has no tag
- **Scene audio** — *ambient* (loops, cross-fades when the scene changes) and *event* (plays once, layered over the ambience)
- **Configurable gaps** — separate pauses for "between sentences" and "between speakers"
- **Floating player** — independent volume control for voice and ambience
- **LAN mode** — a SillyTavern running on your phone can use the Breeze backend on your PC

## How it is put together

Three layers, communicating only over HTTP:

| Layer | What it is | Where |
| --- | --- | --- |
| **Extension** | The SillyTavern extension itself | **this repo** (root) |
| **Sidecar** | Small FastAPI service: voice library, transcripts, scene-audio hosting, `/tts` forwarding | **this repo** ([`server/`](server/)) |
| **Backend** | The Breeze TTS 2 inference server (needs several GB of VRAM) | [breezeblue-ai/breeze-tts](https://github.com/breezeblue-ai/breeze-tts) (Apache-2.0) |

**The backend is deliberately not bundled here** — it is gigabytes in size and the model carries its own licence. Get it from upstream.
The sidecar is kept deliberately thin (`fastapi / uvicorn / numpy / soundfile / python-multipart`, **no torch, no CUDA**) because it does no inference of its own.

## Installation

### Prerequisites

- A working **Breeze TTS 2 backend** listening on `127.0.0.1:7870`
- Python 3.9+ for the sidecar

### 1. Install the extension

```bash
cd <SillyTavern>/public/scripts/extensions/third-party
git clone <this-repo-url> ST-BreezeTTS-Player
```

The directory **must** be named `ST-BreezeTTS-Player`: SillyTavern discovers extensions by folder, and the extension uses that name to locate itself.
Restart SillyTavern; it should appear in the extension list as 「古木兆月:Breeze TTS Player」.

### 2. Run the sidecar

```bash
cd ST-BreezeTTS-Player/server
python -m pip install -r requirements.txt
python breeze_api.py                 # listens on 127.0.0.1:7881, forwards to 127.0.0.1:7870
python breeze_api.py --backend http://127.0.0.1:7870
```

Then open <http://127.0.0.1:7881/> and create your first voice. **A transcript is mandatory when you upload a reference clip**, and it must match the spoken words exactly — otherwise cloning quality drops noticeably.

### 3. Point the extension at the sidecar

| Setting | Value |
| --- | --- |
| TTS endpoint | `http://127.0.0.1:7881/tts` |
| Voice cloning endpoint | `http://127.0.0.1:7881/api/v1/breezetts2_cloning` |
| Voice list endpoint | `http://127.0.0.1:7881/voices` |

> Keep the `/api/v1/breezetts2_cloning` suffix in the cloning field — it is only used as a prefix
> (the code strips that segment and appends `/api/v1/upload`).

## Output format

Every spoken line goes on its own line, in this shape:

```
[Character|gender-age][emotion description][scene]“content”
```

```
[小明|男-少年][语气轻快上扬，带着藏不住的笑意，语速偏快][]“今天的天气真好呢。”
[旁白|中性-未定][平静客观的叙述语气，语速适中，吐字清晰，情绪平稳][雨声]“他走进屋子，甩了甩伞上的水。”
```

- **Character** must carry a `|gender-age` tag drawn from 11 fixed values (`男/女` × `儿童/少年/青年/中年/老年`, plus `中性-未定`). Narration is always `[旁白|中性-未定]`
- **Emotion description** — 10–30 characters describing *how* to say it (tone, mood, pace, timbre), never *what* is said. It is forwarded verbatim as the synthesis instruction
- **Scene** — one or two words. If it matches a file in your scene-audio folders the matching sound plays; otherwise use empty brackets `[]`
- **Content** — wrapped in `「」` or `“”`

The extension ships an injectable prompt describing all of this. It is **off by default**; enable it in the settings.

## Scene audio layout

Scene audio lives under `pjy/` **next to the sidecar** (both subfolders are created automatically on first run):

```
server/pjy/
├─ 环境音效/          <- ambient, looping
├─ 事件音效/          <- event, plays once
└─ (files in pjy/ itself also count as ambient)
```

Supported: `.mp3` `.wav` `.ogg` `.m4a` `.aac` `.flac`. The name the LLM writes in the brackets is the **filename without extension**.
On a name collision, `环境音效/` wins.

> **No audio files are bundled with this repository.** They are large, and some of them may not be appropriate to redistribute.
> Supply your own, or use a sound library with a clear licence.

## LAN / phone use

To let a phone-based SillyTavern use the PC's backend, expose **only the sidecar**:

```bash
python breeze_api.py --host 0.0.0.0
```

Then point the three settings on the phone at your PC's LAN address:

```
http://192.168.x.x:7881/tts
http://192.168.x.x:7881/api/v1/breezetts2_cloning
http://192.168.x.x:7881/voices
```

On Windows you also need an inbound firewall rule, scoped to your own subnet:

```
netsh advfirewall firewall add rule name="BreezeTTS2-7881-LAN" ^
    dir=in action=allow protocol=TCP localport=7881 ^
    remoteip=LocalSubnet profile=any
```

> ⚠️ **The sidecar has no authentication whatsoever.** `--host 0.0.0.0` means anyone on the same network can use your GPU
> and read your voice library and transcripts. Use it on trusted networks only, and never expose it to the internet.
>
> Likewise, **do not expose SillyTavern itself** unless you first enable `basicAuthMode`.

## Known limitations

- You must **build your own voice library**; no audio samples ship with this repo
- **Transcripts are mandatory** — Breeze is noticeably more sensitive to this than IndexTTS2
- **No emotion vectors or LoRA support** (the Breeze backend has no such concept); intensity is tuned via `guidance_scale` and the emotion text
- Scene audio must be supplied by you
- The scene names baked into the default prompt are **examples only** and will not necessarily match your own audio filenames

## Repository layout

```
ST-BreezeTTS-Player/
├─ manifest.json            SillyTavern extension manifest
├─ index.js                  extension core (parsing, playback, panels, floating player)
├─ style.css
├─ LICENSE                  AGPL-3.0 plus an additional attribution notice — do not modify
├─ server/                   the sidecar (interface layer, no inference)
└─ docs/
    ├─ IMPLEMENTATION.md     implementation notes (Chinese)
    ├─ prompt-versions/      prompt iteration history v1 → v8 (Chinese)
    └─ upstream/             original upstream documentation, kept for provenance
```

Development and acceptance-test scripts are intentionally not included — they depend heavily on the author's local paths.

## License & attribution

Released under **AGPL-3.0**. The full text is in [`LICENSE`](LICENSE), which also contains an additional attribution notice made under **AGPLv3 §7(b)**. **That notice is mandatory.**

### Chain of authorship

| Author | Contribution |
| --- | --- |
| **kirara** | Original author. [st-indextts-player](https://github.com/bronie-honkai/st-indextts-player), initially MIT |
| **xiaoxiongweihu** | Substantial subsequent modifications (2026) |
| **Thirteen-Moons** | Rebuilt it as [ST-indexTTS2-X-Player](https://github.com/Thirteen-Moons/ST-indexTTS2-X-Player) — the direct upstream of this extension |
| **古木兆月** | This repository: ported from IndexTTS2 to Breeze TTS 2 |

### Obligations under §7(b)

For every modified, distributed or deployed derivative work:

1. Full credit to **kirara** and **xiaoxiongweihu** must be retained, at minimum within the `LICENSE` file
2. Credit to **Thirteen-Moons** must be **explicit and prominent** in:
   - the `LICENSE` file
   - the project README / documentation
   - **all public community posts, release announcements and project showcase pages**

In practice: if you redistribute this extension, or post about it in your own community, **keep the credit to Thirteen-Moons**.
Keep `LICENSE` intact — do not remove the attribution section from it.

### Third-party components

The Breeze TTS 2 backend is provided by [breezeblue-ai/breeze-tts](https://github.com/breezeblue-ai/breeze-tts) under **Apache-2.0**.
This repository only calls it over HTTP and contains none of its code. The model weights carry a separate licence —
**the code licence here grants no commercial rights to the model**; check the upstream terms before commercial use.
