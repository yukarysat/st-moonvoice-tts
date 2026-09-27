# MoonVoice (ST-MoonVoice)

A read-aloud extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern), adapted for **[Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts)**.

Character dialogue and narration are split into sentences, synthesised one by one, and played back gaplessly. **Emotion is not picked from a fixed word list** — the LLM describes in plain language how a line should be delivered, and that description is passed through verbatim as the synthesis instruction. The ceiling on expressiveness therefore goes from "a few dozen words" to "anything you can describe".

> **This extension is a mouth, not a voice box.** The actual inference server lives in the companion
> **MoonVoice all-in-one package** (extract and run, no Python required, ~7.9 GB).
> Install the package plus this extension and you are making sound within minutes —
> see [Quick start](#quick-start).

> ### About the lineage — please read
>
> This extension is **derived from [Thirteen-Moons/ST-indexTTS2-X-Player](https://github.com/Thirteen-Moons/ST-indexTTS2-X-Player) v1.2.7** (commit `aadc9ca`).
> That project in turn descends from **[kirara](https://github.com/bronie-honkai/st-indextts-player)**'s `st-indextts-player` (originally MIT),
> substantially modified by **xiaoxiongweihu** and later by **Thirteen-Moons**.
>
> This repository is the **fourth hand**: it ports the extension from the IndexTTS2 backend to Breeze TTS 2.
> The full attribution obligations are listed in [License & attribution](#license--attribution).
> See [CHANGELOG.md](CHANGELOG.md) for release notes.

[中文说明 →](README.md)

---

## Contents

- [Features](#features)
- [How it is put together](#how-it-is-put-together)
- [Quick start](#quick-start)
- [Output format](#output-format)
- [Main features](#main-features)
- [Settings](#settings)
- [Scene audio layout](#scene-audio-layout)
- [LAN / phone use](#lan--phone-use)
- [FAQ](#faq)
- [Known limitations](#known-limitations)
- [Building the backend and sidecar yourself](#building-the-backend-and-sidecar-yourself)
- [Repository layout](#repository-layout)
- [License & attribution](#license--attribution)

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
- **Companion package, extract and run** — it ships sample voices and scene audio so you can hear something immediately

## How it is put together

Three layers, communicating only over HTTP:

| Layer | What it is | Where |
| --- | --- | --- |
| **Extension** | The SillyTavern extension itself | **this repo** (root) |
| **Sidecar** | Small FastAPI service: voice library, transcripts, scene-audio hosting, `/tts` forwarding | **this repo** ([`server/`](server/)); `sidecar/` in the package |
| **Backend** | The Breeze TTS 2 inference server (needs several GB of VRAM) | **the MoonVoice package** (`backend/`), or [breezeblue-ai/breeze-tts](https://github.com/breezeblue-ai/breeze-tts) |

**The backend is deliberately not bundled here** — it is gigabytes in size and the model carries its own licence. Get it from the package or from upstream.
The sidecar is kept deliberately thin (`fastapi / uvicorn / numpy / soundfile / python-multipart`, **no torch, no CUDA**) because it does no inference of its own.

## Quick start

Four steps. No command line, no Python.

### 1. Get the all-in-one package

**MoonVoice package download:** `<TBD: package download link>`

The package is a **standalone voice-generation tool** — it does not need this extension. Extract it, double-click, and you can synthesise speech in a browser. This extension merely wires that capability into SillyTavern.

After extraction you get:

| Item | Contents |
| --- | --- |
| `backend/` | Breeze TTS 2 inference runtime (GGUF), no Python needed |
| `sidecar/` | `moonvoice-sidecar.exe` — the voice-library and scene-audio interface layer |
| `data/` | Voice library and scene audio (22 sample voices, 9 sample sounds) |
| `文档/` | Manuals, NOTICE, upstream licences |
| `启动后端.cmd` | Starts the inference server (port `7870`) |
| `启动webui.cmd` | Starts the sidecar and opens the workbench (port `7881`) |
| `启动局域网服务.cmd` | Sidecar on `0.0.0.0`, for phones and tablets |
| `停止全部.cmd` | Stops everything started above |
| `放行防火墙.cmd` | Opens inbound `7881` on its own (needs admin) |

> ⚠️ **The extraction path must be pure ASCII, with no spaces.**
> The underlying runtime opens files through the system ANSI code page: a single non-ASCII
> character in the path (e.g. extracting to a folder with a Chinese name) makes the backend
> fail at startup with `failed to open GGUF file ... (No such file or directory)`.
> Extract to something like `D:\MoonVoice\`.

Then double-click:

1. `启动后端.cmd` — **the first launch takes tens of seconds** (it loads a ~7 GB model). Wait for the listening message. **Leave this window open.**
2. `启动webui.cmd` — starts the sidecar and opens the workbench at <http://127.0.0.1:7881/>. **Leave it open too.**

To check the pipeline before touching SillyTavern, pick a sample voice on the workbench's synthesis tab, type a line, and hit synthesise. If you hear something, both the backend and the sidecar are fine.

When you are done, run `停止全部.cmd` or just close the two console windows.

### 2. Install the extension

Either install it from inside SillyTavern (Extensions → Install extension → `https://github.com/yukarysat/st-moonvoice-tts` → restart), or manually:

```bash
cd <SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/yukarysat/st-moonvoice-tts.git ST-MoonVoice
```

The directory **must** be named `ST-MoonVoice`: SillyTavern discovers extensions by folder, and the extension uses that name to locate itself.
Restart SillyTavern; it should appear in the extension list as 「古木兆月:月声-TTS」.

### 3. Prepare a voice

Open the workbench's **voice library** tab. The package already ships 22 sample voices you can use as-is. To build your own, upload a reference clip (**5–15 s, clean single speaker, no background music**) and **type in a transcript that matches the spoken words exactly**.

> **The transcript is mandatory, not optional.** Breeze's zero-shot cloning aligns phonemes with it.
> Typos, missing words, or a lazy "whatever, some speech" all degrade similarity noticeably — this is
> the single most common beginner mistake.

On the **synthesis** tab you can audition a voice and tweak parameters, and save a result you like back into the library. The **voice design** tab creates a voice from a text description instead of a reference clip.

### 4. Point the extension at the sidecar

| Setting | Value |
| --- | --- |
| TTS endpoint | `http://127.0.0.1:7881/tts` |
| Voice cloning endpoint | `http://127.0.0.1:7881/api/v1/breezetts2_cloning` |
| Voice list endpoint | `http://127.0.0.1:7881/voices` |

> Keep the `/api/v1/breezetts2_cloning` suffix in the cloning field — it is only used as a prefix
> (the code strips that segment and appends `/api/v1/upload`). The full form is the least error-prone.

Replace `127.0.0.1` with your PC's LAN address to use it from a phone — see [LAN / phone use](#lan--phone-use).

You should be able to hear speech now: send a message in chat and click the read-aloud bar. If nothing happens, check the [FAQ](#faq).

### 5. Make the model emit the right format (optional, strongly recommended)

The extension recognises *who is speaking, how, and where* through a fixed text format:

```
[Character|gender-age][emotion description][scene]“content”
```

Your **main model** has to produce that format. The "prompt injection" toggle (default **on**) injects a prompt containing the full spec and examples at a configurable depth, so a fresh install produces the right format out of the box.

The prompt is stored as **two separate pieces** on purpose:

| | Maintained by | On update |
| --- | --- | --- |
| **Body** (format spec, emotion rules, examples) | the extension | refreshed to the latest default on every load; turn "follow plugin updates" off to own it yourself |
| **Available-sound list** | **you** | **never overwritten** — add or remove sounds by editing just this field |

> It also works with injection off, but then you are responsible for teaching the model the format.
> Otherwise lines go unrecognised, which shows up as "only a few scattered sentences got read".

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
- **Scene** — one or two words. If it matches an available sound the matching audio plays; otherwise use empty brackets `[]`
- **Content** — wrapped in `「」` or `“”`

The extension ships an injectable prompt describing all of this. It is **on by default**.
Its scene list is **aligned one-to-one with the nine sounds shipped in the package**, so scene audio works out of the box. To add or remove sounds afterwards, edit the **Available-sound list** field (Prompt management tab) — that field is **yours and is never overwritten** by an update (see [Scene audio layout](#scene-audio-layout)).

## Main features

### Sentence-by-sentence playback and gaps

Body text is split on punctuation and only dialogue and narration are synthesised. Two sentences are separated by 0.25 s by default, and **a change of speaker adds another 0.35 s** — the same character continuing only needs a breath, but a speaker change at that length smears together. Both are configurable.

### Streaming playback

Instead of waiting for the whole reply, synthesis and playback start once a configurable number of sentences have accumulated. Good for long replies.

### Inline playback

Dialogue gets a clickable read-aloud bar right in the chat log, per line.

### Automatic NPC voice assignment

When the LLM invents a walk-on character with no voice bound:

- the pool contains **only tagged voices** (untagged ones at the root are left for you to assign manually)
- scoring: gender match +2 / partial +1 / mismatch −1; age exact +2 / adjacent +1 / ≥2 apart −1
- ties are broken deterministically by hashing the character name, so a character always gets the same voice
- a character **with no tag** gets a temporary pick that is **not written to the cache**

### Scene audio

Two kinds, distinguished by which folder the file sits in:

| Kind | Folder | Behaviour |
| --- | --- | --- |
| Ambient | `<data dir>/pjy/环境音效/`, plus `pjy/` itself | **Loops**; keeps playing while the scene name is unchanged; cross-fades when it changes |
| Event | `<data dir>/pjy/事件音效/` | Plays **once**, layered over the ambience without interrupting it |

Writing `[]` or omitting the third bracket stops the current ambience.

### Floating player

A playback bar independent of the chat log, with separate volume for voice and ambience.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| TTS endpoint | `http://127.0.0.1:7881/tts` | Sidecar synthesis entry point |
| Voice cloning endpoint | `.../api/v1/breezetts2_cloning` | Used as a prefix only |
| Voice list endpoint | `http://127.0.0.1:7881/voices` | Voice library listing |
| Model name | `breeze-tts-2` | Passed through to the backend |
| Default voice | empty | Empty means the first voice in the library; prefer setting it in the dubbing panel |
| Parsing mode | `gal` | `gal` / `audiobook` / `rp` sentence-splitting strategies |
| Inline playback | on | Click-to-read in the chat log |
| Auto inference | on | Synthesise every new reply automatically |
| Auto play | off | Play as soon as synthesis finishes |
| Streaming | on | Synthesise while generating |
| Streaming threshold | 1 | Sentences to accumulate before starting |
| Sentence gap | 0.25 s | `segmentGap` |
| Speaker-change gap | 0.35 s | `speakerChangeGap` |
| Speed / volume | 1.0 | |
| Auto NPC voices | on | |
| NPC voice pool | empty | Empty = every voice in the library with a transcript |
| Ambience volume | 0.4 | |
| Ambience fade duration | 0 | 0 means cut instantly |
| Event volume | 0.6 | Independent of ambience |
| Floating player | on | |
| Prompt injection | on | Injects the format spec at the configured depth. Stored as two pieces: the **body** follows plugin updates, the **available-sound list** is always yours |
| Follow prompt updates | on | Turn it off and the body is yours too (the panel says whether the body is read-only or editable) |
| Regex filter | off | Turning it on **replaces the built-in filtering** (audiobook mode hard-filters markdown and similar decoration) with your own regex |

## Scene audio layout

Scene audio lives under `pjy/` inside the **data directory**:

| How you started it | Data directory |
| --- | --- |
| Package (`启动webui.cmd`) | `<package>\data\` |
| Sidecar from source | the sidecar's own directory (`server/`), or wherever `--data-dir` points |

Both subfolders are created automatically on first run:

```
<data dir>/pjy/
├─ 环境音效/          <- ambient, looping
├─ 事件音效/          <- event, plays once
└─ (files in pjy/ itself also count as ambient)
```

Supported: `.mp3` `.wav` `.ogg` `.m4a` `.aac` `.flac`. The name the LLM writes in the brackets is the **filename without extension**.
On a name collision, `环境音效/` wins.

> **The package ships nine scene sounds**, ready to use. On disk they sit in two folders, but in the
> prompt they are written into a **single list** — the extension resolves the name to a file, and
> whether it loops or fires once is decided by the folder that file is in:
>
> ```
> 环境音效/ (loops): 乡村_傍晚  森林  森林_清晨  森林_起风
>                   沙滩_海浪  瀑布  雨声  雨声_室内
> 事件音效/ (once):  房间_开门
> ```
>
> To use your own, drop the files into those two folders and change the names in the
> **Available-sound list** field (Prompt management tab) to the matching **filenames without
> extension**. The extension does not validate names — a typo is silently silent, not an error.
>
> That field is **permanently yours**: the extension only *hints* when a name shipped in the
> package is missing from your list, and never overwrites or deletes what you wrote.
>
> **No audio files are bundled with this repository.** They are large, and some of them may not be
> appropriate to redistribute. Supply your own, or use a sound library with a clear licence.
> The nine in the package come from SONNISS's free GameAudioGDC bundle, whose licence permits
> redistribution inside a product.

## LAN / phone use

To let a phone-based SillyTavern use the PC's backend, expose **only the sidecar**; neither the backend nor SillyTavern itself needs to change.

- **Package users**: double-click `启动局域网服务.cmd` — it prints your LAN IP and the workbench URL
- **From source**: `python breeze_api.py --host 0.0.0.0`

Then point the three settings on the phone at your PC's LAN address:

```
http://192.168.x.x:7881/tts
http://192.168.x.x:7881/api/v1/breezetts2_cloning
http://192.168.x.x:7881/voices
```

On Windows you also need an inbound rule for `7881`; the package's `放行防火墙.cmd` does this (accept the UAC prompt). Manually, scoped to your own subnet:

```
netsh advfirewall firewall add rule name="MoonVoice-7881-LAN" ^
    dir=in action=allow protocol=TCP localport=7881 ^
    remoteip=LocalSubnet profile=any
```

> ⚠️ **The sidecar has no authentication whatsoever.** `--host 0.0.0.0` means anyone on the same network can use your GPU
> and read your voice library and transcripts. Use it on trusted networks only, and never expose it to the internet.
>
> Likewise, **do not expose SillyTavern itself** unless you first enable `basicAuthMode`.

## FAQ

**The workbench will not open / the console window flashes and vanishes**
Check, in order:

1. **A non-ASCII character or a space in the extraction path** — by far the most common cause, see [step 1](#1-get-the-all-in-one-package)
2. **Port in use**: the backend wants `7870`, the sidecar `7881`. Run `停止全部.cmd` and retry
3. Read the last few lines in the backend window. `failed to open GGUF file` means cause 1

**The first launch sits there for a long time**
It is loading the model. Tens of seconds the first time, faster afterwards. Do not close the window.

**Nothing plays, or the browser console reports a connection failure**
The sidecar or backend is not up. Try `curl http://127.0.0.1:7881/health`, then confirm `7870` responds; if both are fine, go back to [Quick start](#quick-start).

**It works in the workbench but not in SillyTavern**
The three endpoints are wrong, or the sidecar was started after the page loaded (the extension does not reconnect) — reload SillyTavern.

**Nothing works on the phone, but the phone's browser can open the workbench**
You are almost certainly using a **third-party Android app** (a Tauri-based SillyTavern build). Such apps
block cleartext HTTP, so the requests the extension sends to the sidecar are stopped inside the app and the
sidecar never even logs them — it is not a configuration problem. **Open SillyTavern in the phone's browser
instead**; third-party apps are not recommended.

**Synthesis is slow**
The backend takes tens of seconds to load the model (the first request is slow), after which one sentence costs roughly as long as the audio itself. Insufficient VRAM degrades it badly — check the backend log for OOM.

**The cloned voice does not sound like the reference**
Check the transcript first: it must match the spoken words **exactly**, filler words included. Also, reference clips containing shouting noticeably drag the whole result down.

**A line was not read aloud**
It probably was not recognised as dialogue. Check it against the [output format](#output-format) — especially the two brackets at the start of the line. If the custom regex filter is on, check that it is not eating the line.

**The ambience will not stop**
Write `[]` (empty brackets) as the scene name. Note that the scene name must match **exactly** for playback to continue: `雨声` → `雨声_室内` restarts.

**Scene audio makes no sound at all**
The model's scene name does not match your filenames. Look at what is actually in `pjy/` and fix the prompt's list to match (filenames without extension). A wrong name is silent, not an error.

**The NPC voices sound off**
Are the library tags accurate? Scoring depends entirely on the `gender-age` tag. Also, characters you assigned manually in the dubbing panel are never overridden.

## Known limitations

- **Third-party Android apps are not recommended** (Tauri-based SillyTavern builds): they block cleartext HTTP, so the extension's `http://` requests are stopped inside the app and the sidecar never even logs them. **Use the phone's browser to open SillyTavern**
- **The backend must be obtained separately** — use the MoonVoice package, or deploy Breeze TTS 2 yourself
- **The extraction path must be pure ASCII** (a package-side constraint, see [step 1](#1-get-the-all-in-one-package))
- **Transcripts are mandatory** — Breeze is noticeably more sensitive to this than IndexTTS2
- **No emotion vectors or LoRA support** (the Breeze backend has no such concept); intensity is tuned via `guidance_scale` and the emotion text
- The sample voices and scene sounds exist to **prove the pipeline works**; build your own for real use
- The prompt's scene list is a hard-coded string — the extension never reads `pjy/` to generate it, so new audio has to be added there by hand

## Building the backend and sidecar yourself

If you would rather not use the package (you already run Breeze somewhere, or you want Linux), the extension is happy with any Breeze-compatible HTTP service on `7870`, and the sidecar runs fine from source.

### Backend

Get it from [breezeblue-ai/breeze-tts](https://github.com/breezeblue-ai/breeze-tts) — either `audiocpp/` (GGUF, recommended) or the PyTorch build — listening on `127.0.0.1:7870`. The model weights carry a separate licence.

### Sidecar

```bash
cd ST-MoonVoice/server
python -m pip install -r requirements.txt
python breeze_api.py
```

Python 3.9+. Listens on `127.0.0.1:7881` and forwards to `127.0.0.1:7870`:

```bash
python breeze_api.py --backend http://127.0.0.1:7870   # backend elsewhere
python breeze_api.py --host 0.0.0.0                    # expose to the LAN
python breeze_api.py --data-dir /path/to/my-data       # voice library and scene audio elsewhere
```

> `sidecar/moonvoice-sidecar.exe` in the package is this same service frozen with PyInstaller (onefile).
> It accepts the same `--host` / `--backend` / `--data-dir` flags; it just does not need Python installed.

## Repository layout

```
ST-MoonVoice/
├─ manifest.json            SillyTavern extension manifest
├─ index.js                  extension core (parsing, playback, panels, floating player)
├─ style.css
├─ LICENSE                  AGPL-3.0 plus an additional attribution notice — do not modify
├─ server/                   the sidecar (interface layer, no inference)
│   ├─ breeze_api.py
│   ├─ manage.html           voice library management page
│   ├─ webui.html            workbench
│   ├─ requirements.txt
│   ├─ build-exe.cmd         builds moonvoice-sidecar.exe
│   └─ README.md             sidecar details
├─ package/                  all-in-one package build scripts and in-package docs
│   ├─ build-package.py      assembles the package, transcodes audio, writes the zip
│   ├─ make-launchers.py     generates the double-click launchers
│   ├─ launchers/            launcher sources (.cmd / .ps1)
│   ├─ readme.txt            plain-text readme shipped in the package
│   └─ docs/                 in-package manual and NOTICE
└─ docs/
    ├─ IMPLEMENTATION.md     implementation notes (Chinese; includes upstream repo, version and commit)
    └─ prompt-versions/      prompt iteration history v1 → v9 (Chinese)
```

The assembled package itself (`package/MoonVoice/`, ~7.9 GB) is **not committed** — `package/build-package.py` builds it locally.
Development and acceptance-test scripts are intentionally not included either: they depend heavily on the author's local paths.

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

Third-party components and audio licensing inside the package are documented separately in `package/docs/NOTICE`.
