# Windows 被控端使用说明（v1）

本目录是「DSH 远程桌面」的 **Windows 被控端**：在 Windows 10/11 上双击
`start-agent.bat`，即可被 Harness 侧边栏的「远程桌面」面板控制（画面、鼠标键盘、
文件、命令）。不需要安装 VNC / RDP / 任何 npm 依赖，也不修改系统设置。

目录内容：

| 文件 | 作用 |
|---|---|
| `capture-input.ps1` | 采集与注入 helper：GDI 截屏（JPEG）+ SendInput 注入，JSON Lines over stdio |
| `start-agent.bat` | 一键启动器：找/下载 Node → 生成密码 → 打印 IP → 启动 Node Agent |
| `stop-agent.bat` | 兜底停止（正常方式是 Ctrl+C） |
| `README.zh.md` | 本文档 |
| `agent-password.txt` | 首次启动自动生成的访问密码（明文，运行时生成） |
| `node\` | 便携版 Node.js（首次启动自动下载，运行时生成） |

架构：`start-agent.bat` 启动 `..\remote-agent.mjs`（Node Agent，提供 WebSocket /
HTTP / 文件 / 命令），Node 再按需拉起 `capture-input.ps1`（提供截图与键鼠注入）。
helper 通过 stdin/stdout 的 JSON Lines 与 Node 对话，契约见 `docs/WINDOWS.md` §2。

---

## 1. 系统要求

- Windows 10 / Windows 11（x64 已按目标设计；32 位未验证）。
- **必须已登录的交互式桌面会话**（见 §4.1，这是最重要的限制）。
- 不需要管理员权限；建议用普通用户账户运行（helper 以当前用户权限运行）。
- 端口 `38080`（TCP，局域网可达）。
- 首次运行需要联网下载便携版 Node.js（约 30 MB）；之后可离线使用（见 §7.1）。

## 2. 快速开始（3 步）

1. 把整个项目目录（至少 `agent\` 及其 `windows\` 子目录）复制到这台 Windows PC，
   路径尽量不含特殊字符，例如 `D:\dsh-remote\agent\windows\`。
2. 双击 `agent\windows\start-agent.bat`。
   - 首次运行会自动下载便携版 Node.js 到 `node\`（约 30 MB，仅一次）；
   - 自动生成 16 位随机密码文件 `agent-password.txt`；
   - 打印本机 IPv4 地址和连接说明；
   - 启动 Node Agent，监听 `0.0.0.0:38080`。
3. 在 Harness Web UI 打开「远程桌面」面板 → 添加主机 → 输入
   `上面打印的 IPv4:38080` → 输入 `agent-password.txt` 里的密码 → 连接。

首次启动时 Windows 防火墙可能弹窗，**勾选「专用网络」并点「允许访问」**。
控制台窗口需要保持打开；关闭窗口或按 `Ctrl+C` 即停止被控端。

## 3. 面板连接说明

- 面板左侧「主机」列表里新增一条：地址填 `192.168.x.x:38080`（不要带 `http://`）。
- 密码就是 `agent-password.txt` 的 16 位内容（文件里只有密码本身，无换行也可）。
- 连接后：
  - 画面：Windows 端是 **JPEG 整帧**编码（面板工具栏可选画质 低/中/高/极高，
    默认「高 65」）。1080p、质量 65 时单帧约 200–400 KB，建议局域网使用。
  - 鼠标键盘：点击画面即捕获键盘，`Esc` 也可转发给远端；失焦或断开时面板会发送
    `releaseAll` 释放所有按键，避免卡键。
  - 文件：面板文件抽屉可浏览/上传/下载/新建/重命名/删除，根目录为
    `%USERPROFILE%`（即 `C:\Users\<用户名>`），路径显示为 `C:\...`。
  - 命令：面板终端通过 `cmd.exe` 执行命令（无真实 PTY，交互式全屏程序如
    `vim`/`top` 体验有限，属于已知限制）。

## 4. 重要限制（务必阅读）

### 4.1 必须处于「已登录的交互式桌面」

Windows 的安全桌面 / 会话隔离导致以下场景**无法**被正常控制，这不是本工具能绕过的：

- **锁屏界面（Win+L）**：截屏可能全黑，键鼠注入无效。
- **登录界面 / 切换用户界面**：同上。
- **UAC 弹窗**（用户账户控制的安全桌面）：画面黑、无法点击。
- 通过 RDP 连接后**断开 RDP**（未注销）时，本地控制台会话会被锁屏，同样受限；
  远程操作期间请保持本地会话处于解锁状态。
- 用户**注销**后没有交互式桌面，helper 会启动失败或无法截屏；重新登录后再启动。

### 4.2 无法操作「以管理员身份运行」的窗口（UIPI）

helper 以启动它的用户权限运行，**不请求也不应该请求 UAC 提权**。
普通权限的程序无法向更高完整性级别（管理员）窗口注入输入：
画面能看到，但点击/按键会被系统丢弃（SendInput 部分失败）。这是 v1 已知行为。

### 4.3 单显示器 v1

- 只截取**主显示器**（`GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)`）。
- 鼠标绝对坐标按**虚拟桌面**归一化，因此主屏以外的区域可移动指针但**看不到画面**。
- 多屏用户的临时办法：把要控制的内容拖到主屏，或在显示设置里把目标屏设为主屏。

### 4.4 其他已知限制

- 无剪贴板同步（可用「文件上传/下载」或面板的文本注入代替复制粘贴）。
- 不叠加系统硬件光标，面板自绘光标位置/按键状态。
- 无声音、无摄像头、无多会话并发画面（多客户端会共享同一块屏幕与同一套输入）。
- 传输默认明文 `ws://`（协议如此设计），只适合可信局域网；需要更强安全性时用
  SSH 隧道或 TLS 反向代理，面板支持 `wss://` 地址。
- 高 DPI：helper 会尝试设置 Per-Monitor V2 DPI 感知（如果 `powershell.exe` 宿主已经
  固定了 DPI 感知模式，Windows 不允许进程中途更改，此时沿用宿主模式）。单显示器下
  截图通常就是物理像素；如果显示缩放不是 100% 且画面被系统虚拟化缩放（画面变大但
  发虚），可临时把该显示器的缩放设为 100%。

## 5. 安全建议（重要）

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
   重启 `start-agent.bat`，会重新生成新密码并只对新连接生效（旧 token 在 Agent 重启后失效）。
4. 用完就按 `Ctrl+C` 停掉；不要长期挂在后台。可设 `reminder`：把启动器放在只有自己
   能访问的目录。
5. 建议用**普通用户**运行，可减少被控制后能触及的范围（但也就无法操作系统级设置）。
6. 首次运行时 Windows 防火墙弹窗请只勾选「专用网络」。

## 6. 停止与卸载

- 正常停止：在被控端控制台窗口按 `Ctrl+C`（Agent 会关闭连接、结束 helper）。
- 窗口丢了或 Ctrl+C 无效：双击 `stop-agent.bat`（按命令行匹配 `remote-agent.mjs`
  结束 node 进程；子 helper 会在 stdin EOF 后自行退出）。
- 卸载：**直接删除整个目录**即可。本工具不写注册表、不装服务、不加自启动项。
  如加过防火墙规则，用 §5 的 `netsh ... delete rule` 删除。

## 7. 排障

### 7.1 便携 Node 下载失败 / 需要离线部署

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

### 7.2 端口 38080 被占用

```
netstat -ano | findstr :38080
```
找到 PID 后：
```
taskkill /PID <PID> /F
```
或换端口：修改 `start-agent.bat` 里的 `--port 38080`（同时面板地址也要用新端口）。

### 7.3 面板连不上

1. 确认被控端控制台打印了 `remote-agent listening on ...`，且窗口没退出。
2. 在被控端本机测试端口：
   ```
   powershell -NoProfile -Command "Test-NetConnection 127.0.0.1 -Port 38080"
   ```
3. 控制端 `ping <被控端IP>`；确认两台机器在同一网段。
4. 防火墙：确认弹出时选了「允许」，或按 §5 手动加规则；公司网络/公共 Wi-Fi 常禁止
   客户端互访（AP 隔离），换网络或用网线直连试试。
5. 如果控制端跑在另一台机器的浏览器里，注意不要填 `127.0.0.1`（那是浏览器所在机器）。

### 7.4 画面黑屏 / 卡住

- 最常见：被控端**锁屏、UAC 弹窗、登录界面、RDP 断开**（§4.1）。请在本地解锁后重试。
- 目标程序使用独占全屏/DirectX 时，GDI 截屏可能黑屏；把它改为「窗口化/无边框窗口」。
- 用 helper 自检确认截屏功能本身正常（见 §7.6 的 `selftest`，其中 `capture` 项应为
  `ok:true` 并带 `width/height/bytes/encodeMs`）。

### 7.5 鼠标键盘没反应

- 目标窗口是否「以管理员身份运行」→ UIPI 限制（§4.2），v1 无解。
- 是否在锁屏/UAC/登录界面（§4.1）。
- 面板失焦后键盘捕获会释放，点一下远程画面重新捕获；先点工具栏「释放键盘」再点画面。
- 游戏/反作弊/受保护程序可能屏蔽 SendInput，属预期之外，通常无解。

### 7.6 helper 启动失败 / 排查画面与注入

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
  `capture` 失败通常就是 §4.1 的会话问题或 GDI 被限制。
- 输入 `{"cmd":"shutdown"}` 结束。

helper 依赖 **Windows PowerShell 5.1**（Windows 10/11 自带的 `powershell.exe`）。
确认版本：
```
powershell -NoProfile -Command "$PSVersionTable.PSVersion"
```
启动器已带 `-ExecutionPolicy Bypass`；若组织策略禁止脚本执行，需要 IT 放行或改为
组策略允许（helper 由 Node 以同样参数启动）。

### 7.7 中文/emoji 文本注入

面板「文本」输入走 `KEYEVENTF_UNICODE` 逐 UTF-16 单元注入，可直接输入中文/emoji，
但**不经过输入法**：某些应用（老式输入框）可能对代理对（emoji）显示为乱码，
属应用侧差异。批量粘贴建议用「文件上传」或终端写文件。

### 7.8 性能建议

- 局域网 + 有线网络最佳；Wi-Fi 建议把画质调到「低 30」或「中 50」。
- 1080p 高质量单帧约 200–400 KB；4K 屏幕单帧会明显变大（质量 65 可能 1 MB+），
  面板会明显变卡，建议先在 Windows 显示设置里降低分辨率或缩放。
- 输入注入本身很快（单事件 < 5 ms），卡顿通常来自网络带宽或画面编码。
- helper 是**单线程串行**处理：抓帧（约 20–60 ms）期间收到的键鼠事件会排队，最坏
  延迟约一帧（15 fps 下约 66 ms），高精度拖拽/绘图不如本地顺手，属 v1 行为。
- 启动后第一帧之前有约 1–3 秒的内联 C# 编译时间（`Add-Type`），面板上表现为
  "连接中"稍久，属正常。

## 8. 已验证 / 待人工验证

Linux 开发环境已完成（静态 + 协议级模拟）：

- PowerShell 脚本语法解析（`pwsh` AST parser）：通过。
- 内联 C# 用 Mono `mcs` 单独编译（`-target:library -r:System.Drawing.dll
  -r:System.Windows.Forms.dll`）：通过（脚本支持 `--dump-csharp <path>` 或环境变量
  `DS_REMOTE_DUMP_CSHARP=<path>` 导出内联 C# 供编译校验）。
- 用 mock native 层在 Linux 上跑通 helper 的**真实 JSON Lines 主循环**（hello/info/
  capture/输入命令/releaseAll/selftest/坏 JSON/shutdown/EOF）：23/23 通过。

**必须在 Windows 实机上人工验证**（无法在 Linux 验证运行时行为）：

- 双击启动、便携 Node 下载/解压、防火墙放行；
- 真实截屏画面、鼠标键盘注入、文本注入、文件上传下载、命令输出；
- 锁屏 / UAC / 登录界面 / 管理员窗口的实际表现（预期受限，见 §4）；
- 1080p 单帧耗时与体积是否符合预期（目标 p50 ≤ 60 ms、质量 65 ≤ 400 KB）。

契约权威文档：`docs/WINDOWS.md`（§2 helper JSON Lines 契约、§4 启动器要求）。
