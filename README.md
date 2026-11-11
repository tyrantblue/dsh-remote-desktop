# DSH 远程桌面（Remote Desktop）

在 DeepSeek Harness 的 Web UI 里加一个**远程桌面窗口**：左侧边栏入口 → 主面板里连接另一台主机，实时看它的屏幕、用鼠标键盘操作它、传文件、开远程命令行。

**当前重点是被控端是 Windows 10/11**：把 `agent/` 拷到 Windows、双击 `agent/windows/start-agent.bat`（自动下载便携 Node、生成密码、打印连接信息），不需要安装 RDP/VNC、不改系统设置。Linux/X11 路径保留（纯 JS X11 实现，同时作为 E2E 回归环境）。

参考了 [1Remote](https://github.com/1Remote/1Remote)（多协议远程会话管理器的产品结构）以及向日葵 / 网易 UU 远程这类软件的核心体验（一侧被控 Agent + 一侧控制端，低延迟画面 + 输入回传 + 文件/终端辅助面板）。区别在于：本项目把控制端直接做进 Harness Web UI，被控端是自研 Agent（Node 内核 + 平台采集/注入后端），不经过第三方服务器。

```
┌──────────────────────────────┐         ┌──────────────────────────────────────────┐
│ Harness Web UI（浏览器）      │         │ 被控主机                                  │
│                              │  WS     │  remote-agent.mjs（Node 内核）            │
│ 侧边栏「远程桌面」            │────────▶│   ├─ Windows: backend-win32 ──▶ helper    │
│  ├─ 主机列表 / 连接           │  HTTP   │   │      （PowerShell+C#：GDI 截屏 JPEG、│
│  ├─ 远程画面 canvas           │────────▶│   │       SendInput 鼠标键盘）           │
│  ├─ 文件传输抽屉              │         │   ├─ Linux: backend-x11（纯 JS X11）      │
│  └─ 命令终端抽屉              │         │   ├─ 文件 API（fs-root 沙箱）             │
└──────────────────────────────┘         │   └─ 远程 shell（Windows: cmd / Linux: PTY）│
                                         └──────────────────────────────────────────┘
```

## 功能

**已实现（v1，真实可用）**

- 侧边栏入口 + 主面板页面：`@local/remote-desktop` 插件（纯前端，无需 Host 服务）。
- 主机管理：名称 / 地址 / 密码，保存在浏览器 localStorage，可增删改。
- 实时屏幕：双后端统一协议——Windows 走 GDI 截屏 + JPEG 全帧（`encoding:"jpeg"`），Linux 走纯 JS X11 `GetImage` + 瓦片脏区 + zlib 压缩（`encoding:"tiles"`）；浏览器 canvas 解码绘制、信箱式自适应缩放、显示远端光标与按键状态，可调 fps / 画质。
- 鼠标键盘控制：移动 / 左中右键 / 滚轮 / 键盘（含修饰键、方向键、F1-F12、小键盘、CapsLock 等），键盘捕获模式（点击画面捕获，工具栏或画面外点击释放，失焦自动 `releaseAll` 防卡键）。
- 文件传输：远程目录浏览、下载、上传（多文件）、新建目录、重命名、删除；路径限制在 Agent 的 `--fs-root` 内。
- 远程命令行：持久 shell 会话（`script` 分配 PTY），流式输出 + 最小 VT 处理（CR/LF/退格/清屏/剥色），键盘输入 + 单行命令输入框。
- 连接管理：密码鉴权（token）、断线自动重连（指数退避）、状态/错误提示、心跳。
- **Windows 一键被控端**：双击 `agent/windows/start-agent.bat` 即可（自动下载便携 Node、生成随机密码、打印本机 IP 与连接方式）；采集注入 helper 用 Windows 自带的 PowerShell 5.1 + 内联 C#，不装 VNC/RDP、不改系统设置、不请求管理员权限。
- 零 npm 依赖：Agent 只用 Node 内置模块；Linux 端额外只用系统 X11 socket、`script`、可选 `xdotool`。
- 降级：屏幕/输入不可用时仍可只用文件与命令行。

**后续可做（本文档不承诺）**：H.264/WebRTC 低延迟编码、多显示器/多屏切换、剪贴板双向同步、音频、TLS/wss 内置、macOS 采集后端、多标签页、SSH 隧道/中继。

## 目录

```
/opt/remote
├── agent/                 被控端 Agent（拷贝到被控机即可）
│   ├── remote-agent.mjs   CLI 入口 / HTTP + WS 会话编排
│   ├── lib/               backend(+x11/win32) / capture / input / ws / http / files / shell
│   └── windows/           Windows 一键启动器 + PowerShell/C# 采集注入 helper
├── plugin/                Harness Web UI 插件 @local/remote-desktop
│   ├── client.js          侧边栏入口 + 主面板（画面/文件/终端全部 UI）
│   ├── index.js           空 Host 半（bundle 需要一个 Host 行）
│   ├── package.json       dsh.bundle / dsh.client 声明
│   └── cordis.patch.yml   Loader patch
├── test/                  Xvfb 真实端到端测试 + Windows fake-helper 协议测试
├── demo/                  真实远程画面演示（截图）与本地演示被控端沙箱
├── scripts/               本机 demo 被控端启动/停止脚本
└── docs/                  协议契约 / Windows 契约 / X11 实现笔记 / 插件实现规范
```

## 快速开始

### 1. Windows 被控机（推荐）

要求：Windows 10/11（自带 Windows PowerShell 5.1），已登录到桌面。把仓库里的 `agent/` 目录整个拷到 Windows 任意位置（例如 `D:\dsh-agent\agent`），**双击 `agent\windows\start-agent.bat`**：

1. 首次运行会自动下载便携版 Node.js 到 `agent\windows\node\`（无需安装 Node，不用管理员权限；离线时按提示手动放好 `node\node.exe`）。
2. 自动生成 `agent-password.txt` 随机密码，并打印本机 IPv4 与连接方式。
3. Windows 防火墙弹窗时选择「允许」（专用网络即可）；端口默认 38080。
4. 面板里添加主机：地址 `被控机IP:38080`，密码见 `agent-password.txt`。

> 该窗口保持打开即被控中；`Ctrl+C` 停止（也可运行 `stop-agent.bat` 兜底）。
> 必须在**已登录且未锁屏**的交互式桌面里运行：Windows 的锁屏/UAC 安全桌面无法被控制（系统安全边界，VNC/向日葵同样如此）。

### 2. Linux/X11 被控机（保留路径，也是 E2E 环境）

要求：Linux + X11 桌面（Xorg/Xvfb 均可）+ Node.js ≥ 18。把 `agent/` 目录拷到被控机：

```bash
node agent/remote-agent.mjs \
  --port 38080 \
  --password '换成一个强密码' \
  --display :0 \
  --fs-root /home/you
```

看到 `remote-agent listening on http://0.0.0.0:38080 ...` 即成功；放行 TCP 38080（或只在内网/SSH 隧道里使用，见「安全」）。

> 真实桌面需要 xauthority：一般从桌面终端启动即可自动读取 `$XAUTHORITY` / `~/.Xauthority`；服务/SSH 会话启动时需手动 `export XAUTHORITY=<桌面会话路径>`。
> 纯命令行场景可加 `--no-screen`；临时测试可加 `--insecure`（无密码，且未显式 --bind 时只监听 127.0.0.1）。

### 3. Harness 里启用插件

插件包位于 `/opt/remote/plugin`，本机已安装到当前 `web` profile（`@local/remote-desktop`，bundle 已启用）。

- 如果侧边栏还没出现「远程桌面」图标：刷新页面（Ctrl/Cmd+R）。新装的客户端插件通常会被 Harness 的 client HMR 热加载；刷新一定可以拿到最新版本。
- 换一台 Harness 部署时重新安装：
  ```
  plugin_manager action=install_bundle target=/opt/remote/plugin
  ```
  安装会写入当前 profile 的 bundle 列表并在 `application: applied` 后生效；卸载用 `plugin_manager action=remove_bundle target=@local/remote-desktop`。

### 4. 连接

1. 点击侧边栏「远程桌面」；
2. 「＋ 添加主机」→ 名称随便填，地址填 `被控机IP`（默认端口 38080）或 `被控机IP:端口`，密码填 Agent 的密码；
3. 点击主机 → 连接 → 画面出现后点击画面即可捕获键盘，鼠标/滚轮直接操作远端；
4. 工具栏「文件」打开文件抽屉，「终端」打开命令行抽屉；Windows 被控端可用「画质」下拉调节 JPEG 质量。

### 在本机快速试用（可选）

仓库自带一个只监听 loopback 的演示被控端（Xvfb :97 + xterm + bash，文件沙箱 `demo/sandbox/`）：

```bash
bash scripts/demo-serve.sh     # 输出: host 127.0.0.1:38080 / password demo-pass
bash scripts/demo-stop.sh      # 停止
```

面板里「添加主机」→ 地址 `127.0.0.1:38080`、密码 `demo-pass` 即可连接。注意它只绑定 `127.0.0.1`：只有浏览器与 Harness 在同一台机器时才连得上；真实远程主机请在被控机按上文启动 Agent（可配合 `ssh -L 38080:127.0.0.1:38080 user@host` 做隧道）。

![真实远程画面：通过 Agent 键盘注入在 xterm 中执行命令，画面为 Agent 解码后的帧](demo/live-demo.png)

## 验证

本仓库的验证全部基于真实 X 服务器与真实 Agent 进程，不使用 mock 画面：

- **E2E：27/27 通过**（`bash test/run.sh`，约 17 秒，退出码 0）：
  - 01–22 Linux/X11：HTTP 鉴权/限流/CORS/文件越界、WS 握手与 hello 顺序、屏幕 keyframe 与独立 `xwd` 逐像素比对、增量瓦片、`screen.refresh`、鼠标（xev MotionNotify/Button）、键盘（keycode 38 / Shift state 0x1 / releaseAll 防卡键）、真实字符输入到 xterm、文本注入、shell、双客户端并发、SIGINT/端口/子进程/Xvfb 清理；
  - 23–27 **Windows 后端（fake helper）**：`platform=win32` 与 `screen=800x600`（来自 helper hello）、`encoding:"jpeg"` 全帧（header 字段、无 tiles、payloadLen、FFD8…FFD9、与 fixture 字节相等、seq 递增）、mouse/wheel/key+mods/Unicode text/releaseAll **逐字段转发到 helper 日志**、helper 崩溃/坏 JSON/抓帧超时后 Agent 存活并以 `error no_screen` 上报、SIGINT 后 Agent 与 helper 零残留。
- **Windows 静态校验**（`node test/static-checks.mjs`，4 PASS / 0 FAIL / 0 SKIP）：JPEG fixture 可解码；`agent/windows/capture-input.ps1` 经 PowerShell 7.4.6 Parser 语法校验；内联 C# 经 `--dump-csharp` 导出后用 Mono `mcs` 编译通过；PS 纯 ASCII。另有 helper 自身的 JSON Lines 协议测试（mock C#）25/25，键位扫描码表覆盖 102 个必需 code 全命中。
- **真实画面演示（`bash demo/run.sh`）**：Xvfb + 真 xterm + bash + Agent，客户端经 Agent 键盘注入逐字键入命令，取 `screen.refresh` 的全量帧解码为 RGBA 后写 PNG：`demo/screenshot.png`。
- **Harness 侧**：bundle 安装 `application: applied`；客户端模块 `/plugins/??@local/remote-desktop/client.js&rev=…` 返回 200；live Client 注册表里 `sidebar.panellist` 有 `remote-desktop`（order 5），`main` 有 key `remote-desktop`（active），页面无刷新即已热加载。
- **X11 层**：`getImage` 像素与 `xwd` 一致；XTEST 注入经 `xev` 验证（按键 keycode、Shift 状态、鼠标按键）；Xauthority 的 6 种场景（正确/缺失/错误 cookie、wildcard、`~/.Xauthority`、TCP+auth）实测符合预期。
- **插件 UI**：`node --check` 通过；mock 加载器 + 假 ctx 执行 `apply` 验证注册；组件浅渲染/JPEG 解码分支/画质与重连逻辑共 54 项冒烟通过；live Client 注册表在页面热加载后含 `remote-desktop` 入口与主面板。**浏览器内真实视觉/交互、以及 Windows 真实运行（双击启动/GDI 截屏/SendInput/防火墙）无法在本环境自动验证**（见下方限制）。

## 安全建议

v1 的 Agent 使用**明文 HTTP/WS + 密码换 token**，与 VNC/RDP 未加密端口类似，请务必：

- Windows 默认监听 `0.0.0.0:38080` 是刻意为之（控制端要连入），密码 + token 是唯一防线：
  - **只用受信任内网**；在 Windows 防火墙里把 38080 的入站规则限制到你的控制端 IP；
  - 或建 SSH 隧道（`ssh -L 38080:127.0.0.1:38080 user@被控机`）并把 Agent 的 `--bind` 改为 `127.0.0.1`；
  - 或反代 TLS：用 nginx/Caddy 给 38080 加 `https://` + `wss://`，插件地址支持 `wss://`；
- 强密码 + 防火墙限制来源 IP；`--fs-root` 指向最小必要目录（Windows 默认 `%USERPROFILE%`，Linux 默认 `$HOME`）；
- Windows 密码文件 `agent-password.txt` 明文保存在 agent 目录，注意保管；helper 以启动用户权限运行、不请求 UAC 提权，因此**无法操作管理员权限窗口**（UIPI 限制）；
- 密码保存在浏览器 localStorage（本机），共用电脑请自行清理；浏览器与 Agent 之间不要跨公网直连。

## 测试与验证

```bash
# 全链路端到端（Xvfb + 真实 Agent + Windows fake-helper；27 个用例）
bash /opt/remote/test/run.sh

# Windows 静态校验（PowerShell 语法 + 内联 C# 编译 + JPEG fixture）
node /opt/remote/test/static-checks.mjs

# 真实远程画面演示：起 Xvfb + xterm + Agent，客户端键入命令后截图
bash /opt/remote/demo/run.sh     # 产出 demo/screenshot.png
```

测试使用独立 X display（:100 起，不动现有会话）、真实 `xwd` 像素做参考、真实 `xev` 校验鼠标键盘事件，不需要 root。

## 已知限制（v1）

- **Windows**：v1 只截**主显示器**（多屏切换后续）；屏幕为 JPEG 全帧，带宽/画质受「画质」与 fps 影响，适合局域网；无法控制锁屏/UAC/登录界面；无法向管理员权限窗口注入输入（UIPI）；Windows 终端是 `cmd.exe` 管道（逐行执行、无 PTY/无回显），单行命令框是主要用法。
- **Linux/X11**：纯 JS X11 路径保留；真实桌面需 Xauthority；终端为 PTY + 轻量 VT 渲染（`vim`/`top` 等全屏程序显示不完整）。
- 明文传输、无内置 TLS（见安全建议）；单 Agent 支持多客户端但输入共享同一屏幕（真实远程桌面语义）。
- 画面编码：Windows JPEG 全帧 / Linux zlib RGBA 瓦片；无 H.264/WebRTC，弱网体验有限。
- 文件传输无进度条/断点续传；剪贴板双向同步、音频、多标签未实现。
- 浏览器需支持 `createImageBitmap`、`DecompressionStream('deflate')`（Chrome/Edge 103+、Firefox 113+、Safari 16.4+）。
- 插件页面视觉细节、Windows 真实运行（双击/截屏/注入/防火墙）无法在 Linux 自动验证：只做静态校验与 fake-helper 协议测试，见交付报告验证范围。

## 与参考项目的关系

- **1Remote**：它的价值是「一个地方管理所有远程会话」——多协议（RDP/VNC/SSH/SFTP…）、连接配置、标签页、启动器。本项目借用了这种「会话管理器 + 多种辅助面板」的产品结构，但协议与实现完全自研，控制端内嵌在 Harness Web UI 中。
- **向日葵 / 网易 UU 远程**：核心是「被控端常驻 Agent + 控制端低延迟画面/输入回传 + 文件与命令辅助」。本项目实现了同样的一条最小闭环（鉴权、屏幕增量、输入注入、文件、shell），但走 Web 技术栈且只依赖 Node 内置模块，便于在 Harness 生态里二次开发。
