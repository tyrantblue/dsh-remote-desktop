# 远程桌面 Web 插件实现规范（plugin/client.js）

交付物：`/opt/remote/plugin/client.js`（单文件、纯 JS、无构建）。宿主文件（`package.json`、`cordis.patch.yml`、`index.js`、`locale/`、`icon.svg`）由 Lead 提供，**不要修改它们**（需要改动先找 Lead）。

## 0. 硬性约束

- 只允许 `const React = require('react');`，禁止 require 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-primitives` 等）。
- 样式：内联 style 对象或单个 `<style>` 元素里的 CSS，类名前缀 `rdx-`；颜色只用主题 token（见下），不得写死亮/暗色。`var(--dsw-alias-bg-base)` 等。
- 所有可见文案走 `ctx.locale`（`zh`/`en` 字典内联在 client.js 中），不得在 JSX 里硬编码中文（注释可以）。
- 资源清理：WS、定时器、事件监听、ResizeObserver 必须在组件卸载/插件卸载时释放（useEffect cleanup 或 `ctx.effect`）。
- 不允许操作 `document.body`、不允许读取其他插件的 DOM/CSS。
- 必须能通过 `node --check plugin/client.js`。
- 不要引入外部 CDN、图片、字体。图标用内联 SVG。

## 1. 模块外壳

```js
window.__ModuleLoader__.load({
  id: '@local/remote-desktop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'remoteDesktop';
    const PANEL_ID = 'remote-desktop';
    const en = { /* ... */ };
    const zh = { /* ... */ };
    // ... RemoteClient 类、组件 ...
    function SidebarIcon() { /* 内联 SVG，24x24，currentColor */ }
    function RemoteDesktopPanel() { /* 主面板根组件 */ }
    const inject = ['slots', 'locale'];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'remote-desktop: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 5,
        label: () => t('sidebar.label'), locale: NS,
      }, SidebarIcon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
      }, RemoteDesktopPanel));
    }
    return { inject, apply };
  },
});
```

- 侧边栏入口 id 与 main 面板 key 必须都是 `remote-desktop`。
- 面板根元素：`<div className="rdx-panel" style={{flex:1, display:'flex', flexDirection:'column', minHeight:0, width:'100%', background:'var(--dsw-alias-bg-base)'}}>`。

## 2. 数据与网络层

### 2.1 主机存储（localStorage）

- key `dsh.remoteDesktop.hosts.v1`：`[{ id, name, address, password, createdAt }]`
- key `dsh.remoteDesktop.activeHost.v1`：当前选中的 host id
- `address` 归一化规则（接受用户输入）：
  - `192.168.1.5` → `http://192.168.1.5:38080` / `ws://192.168.1.5:38080/ws`
  - `192.168.1.5:39000` → 端口 39000
  - `ws://host:port` 或 `wss://` → http(s) 同源；`http(s)://` → ws(s) 同源
- 密码仅保存在本机 localStorage（UI 需提示这一点）；不做任何遥测/外发。

### 2.2 RemoteClient 类（单连接会话）

职责：`connect(host)`、`disconnect()`、`on(event, cb)`/`emit`、`auth`、`ws`、`reconnect`、HTTP 文件操作。

```js
class RemoteClient {
  // 状态：'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'
  // 事件：state, welcome, frame, shell-data, shell-exit, error
  async connect(host)      // POST /api/auth 拿 token；open ws；发 hello；等 welcome
  disconnect()             // 主动断开，不发重连
  startScreen(fps=15)      // 发 screen.start
  stopScreen()
  refreshScreen()
  sendInput(msg)           // mouse/wheel/key/text/releaseAll 原样发
  startShell(cols,rows,cwd) / shellInput(str) / stopShell()
  // HTTP
  async listFiles(path)    // GET /api/fs/list
  async downloadFile(path) // GET /api/fs/download → blob → 触发浏览器下载
  async uploadFile(dir, file) // PUT /api/fs/upload?path=dir+name
  async mkdir(path) / rename(from,to) / remove(path, recursive)
}
```

- WS 断开（非主动）→ 状态 `reconnecting`，自动重连最多 5 次（1s/2s/4s/8s/16s），恢复后重新 `hello` + `screen.start`；shell 由终端组件重新 start。
- 所有 Promise 失败要有可读错误，UI 以工具栏错误条/toast 展示。
- 帧解析：二进制帧 `u32le headerLen + headerJSON + payload`；对每个 tile 用 `DecompressionStream('deflate')` 解压（异步），得到 RGBA，`ImageData` 后 `putImageData`。**必须处理浏览器不支持 DecompressionStream 的情况**：显示错误提示（现代 Chrome/Edge 均支持）。
- 不要因为帧解码慢而阻塞事件循环：用队列 + `await` 顺序解码（帧很小），丢帧允许（新帧覆盖旧帧）。

### 2.3 面板状态

- `hosts`：主机列表；`activeHostId`；`session`：`{client, state, screen, error}`；`drawer`：`null | 'files' | 'terminal'`；`keyboardCaptured`：bool；`fps`。

## 3. 组件与交互

### 3.1 根页面 `RemoteDesktopPanel`
- 顶部 header（高 48px，边框 `--dsw-alias-border-l1`）：标题「远程桌面」+ 当前主机名/状态点 + 右侧按钮「添加主机」。
- 左侧主机栏（宽 220px，可滚动）：主机列表（名称 + 地址小字；选中态背景 `--dsw-alias-bg-layer-1`；右键或悬停 `...` 按钮编辑/删除）。底部「＋ 添加主机」。
- 右侧工作区：无主机时显示引导（添加主机 + 部署 Agent 步骤，可折叠 `<details>`），选中未连接时显示「连接」按钮 + 地址/密码摘要；`connecting` 显示进度；`connected` 渲染 `SessionView`。
- 添加/编辑主机用模态框（自有样式，Escape 关闭，点击遮罩关闭），字段：名称、地址、密码；校验地址非空；保存后不自动连接。

### 3.2 `SessionView`
- 工具栏（高 40px）：状态点 + 主机名；`fps` 下拉（5/10/15/24）；按钮：刷新画面、文件、终端、释放键盘（仅捕获时可用）、断开。
- 主区域：`ScreenSurface`（flex:1，min-height:0，深色背景 `#000` 不是主题色——这是远程画面信箱区，允许固定黑）；右侧抽屉（宽 380px）按当前 tab 渲染 `FileBrowser`/`TerminalConsole`，可关闭；窄屏（<900px）抽屉覆盖在画面上方或改为底部 tab（简化为覆盖式绝对定位）。
- 错误条：连接/文件/终端错误的红色文本 + 关闭按钮，位于工具栏下方。

### 3.3 `ScreenSurface`（核心）
- 容器 div `position:relative; flex:1; min-height:0; overflow:hidden; outline:none`，内部 `<canvas ref>` 绝对定位居中。
- `welcome` 后 canvas.width/height = 远程屏幕尺寸；用 `ResizeObserver` 计算 fit：`scale = min(cw/W, ch/H)`，canvas.style.width = W*scale，height = H*scale，left/top 居中（信箱式）。
- 绘制：维护 `pendingFrames` 队列；`requestAnimationFrame` 循环取最新帧绘制（丢弃更旧的同 seq 帧）；每帧对每个 tile：解压 → `ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), x, y)`；键帧发送 `screen.refresh`。
- 光标：绝对定位内联 SVG 箭头（16px），位置 `left = offsetX + cursor.x*scale`，`top = offsetY + cursor.y*scale`；`buttons>0` 时加 class 显示按下态；指针在画布外隐藏。
- 输入（仅 `pointer-events:auto` 区域）：
  - `mousemove`：rAF 节流，发 `mouse move`（用逆变换得到远程坐标，四舍五入）。
  - `mousedown`：先发 move 再发 `down`，`setPointerCapture`，`preventDefault`；`mouseup` 发 `up`，释放 capture。
  - `wheel`：`preventDefault`，发 `wheel {dx,dy}`（像素），负值向上。
  - `contextmenu`：`preventDefault`。
  - 键盘：点击画面后 `keyboardCaptured=true`，焦点放到容器（tabIndex=0）；捕获期间 `window.addEventListener('keydown'/'keyup', handler, {capture:true})`：`preventDefault`（除非 F5/F12 等浏览器保留键；建议全部阻止并发送），忽略 `e.isComposing`，构造 `{t:'key', code, key, down, mods:{shift,ctrl,alt,meta}}`；`window.blur`/`visibilitychange` 发 `releaseAll` 并释放捕获。
  - 工具栏「释放键盘」与点击画面外：释放捕获并 `releaseAll`。
  - 粘贴文本入口：工具栏菜单「粘贴文本到远端」→ 弹 textarea → 发 `{t:'text'}`（v1 可选但建议实现）。
- 画面 0 桌面尺寸变化：Agent welcome 里的尺寸为准；若收到 `frame.width/height` 变化则调整 canvas。

### 3.4 `FileBrowser`
- 顶部：路径面包屑/输入框（可编辑，回车跳转）+ 刷新 + 上传 + 新建文件夹。
- 列表：名称（图标区分目录/文件）、大小（人类可读）、修改时间；点击目录进入；文件行「下载」；操作列「重命名」「删除」（删除前 `confirm`，目录 recursive 需二次确认）。
- 上传：隐藏 `<input type=file multiple>`；上传中显示 spinner 与当前文件名；完成后刷新列表。
- 下载：fetch 拿 blob，`a.download` 保存，完成后 URL.revokeObjectURL。
- 错误：显示 `error.code + message`。

### 3.5 `TerminalConsole`
- 挂载后 `shell.start(cols, rows, cwd)`（cwd 用当前文件面板路径或默认）；显示输出 `<pre>`（等宽字体、行高 1.35、可滚动、自动滚底）。
- 数据：TextDecoder 流式解码；最小 VT 处理：`\r` 回行首、`\n` 换行、`\b` 退格、`\x1b[K` 清行、`\x1b[2J` 清屏、`\x1b[H` 回左上、其他 CSI/SGR 序列剥离（如 `\x1b[0;32m`）。保留最近 5000 行。
- 输入：`<pre>` 区域获得焦点时捕获 keydown：可打印字符、Enter→`\r`、Backspace→`\x7f`、Tab→`\t`、Ctrl+C→`\x03`、方向键→ANSI 序列；发送 `shell.input`。另提供底部单行输入框（回车发送 `text + '\r'`），方便纯命令场景。
- 按钮：清屏（本地）、重启 shell、停止。显示 shell 退出码。
- 若 `capabilities.shell=false`，显示不支持提示。

### 3.6 部署引导
- 无主机时的引导里放可复制的启动命令（从 `t('deploy.command')` 模板 + 当前地址），例如：
  `node remote-agent.mjs --port 38080 --password '<your-password>' --display :0`
- 说明需在目标机执行、默认端口、需要 X11（桌面会话），以及浏览器需能直连目标机端口。

## 4. 主题 token（只用这些）

`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-idle-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、`--dsw-specific-sidebar-fill`。

字号 12/13px，控件圆角 6px，按钮高度 28px；与 Harness 现有管理页风格一致。

## 5. 验收清单

1. `node --check plugin/client.js` 通过。
2. 面板在侧边栏出现（id `remote-desktop`），点击进入主面板（main key `remote-desktop`），无 console 报错。
3. 手动协议测试（由测试同学提供 Node 脚本）能完成：添加主机 → 连接 → 看到画面 → 移动/点击/键入 → 打开文件面板浏览/下载/上传 → 打开终端执行命令。
4. 切换侧边栏面板再返回，连接保持（页面不卸载时）或能自动重连；断开后资源释放（WS close、shell 停止）。
5. 亮/暗色下界面均可读（使用 token，不写死颜色，除远程画面信箱底色）。
6. 视觉细节未验证时如实说明（没有浏览器自动化环境）。
