# X11 纯 JS 实现笔记（给 Agent 屏幕/输入模块）

本机已安装 X11 头文件与测试工具，可直接查证，不要凭记忆写：

- 协议结构体：`/usr/include/X11/Xproto.h`、`/usr/include/X11/extensions/xtestproto.h`
- 测试工具：`Xvfb`、`xdpyinfo`、`xev`、`xdotool`、`xterm`（已 apt 安装）
- 启动测试显示：`Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &`，然后 `DISPLAY=:99 xdpyinfo`

## 1. 连接与 setup

1. `net.connect('/tmp/.X11-unix/X99')`（`DISPLAY=:99`；也支持 `hostname:99` 时用 TCP 6099）。
2. 发送连接请求（小端）：12 字节固定头 —— `'l'` (0x6c) 字节序、pad、`major=11` (u16)、`minor=0` (u16)、`authNameLen` (u16)、`authDataLen` (u16)、pad 2 字节；随后是 `authName`（4 字节对齐）与 `authData`（4 字节对齐）。请求总长 = 12 + align4(authNameLen) + align4(authDataLen)。
   - **Xauthority（MIT-MAGIC-COOKIE-1）**：真实 Xorg 桌面默认校验 cookie。按优先级读取 `$XAUTHORITY`（非空则只用它）→ `~/.Xauthority`；解析二进制大端条目（`family u16` + address/number/name/data 各 `len u16`+内容），取 display 号匹配 `:N`（`:N.S` 取 screen 0，空 number 视为 wildcard）且 name == `MIT-MAGIC-COOKIE-1` 的条目，`authName="MIT-MAGIC-COOKIE-1"`、`authData` 为 16 字节 cookie。没有匹配时回退空 auth（Xvfb、`-ac`、无访问控制的 X 可用）。
3. 读 **8 字节前缀**：`success(1) reasonLen(1) major(2) minor(2) length(u16 @offset 6)`；后续 setup 数据长度 = `length * 4` 字节（**不是** u32 @offset 8）。失败时读 reason 字符串。
4. 后续数据按 `xConnSetup`（40 字节，见头文件 297 行）解析：
   ```
   release u32 | ridBase u32 | ridMask u32 | motionBufferSize u32
   nbytesVendor u16 | maxRequestSize u16 | numRoots u8 | numFormats u8
   imageByteOrder u8 | bitmapBitOrder u8 | bitmapScanlineUnit u8 | bitmapScanlinePad u8
   minKeyCode u8 | maxKeyCode u8 | pad u32
   ```
   然后是 vendor 字符串（`nbytesVendor` 字节，4 字节对齐），`numFormats` 个 `xPixmapFormat(8)`：
   ```
   depth u8 | bitsPerPixel u8 | scanlinePad u8 | pad u8[5]
   ```
   然后 `numRoots` 个 `xWindowRoot(40)`（见头文件 344 行）：
   ```
   window u32 | defaultColormap u32 | white u32 | black u32 | currentInputMask u32
   pixWidth u16 | pixHeight u16 | mmWidth u16 | mmHeight u16
   minInstalledMaps u16 | maxInstalledMaps u16 | rootVisual u32
   backingStore u8 | saveUnders u8 | rootDepth u8 | nDepths u8
   ```
   每个 root 后跟 `nDepths` 个 `xDepth(8)`：`depth u8 | pad u8 | nVisuals u16 | pad u32`，
   再跟 `nVisuals` 个 `xVisualType(24)`：`visualID u32 | class u8 | bitsPerRGB u8 | colormapEntries u16 | redMask u32 | greenMask u32 | blueMask u32 | pad u32`。
   取 root 的 `rootDepth` 对应 pixmap format 的 `bitsPerPixel`、`scanlinePad`，取 root visual 的 RGB mask。

## 2. 请求/回复通用规则

- 请求头 4 字节：`opcode u8 | data u8 | length u16`，`length` = 整个请求的 4 字节单位数。
- **回复**（除 GenericEvent 外）32 字节：`type u8 (1=Reply/0=Error) | detail u8 | sequence u16 | length u32 | ...`，`length` 为附加数据长度/4。多请求并发时用 sequence 匹配；本实现可以串行（发一个读一个）。
- 读取必须精确按长度消费流，不能多读/少读。

## 3. 本实现用到的 opcode

| 用途 | opcode | 请求体（在 4 字节头后） |
|---|---|---|
| GetImage | 73 | `reqType(1) format(1, 2=ZPixmap) length(2) drawable u32 | x i16 | y i16 | w u16 | h u16 | planeMask u32`；**共 20 字节，length=5**（format 在偏移 1，不是 body 末尾） |
| QueryPointer | 38 | `window u32`；length=2 |
| QueryExtension | 98 | `nameLen u16 | pad u16 | name(pad 4)`；length = (8+len+3)/4 |
| GetKeyboardMapping | 101 | `firstKeycode u8 | count u8 | pad u16`；length=2 |
| XTest FakeInput | 扩展 major opcode | 见下节，36 字节，**length=9** |

### GetImage 回复
32 字节头：`type u8 | depth u8 | sequence u16 | length u32 | visual u32 | pad[20]`；
随后 `length*4` 字节像素。数据按行存放，行字节数 = `ceil(width * bpp / scanlinePad) * scanlinePad / 8`（Xvfb 24 深度/32bpp/scanlinePad 32 → `width*4`）。
**注意**：行 padding 按本次请求的 `width` 计算，而不是 drawable/屏幕全宽；对 1280 宽屏幕请求 `getImage({x:5,y:5,width:64,height:64})` 每行是 64*4=256 字节。
`bpp==32` 时每像素小端 u32 = `0x00RRGGBB`（Xvfb），按 root visual 的 mask 提取：
`r = (px & redMask) >>> shift(redMask)`，再缩放到 0..255（mask 为 0xff0000 时直接移位即可）。

### QueryPointer 回复
`type(1) | sameScreen(1) | sequence(2) | length(4=0) | root u32 | child u32 | rootX i16 | rootY i16 | winX i16 | winY i16 | mask u16 | pad u16`。
mask 位：1=Button1, 2=Button2, 4=Button3, 8=Button4, 16=Button5…

### QueryExtension 回复
`type(1) | present(1) | majorOpcode(1) | firstEvent(1) | firstError(1) | pad[23]`。

### GetKeyboardMapping 回复
`type(1) | keysymsPerKeycode(1) | sequence(2) | length(4) | pad[24]`；随后 `count * keysymsPerKeycode` 个 u32 keysyms（行优先按 keycode）。
用它建 `keysym -> keycode` 表（取第一列即 group 1 unshifted；同一 keysym 有多个 keycode 时取最小 keycode）。

## 4. XTest FakeInput（`/usr/include/X11/extensions/xtestproto.h` 第 89 行）

36 字节，length=9，字段顺序与偏移：

| off | size | 字段 |
|---|---|---|
| 0 | 1 | reqType（XTEST 扩展 major opcode） |
| 1 | 1 | xtReqType = 2（X_XTestFakeInput） |
| 2 | 2 | length = 9 |
| 4 | 1 | type：X 事件类型 2=KeyPress 3=KeyRelease 4=ButtonPress 5=ButtonRelease 6=MotionNotify |
| 5 | 1 | detail：键码或按钮号；Motion 时为 0 |
| 6 | 2 | pad0 |
| 8 | 4 | time = 0（CurrentTime） |
| 12 | 4 | root（Motion 时填根窗口 id，其他为 0） |
| 16 | 4 | pad1 = 0 |
| 20 | 4 | pad2 = 0 |
| 24 | 2 | rootX（Motion 用，其他 0） |
| 26 | 2 | rootY（Motion 用，其他 0） |
| 28 | 4 | pad3 = 0 |
| 30 | 2 | pad4 = 0 |
| 32 | 1 | pad5 = 0 |
| 33 | 1 | deviceid = 0（0 = 核心指针/键盘） |

坐标用 `i16` 写入（Little Endian）。发完请求后 `flush`（socket.write 即可）；无回复。

## 5. keysym 表（浏览器 code → X keysym）

`agent/lib/input.mjs` 需覆盖：
- 字母 `KeyA..KeyZ` → 0x61..0x7a；数字 `Digit0..9` → 0x30..0x39
- 符号（unshifted keysym，Shift 由修饰键完成）：`Minus 0x2d, Equal 0x3d, BracketLeft 0x5b, BracketRight 0x5d, Backslash 0x5c, Semicolon 0x3b, Quote 0x27, Backquote 0x60, Comma 0x2c, Period 0x2e, Slash 0x2f, Space 0x20`
- 控制键：`Enter 0xff0d, Backspace 0xff08, Tab 0xff09, Escape 0xff1b, Delete 0xffff, Insert 0xff63`
- 移动：`ArrowLeft 0xff51, ArrowUp 0xff52, ArrowRight 0xff53, ArrowDown 0xff54, Home 0xff50, End 0xff57, PageUp 0xff55, PageDown 0xff56`
- 修饰：`ShiftLeft/Right 0xffe1, ControlLeft/Right 0xffe3, AltLeft/Right 0xffe9, MetaLeft/Right 0xffeb, CapsLock 0xffe5`
- 功能键 `F1..F12` → 0xffbe..0xffc9；`PrintScreen 0xff61, Pause 0xff13, ScrollLock 0xff14`
- 小键盘 `Numpad0..9 → 0xffb0..0xffb9, NumpadAdd 0xffab, NumpadSubtract 0xffad, NumpadMultiply 0xffaa, NumpadDivide 0xffaf, NumpadDecimal 0xffae, NumpadEnter 0xff8d`

## 6. 真实桌面鉴权（Xauthority）的验证

```bash
Xvfb :97 -screen 0 800x600x24 -nolisten tcp -auth /tmp/xauth97 &
COOKIE=$(python3 -c 'import secrets;print(secrets.token_hex(16))')
xauth -f /tmp/xauth97 add :97 MIT-MAGIC-COOKIE-1 "$COOKIE"
DISPLAY=:97 xdpyinfo                      # 未设 XAUTHORITY 时应报 Authorization required
XAUTHORITY=/tmp/xauth97 DISPLAY=:97 xdpyinfo   # 应成功
XAUTHORITY=/tmp/xauth97 node your-x11-check.mjs
```

- 真实 Xorg 桌面（GNOME/KDE 等）默认启用 cookie 校验；`XAUTHORITY` 通常在登录会话的环境里。
- 没有匹配 cookie 时回退空 auth：Xvfb、`-ac`、`xhost +` 的场景仍可用。
- `xwd` 生成的 XWD v7 文件头是**大端**（header_size=107 等），像素字节序由文件头 `byte_order` 字段决定（0=LSBFirst），像素数据偏移 = `header_size + ncolors*12`；解析参考实现见 `test/lib/xwd.mjs`。

## 7. 手工验证手段

```bash
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
DISPLAY=:99 xdpyinfo | head -20                      # 交叉验证 setup 解析
DISPLAY=:99 xsetroot -solid '#3366cc'                 # 给根窗口上色（修改前先确认 xsetroot 是否安装）
DISPLAY=:99 xterm -geometry 40x12+10+10 -e 'bash -lc "echo hello; sleep 300"' &
DISPLAY=:99 xwd -root -out /tmp/root.xwd              # 若可用，作为像素参考
DISPLAY=:99 xdotool getmouselocation                  # 交叉验证 QueryPointer
DISPLAY=:99 xdotool mousemove 640 400                 # 交叉验证注入（用 xev 观察）
DISPLAY=:99 xev -geometry 200x200+0+0                 # 观察 KeyPress/ButtonPress
```

注意：测试脚本必须自行启动/清理 Xvfb（唯一 display 号，如 `:99`），不得影响已有的 X 会话。
