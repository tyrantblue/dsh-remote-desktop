# 跨 NAT 中继（Relay）契约

普通家用/办公网络没有公网 IPv4，浏览器无法直连被控机的 `10.x/192.168.x` 地址。向日葵/UU 远程的做法是：
被控端**主动出站**连到公网上的汇聚服务器，控制端再连汇聚服务器，由它转发。本项目把中继做进 Harness 自带的
Web 服务器：**不需要额外端口、不需要改反向代理**，浏览器和 Windows Agent 都通过现有的
`https://<harness-origin>` 访问中继。

```
Windows Agent ──出站 wss://<origin>/api/auth/remote-desktop/relay/agent?code=接入码──┐
                                                               ▼
                                                    Harness Host 插件（RelayHub，进程内存）
                                                               ▲
浏览器面板 ──同源 HTTPS/WS /api/auth/remote-desktop/relay/client/<code>/... ──┘
```

- 中继只是**字节转发**：Agent 仍然自己校验密码（`/api/auth`）和 WS token，中继不接触密码明文以外的数据。
- 中继不落盘、不记录 payload；只在 Host 进程内存里维护 `code → agent` 映射。
- 一个 Agent 连接最多 8 个浏览器会话；一个 code 同时只保留最新一条 Agent 连接（重连顶掉旧的）。

## 1. 路由（注册在 Harness 的 `ctx.webServer` 上）

基址：`/api/auth/remote-desktop/relay`。Harness 的 `dsh-web-startup-auth` 只放行 `/api/auth/` 前缀，被控端没有 Harness 登录态，所以中继必须位于该前缀下才能建立隧道；中继安全不依赖该前缀（接入码随机 + Agent 自身密码/token 校验 + 可选 RELAY_TOKEN）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/auth/remote-desktop/relay/info` | 公开 JSON：`{"enabled":true,"protocol":1,"agentPath":"/api/auth/remote-desktop/relay/agent","clientPath":"/api/auth/remote-desktop/relay/client","wsPath":"/api/auth/remote-desktop/relay/ws"}` |
| WS upgrade | `/api/auth/remote-desktop/relay/agent?code=<CODE>[&token=<RELAY_TOKEN>]` | 被控端出站长连接 |
| HTTP prefix | `/api/auth/remote-desktop/relay/client/<CODE>/<agent-path>` | 浏览器经中继访问 Agent 的 HTTP API（`/api/auth`、`/api/info`、`/api/fs/*` 等） |
| WS upgrade | `/api/auth/remote-desktop/relay/ws?code=<CODE>&token=<agent-token>` | 浏览器经中继访问 Agent 的 `/ws` 会话（`token` 原样转给 Agent 校验） |

- `<CODE>`：6–32 位 `[A-Za-z0-9_-]`；由 Agent 生成（默认 10 位大写字母+数字），在 Windows 控制台打印。
- 可选 `RELAY_TOKEN`：Host 部署可设置环境变量 `DSH_REMOTE_RELAY_TOKEN`；设置后 Agent 必须带 `token` 且常量时间比较，否则用 403 拒绝升级。未设置则不校验（靠 code 的随机性 + Agent 密码）。
- 中继路由**不要求 Harness 登录**（Cloudflare/反代后公开可达）；安全边界 = code 随机性 + Agent 密码 + 可选 RELAY_TOKEN。请只把 code 给要控制的人。

## 2. Agent ↔ Host 协议（WebSocket）

Agent 用**全局 WebSocket**（Node ≥ 22，Windows 便携版满足；wss 由 Node 内置 TLS 校验）主动连接：
`wss(s)://<origin>/api/auth/remote-desktop/relay/agent?code=<CODE>[&token=<RELAY_TOKEN>]`

### 2.1 帧格式

- **文本帧** = JSON 控制消息。
- **二进制帧** = `uint32le headerLen` + UTF-8 JSON header + 原始 payload（用于 HTTP body 与浏览器二进制 WS 消息，避免 base64 膨胀）：
  - `{"t":"http.body","id":N}` + payload
  - `{"t":"ws.msg","id":N,"binary":true}` + payload
- 单帧 payload 上限 16MiB；超过由发送方拆分（HTTP body 按 64KiB 分片）。JSON 控制消息上限 1MiB。

### 2.2 握手与心跳

- Host 在升级成功后立即发 `{"t":"relay.ready","protocol":1}`。
- Agent 回 `{"t":"relay.hello","agent":{"name":"<hostname>","platform":"win32","version":"1.0.0"},"code":"<CODE>"}`。
- 之后双方每 15s 发 `{"t":"ping"}`，收方回 `{"t":"pong"}`；45s 无任何消息视为断开。
- Host 关闭/替换连接时发 `{"t":"relay.close","reason":"replaced|shutdown"}` 再关闭（4000/4001）。

### 2.3 Host → Agent

```jsonc
{"t":"http.request","id":1,"method":"GET","path":"/api/info?x=1","headers":{"authorization":"Bearer …","accept":"*/*"}}
{"t":"http.body","id":1,"binary":true}   // 二进制帧 header；payload 为请求体分片
{"t":"http.end","id":1}                   // 请求体结束（GET 也发，无 body）
{"t":"http.abort","id":1}                 // 浏览器断开或超时，Agent 应中止本地请求
{"t":"ws.open","id":2,"path":"/ws?token=<agent-token>"}
{"t":"ws.msg","id":2,"binary":false,"data":"<text>"}   // 浏览器文本帧
{"t":"ws.msg","id":2,"binary":true}                     // 二进制帧 header + payload
{"t":"ws.close","id":2,"code":1000,"reason":""}
{"t":"ping"}
```

- `headers` 为小写键名；Host 只转发：`authorization, content-type, accept, accept-language, range, if-none-match, if-modified-since, cache-control`。`host/connection/upgrade/sec-*` 等逐跳头不转发。
- `path` 是 Agent 自己的 URL path（以 `/` 开头，含 query）。
- `id` 由 Host 分配，Agent 必须原样带回。

### 2.4 Agent → Host

```jsonc
{"t":"relay.hello","agent":{...},"code":"<CODE>"}
{"t":"http.response","id":1,"status":200,"headers":{"content-type":"application/json","content-length":"123","content-disposition":"attachment; filename*=UTF-8''a.txt"}}
{"t":"http.body","id":1,"binary":true}   // 二进制帧；响应体分片（64KiB）
{"t":"http.end","id":1}
{"t":"http.error","id":1,"status":502,"message":"local request failed"}
{"t":"ws.opened","id":2,"ok":true}
{"t":"ws.opened","id":2,"ok":false,"error":"bad token"}
{"t":"ws.msg","id":2,"binary":false,"data":"<text>"}
{"t":"ws.msg","id":2,"binary":true}      // 二进制帧 header + payload
{"t":"ws.closed","id":2,"code":1000,"reason":""}
{"t":"pong"}
```

- Agent 收到未知/非法消息必须回 `{"t":"error","message":"..."}` 并继续存活；单条 HTTP/WS 会话失败只结束该会话，不断开隧道。
- HTTP 流：先 `http.response`（status+headers），再若干 `http.body`，最后 `http.end`；HEAD 请求只有 `http.response` + `http.end`，无 body。
- WS 流：`ws.open` → `ws.opened`；之后 `ws.msg` 双向；任一侧关闭 → 对端 `ws.closed`，Host 关闭浏览器 WS。
- 连接断开时 Agent 必须关闭所有由该隧道创建的本地 WS 会话并中止未完成的本地 HTTP 请求。

## 3. Agent 侧实现要求（`agent/lib/relay-client.mjs`）

- CLI：`--relay <base-url>`（打开控制端面板的 Harness 地址，如 `https://<your-harness>`；也可带反向代理子路径）、`--relay-code <CODE>`、`--relay-code-file <path>`。
  - 只给固定 code 用 `--relay-code`；想让它跨重启保持不变用 `--relay-code-file`：文件不存在则生成 10 位 `[A-Z0-9]` 并写入（0600），已存在则复用（非法/空则重生成覆盖）；显式 `--relay-code` 优先并写回文件。
  - Windows 启动器/GUI 默认传 `--relay-code-file "agent\windows\relay-code.txt"`，所以**面板保存的接入码在重启后继续有效**；删除该文件（或 GUI 里 Regenerate）才会换码。
- 启动后先监听本地 HTTP/WS 端口，再连接中继；中继失败**不得**影响本地直连模式，按 1s/2s/4s/8s/16s/30s 退避重连，并打印清晰状态：
  - 成功：`[relay] connected ... 接入码: ABC123DEF4`
  - 失败：`[relay] connect failed: ... (retry in 4s)`
- 关闭（Ctrl+C）时先通知 Host（关帧 1000），再退出。
- Node < 22（无全局 WebSocket）时打印 `relay mode requires Node.js >= 22`，只跑本地模式，不崩。
- 本地请求固定打 `http://127.0.0.1:<port>`，不得回到公网；本地 WS 用 `ws://127.0.0.1:<port>/ws?token=...`。
- 不修改 Agent 现有 HTTP/WS 协议与鉴权；中继只是新增入口。

## 4. 浏览器面板（plugin/client.js）

- 主机模型增加 `mode: 'direct' | 'relay'`（旧数据缺省 `direct`，保持兼容）：
  - direct：`address`（host:port / ws(s):// / http(s)://）。
  - relay：`code`（接入码）+ `password`；中继地址自动取**当前页面 origin**：
    - HTTP base：`<origin>/api/auth/remote-desktop/relay/client/<code>`
    - WS：`<wsOrigin>/api/auth/remote-desktop/relay/ws?code=<code>&token=<token>`
- 添加/编辑主机对话框：模式切换（直连 / 中继）；中继模式字段：接入码、密码；提示“Windows 控制台会打印接入码；中继由当前 Harness 提供，无需公网端口”，并提供一键复制 `relay.txt` 内容（= 当前 origin）。
- 连接状态栏显示 `中继` 标记（直连显示原地址）。
- 其余（画面/输入/文件/终端/重连）完全复用现有逻辑。

## 5. 测试（Linux 可自动验证）

- `test/relay.mjs`（独立于 Harness）：用 `plugin/relay-host.mjs` 的 `RelayHub` 挂在普通 `node:http` 服务上，启动真实 Agent（`--relay ws://127.0.0.1:<port> --relay-code TESTCODE`），然后以浏览器身份：
  - `POST /api/auth/remote-desktop/relay/client/TESTCODE/api/auth` 拿 token；
  - `GET .../api/info`、文件 upload/list/download 经中继往返；
  - `WS /api/auth/remote-desktop/relay/ws?code=TESTCODE&token=...`：hello/welcome、screen.start 收到帧（Linux tiles / win32 fake helper JPEG 各一次）、输入、shell；
  - 错误 code → HTTP 404 / WS 拒绝；Agent 断开后 HTTP 503、重连后恢复；隧道 ping/pong。
- 测试不得依赖 Harness 进程；总耗时 < 20s。
- 部署后人工验证：本机 Agent 连 `wss://<your-harness>/...`，用公网 `https://<your-harness>/...` 作为浏览器路径（反向代理需放行 WebSocket）。
