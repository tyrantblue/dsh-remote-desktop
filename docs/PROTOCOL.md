# 远程桌面协议 v1（Agent ⇄ 浏览器客户端契约）

本文档是 `agent/` 与 `plugin/` 两个实现之间的**唯一契约**。任何一侧改动消息字段，必须同时更新本文档与对端实现。

- Agent：零 npm 依赖的 Node.js 程序，运行在**被控主机**上。
- Client：Harness Web UI 里的插件页面（浏览器），通过 WebSocket + HTTP 直连 Agent。
- 传输：明文 `ws://` / `http://`（生产环境建议用 TLS 反向代理包一层，见 README 安全章节）。

```
浏览器 (Harness UI 插件页) ──WS /ws?token=…──▶ Agent :38080
        │  HTTP /api/*（Bearer token）
        └─▶ Agent :38080
Agent ──X11 协议──▶ 本机 X 服务器（Xorg/Xvfb）：截屏 + XTEST 注入输入
Agent ──spawn────▶ shell 进程（PTY）
Agent ──fs────────▶ 本机文件系统（受 fs-root 限制）
```

## 1. 术语与端口

| 项 | 值 |
|---|---|
| 默认监听 | `0.0.0.0:38080` |
| WS 路径 | `/ws` |
| HTTP API 前缀 | `/api` |
| 鉴权方式 | `POST /api/auth` 换取不透明 token，HTTP 用 `Authorization: Bearer <token>`，WS 用 `?token=<token>` |
| token 有效期 | 12h（可配置），内存态，重启 Agent 后失效 |
| 协议版本 | `1`（`welcome.protocol`） |

## 2. HTTP API

所有 JSON 请求/响应均为 UTF-8。除 `/health`、`/api/auth`、`/` 外都需要鉴权。全部响应带 CORS 头，允许任意 Origin（`Access-Control-Allow-Origin: *`），允许 `Authorization, Content-Type` 头，允许 `GET,POST,PUT,OPTIONS`，`OPTIONS` 预检返回 204。

### POST /api/auth

请求：`{"password":"..."}`；成功 `200 {"token":"...","expiresAt":<unix ms>,"agent":{"version":"1.0.0","name":"<hostname>"}}`
失败：`401 {"error":"invalid_password"}`；连续失败限流 `429 {"error":"rate_limited","retryAfterMs":n}`（每 IP 每分钟最多 5 次失败）。

### GET /api/info（鉴权）

```json
{"agent":{"name":"host","version":"1.0.0","platform":"linux"},
 "screen":{"width":1280,"height":800,"depth":24},
 "capabilities":{"screen":true,"input":true,"shell":true,"files":true,"text":false},
 "fsRoot":"/root","protocol":1}
```

### 文件接口（均鉴权，`path` 为绝对路径或 `~` 开头的路径）

- `GET /api/fs/list?path=/root` → `{"path":"/root","parent":"/","entries":[{"name":"a.txt","type":"file","size":12,"mtimeMs":1690000000000}]}`
  - `type` ∈ `file | dir | symlink | other`；条目按目录在前、名称升序。
- `GET /api/fs/download?path=/root/a.txt` → 原始字节流，`Content-Type: application/octet-stream`，`Content-Length` 已知时给出，`Content-Disposition: attachment; filename*=UTF-8''...`。
- `PUT /api/fs/upload?path=/root/new.bin` → 请求体为原始字节（`application/octet-stream`），成功 `{"path":"...","size":n}`。父目录必须存在。
- `POST /api/fs/mkdir` `{"path":"/root/newdir"}` → `{"path":"..."}`。
- `POST /api/fs/rename` `{"from":"/a","to":"/b"}` → `{"from":"/a","to":"/b"}`。
- `POST /api/fs/remove` `{"path":"/root/a.txt","recursive":false}` → `{"removed":"..."}`；非空目录必须 `recursive:true`。
- 错误统一：`4xx {"error":"<code>","message":"..."}`，code ∈ `no_token | bad_token | not_found | is_directory | not_directory | exists | permission_denied | outside_root | invalid_request | too_large | server_error`。
- 路径安全：解析后必须位于 `fs-root` 之内（符号链接按真实路径校验），否则 `403 outside_root`。

### GET /health（免鉴权）

`{"ok":true,"protocol":1}`

## 3. WebSocket 传输

- 握手：标准 RFC6455，`GET /ws?token=<token>`。token 无效 → HTTP 401 拒绝升级。
- 心跳：客户端每 15s 发 `{"t":"ping","id":<n>}`，Agent 回 `{"t":"pong","id":<n>}`；30s 无任何帧则 Agent 关闭连接。Agent 也可发 `{"t":"ping"}`，客户端回 `{"t":"pong"}`。
- 帧：
  - 文本帧 = UTF-8 JSON 控制消息（仅控制，不带大块数据）。
  - 二进制帧 = 屏幕帧 / shell 输出。格式：`uint32le headerLen` + `headerLen` 字节 UTF-8 JSON + 剩余为 payload 字节。
- 单连接即一个远程会话：一条 WS 上最多一个屏幕订阅 + 一个 shell 会话。
- Agent 重启/断网：客户端负责重连（重新 auth、重新 `hello`、`screen.start`、恢复 shell 需用户重新开）。

### 3.1 客户端 → Agent 控制消息

```jsonc
{"t":"hello","client":"remote-desktop-web","version":1}          // 必须第一条；Agent 回 welcome
{"t":"screen.start","fps":15,"tile":64,"quality":65}             // 订阅屏幕；Agent 先发 keyframe；quality 30..90（默认 65，仅 JPEG 后端生效）
{"t":"screen.stop"}
{"t":"screen.refresh"}                                           // 请求一次完整 keyframe
{"t":"mouse","action":"move|down|up","x":640.0,"y":400.0,"button":0} // button 0=左 1=中 2=右（down/up 时有效）
{"t":"wheel","dx":0,"dy":120}                                    // 像素；正值向下/向右，Agent 折算成滚轮点击
{"t":"key","code":"KeyA","key":"a","down":true,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false}}
{"t":"releaseAll"}                                               // 释放所有按下的键/修饰键
{"t":"text","text":"你好"}                                       // 文本注入（走 xdotool，若不可用仅 ASCII）
{"t":"shell.start","cols":120,"rows":32,"cwd":"/root"}
{"t":"shell.input","data":"ls -la\r"}                            // 字符串；控制字符原样发送
{"t":"shell.stop"}
{"t":"ping","id":1}
{"t":"pong"}
```

`key.code` 使用浏览器 `KeyboardEvent.code`（`KeyA`、`Digit1`、`Minus`、`ShiftLeft`、`ArrowUp`、`F5`、`CapsLock` …）。`mods` 是该次按键发生时浏览器给出的修饰键状态，Agent 用它保证修饰键状态正确（防止事件丢失导致 Shift 卡住）。`key` 仅作为 `code` 缺失时的兜底。

### 3.2 Agent → 客户端控制消息

```jsonc
{"t":"welcome","protocol":1,"session":"<随机 id>",
 "agent":{"name":"host","version":"1.0.0","platform":"linux"},
 "screen":{"width":1280,"height":800,"depth":24},
 "capabilities":{"screen":true,"input":true,"shell":true,"files":true,"text":false},
 "fsRoot":"/root"}
{"t":"screen.started","fps":15,"tile":64,"width":1280,"height":800}
{"t":"screen.stopped"}
{"t":"error","code":"no_screen|no_shell|bad_request|internal","message":"..."}
{"t":"pong","id":1}
{"t":"ping"}
{"t":"shell.started","cols":120,"rows":32}
{"t":"shell.exit","code":0}
```

### 3.3 屏幕帧（二进制）

header JSON（两种编码，`encoding` 缺省视为 `tiles`）：

```json
{"t":"frame","seq":42,"width":1280,"height":800,"keyframe":false,"encoding":"tiles",
 "cursor":{"x":640,"y":400,"buttons":0},
 "tiles":[{"x":0,"y":0,"w":64,"h":64,"off":0,"len":512}],
 "payloadLen":512}
```

```json
{"t":"frame","seq":43,"width":1920,"height":1080,"keyframe":true,"encoding":"jpeg",
 "cursor":{"x":640,"y":400,"buttons":0},"payloadLen":183456}
```

- `encoding:"tiles"`（Linux/X11 后端）：`payload` = 所有瓦片按 `tiles` 顺序拼接；每块是 `zlib deflate`（RFC1950，浏览器 `DecompressionStream('deflate')` 可解）压缩的 RGBA 像素：`w*h*4` 字节，行优先，每像素 R,G,B,A。
- `encoding:"jpeg"`（Windows 后端）：`payload` 是一整帧 JPEG 字节（`FFD8…FFD9`），无 `tiles`，客户端用 `createImageBitmap` 解码后整帧绘制；此类帧总是全帧（`keyframe` 视为 true），`quality` 由 `screen.start` 指定。
- 瓦片网格：Agent 把屏幕切成 `tile x tile` 的网格（最后一列/行可小于 tile）；只有内容变化的瓦片才发送（与上一帧比较）。`keyframe:true` 时发送全部瓦片。客户端以 `seq` 单调递增判断丢帧，直接在当前画布上覆盖绘制即可（瓦片互不重叠）。
- `cursor`：X 指针位置（屏幕像素，整数）与按下的按钮掩码（X11 mask：1=左 2=中 4=右…）。客户端自行绘制光标。
- 背压：Agent 在 `ws.bufferedAmount > 4MB` 时跳过本帧（不发送），下一帧仍在最新状态上做差。客户端无需处理"缺帧"。
- 单帧 payload 上限 12MB；超过则降级为 raw? 不允许，Agent 必须始终 deflate 并限制像素规模。

### 3.4 shell 输出（二进制）

header：`{"t":"shell.data","stream":"stdout"|"stderr"}`，payload 为原始字节（通常 UTF-8 文本，含 ANSI 转义）。客户端用流式 `TextDecoder` 解码。

## 4. 输入语义

- 坐标空间：`x/y` 为远程屏幕像素（0..width-1 / 0..height-1），客户端负责按画布缩放反算，Agent 负责取整并 clamp。
- `mouse`：`move` 只移动；`down/up` 使用 `button` 映射 0/1/2 → X11 button 1/2/3。按下前若指针不在目标坐标，Agent 先移动到该坐标。
- `wheel`：`dy>0` 向下 ⇒ 重复 X11 button 5 press+release；`dy<0` ⇒ button 4；`dx` ⇒ button 7（右）/6（左）。每次消息最多折算 10 次点击。
- `key`：Agent 维护 `pressedKeys`/`pressedMods` 集合，重复的 down/up 被忽略（幂等）。按下非修饰键前，根据 `mods` 补按缺失的修饰键；收到 `releaseAll`、连接关闭、或某次按键 up 后 `mods` 全为 false 且无按键按下时，释放所有修饰键，避免卡键。
- 修饰键映射：ShiftLeft/Right→`Shift_L`(0xffe1)，ControlLeft/Right→`Control_L`(0xffe3)，AltLeft/Right→`Alt_L`(0xffe9)，MetaLeft/Right→`Super_L`(0xffeb)。
- `text`：优先调用系统 `xdotool type --clearmodifiers --delay 0 -- <text>`；没有 xdotool 时仅注入 ASCII（按 keysym 表，自动处理 Shift）。
- 键盘布局：Agent 启动时用 X11 `GetKeyboardMapping` 建立 keysym→keycode 表；找不到的 keysym 返回 `error code=unsupported_key`（忽略该按键，不中断会话）。

## 5. 屏幕采集要求（Linux/X11）

- 纯 JS 实现 X11 协议客户端（unix socket `/tmp/.X11-unix/X<n>`），**不得依赖 npm 包**；外部命令可用于测试/兜底但核心路径必须自包含。
- Agent 从 `DISPLAY` 或 `--display` 解析显示号与 socket 路径。
- 采集：`GetImage`（ZPixmap）读根窗口整屏 → 转 RGBA（按 visual 的 red/green/blue mask 位移，处理 24/32bpp，Xvfb 典型为 32bpp little-endian）。
  - 行字节数按 pixmap format 的 `scanline_pad`（通常 32）对齐，且按**请求宽度**计算（不是屏幕全宽）。
- 鉴权：连接 X server 时支持 Xauthority / MIT-MAGIC-COOKIE-1（`$XAUTHORITY` → `~/.Xauthority`），真实 Xorg 桌面必须；无 cookie 时回退空 auth（Xvfb、`-ac` 等）。实现细节见 `docs/X11-NOTES.md`。
- 指针：`QueryPointer` 每帧读取根坐标与按钮掩码。
- 输入：XTest 扩展（`QueryExtension("XTEST")` + `FakeInput`），wire 格式见 `docs/X11-NOTES.md`。
- 无 X / 无 XTEST：按能力位上报 `capabilities.screen=false` / `input=false`，其他功能（shell/files）照常。
- **Windows 后端**：不使用 X11；由 `agent/windows/capture-input.ps1`（PowerShell 5.1 + 内联 C#）提供 GDI 截屏（JPEG，主显示器）与 SendInput 注入（物理扫描码 + Unicode），Node 侧 `agent/lib/backend-win32.mjs` 以 JSON Lines 契约驱动它，详见 `docs/WINDOWS.md`。客户端通过 `encoding:"jpeg"` 兼容。

## 6. Agent CLI

```
node agent/remote-agent.mjs [选项]
  --port <n>            默认 38080
  --bind <addr>         默认 0.0.0.0
  --password <p>        访问密码；或 REMOTE_AGENT_PASSWORD；或 --password-file <path>
  --display <:n>        默认 $DISPLAY 或 :0
  --fs-root <dir>       文件接口根目录，默认 $HOME
  --no-screen           禁用屏幕采集
  --no-shell            禁用命令行
  --no-files            禁用文件接口
  --read-only-fs        文件接口只读
  --token-ttl-hours <n> 默认 12
  --insecure            无密码模式（仅测试用；未显式 --bind 时强制 127.0.0.1）
  --quiet
```

启动后打印：`remote-agent listening on http://<bind>:<port>  ws://<host>:<port>/ws`，并打印屏幕尺寸、fsRoot、能力。收到 SIGINT/SIGTERM 时关闭所有连接与子进程后退出。

- X11 鉴权：自动读取 `$XAUTHORITY` / `~/.Xauthority` 的 MIT-MAGIC-COOKIE-1；真实桌面会话需在启动 Agent 的环境里带上正确的 `XAUTHORITY`（例如从桌面终端启动，或 `export XAUTHORITY=/run/user/1000/gdm/Xauthority`）。
- 屏幕不可用（无 DISPLAY、鉴权失败）时只降级 `capabilities.screen=false`，shell/files 仍可用。

## 7. 会话生命周期与错误处理

1. 浏览器 `POST /api/auth` 拿 token → 打开 `ws://host:port/ws?token=…`。
2. 连上后立即发 `hello`；未 hello 前的其他消息返回 `error bad_request`。
3. `screen.start` 后 Agent 启动 15fps 循环（fps 可调 1..30；实际由 Agent 节流）。
4. 客户端关闭或断线：Agent 清理订阅、shell 进程、按键状态（releaseAll），不得泄漏。
5. 同一 Agent 可同时服务多个客户端（各自独立屏幕帧序列；输入共享同一屏幕，符合真实远程桌面语义）。
6. 所有错误消息都可被客户端展示；Agent 不崩溃、不断开（除鉴权失败）。

## 8. 验收（端到端）

- 鉴权：错误密码 401 + 限流；正确密码拿到 token；无 token 的 HTTP/WS 被拒。
- 屏幕：1280x800 根窗口，测试窗口填纯色后，客户端收到的帧解码后该像素颜色正确；窗口改色后增量帧只含变化瓦片。
- 鼠标：`mouse move` 后 `QueryPointer`/测试窗口收到 MotionNotify；`down/up` 后测试窗口收到 ButtonPress/ButtonRelease，detail 正确。
- 键盘：`key down/up`（如 `KeyA`、`ShiftLeft`）后测试窗口收到 KeyPress/KeyRelease，keycode 正确。
- 命令行：`shell.start` + `shell.input "echo hello"` 输出包含 `hello`；`shell.stop` 后进程退出。
- 文件：upload → list → download 内容一致；mkdir/rename/remove 生效；越界路径被拒。
