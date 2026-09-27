# server/ —— 月声 侧车（接口层）

侧车是一个很小的 FastAPI 服务，**不做语音推理**。它负责：

| 能力 | 路由 |
|---|---|
| 音色库（wav + json 元数据、按标签分文件夹、逐字稿） | `GET /voices`、`/voices/{id}/audio`、`/api/v1/upload`、`/voices/{id}/move` |
| 转发合成请求给 Breeze 后端（串行化，单并发） | `POST /tts`（JSON，音色库音色）、`POST /tts_ref`（multipart，临时参考音频） |
| 场景音效清单与静态托管 | `GET /api/v1/scene_audios`、`/pjy/...` |
| 标签统计、声音设计 | `GET /api/v1/tags`、`POST /design` |
| 管理页 / 工作台 | `GET /`、`GET /manage` |

### 两条合成路径

| | `POST /tts` | `POST /tts_ref` |
|---|---|---|
| 收什么 | JSON | multipart（`file` + 其余字段） |
| 参考音频 | 音色库里的音色 id | 请求里带上来的那一段 |
| 谁在用 | SillyTavern 插件 | 工作台「合成」页的拖拽区 |
| 落盘 | 不动 | 转成 WAV 后按内容哈希存进 `<数据目录>/refs/`，不进音色库、不出现在 `/voices` |

两条都要求逐字稿（`ref_text` / 音色的 `.txt`）：Breeze 靠「参考音频 + 逐字稿」对齐音素，
缺了它克隆会失效，所以缺逐字稿一律 400 拒绝，而不是让它悄悄变差。
`refs/` 整个目录随时可以删，不影响音色库与场景音效。

> 上传的参考音频（两条路径都是）会先用 libsndfile 统一转成 16bit PCM WAV 再落盘。
> 旧行为是把上传内容原样写进 `<名字>.wav` —— 传 mp3 时会得到一个名字像 WAV、
> 内容却是 mp3 的文件，克隆当场失败而报错完全看不出原因。


## 跑起来

```bash
python -m pip install -r requirements.txt
python breeze_api.py                     # 默认 127.0.0.1:7881，后端指向 127.0.0.1:7870
python breeze_api.py --backend http://127.0.0.1:7870
python breeze_api.py --host 0.0.0.0      # 让手机等局域网设备也能访问
```

后端地址也可以走环境变量 `BREEZE_BACKEND` / `BREEZE_MODEL`。

## 数据目录

侧车把「代码」和「数据」分得很清楚：

| 概念 | 变量 | 在哪 |
| --- | --- | --- |
| 代码目录 | `HERE` | `breeze_api.py` 所在目录（`webui.html` / `manage.html` 也在这里找） |
| 数据目录 | `DATA_DIR` | `voices/` 与 `pjy/` 的父目录，**默认等于代码目录** |

不给参数时数据目录就是脚本旁边，和旧版本行为完全一致：

```
server/
├─ breeze_api.py
├─ voices/                    <- 运行时自动创建；<音色id>.wav + <音色id>.json
│   ├─ 男-青年/  ...          <- 按标签分的子文件夹
│   └─ <根目录留给主角音色>
└─ pjy/                       <- 运行时自动创建；场景音效
    ├─ 环境音效/              <- 循环播放，切换场景时交叉淡入淡出
    └─ 事件音效/              <- 只响一次，叠在环境音之上
```

两个子目录都会自动创建，不需要手动建。

### 逐字稿存在哪：`<音色id>.txt` 与 `<音色id>.json`

一个音色的逐字稿有**两套**存储，读取时 **`.txt` 优先于 JSON**：

- `<名字>.txt` —— 纯文本，方便批量放文件：把音频和同名 txt 一起丢进 `voices/`
  就成了，不必手写 JSON
- `<名字>.json` —— 其余元数据（名称、标签、guidance_scale 等）也在这里

两条路都写同一个字段，所以它们必须保持一致：`.txt` 优先，意味着库里若留着一个旧的
`.txt`，通过接口改的逐字稿会被它盖回去 —— 界面上看就是「保存成功但没生效」，而且
一个报错都不会有。侧车因此在**动过 `ref_text` 的路径**上把两者一起更新：

- 上传（`POST /api/v1/upload`）与保存进音色库：两套一起写
- 编辑逐字稿（`PUT /voices/{id}` 带 `ref_text`）：两套一起改；传空字符串会把 `.txt`
  一起删掉（否则「清空逐字稿」同样无效）
- 删除音色（`DELETE /voices/{id}`）：wav、json、**txt 三个一起删**。留着孤儿 `.txt`
  的话，之后同名重新上传（且不填逐字稿）会静默继承这份旧稿，克隆用错文本还查不出原因
- 换标签（`POST /voices/{id}/move`）：三个文件一起搬

只改名字之类的请求不会碰 `.txt`，手工放的 txt 不会被凭空删掉或复制。

解析音色 id 时**只认 `.wav`**：`/voices/<名字>.txt/audio` 这类请求会 404，
不会把同目录的 txt / json 当成音色吐出来。

### 把数据放到别处：`--data-dir`

想升级代码又不愿意挪动几百 MB 的音色库和场景音效时用它：

```bash
python breeze_api.py --data-dir /path/to/my-data
BREEZE_DATA_DIR=/path/to/my-data python breeze_api.py     # 也可以用环境变量
```

代码留在仓库里（始终只有一份），数据留在原地。别人部署时则不需要这个参数。

### 打包进整合包

月声整合包里的 `sidecar/moonvoice-sidecar.exe` 就是这个服务的 PyInstaller onefile 打包版，
由 [`build-exe.cmd`](build-exe.cmd) 生成（会顺带把 `webui.html` / `manage.html` 收进去）：

```
MoonVoice/
├─ backend/       Breeze TTS 2 推理运行时（GGUF）
├─ sidecar/       moonvoice-sidecar.exe
├─ data/          <- 数据目录（启动器用 --data-dir 显式指到这里）
│   ├─ voices/    音色库
│   └─ pjy/       场景音效
└─ 启动webui.cmd  启动器
```

**为什么启动器要显式传 `--data-dir`**：打包后数据目录默认是 exe 所在目录，也就是
`sidecar/`，而包内约定数据放在同级 `data/`。启动器里那一行是：

```bat
start "" /min /d "%SIDECAR%" "%SIDECAR_EXE%" %HOSTARG% --data-dir "%DATA%"
```

这样「代码」和「数据」在整合包里也是分开的，重装侧车不会动到音色库。

对比一下：上游 `api.py` 有 `project_root/indextts`、`project_root/checkpoints` 这类硬依赖，
**必须**待在整合包内部；本侧车没有这种依赖，放哪都能跑。

## 安全提醒

侧车**没有任何鉴权**。`--host 0.0.0.0` 会让同局域网内的任何人都能用你的 GPU 合成语音，
并读取音色库与逐字稿。只在可信网络里这样用，且用防火墙把来源限制在同一网段。

### 浏览器来源校验（`--origin-guard`）

「没鉴权」之外还有个更近的口子：侧车的 CORS 是放开的（`allow_origins=["*"]`，
否则不同源的酒馆页面调不动它）。两者叠在一起，意味着**你在浏览器里访问的任意一个网页**
都能跨站调用侧车的改写类接口 —— 实测带 `Origin: https://evil.example` 发
`DELETE /voices/{id}` 真的会删掉音色库里的文件，上传接口的预检同样放行。
所以侧车带了一道默认开启的来源闸：

| 值 | 行为 |
|---|---|
| `mutating`（默认） | 只拦跨站的 `POST` / `PUT` / `PATCH` / `DELETE`，`GET` 放行 |
| `all` | 连 `GET` 也拦 —— 跨站页面连音色清单都读不到 |
| `off` | 关闭本机制 |

判定规则：

- **没有 `Origin` 头的一律放行** —— curl、脚本、服务端调用，以及 `<audio src>` 这类
  非 CORS 请求都不带这个头，挡了会把正常用法一起挡掉
- 带头的必须是本机（`localhost` / `127.0.0.1` / `::1`）或私有网段
  （`10./172.16-31./192.168./169.254.`，以及 Tailscale 用的 `100.64.0.0/10`）
- 其余一律 `403`，包括 `Origin: null`（`file://` 页面与沙箱 iframe）

插件跑在酒馆页面上，来源正好就是这些本机 / 局域网地址，所以**正常使用不受影响**。
只有把酒馆放在域名后面（反向代理、内网域名）时才需要显式放行，可重复传多次：

```
python breeze_api.py --allow-origin https://st.example.com
```

被拦时侧车窗口会打印一行 `[origin] 已拒绝 ...`，响应体也说明了原因。
也可以用环境变量：`BREEZE_ORIGIN_GUARD=off`。

这道闸**不改变**「服务本身没有鉴权」这件事：同网段的人直接用 curl 依然能调
（你本来就把服务开给了整个网段）。它专门针对「浏览器里的第三方页面」。
