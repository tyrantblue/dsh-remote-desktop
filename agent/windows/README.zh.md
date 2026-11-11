# Windows 被控端使用说明（v1）

本目录是「DSH 远程桌面」的 **Windows 被控端**：在 Windows 10/11 上双击
`start-agent-gui.bat`（原生图形界面，推荐）或 `start-agent.bat`（命令行），即可被
Harness 侧边栏的「远程桌面」面板控制（画面、鼠标键盘、文件、命令）。不需要安装
VNC / RDP / 任何 npm 依赖，也不修改系统设置。

目录内容：

| 文件 | 作用 |
|---|---|
| `capture-input.ps1` | 采集与注入 helper：GDI 截屏（JPEG）+ SendInput 注入，JSON Lines over stdio |
| `start-agent-gui.bat` + `gui.ps1` | **图形界面（推荐）**：中继地址/接入码/密码/端口、启动停止、状态与实时日志 |
| `start-agent.bat` | 命令行启动器：找/下载 Node → 生成密码 → 打印 IP → 启动 Node Agent |
| `relay.txt` | 可选（用户创建 / GUI 保存）：跨 NAT 中继的 Harness 地址，见 §9 |
| `relay-code.txt` | 中继持久化接入码（Agent/GUI 自动读写，重启不变），见 §9.2 |
| `stop-agent.bat` | 兜底停止（正常方式是 Ctrl+C） |
| `README.zh.md` | 本文档 |
| `agent-password.txt` | 首次启动自动生成的访问密码（明文，运行时生成） |
| `node\` | 便携版 Node.js（首次启动自动下载，运行时生成） |

架构：`start-agent-gui.bat`（或 `start-agent.bat`）启动 `..\remote-agent.mjs`
（Node Agent，提供 WebSocket / HTTP / 文件 / 命令），Node 再按需拉起
`capture-input.ps1`（提供截图与键鼠注入）。GUI 只是 Node Agent 的原生“遥控器”，
与命令行启动的是同一个 Agent。
helper 通过 stdin/stdout 的 JSON Lines 与 Node 对话，契约见 `docs/WINDOWS.md` §2。

如果被控机和 Harness **不在同一局域网**（家用宽带没有公网 IP），不需要端口映射：
把 Harness 地址写进 `agent\windows\relay.txt`，Agent 会主动出站连接 Harness 的中继，
面板用「中继 + 接入码」连接，详见 §9。

---

## 1. 系统要求

- Windows 10 / Windows 11（x64 已按目标设计；32 位未验证）。
- **必须已登录的交互式桌面会话**（见 §5.1，这是最重要的限制）。
- 不需要管理员权限；建议用普通用户账户运行（helper 以当前用户权限运行）。
- 图形界面（`start-agent-gui.bat`）需要 Windows PowerShell 5.1 与 .NET Framework 4.5
  （Windows 10/11 自带），同样不需要管理员权限。
- 端口 `38080`（TCP，局域网可达；跨 NAT 时无需开放任何端口，走中继，见 §9）。
- 首次运行需要联网下载便携版 Node.js（约 30 MB）；之后可离线使用（见 §8.1）。

## 2. 快速开始（3 步）

1. 把整个项目目录（至少 `agent\` 及其 `windows\` 子目录）复制到这台 Windows PC，
   路径尽量不含特殊字符，例如 `D:\dsh-remote\agent\windows\`。
2. 启动被控端（两种方式，推荐 GUI）：
   - **图形界面（推荐）**：双击 `agent\windows\start-agent-gui.bat`，在窗口里点
     `Start agent`（界面说明见 §3）。如果还没有 `node\` 便携运行时，先双击一次
     `start-agent.bat` 让它下载 Node。
   - **命令行**：双击 `agent\windows\start-agent.bat`。首次运行会自动下载便携版
     Node.js 到 `node\`（约 30 MB，仅一次）、生成 16 位随机密码文件
     `agent-password.txt`、打印本机 IPv4 与连接说明，并启动 Node Agent（监听
     `0.0.0.0:38080`）。
3. 在 Harness Web UI 打开「远程桌面」面板 → 添加主机 → 输入 `IPv4:38080` +
   `agent-password.txt` 里的密码 → 连接。

首次启动时 Windows 防火墙可能弹窗，**勾选「专用网络」并点「允许访问」**。
命令行方式需要保持控制台窗口打开；关闭窗口或按 `Ctrl+C` 即停止被控端。GUI 方式在
关闭窗口时会询问是否停止 Agent。

如果被控机和 Harness 不在同一局域网：在 GUI 的 `Relay server` 里填 Harness 地址
（或写进 `agent\windows\relay.txt`），详见 §9；地址可直接用面板「添加主机」→ 模式
「中继」→「Copy relay.txt」得到。

## 3. 图形界面（GUI，推荐）

推荐日常使用原生图形界面：双击 `agent\windows\start-agent-gui.bat`（控制台隐藏，
只显示窗口）。

```
[截图位置：DSH Remote Desktop Agent 窗口 —— 上部 Relay server / Relay code，
中部 Password / Port / Start agent / Stop agent / Open folder，下部 Status 与 Log]
```

窗口内容：

| 区域 | 说明 |
|---|---|
| Relay server | Harness 地址（http/https），留空 = 只开局域网直连。面板「添加主机」→ 模式「中继」→「Copy relay.txt」得到的就是**当前实际 origin**，粘贴到这里即可。 |
| Relay code | 中继接入码，保存在 `relay-code.txt`，**重启 Agent 后不变**（面板保存的主机可继续用）。`Regenerate` 换新码（重启生效），`Copy code` 复制；留空则让 Agent 自动生成并保存。 |
| Password | 读取 `agent-password.txt`（首次运行自动生成 16 位）；`Copy password` 复制，`Regenerate password` 换新密码（重启生效）。 |
| Port | 监听端口，默认 38080。 |
| Start agent / Stop agent | 启动/停止 Agent；启动的是与 `start-agent.bat` 相同的 Node Agent，子进程无控制台窗口。 |
| Open folder | 打开 `agent\windows` 目录（relay.txt / relay-code.txt / agent-password.txt 都在这里）。 |
| Copy relay.txt | 把 `relay.txt` 里的地址复制到剪贴板。 |
| Save settings | 把 Relay server / Relay code 写回 `relay.txt` / `relay-code.txt`（点 `Start agent` 时也会自动保存）。 |
| Status | Agent 运行状态、`[relay] connected ... 接入码: XXXX` 解析结果、监听地址、fsRoot。 |
| Log | Agent 的 stdout/stderr 实时输出，保留最近约 500 行。 |

使用步骤：

1. 首次使用：若还没有 `node\` 便携运行时，先双击一次 `start-agent.bat`（下载 Node、
   生成密码；GUI 不会自动下载 Node），或直接打开 GUI 按提示操作。
2. 双击 `start-agent-gui.bat` 打开窗口；跨 NAT 时填写 `Relay server`，确认 Password。
3. 点 `Start agent`；状态区出现 `Agent: running` 与监听地址；跨 NAT 时等待
   `Relay: connected, access code XXXX`。
4. 面板「添加主机」：局域网直连填 `IP:38080` + 密码；跨 NAT 选「中继」填接入码 + 密码。
5. 关闭窗口时会询问是否停止 Agent；也可先点 `Stop agent`。

说明：

- GUI 只是 Agent 的原生遥控器：端口、协议、防火墙行为与命令行启动完全一致；两者不要
  同时运行（同一端口会冲突，GUI 已做单实例限制）。
- 修改 Relay code / Password 后需要 `Stop agent` → `Start agent` 才生效。
- 没有管理员权限要求；如果双击后只闪一下没有窗口，见 §8.10。

## 4. 面板连接说明

- 面板左侧「主机」列表里新增一条：地址填 `192.168.x.x:38080`（不要带 `http://`）。
- 密码就是 `agent-password.txt` 的 16 位内容（文件里只有密码本身，无换行也可）。
- 跨 NAT（公网/不同网络）：主机模式选「中继」，填**接入码** + 密码，不填地址（中继
  地址自动取当前 Harness 页面 origin），见 §9。接入码保存在 `relay-code.txt`，
  **重启 Agent 后不变**，面板里保存的主机可以继续用。
- 连接后：
  - 画面：Windows 端是 **JPEG 整帧**编码（面板工具栏可选画质 低/中/高/极高，
    默认「高 65」）。1080p、质量 65 时单帧约 200–400 KB，建议局域网使用。
  - 鼠标键盘：点击画面即捕获键盘，`Esc` 也可转发给远端；失焦或断开时面板会发送
    `releaseAll` 释放所有按键，避免卡键。
  - 文件：面板文件抽屉可浏览/上传/下载/新建/重命名/删除，根目录为
    `%USERPROFILE%`（即 `C:\Users\<用户名>`），路径显示为 `C:\...`。
  - 命令：面板终端通过 `cmd.exe` 执行命令（无真实 PTY，交互式全屏程序如
    `vim`/`top` 体验有限，属于已知限制）。

## 5. 重要限制（务必阅读）

### 5.1 必须处于「已登录的交互式桌面」

Windows 的安全桌面 / 会话隔离导致以下场景**无法**被正常控制，这不是本工具能绕过的：

- **锁屏界面（Win+L）**：截屏可能全黑，键鼠注入无效。
- **登录界面 / 切换用户界面**：同上。
- **UAC 弹窗**（用户账户控制的安全桌面）：画面黑、无法点击。
- 通过 RDP 连接后**断开 RDP**（未注销）时，本地控制台会话会被锁屏，同样受限；
  远程操作期间请保持本地会话处于解锁状态。
- 用户**注销**后没有交互式桌面，helper 会启动失败或无法截屏；重新登录后再启动。

### 5.2 无法操作「以管理员身份运行」的窗口（UIPI）

helper 以启动它的用户权限运行，**不请求也不应该请求 UAC 提权**。
普通权限的程序无法向更高完整性级别（管理员）窗口注入输入：
画面能看到，但点击/按键会被系统丢弃（SendInput 部分失败）。这是 v1 已知行为。

### 5.3 单显示器 v1

- 只截取**主显示器**（`GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)`）。
- 鼠标绝对坐标按**虚拟桌面**归一化，因此主屏以外的区域可移动指针但**看不到画面**。
- 多屏用户的临时办法：把要控制的内容拖到主屏，或在显示设置里把目标屏设为主屏。

### 5.4 其他已知限制

- 无剪贴板同步（可用「文件上传/下载」或面板的文本注入代替复制粘贴）。
- 不叠加系统硬件光标，面板自绘光标位置/按键状态。
- 无声音、无摄像头、无多会话并发画面（多客户端会共享同一块屏幕与同一套输入）。
- 传输默认明文 `ws://`（协议如此设计），只适合可信局域网；需要更强安全性时用
  SSH 隧道或 TLS 反向代理，面板支持 `wss://` 地址。
- 高 DPI：helper 会尝试设置 Per-Monitor V2 DPI 感知（如果 `powershell.exe` 宿主已经
  固定了 DPI 感知模式，Windows 不允许进程中途更改，此时沿用宿主模式）。单显示器下
  截图通常就是物理像素；如果显示缩放不是 100% 且画面被系统虚拟化缩放（画面变大但
  发虚），可临时把该显示器的缩放设为 100%。

## 6. 安全建议（重要）

默认 `--bind 0.0.0.0` 是刻意的（控制端需要连入）。密码 + token 是唯一防线：

1. **只在内网使用**，不要在路由器上把 38080 端口映射到公网。
2. 用 Windows 防火墙**限制来源 IP**（管理员 PowerShell 执行，示例只允许 192.168.1.0/24）：
   ```
   netsh advfirewall firewall add rule name="DSH Remote 38080" dir=in action=allow protocol=TCP localport=38080 remoteip=192.168.1.0/24 profile=private
   ```
   删除该规则：
   ```
   netsh advfirewall firewall delete rule name="DSH Remote 38080"
   ```
3. **妥善保管 `agent-password.txt`**（明文 16 位随机密码）。怀疑泄露时：删除该文件并
   重启 Agent（或 GUI 里 `Regenerate password`），会重新生成新密码并只对新连接生效
   （旧 token 在 Agent 重启后失效）。
4. 用完就按 `Ctrl+C` 停掉；不要长期挂在后台。可设 `reminder`：把启动器放在只有自己
   能访问的目录。
5. 建议用**普通用户**运行，可减少被控制后能触及的范围（但也就无法操作系统级设置）。
6. 首次运行时 Windows 防火墙弹窗请只勾选「专用网络」。
7. 使用中继时，**接入码等同于额外凭据**（持久化在 `relay-code.txt`），只发给要控制的
   人；怀疑泄露时在 GUI 点 `Regenerate`（或删掉 `relay-code.txt` 后重启 Agent）换新码，
   见 §9.2。

## 7. 停止与卸载

- 正常停止：GUI 里点 `Stop agent`（关闭窗口会询问是否停止）；命令行方式在控制台按
  `Ctrl+C`（Agent 会关闭连接、结束 helper）。
- 窗口丢了或 Ctrl+C 无效：双击 `stop-agent.bat`（按命令行匹配 `remote-agent.mjs`
  结束 node 进程；子 helper 会在 stdin EOF 后自行退出）。
- 卸载：**直接删除整个目录**即可（`agent-password.txt`、`relay.txt`、`relay-code.txt`、
  `node\` 都在目录内，一并删除）。本工具不写注册表、不装服务、不加自启动项。
  如加过防火墙规则，用 §6 的 `netsh ... delete rule` 删除。

## 8. 排障

### 8.1 便携 Node 下载失败 / 需要离线部署

`start-agent.bat` 首次运行会从
`https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip`
下载并解压到 `agent\windows\node\`。若下载失败（无外网、代理、证书问题）：

- 手动方案（推荐）：在能上网的机器下载上面的 zip，解压后把其中的
  `node-v22.14.0-win-x64` 文件夹**整个复制**到 `agent\windows\` 并**重命名为 `node`**，
  确认存在：
  ```
  agent\windows\node\node.exe
  ```
  然后重新双击 `start-agent.bat`。
- 也可以安装官方 Node.js LTS（https://nodejs.org/），确保命令行里 `node -v` 可用；
  启动器会优先使用 `PATH` 里的 `node`。
- 如果系统提示「无法验证发布者/被阻止」：右键 zip → 属性 → 解除锁定，或在
  PowerShell 执行 `Get-ChildItem -Recurse | Unblock-File` 后再试。

### 8.2 端口 38080 被占用

```
netstat -ano | findstr :38080
```
找到 PID 后：
```
taskkill /PID <PID> /F
```
或换端口：修改 `start-agent.bat` 里的 `--port 38080`（同时面板地址也要用新端口）。

### 8.3 面板连不上

1. 确认被控端控制台打印了 `remote-agent listening on ...`，且窗口没退出。
2. 在被控端本机测试端口：
   ```
   powershell -NoProfile -Command "Test-NetConnection 127.0.0.1 -Port 38080"
   ```
3. 控制端 `ping <被控端IP>`；确认两台机器在同一网段。
4. 防火墙：确认弹出时选了「允许」，或按 §6 手动加规则；公司网络/公共 Wi-Fi 常禁止
   客户端互访（AP 隔离），换网络或用网线直连试试。
5. 如果控制端跑在另一台机器的浏览器里，注意不要填 `127.0.0.1`（那是浏览器所在机器）。

### 8.4 画面黑屏 / 卡住

- 最常见：被控端**锁屏、UAC 弹窗、登录界面、RDP 断开**（§5.1）。请在本地解锁后重试。
- 目标程序使用独占全屏/DirectX 时，GDI 截屏可能黑屏；把它改为「窗口化/无边框窗口」。
- 用 helper 自检确认截屏功能本身正常（见 §8.6 的 `selftest`，其中 `capture` 项应为
  `ok:true` 并带 `width/height/bytes/encodeMs`）。

### 8.5 鼠标键盘没反应

- 目标窗口是否「以管理员身份运行」→ UIPI 限制（§5.2），v1 无解。
- 是否在锁屏/UAC/登录界面（§5.1）。
- 面板失焦后键盘捕获会释放，点一下远程画面重新捕获；先点工具栏「释放键盘」再点画面。
- 游戏/反作弊/受保护程序可能屏蔽 SendInput，属预期之外，通常无解。

### 8.6 helper 启动失败 / 排查画面与注入

Node 会把 helper 的 stderr 收进错误信息，面板会显示类似
`helper_init_failed: ...` 的错误。也可以在**被控端手动跑 helper** 做自检：

```
cd /d D:\dsh-remote\agent\windows
powershell -NoProfile -ExecutionPolicy Bypass -File capture-input.ps1
```
它会先编译内联 C#（约 1–3 秒），然后打印一行 `hello` JSON。接着手动输入
（每行一条，回车发送）：

```
{"id":1,"cmd":"info"}
{"id":2,"cmd":"capture","quality":65}
{"id":9,"cmd":"selftest"}
```

- `info` 返回屏幕宽高、光标位置、按键状态；
- `capture` 返回 `format:"jpeg"` 和 base64 数据（数据很大，只用于确认能截屏）；
- `selftest` 返回 `tests` 数组，`dpi/screen/capture/cursor/keymap` 各项 `ok` 应为 `true`。
  `capture` 失败通常就是 §5.1 的会话问题或 GDI 被限制。
- 输入 `{"cmd":"shutdown"}` 结束。

helper 依赖 **Windows PowerShell 5.1**（Windows 10/11 自带的 `powershell.exe`）。
确认版本：
```
powershell -NoProfile -Command "$PSVersionTable.PSVersion"
```
启动器已带 `-ExecutionPolicy Bypass`；若组织策略禁止脚本执行，需要 IT 放行或改为
组策略允许（helper 由 Node 以同样参数启动）。

### 8.7 中文/emoji 文本注入

面板「文本」输入走 `KEYEVENTF_UNICODE` 逐 UTF-16 单元注入，可直接输入中文/emoji，
但**不经过输入法**：某些应用（老式输入框）可能对代理对（emoji）显示为乱码，
属应用侧差异。批量粘贴建议用「文件上传」或终端写文件。

### 8.8 性能建议

- 局域网 + 有线网络最佳；Wi-Fi 建议把画质调到「低 30」或「中 50」。
- 1080p 高质量单帧约 200–400 KB；4K 屏幕单帧会明显变大（质量 65 可能 1 MB+），
  面板会明显变卡，建议先在 Windows 显示设置里降低分辨率或缩放。
- 输入注入本身很快（单事件 < 5 ms），卡顿通常来自网络带宽或画面编码。
- helper 是**单线程串行**处理：抓帧（约 20–60 ms）期间收到的键鼠事件会排队，最坏
  延迟约一帧（15 fps 下约 66 ms），高精度拖拽/绘图不如本地顺手，属 v1 行为。
- 启动后第一帧之前有约 1–3 秒的内联 C# 编译时间（`Add-Type`），面板上表现为
  "连接中"稍久，属正常。

### 8.9 跨 NAT / 中继

- 控制台/GUI 日志**完全没有** `[relay]` 行：`relay.txt` 没被读到（文件名/位置/第一行
  是空行或 `#` 注释）。命令行 `[3/4]` 应显示 `Relay server: ...`；GUI 状态区应显示
  `Relay: connecting / connected`。
- 看到 `[remote-agent] relay mode requires Node.js >= 22`：Node 版本过低（便携版 v22 满足）。
- 有 `[relay] connect failed`：检查 Harness 地址、公司网络/代理拦截出站 WSS、
  Cloudflare 是否开启 WebSocket。
- 接入码重启后变了：确认启动参数带 `--relay-code-file relay-code.txt`（GUI 与
  `start-agent.bat` 都会自动加）；详见 §9.2。
- 完整配置步骤与排障见 §9（跨 NAT / 公网中继）。

### 8.10 GUI 排障

- 双击 `start-agent-gui.bat` 只闪一下没有窗口：确认没有已在运行的 GUI 实例（单实例，
  第二次启动会直接退出）；确认 `gui.ps1` 存在、Windows PowerShell 5.1 可用
  （`powershell -NoProfile -Command "$PSVersionTable.PSVersion"`）。也可以在命令行手动
  运行 `powershell -Sta -NoProfile -ExecutionPolicy Bypass -File agent\windows\gui.ps1`
  查看错误。
- 窗口打开但 `Start agent` 提示找不到 Node：先双击 `start-agent.bat` 下载便携 Node
  （GUI 不自动下载），再回来启动；或把 Node 装到 PATH。
- GUI 无响应/卡住：确认没有同时运行 `start-agent.bat`（同一个 38080 端口会冲突）；
  看日志区最后几行；必要时用任务管理器结束 `powershell.exe`（GUI 进程）后重新打开。
- GUI 显示 `Agent: running` 但面板连不上：这不是 GUI 问题，按 §8.3 检查 Windows 防火墙
  是否放行 38080、两台机器是否同网段；跨 NAT 时确认状态是 `Relay: connected`。
- 修改 `Relay code` / `Password` 没生效：需要 `Stop agent` → `Start agent`。
- 高 DPI 屏幕上窗口偏小或略模糊：WinForms 在 PowerShell 宿主中的已知表现，不影响功能。

## 9. 跨 NAT / 公网中继

**原理一句话**：被控端（Windows Agent）**主动出站**连接你正在使用的这个 Harness 的中继
接口（`<Harness 地址>/api/auth/remote-desktop/relay/agent`），浏览器面板也连同一个 Harness，由
Harness 在内存里做字节转发。所以**不需要公网 IP、不需要路由器端口映射**，也不需要
向日葵/UU 之类的第三方软件。中继只转发字节、不落盘、不记录画面；密码仍然只由本机
Agent 校验。协议细节见 `docs/RELAY.md`。

### 9.1 配置（3 步）

1. 取得 Harness 地址：面板「添加主机」→ 模式选「中继」→ 点「Copy relay.txt」，得到
   **当前实际的 origin**（形如 `https://<你的 Harness 地址>`）。把它填进 GUI 的
   `Relay server`（或 `agent\windows\relay.txt` 第一行）。
   - 地址必须是 `http://` 或 `https://`，不要带路径和结尾斜杠；留空 = 只开局域网直连；
   - 空行和以 `#` 开头的行会被忽略，取第一行有效内容；
   - 建议用记事本保存为 ANSI 或 UTF-8（无 BOM），内容只放一行 ASCII 地址最稳妥。
2. 启动 Agent（GUI 点 `Start agent`，或双击 `start-agent.bat`）：
   - GUI 状态区显示 `Relay: connecting`，成功后 `Relay: connected, access code XXXX`；
   - 命令行 `[3/4]` 显示 `Relay server: ...`，日志先打印
     `[relay] code: ABC123DEF4 (persistent: ...)`，连上后是
     `[relay] connected ... 接入码: ABC123DEF4`；
   - 接入码同时写入 `relay-code.txt`，**重启后不变**；
   - 密码仍是 `agent-password.txt` 里的 16 位内容。
   - 提示：cmd 控制台编码是本地代码页，Agent 日志里的中文可能显示成乱码，**不影响**
     ASCII 的接入码与 `[relay]` 关键字。
3. 面板「添加主机」→ 模式选「中继」→ 填**接入码** + **密码** → 连接。
   中继地址自动取当前 Harness 页面的 origin，不用手填。

局域网直连（`IP:38080`）和公网中继可以**同时使用**：Agent 仍然监听 `0.0.0.0:38080`，
`relay.txt` 只是额外开一条出站隧道；不需要改任何既有配置。

### 9.2 接入码（持久化）

- Agent 启动时用 `--relay-code-file relay-code.txt`：文件里有合法接入码就复用，没有就
  生成一个 10 位 `[A-Z0-9]` 并写入。所以**重启后接入码不变**，面板里保存的主机可以
  继续用，不必每次改接入码。
- GUI 的 `Relay code` 框显示当前接入码：`Regenerate` 生成新码（写入 `relay-code.txt`，
  重启 Agent 后生效），`Copy code` 复制；留空则交给 Agent 生成并自动保存。
- 手动命令行同样可以固定接入码（`--relay-code-file`；也可用 `--relay-code` 直接指定）：
  ```
  cd /d <安装目录>\agent
  node remote-agent.mjs --port 38080 --bind 0.0.0.0 --fs-root "%USERPROFILE%" --password-file windows\agent-password.txt --relay https://<你的 Harness 地址> --relay-code-file windows\relay-code.txt
  ```
  接入码用 6–32 位 `[A-Za-z0-9_-]`；同一个接入码同时只保留最新一条 Agent 连接
  （重连会顶掉旧的）。
- 接入码只发给要控制这台机器的人；怀疑泄露时在 GUI 点 `Regenerate`（或删除
  `relay-code.txt` 后重启 Agent）换新码。

### 9.3 安全

- 中继不改变鉴权：面板登录仍要 Agent 密码，密码只在本机校验；中继按字节转发、不落盘。
- 中继入口不要求 Harness 登录，安全边界 = **接入码随机性 + Agent 密码**。
- Harness 管理员若设置了 `DSH_REMOTE_RELAY_TOKEN`，Agent 必须额外带 token 才能连中继；
  **Windows 侧不需要任何配置**，若 Harness 开了它而你的 Agent 连不上，请联系 Harness
  管理员确认 token 是否随 Agent 一起分发。
- 只在你信任的 Harness 上使用中继；接入码不要发到公开群或截图里。`relay-code.txt`
  等同于凭据，不要提交到 Git 或打包分享（见 §9.2）。

### 9.4 排障

- 控制台/GUI 日志**完全没有** `[relay]` 行：`relay.txt` 没读到（文件名/位置不对、第一行
  是空行或 `#` 注释）。命令行 `[3/4]` 应显示 `Relay server: ...`；GUI 状态区应显示
  `Relay: connecting / connected`，否则回看 §9.1。
- `[relay] cannot write relay code file ...`：`relay-code.txt` 所在目录不可写；检查
  `agent\windows` 的权限（GUI 里 `Open folder` 可打开该目录）。
- 看到 `[remote-agent] relay mode requires Node.js >= 22`：Node 版本过低。便携版
  v22.14.0 满足；若 PATH 里有更旧的 `node`，升级它或临时改名让启动器改用 `node\`。
- `[relay] disabled: invalid relay URL: ...`：`relay.txt` 第一行少了 `http://` 或
  `https://` 前缀，Agent 会退回仅局域网模式，改成完整地址即可。
- `[relay] disabled: ...` / `[relay] connect failed: ... (retry in Ns)`：先检查地址是否
  可访问 —— 浏览器打开 `https://<地址>/api/auth/remote-desktop/relay/info` 应返回
  `{"enabled":true,...}`；再检查公司网络/代理是否拦截出站 WSS；用 Cloudflare 时确认
  已开启 WebSocket。
- 面板选「中继」提示接入码无效：面板里的接入码是否与 GUI `Relay code` / `relay-code.txt`
  一致；Agent 是否在线（看是否有 `[relay] connected`）。
- 中继能连但画面卡：中继走公网带宽，把面板画质调到「低/中」；直连正常而中继慢通常
  是上行带宽或跨运营商问题。
- 升级/重装（`install.ps1`）会重新解压 `agent\` 目录，但会**保留** `agent-password.txt`、
  `relay.txt`、`relay-code.txt` 与便携 `node\`；如果手动覆盖安装，升级前先备份这些文件
  （`relay.txt` 内容与面板里复制的 origin 一致）。

## 10. 已验证 / 待人工验证

Linux 开发环境已完成（静态 + 协议级模拟）：

- PowerShell 脚本语法解析（`pwsh` AST parser）：通过。
- 内联 C# 用 Mono `mcs` 单独编译（`-target:library -r:System.Drawing.dll
  -r:System.Windows.Forms.dll`）：通过（脚本支持 `--dump-csharp <path>` 或环境变量
  `DS_REMOTE_DUMP_CSHARP=<path>` 导出内联 C# 供编译校验）。
- 用 mock native 层在 Linux 上跑通 helper 的**真实 JSON Lines 主循环**（hello/info/
  capture/输入命令/releaseAll/selftest/坏 JSON/shutdown/EOF）：23/23 通过。
- Windows 启动器/文档的中继支持：`start-agent.bat` 的 `relay.txt` 解析与
  `--relay` + `--relay-code-file` 参数拼装、`install.ps1` 的保留逻辑与中继提示、
  README 本节的静态检查（ASCII/CRLF、goto 标签、bat 内嵌 PowerShell 语法解析）。
- GUI：`gui.ps1` 通过 PowerShell 语法解析、内联 C# 用 Mono `mcs` 独立编译、纯
  ASCII/LF；`start-agent-gui.bat` 纯 ASCII/CRLF 且含 `-Sta` / `-WindowStyle Hidden` /
  `-File`；`install.ps1` 优先启动 GUI 并保留 `relay-code.txt`——均为静态检查，
  **未在 Windows 上实际渲染或点击**。

**必须在 Windows 实机上人工验证**（无法在 Linux 验证运行时行为）：

- 双击启动、便携 Node 下载/解压、防火墙放行；
- 真实截屏画面、鼠标键盘注入、文本注入、文件上传下载、命令输出；
- 锁屏 / UAC / 登录界面 / 管理员窗口的实际表现（预期受限，见 §5）；
- 1080p 单帧耗时与体积是否符合预期（目标 p50 ≤ 60 ms、质量 65 ≤ 400 KB）。
- 中继：创建 `relay.txt` → 启动看到 `[3/4] Relay server: ...` / GUI 状态
  `Relay: connected` 与 `[relay] connected ... 接入码` → 面板「中继」模式用接入码 +
  密码连接成功；以及**重启后接入码不变**（`relay-code.txt` 持久化）、GUI `Regenerate`
  换码后重启生效。
- GUI：双击打开窗口、Start/Stop、Copy 按钮（接入码/密码/relay.txt）、日志与状态解析、
  关闭时的停止确认、高 DPI 下的显示效果（真实 Windows 渲染无法在 Linux 验证）。

契约权威文档：`docs/WINDOWS.md`（§2 helper JSON Lines 契约、§5 启动器要求）。
