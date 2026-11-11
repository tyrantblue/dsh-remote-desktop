# Windows 被控端（v1）契约与部署说明

目标：在 Windows 10/11 上双击 `windows/start-agent.bat` 即可被 Harness 的「远程桌面」面板控制（屏幕、鼠标键盘、文件、命令），
不要求安装 Node、VNC、RDP，也不改系统设置。实现只新增两块：

1. `agent/windows/capture-input.ps1`：PowerShell 5.1 脚本，运行时用 `Add-Type` 编译一小段内联 C#，负责 GDI 截屏（JPEG）与 SendInput 注入；通过 **JSON Lines over stdio** 与 Node Agent 通信。
2. `agent/lib/backend-win32.mjs`：Node 侧平台后端，管理 helper 子进程、按需请求帧、转发输入事件。
3. `agent/windows/start-agent.bat`：启动器（自动下载便携版 Node → 生成/读取密码 → 启动 Agent → 打印连接信息）。

Linux/X11 路径保持现状（`backend-x11.mjs`），E2E 回归必须继续 22/22 通过。

## 1. 后端接口（Node 侧）

`agent/lib/backend.mjs`：

```js
export async function createBackend(options) -> Backend

// options: { display, noScreen, noInput, env, platform? }
//   - platform 默认 process.platform；测试可用 options.platform='win32' + options.helperCommand
//   - helperCommand: 可选，覆盖 Windows helper 启动命令（数组），来自 env RDA_HELPER_CMD（测试用）

Backend = {
  platform: 'linux' | 'win32',
  capabilities: { screen, input, text, shell, files }, // backend 只决定 screen/input/text，shell/files 由主程序按平台给出
  info: { screen: { width, height, depth? } | null, display?: string, helper?: object },
  async grab({ quality = 65 }) -> Frame,        // 仅 screen=true 时调用；单飞：调用方不会并发 grab
  handleInput(message) -> { ok: boolean, error?: string },
  // message 即 PROTOCOL.md §3.1 的 mouse/wheel/key/text/releaseAll（backend 只实现这 5 类）
  async close() -> void,
}

Frame =
  { encoding: 'tiles', width, height, cursor: { x, y, buttons },
    tiles: [{ x, y, w, h, data: Buffer /* RGBA, w*h*4 */ }], changed }
| { encoding: 'jpeg', width, height, cursor: { x, y, buttons },
    data: Buffer /* 完整 JPEG */, changed: true }
```

- `backend-x11.mjs` 包现有 `X11Display + ScreenCapture + InputController`，行为与现在完全一致（tiles、cursor.buttons = X11 mask，按键错误码 `unsupported_key`）。
- `backend-win32.mjs` 用 helper 拿 JPEG 全帧；`cursor.buttons` 用位掩码 1=左 2=右 4=中（仅用于客户端显示按下态，取值语义在客户端不参与逻辑）。
- `backend-null/降级`：无屏幕时 `capabilities.screen=false`，`grab` 抛错，主程序不启动屏幕循环。

`agent/remote-agent.mjs` 改造点：
- 不再直接 import X11 模块；`const backend = await createBackend({display, noScreen, noInput, env: process.env})`。
- `welcome.screen` 取 `backend.info.screen`，`capabilities.screen/input/text` 取 backend。
- 屏幕循环：`const frame = await backend.grab({quality: currentQuality})`；瓦片帧按现有逻辑（无变化瓦片且 cursor 未变则不发；cursor 变则只发 cursor 帧）；JPEG 帧每次都发。
- 帧头新增 `encoding` 字段：`{"t":"frame", seq, width, height, keyframe, cursor, encoding:"tiles"|"jpeg", tiles?, payloadLen}`；省略 `encoding` 视为 `tiles`（向后兼容）。JPEG 帧无 `tiles`，payload 为整段 JPEG。
- `screen.start` 的 `quality`（30..90，默认 65）记录到当前会话，传给 grab；`fps` 逻辑不变。
- 输入：`mouse/wheel/key/text/releaseAll` → `backend.handleInput(msg)`；`unsupported_key` 可回 `error`，其余失败忽略（不中断会话）。
- 退出/断连：`await backend.close()`，Windows 需确保 helper 子进程被 kill、无残留。

## 2. Windows helper 进程契约（JSON Lines）

Node 启动：

```
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <pkg>/windows/capture-input.ps1
```
（测试时用 `RDA_HELPER_CMD` 指向任意可执行文件/命令，例如 `node /opt/remote/test/fixtures/fake-win-helper.mjs`。）

- stdin：每行一个 JSON 请求（UTF-8，不换行）；stdout：每行一个 JSON 响应；stderr：日志（Node 收集最后若干行用于报错，不当作协议）。
- 每个请求带 `id`（整数，可省略；省略表示不要求响应）；响应必须原样带回 `id`。协议为严格单飞：Node 收到上一响应后才发下一请求（capture/info 有响应；输入命令可无 id，不等响应）。
- 启动时 helper 主动输出一行 hello（`id` 不存在）：
  `{"ok":true,"hello":{"helper":"1.0.0","width":W,"height":H,"screens":N,"format":"jpeg","dpi":D}}`
- `{"id":1,"cmd":"info"}` → `{"id":1,"ok":true,"width":W,"height":H,"screens":N,"cursor":{"x":X,"y":Y},"buttons":M}`
- `{"id":2,"cmd":"capture","quality":65}` → `{"id":2,"ok":true,"width":W,"height":H,"format":"jpeg","data":"<base64>","cursor":{"x":X,"y":Y},"buttons":M,"encodeMs":N}`
  - 只截主显示器；`data` 为 JPEG（可被浏览器 `createImageBitmap` 解码）。
  - 单帧 base64 上限约定 8MB（超了降质量重试一次）。
- `{"cmd":"mouse","action":"move|down|up","x":X,"y":Y,"button":0|1|2}`（无 id，无响应）
- `{"cmd":"wheel","dx":D,"dy":D}`（无 id）
- `{"cmd":"key","code":"KeyA","key":"a","down":true,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false}}`（无 id）
  - `code` 为浏览器 `KeyboardEvent.code`；helper 用**物理扫描码**（KEYEVENTF_SCANCODE）注入，布局无关；扩展键（方向键/Delete/Home 等）带 extended 标志。
- `{"cmd":"text","text":"任意 Unicode"}`（无 id）：用 `KEYEVENTF_UNICODE` 逐字符注入（中文/emoji 可用）。
- `{"cmd":"releaseAll"}`（无 id）：释放所有按下的键/鼠标键，防卡键。
- `{"cmd":"shutdown"}` → `{"ok":true}` 然后退出；收到 stdin EOF 也要退出。
- 错误：`{"id":..,"ok":false,"error":"<code>","message":"..."}`；单条命令失败不能让 helper 退出。
- 日志/诊断：helper 自检命令 `{"id":9,"cmd":"selftest"}` → `{"id":9,"ok":true,"tests":[...]}`（可选，便于用户排障）。

### C#（内联，Add-Type）要求

- 目标 API 面：.NET Framework 4.5 / Windows PowerShell 5.1（`Add-Type -TypeDefinition` 默认引用 System、System.Drawing、System.Windows.Forms；如需引用要在 `-ReferencedAssemblies` 明确写出）。
- 截屏：`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`（失败回退 `SetProcessDPIAware`）；主屏尺寸用 `GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)`；GDI `GetDC(NULL)` / `CreateCompatibleDC` / `CreateCompatibleBitmap` / `BitBlt(SRCCOPY)`，再 `GetDIBits` 取 32bpp 像素，用 `System.Drawing.Bitmap` 包装后 `Save(stream, ImageFormat.Jpeg)` 并按 `EncoderParameters` 设质量；全程 finally 释放 DC/Bitmap。
  或用 `Graphics.CopyFromScreen`（更短，确认 .NET Framework 可用即可）。优先简单可靠。
- 输入：`SendInput` + `INPUT`/`MOUSEINPUT`/`KEYBOARDINPUT`；鼠标绝对坐标用 `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK`，按 **虚拟桌面** 尺寸与主屏偏移归一化（截屏是主屏，但注入要能落到主屏像素坐标；主屏为 0,0 时可简化，仍建议用 `SM_XVIRTUALSCREEN` 等做通用实现）。
- 扫描码映射：`code → (scanCode, extended)` 需要在 C# 或 PS 里维护完整表（`KeyA..KeyZ`、`Digit0..9`、F1..F12、方向、Insert/Delete/Home/End/PageUp/PageDown、Shift/Ctrl/Alt/Win 左右、CapsLock、Tab、Enter、Backspace、Escape、Space、标点 `Minus/Equal/BracketLeft/.../Slash/Backquote`、小键盘 `Numpad0..9/NumpadAdd/...`、PrintScreen/ScrollLock/Pause）。无映射的 code 返回 `unsupported_key`（无响应即可，Node 侧不阻塞）。
- 线程模型：PowerShell 单线程同步循环即可；每条请求处理完立即输出响应并 `Flush`。
- 性能目标（1080p，局域网）：capture 单帧 p50 ≤ 60ms，编码质量 65 时 JPEG ≤ 400KB；输入注入单事件 ≤ 5ms。helper 循环不能有明显 sleep。

## 3. 客户端（plugin/client.js）改造

- 帧解析：`header.encoding === 'jpeg'` 时，payload 为整帧 JPEG：`createImageBitmap(new Blob([payload],{type:'image/jpeg'}))` → `ctx.drawImage(bitmap,0,0,canvas.width,canvas.height)`（canvas 尺寸 = header.width/height）；`createImageBitmap` 不存在时用 `Image` + `URL.createObjectURL` 回退。JPEG 帧总是全帧，`keyframe` 视为 true。
- 瓦片帧逻辑不变（`encoding` 缺省按 tiles 处理）。
- `screen.start` 增加 `quality`（30/50/65/80 下拉，默认 65），随 `fps` 一起发送；工具栏加「画质」选择（仅对 JPEG 生效，UI 提示）。
- 状态栏显示 `welcome.agent.platform`（linux/win32）与当前编码（瓦片/JPEG）。
- 其余（输入、文件、终端、重连）不变；Windows 路径显示（`C:\`）在文件抽屉里正常渲染即可。

## 4. 启动器 `agent/windows/start-agent.bat`

要求（可被用户双击，控制台窗口保持打开）：

1. `cd /d "%~dp0"`。
2. 找 Node：先 `where node`，再用同目录 `node\node.exe`（便携版）；都没有则用 PowerShell 从 `https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip` 下载并解压到 `node\`（`Expand-Archive`），失败给出可复制的下载地址。
3. 密码：`agent-password.txt` 不存在则生成 16 位随机密码写入；启动参数 `--password-file "%~dp0agent-password.txt"`。
4. 启动：`"%NODE%" "%~dp0..\remote-agent.mjs" --port 38080 --bind 0.0.0.0 --fs-root "%USERPROFILE%"`。
5. 启动前打印本机 IPv4（`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual).IPAddress"`）和连接说明（面板添加 `IP:38080` + 密码）。
6. 首次运行 Windows 防火墙会弹窗，提示用户选择「允许」（并说明专用网络即可）。
7. 编码：bat 内只用 ASCII 输出（避免 cmd 代码页乱码）；中文文档放 `agent/windows/README.zh.md`。
8. 提供 `agent/windows/stop-agent.bat`（`taskkill /F /IM node.exe` 太粗暴，改为用 `wmic`/PowerShell 按命令行匹配 remote-agent.mjs 结束，或提示 Ctrl+C）。简单方案：提示用户在控制台按 Ctrl+C；另加可选 `stop-agent.bat` 用 PowerShell 找带 `remote-agent.mjs` 的 node 进程结束。
9. `agent/windows/README.zh.md`：双击步骤、防火墙、需要**已登录的交互式桌面会话**（锁屏/UAC/登录界面无法控制，这是 Windows 会话隔离限制）、单显示器 v1、画质/性能、安全建议（只在内网/SSH 隧道使用、限制来源 IP、密码文件保管、用完 Ctrl+C）、卸载（删除文件夹）。

## 5. 验收

Linux 上可自动验证的（必须做）：
- E2E 回归 22/22（X11 backend 不回归）。
- 用 **fake helper**（Node 脚本，遵循 §2 协议，输出一张真实可解码的 JPEG 或至少合法 JPEG 字节）在 Linux 上跑通 `backend-win32`：hello/info/capture、输入命令转发、releaseAll、helper 崩溃/超时错误处理、shutdown/close 无残留进程。
- Agent 在 `RDA_HELPER_CMD` 下以 win32 后端启动：`/api/info` capabilities、WS welcome 的 screen/agent.platform、`screen.start` 收到 `encoding:"jpeg"` 帧（header 与 payload 正确）、`screen.stop`。
- `node --check` 所有新增 JS；PowerShell 脚本用 `pwsh` 解析器做语法校验；内联 C# 用 Mono `mcs`（或 .NET SDK）做编译校验（GDI/USER32 P/Invoke 在 Linux 只编译不运行）。
- `start-agent.bat` 无法在 Linux 执行：只做静态检查（ASCII、URL、参数、路径引用存在）。

Windows 上需人工验证的（如实说明，不假装已验证）：
- 双击启动、Node 便携下载、防火墙放行、面板连上看画面、鼠标键盘、文件上传下载、命令输出、锁屏/UAC 限制。

## 6. 安全

- 默认 `--bind 0.0.0.0` 是有意为之（控制端需要连入），密码 + token 是唯一防线；README 必须提示：仅内网使用、Windows 防火墙限制来源 IP、或使用 SSH 隧道/TLS 反代（面板支持 `wss://` 地址）。
- helper 以启动用户的权限运行（非 SYSTEM），不请求 UAC 提权；因此**无法**与管理员窗口交互（UIPI 限制），这是 v1 已知行为。
- 密码文件明文保存在 agent 目录，提示用户保管。
