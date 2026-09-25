# server/ —— 月声 侧车（接口层）

侧车是一个很小的 FastAPI 服务，**不做语音推理**。它负责：

| 能力 | 路由 |
|---|---|
| 音色库（wav + json 元数据、按标签分文件夹、逐字稿） | `GET /voices`、`/voices/{id}/audio`、`/api/v1/upload`、`/voices/{id}/move` |
| 转发合成请求给 Breeze 后端（串行化，单并发） | `POST /tts` |
| 场景音效清单与静态托管 | `GET /api/v1/scene_audios`、`/pjy/...` |
| 标签统计、声音设计 | `GET /api/v1/tags`、`POST /design` |
| 管理页 / 工作台 | `GET /`、`GET /manage` |

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
