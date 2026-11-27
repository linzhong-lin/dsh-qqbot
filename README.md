# dsh-qqbot

DeepSeek Harness（DSH）的 **QQ 频道**插件：把 QQ 私聊/群聊接进 DSH，一个 QQ 会话对应一个 DSH agent 会话——人格、长期记忆、上下文压缩、工具全部照旧，只是把"嘴"换成了 QQ。

底层走 [OpenQQ](https://github.com/feijx3/OpenQQ)（OneBot v11 正向 WebSocket），不 hook QQ 客户端二进制，装完 QQ 照常用。

- 版本：0.13.0
- 依赖：DSH ≥ 0.2.1-rc.2、Node ≥ 22、OpenQQ（本机常驻）
- 协议：MIT

---

## 一、能做什么

### 聊天

| 能力 | 说明 |
| --- | --- |
| 私聊 / 群聊 | 群里默认要 @ 才应；私聊默认只认主人（`owner.qq`），也支持白名单/全开 |
| 收图片 | 对方发来的图片会被下载、识别格式，作为真正的图片块喂给模型（能"看见"）；动图取首帧 |
| 发图片 | `qq_send_image`（本地路径或 http(s)） |
| 发语音 | `qq_send_voice`：Windows SAPI 或 **克隆声线**（IndexTTS），带时长/字数/语速/语调四个可调项 |
| 发表情包 | `qq_send_meme`：自己准备一套 PNG，按 `key` 发，每日额度服务端硬限 |
| QQ 表情 | 正文里的 `[face:178]` 会变成真表情；可整体禁用 |
| 戳一戳 | `qq_poke` / 收到戳一戳 |
| 主动搭话 | 定时掷骰子：多数回合只发一句话，偶尔配表情或语音，避开免打扰时段、有每日上限 |
| 回复节奏 | 先攒 `batchWindowSec` 秒合并连发消息，再随机延迟 `minDelaySec~maxDelaySec` 才回；一条连续消息、不换行 |

### 记忆力

- **当天流水**：`~/.dsh/qqbot/days/YYYY-MM-DD.md`，进出消息都记。
- **每日日记**：到点（默认 23:30）让模型按人设写一篇，写到 `~/.dsh/qqbot/diary/`；写不出来会重试一次，被内容审查打断会打码敏感词再试。
- **记忆检索**：`qq_recall(keyword)` 扫日记 + 最近 N 天流水；每天第一条消息自动带上"上一篇日记 + 命中片段"。
- **压缩可回溯**：被上下文压缩折掉的原文，可用 `search_context` / `decompress` 找回来。

### 自救与扩展

| 工具 | 用途 |
| --- | --- |
| `qq_plugin_install(spec)` | 装插件：npm 包名、GitHub 链接、本地路径都行，装完自动启用 |
| `qq_plugin_list()` / `qq_plugin_set(name, enabled)` | 看已装插件、开关 |
| `qq_shell(command)` | 跑 PowerShell 命令（有超时与输出截断） |
| `qq_read_file(path)` / `qq_write_file(path, content)` | 读日志、改配置；写前自动备份 `.bak-<时间戳>` |

内容审查（`CONTENT_REFUSED`）不再卡死：被拒一次会自动重建一个干净会话，并把刚才那句原话重发过去。

### 面板

首页左侧边栏「QQ 频道」 → 五个分区：

- **概览**：连接状态、快捷动作（测试消息 / 表情 / 戳一戳 / 主动一次）、上下文洞察（窗口占用条 + 构成 + 请求柱状图）、最近对话
- **对话**：聊天对象、主动搭话、回复节奏（含单条字数上限与句数上限）、群聊、QQ 专属人设补充
- **声音与表情**：语音引擎与音色（可试听）、时长/字数上限、**语速**与**语调**滑杆、表情包目录与额度、识图开关
- **记忆**：读今天的日记、日记时间、回忆天数、日记文风
- **安装与调试**：上面四个工具的总开关、命令超时、输出上限、插件列表

有改动未保存的卡片会亮「未保存」，保存/发送都有底部状态条与时间戳。

---

## 二、安装

### 1. 准备 OpenQQ

```powershell
# 下载 release（Windows x64 免编译）
# https://github.com/feijx3/OpenQQ/releases
```

`config/openqq.json`（必须 UTF-8 **无 BOM**）：

```json
{
  "version": 1,
  "qqRoot": "C:\\Program Files\\Tencent\\QQNT",
  "webPort": 17860,
  "accessToken": "随便一串只有你知道的",
  "ws": { "enabled": true, "host": "127.0.0.1", "port": 3001 },
  "reverseWs": [],
  "http": { "enabled": false, "host": "127.0.0.1", "port": 5700 },
  "httpPost": []
}
```

`node src/main.mjs start` 起来后，打开日志里的 WebUI 地址扫码登录 QQ，看到 `✔ QQ 会话就绪` 即可。

### 2. 装插件

```powershell
# 从本地目录
dsh plugin --profile desktop add "dsh-qqbot@file:D:/DSH/plugins/dsh-qqbot"

# 或从 GitHub
dsh plugin --profile desktop add "dsh-qqbot@https://github.com/<你>/dsh-qqbot/tarball/main"
```

装完重启 DSH，侧边栏出现「QQ 频道」。

### 3. 填配置

首次加载会生成 `~/.dsh/qqbot.json`，最少改三个值：

```json
{
  "ws": { "url": "ws://127.0.0.1:3001", "accessToken": "和 openqq.json 里一致" },
  "selfId": "机器人 QQ 号",
  "owner": { "qq": "你的 QQ 号", "name": "主人" }
}
```

`owner.qq` 留空时所有私聊都放行（方便先聊上，日志里能看到对方号），建议随后填上。

也可以完全不手动改：打开面板「对话 → 聊天对象」直接填，保存即写回文件。

---

## 三、可选能力

### 克隆声线（IndexTTS）

默认用 Windows SAPI（装了中文语音包即可用）。想要"像某个人的声音"：

1. 准备 10 秒左右干净人声，放 `D:\DSH\voice\ref\ref.wav`
2. 准备 `say.py` 包装脚本：`python say.py --text "..." --out out.wav --ref ref.wav`
3. 面板「声音与表情 → 语音」把引擎切到 `clone`，填 Python / say.py / 参考音频三个路径

`voice.speed`（0.6~1.6）与 `voice.pitchSemitones`（-6~+6）通过 ffmpeg 后处理实现（变调用 `asetrate` + `atempo` 抵消时长变化）。找不到 ffmpeg 时会跳过并原样发送。

### 表情包

把 PNG/JPG 丢进一个目录（默认 `C:\Users\<你>\Desktop\meme`），文件名就是 `key`。给每个 key 在 `MEME_HINTS` 里写一句含义，模型才知道什么时候用。

出于 QQ 协议限制，出站图片必须是 `base64://` 或 http(s)，插件内部会转。

### 上下文洞察

面板里的"窗口占用"是插件自己读会话事件算的：`request/context` 取窗口大小，`assistant/message.data.usage` 累加用量，`request/header` 里的工具定义按字符估 token。不需要装 `dsh-context`。

---

## 四、配置项（`~/.dsh/qqbot.json`）

```jsonc
{
  "enabled": true,
  "ws": { "url": "ws://127.0.0.1:3001", "accessToken": "" },
  "selfId": "",
  "owner": { "qq": "", "name": "主人" },
  "allowPrivate": [],            // 额外的私聊白名单
  "allowGroups": [],             // 允许的群；空 = 全部
  "groupRequireMention": true,
  "workspace": "C:\\Users\\<你>\\.dsh\\qqbot-workspace",

  "send": {
    "maxChars": 1200,            // 单条硬上限
    "replyMaxChars": 90,         // 闲聊默认字数上限（说"详细讲"时放宽 3 倍）
    "maxSentences": 3,
    "forbidFaces": ["179"],      // 额外禁用的表情 id
    "facesEnabled": false        // false = 一个 QQ 表情都不发
  },

  "reply": { "minDelaySec": 3, "maxDelaySec": 12, "batchWindowSec": 8 },

  "voice": {
    "enabled": true,
    "engine": "clone",           // clone | sapi
    "voiceName": "Microsoft Huihui Desktop",
    "rate": 0,
    "maxChars": 60,              // 一段最多几个字
    "maxSeconds": 12,            // 最长几秒（超了先压短重合成，再超就硬裁）
    "speed": 1,                  // 0.6 ~ 1.6
    "pitchSemitones": 0,         // -6 ~ +6
    "clonePython": "D:\\DSH\\voice\\venv\\Scripts\\python.exe",
    "cloneScript": "D:/DSH/voice/say.py",
    "cloneRef": "D:/DSH/voice/ref/ref.wav",
    "ffmpeg": ""                 // 留空自动找
  },

  "image": { "enabled": true, "maxCount": 4, "maxBytes": 8388608 },

  "meme": { "enabled": true, "dir": "C:\\Users\\<你>\\Desktop\\meme", "dailyLimit": 10, "maxBytes": 8388608 },

  "memory": {
    "enabled": true,
    "recallDays": 30,
    "diaryHour": 23,
    "diaryMinute": 30,
    "maxSnippetChars": 600,
    "diaryStyle": "按她现在的人设写：冷一点、糙一点、话短，不煽情，不总结，不解释。"
  },

  "proactive": {
    "enabled": true,
    "everyMinutes": 60,
    "chance": 0.3,
    "minIdleMinutes": 20,
    "quietHours": ["00:30", "08:00"],
    "maxPerDay": 8,
    "testOnStart": false
  },

  "debug": { "enabled": true, "shellTimeoutMs": 120000, "maxOutputChars": 4000, "allowWrite": true }
}
```

文件必须 **UTF-8 无 BOM**（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，用 `[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false)))`）。

---

## 五、人格从哪来

本插件不定义人格。人格由 `dsh-soul-md` 的人设卡（设置 → 人设卡）提供，`qq_send_*` 之外的语气规则写在卡片里就行。插件额外支持 `personaNote`：只对 QQ 频道生效的补充设定。

---

## 六、常见问题

**面板显示"面板接口不可用：Failed to fetch"**
桌面端页面源是 `dsh-app://app/`，插件会自动回退到 `${GUI 地址}/qqbot-api/*`。若仍失败，确认发图/发消息能通（说明宿主正常），然后 `Ctrl+R` 重载窗口。

**她只发文字，不发表情/语音**
检查 `send.facesEnabled`（false 时表情一律不发）和 `voice.enabled`；再看日志里有没有 `已发表情` / `语音后处理完成`。

**`tool "xxx" returned invalid output: userRender is not a function`**
DSH 的 `defineTool` 要求 `output: { schema, render }`，只写 `schema` 会在渲染工具结果时抛错。本插件 0.5.2 起所有工具都带 `render`。

**插件定义了带 `required: false` 的参数后宿主直接崩**
DSH 0.2.2 的 schema 编译器只接受"省略 required"或 `required: true`。写 `false` 会 `fatal load failure`。

**内容审查一直拒**
`CONTENT_REFUSED` 是服务端拦的，本地没法关。插件会自动重建干净会话并重放这句话；同时提示词里让它少堆脏字。

---

## 七、日志与数据

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/qqbot/qqbot.log` | 连接、收发摘要、投掷结果、错误 |
| `~/.dsh/qqbot.json` | 配置 |
| `~/.dsh/qqbot/chats.json` | chatId → sessionId，重启续接同一段对话 |
| `~/.dsh/qqbot/days/*.md` | 每日流水 |
| `~/.dsh/qqbot/diary/*.md` | 每日日记 |
| `~/.dsh/qqbot-workspace/` | QQ 会话的工作目录 |

---

## License

MIT
