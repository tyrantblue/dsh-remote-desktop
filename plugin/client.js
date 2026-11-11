/**
 * Remote desktop — browser half of the @local/remote-desktop bundle.
 *
 * A single-file, build-free Harness Web UI plugin. It registers a sidebar entry
 * (`sidebar.panellist`, id `remote-desktop`) and a main panel (key
 * `remote-desktop`) that talks directly to a remote agent over HTTP + WebSocket:
 *
 *   - saved hosts (localStorage), connect / auto-reconnect state machine
 *   - screen streaming: binary frames (u32le header length + JSON header +
 *     deflated RGBA tiles) painted on a letterboxed canvas, remote pointer
 *     overlay, mouse / wheel / keyboard forwarding
 *   - file drawer: browse / download / upload / mkdir / rename / delete
 *   - terminal drawer: PTY shell over the same WS with a minimal VT parser
 *
 * Hard constraints honoured here:
 *   - only `require('react')`; no Harness client packages, no DOM body access
 *   - visible copy comes from the inline `en` / `zh` dictionaries via ctx.locale
 *   - CSS uses only the documented theme tokens and `rdx-` class prefix
 *   - every socket, timer, listener and observer is torn down on unmount
 */
window.__ModuleLoader__.load({
	id: '@local/remote-desktop',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback, useMemo } = React;

		const NS = 'remoteDesktop';
		const PANEL_ID = 'remote-desktop';

		// ==================================================================
		// 1. Dictionaries (all visible copy lives here)
		// ==================================================================

		const en = {
			'sidebar.label': 'Remote desktop',
			'panel.title': 'Remote desktop',
			'panel.addHost': 'Add host',

			'host.listHead': 'Hosts',
			'host.none': 'No hosts saved yet.',
			'host.edit': 'Edit',
			'host.editTitle': 'Edit host',
			'host.addTitle': 'Add host',
			'host.delete': 'Delete host',
			'host.deleteConfirm': 'Delete host "{name}"? The remote machine is not affected.',
			'host.name': 'Name',
			'host.address': 'Address',
			'host.addressHint': 'host, host:port, ws://host:port or http://host:port. The default port is 38080.',
			'host.password': 'Password',
			'host.passwordHint': 'Stored only in this browser (localStorage) and sent to the agent for authentication.',
			'host.namePlaceholder': 'e.g. Office PC',
			'host.addressPlaceholder': '192.168.1.5:38080',
			'host.passwordPlaceholder': 'Agent password',
			'host.connect': 'Connect',
			'host.connecting': 'Connecting…',
			'host.reconnect': 'Reconnect',
			'host.disconnect': 'Disconnect',
			'host.disconnectConfirm': 'Disconnect from this host?',
			'host.passwordSaved': 'Password saved',
			'host.passwordMissing': 'No password saved',
			'host.save': 'Save',
			'host.addressRequired': 'Enter an address.',
			'host.addressInvalid': 'Enter a valid host, host:port, ws:// or http:// address.',

			'state.idle': 'Not connected',
			'state.connecting': 'Connecting',
			'state.connected': 'Connected',
			'state.reconnecting': 'Reconnecting',
			'state.error': 'Connection failed',
			'state.closed': 'Disconnected',

			'session.connectingTo': 'Connecting to {address}…',
			'session.reconnecting': 'Connection lost. Reconnecting ({attempt}/{max})…',
			'session.keyboardCaptured': 'Keyboard captured. Press the release button or click outside the screen to stop.',
			'session.screenHint': 'Click the screen to capture keyboard input.',
			'session.waitingFrame': 'Waiting for the first frame…',
			'session.noScreen': 'The agent could not open the remote screen. Desktop access (X11) may be unavailable.',
			'session.pasteTitle': 'Paste text to the remote host',
			'session.pasteHint': 'The text is typed on the remote host.',
			'session.pastePlaceholder': 'Text to type remotely…',
			'session.send': 'Send',
			'session.textUnavailable': 'This agent reports no text-injection capability; only ASCII may work.',
			'session.decodeUnsupported': 'This browser cannot decode screen frames (DecompressionStream is missing). Use a current Chrome or Edge.',
			'session.decodeFailed': 'A screen frame could not be decoded.',
			'session.jpegUnsupported': 'This browser cannot decode JPEG screen frames.',

			'toolbar.fps': 'FPS',
			'toolbar.fpsOption': '{fps} fps',
			'toolbar.refresh': 'Refresh screen',
			'toolbar.files': 'Files',
			'toolbar.terminal': 'Terminal',
			'toolbar.releaseKeyboard': 'Release keyboard',
			'toolbar.paste': 'Paste text',
			'toolbar.disconnect': 'Disconnect',
			'toolbar.close': 'Close',
			'toolbar.quality': 'Quality',
			'toolbar.qualityHint': 'JPEG quality. Only affects JPEG streaming; tile streaming ignores it.',
			'toolbar.quality30': 'Low ({value})',
			'toolbar.quality50': 'Medium ({value})',
			'toolbar.quality65': 'High ({value})',
			'toolbar.quality80': 'Ultra ({value})',
			'toolbar.platform': 'Platform',
			'toolbar.encoding': 'Encoding',
			'toolbar.encodingJpeg': 'JPEG',
			'toolbar.encodingTiles': 'Tiles',
			'platform.win32': 'Windows',
			'platform.linux': 'Linux',
			'platform.darwin': 'macOS',
			'platform.unknown': 'Unknown',

			'error.source.connection': 'Connection',
			'error.source.files': 'Files',
			'error.source.terminal': 'Terminal',
			'error.invalidPassword': 'The password was rejected by the agent.',
			'error.rateLimited': 'Too many failed attempts. Try again in {seconds}s.',
			'error.network': 'Cannot reach the host. Check the address, port and network.',
			'error.timeout': 'The connection timed out.',
			'error.reconnectFailed': 'Reconnecting failed after several attempts.',
			'error.wsClosed': 'The connection was closed.',
			'error.protocol': 'The agent protocol version ({version}) is not supported.',
			'error.noDecompression': 'This browser cannot decode the remote screen.',
			'error.noWebSocket': 'This browser does not support WebSockets.',
			'error.noToken': 'No session token. Connect to the host first.',
			'error.closed': 'The connection is closed.',
			'error.unknown': 'Unknown error.',

			'common.cancel': 'Cancel',
			'common.save': 'Save',
			'common.create': 'Create',
			'common.close': 'Close',
			'common.retry': 'Retry',
			'common.copy': 'Copy',
			'common.copied': 'Copied',
			'common.copyFailed': 'Copy failed — select the command and copy it manually.',

			'deploy.title': 'No saved hosts',
			'deploy.intro': "Add a host to control another computer's screen, files and shell from this panel.",
			'deploy.step1': 'Run the remote agent on the machine you want to control.',
			'deploy.step2': 'Make sure the agent port is reachable from this browser.',
			'deploy.step3': 'Add the host here with its address and password.',
			'deploy.command': "node remote-agent.mjs --port {port} --password '<your-password>' --display :0",
			'deploy.note': 'The agent needs Node.js and an X11 desktop session (Xorg or Xvfb). Unless TLS is put in front of it, traffic is plain ws/http.',
			'deploy.details': 'Deployment command',
			'deploy.addressHint': 'Browser → agent: ws://{host}/ws and http://{host}/api',

			'files.title': 'Files',
			'files.pathPlaceholder': 'Absolute path or ~/…',
			'files.refresh': 'Refresh',
			'files.upload': 'Upload',
			'files.uploading': 'Uploading {name}…',
			'files.downloading': 'Downloading {name}…',
			'files.deleting': 'Deleting {name}…',
			'files.mkdir': 'New folder',
			'files.newFolderTitle': 'New folder',
			'files.renameTitle': 'Rename',
			'files.nameLabel': 'Name',
			'files.download': 'Download',
			'files.rename': 'Rename',
			'files.delete': 'Delete',
			'files.up': 'Up one level',
			'files.empty': 'This folder is empty.',
			'files.loading': 'Loading…',
			'files.root': 'Agent root: {root}',
			'files.deleteConfirm': 'Delete "{name}"?',
			'files.deleteDirConfirm': '"{name}" is a folder. Delete it and everything inside? This cannot be undone.',
			'files.nameRequired': 'Enter a name.',
			'files.nameInvalid': 'The name cannot contain "/" or be "." or "..".',
			'files.error': 'File operation failed',

			'terminal.title': 'Terminal',
			'terminal.clear': 'Clear',
			'terminal.restart': 'Restart shell',
			'terminal.stop': 'Stop shell',
			'terminal.running': 'Shell running',
			'terminal.starting': 'Starting shell…',
			'terminal.exited': 'Shell exited with code {code}',
			'terminal.stopped': 'Shell stopped',
			'terminal.unsupported': 'This agent does not provide a shell.',
			'terminal.commandPlaceholder': 'Type a command and press Enter',
			'terminal.send': 'Run',
			'terminal.hint': 'Click the output area to type directly; the single-line box below runs one command at a time.',
		};

		const zh = {
			'sidebar.label': '远程桌面',
			'panel.title': '远程桌面',
			'panel.addHost': '添加主机',

			'host.listHead': '主机',
			'host.none': '还没有保存的主机。',
			'host.edit': '编辑',
			'host.editTitle': '编辑主机',
			'host.addTitle': '添加主机',
			'host.delete': '删除主机',
			'host.deleteConfirm': '删除主机“{name}”？不会影响远端机器。',
			'host.name': '名称',
			'host.address': '地址',
			'host.addressHint': 'host、host:port、ws://host:port 或 http://host:port，默认端口 38080。',
			'host.password': '密码',
			'host.passwordHint': '仅保存在本机浏览器 localStorage 中，并发送给 Agent 用于鉴权。',
			'host.namePlaceholder': '例如：办公室电脑',
			'host.addressPlaceholder': '192.168.1.5:38080',
			'host.passwordPlaceholder': 'Agent 密码',
			'host.connect': '连接',
			'host.connecting': '正在连接…',
			'host.reconnect': '重新连接',
			'host.disconnect': '断开连接',
			'host.disconnectConfirm': '要断开此主机的连接吗？',
			'host.passwordSaved': '已保存密码',
			'host.passwordMissing': '未保存密码',
			'host.save': '保存',
			'host.addressRequired': '请输入地址。',
			'host.addressInvalid': '请输入有效的 host、host:port、ws:// 或 http:// 地址。',

			'state.idle': '未连接',
			'state.connecting': '连接中',
			'state.connected': '已连接',
			'state.reconnecting': '重连中',
			'state.error': '连接失败',
			'state.closed': '已断开',

			'session.connectingTo': '正在连接 {address}…',
			'session.reconnecting': '连接中断，正在重连（{attempt}/{max}）…',
			'session.keyboardCaptured': '键盘已捕获。点击“释放键盘”或画面外区域即可停止。',
			'session.screenHint': '点击画面以捕获键盘输入。',
			'session.waitingFrame': '正在等待第一帧画面…',
			'session.noScreen': 'Agent 无法获取远程画面，可能没有可用的桌面（X11）。',
			'session.pasteTitle': '粘贴文本到远端',
			'session.pasteHint': '文本会在远端被逐字输入。',
			'session.pastePlaceholder': '要发送到远端的文本…',
			'session.send': '发送',
			'session.textUnavailable': '该 Agent 未上报文本注入能力，可能只支持 ASCII。',
			'session.decodeUnsupported': '当前浏览器无法解码画面帧（缺少 DecompressionStream），请使用较新的 Chrome 或 Edge。',
			'session.decodeFailed': '有一帧画面解码失败。',
			'session.jpegUnsupported': '当前浏览器无法解码 JPEG 画面帧。',

			'toolbar.fps': '帧率',
			'toolbar.fpsOption': '{fps} 帧/秒',
			'toolbar.refresh': '刷新画面',
			'toolbar.files': '文件',
			'toolbar.terminal': '终端',
			'toolbar.releaseKeyboard': '释放键盘',
			'toolbar.paste': '粘贴文本',
			'toolbar.disconnect': '断开',
			'toolbar.close': '关闭',
			'toolbar.quality': '画质',
			'toolbar.qualityHint': 'JPEG 画质，仅对 JPEG 串流生效，瓦片串流不受影响。',
			'toolbar.quality30': '低（{value}）',
			'toolbar.quality50': '中（{value}）',
			'toolbar.quality65': '高（{value}）',
			'toolbar.quality80': '极高（{value}）',
			'toolbar.platform': '平台',
			'toolbar.encoding': '编码',
			'toolbar.encodingJpeg': 'JPEG',
			'toolbar.encodingTiles': '瓦片',
			'platform.win32': 'Windows',
			'platform.linux': 'Linux',
			'platform.darwin': 'macOS',
			'platform.unknown': '未知',

			'error.source.connection': '连接',
			'error.source.files': '文件',
			'error.source.terminal': '终端',
			'error.invalidPassword': 'Agent 拒绝了该密码。',
			'error.rateLimited': '失败次数过多，请 {seconds} 秒后重试。',
			'error.network': '无法连接主机，请检查地址、端口与网络。',
			'error.timeout': '连接超时。',
			'error.reconnectFailed': '多次重试后仍未恢复连接。',
			'error.wsClosed': '连接已关闭。',
			'error.protocol': 'Agent 协议版本（{version}）不受支持。',
			'error.noDecompression': '当前浏览器无法解码远程画面。',
			'error.noWebSocket': '当前浏览器不支持 WebSocket。',
			'error.noToken': '没有会话令牌，请先连接主机。',
			'error.closed': '连接已断开。',
			'error.unknown': '未知错误。',

			'common.cancel': '取消',
			'common.save': '保存',
			'common.create': '创建',
			'common.close': '关闭',
			'common.retry': '重试',
			'common.copy': '复制',
			'common.copied': '已复制',
			'common.copyFailed': '复制失败，请手动选中命令复制。',

			'deploy.title': '还没有保存的主机',
			'deploy.intro': '添加一台主机，即可在此面板控制另一台电脑的画面、文件与命令行。',
			'deploy.step1': '在被控主机上运行远程 Agent。',
			'deploy.step2': '确保浏览器可以直连 Agent 的端口。',
			'deploy.step3': '在这里添加主机地址与密码。',
			'deploy.command': "node remote-agent.mjs --port {port} --password '<your-password>' --display :0",
			'deploy.note': 'Agent 需要 Node.js 和 X11 桌面会话（Xorg 或 Xvfb）。若不做 TLS 反向代理，流量为明文 ws/http。',
			'deploy.details': '部署命令',
			'deploy.addressHint': '浏览器 → Agent：ws://{host}/ws 与 http://{host}/api',

			'files.title': '文件',
			'files.pathPlaceholder': '绝对路径或 ~/…',
			'files.refresh': '刷新',
			'files.upload': '上传',
			'files.uploading': '正在上传 {name}…',
			'files.downloading': '正在下载 {name}…',
			'files.deleting': '正在删除 {name}…',
			'files.mkdir': '新建文件夹',
			'files.newFolderTitle': '新建文件夹',
			'files.renameTitle': '重命名',
			'files.nameLabel': '名称',
			'files.download': '下载',
			'files.rename': '重命名',
			'files.delete': '删除',
			'files.up': '上一级',
			'files.empty': '此文件夹为空。',
			'files.loading': '加载中…',
			'files.root': 'Agent 根目录：{root}',
			'files.deleteConfirm': '删除“{name}”？',
			'files.deleteDirConfirm': '“{name}”是文件夹。要连同其中的所有内容一起删除吗？此操作不可撤销。',
			'files.nameRequired': '请输入名称。',
			'files.nameInvalid': '名称不能包含“/”，也不能是“.”或“..”。',
			'files.error': '文件操作失败',

			'terminal.title': '终端',
			'terminal.clear': '清屏',
			'terminal.restart': '重启终端',
			'terminal.stop': '停止终端',
			'terminal.running': '终端运行中',
			'terminal.starting': '正在启动终端…',
			'terminal.exited': '终端已退出，退出码 {code}',
			'terminal.stopped': '终端已停止',
			'terminal.unsupported': '该 Agent 未提供命令行功能。',
			'terminal.commandPlaceholder': '输入命令后按回车',
			'terminal.send': '运行',
			'terminal.hint': '点击输出区域可直接键入；下方单行输入框用于逐条执行命令。',
		};

		// ==================================================================
		// 2. Constants and small utilities
		// ==================================================================

		const DEFAULT_PORT = 38080;
		const HOSTS_KEY = 'dsh.remoteDesktop.hosts.v1';
		const ACTIVE_KEY = 'dsh.remoteDesktop.activeHost.v1';
		const PROTOCOL_VERSION = 1;
		const FPS_OPTIONS = [5, 10, 15, 24];
		const DEFAULT_QUALITY = 65;
		const QUALITY_OPTIONS = [30, 50, 65, 80];
		const QUALITY_LABEL_KEYS = {
			30: 'toolbar.quality30',
			50: 'toolbar.quality50',
			65: 'toolbar.quality65',
			80: 'toolbar.quality80',
		};
		const PLATFORM_LABEL_KEYS = {
			win32: 'platform.win32',
			linux: 'platform.linux',
			darwin: 'platform.darwin',
		};
		const MAX_RECONNECT = 5;
		const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
		const SHELL_SCROLLBACK_LIMIT = 5000;
		const PING_INTERVAL_MS = 15000;
		const PING_STALE_MS = 45000;
		const MAX_PENDING_FRAMES = 60;

		function cx() {
			let out = '';
			for (let i = 0; i < arguments.length; i += 1) {
				const value = arguments[i];
				if (value) out += (out ? ' ' : '') + value;
			}
			return out;
		}

		function makeError(code, message, extra) {
			const error = new Error(message || code);
			error.code = code;
			if (extra) {
				for (const key of Object.keys(extra)) {
					if (extra[key] !== undefined) error[key] = extra[key];
				}
			}
			return error;
		}

		function makeAddressError(kind) {
			return makeError(kind);
		}

		function errorPayload(error) {
			if (!error) return { code: 'unknown', message: '' };
			if (typeof error === 'string') return { code: error, message: '' };
			const payload = { code: error.code ? String(error.code) : 'unknown', message: error.message ? String(error.message) : '' };
			if (error.retryAfterMs !== undefined) payload.retryAfterMs = error.retryAfterMs;
			if (error.params !== undefined) payload.params = error.params;
			if (error.protocol !== undefined) payload.protocol = error.protocol;
			return payload;
		}

		function describeError(t, error) {
			if (!error) return '';
			if (error.translateKey) return t(error.translateKey, error.params || {});
			const code = error.code;
			if (code === 'invalid_password') return t('error.invalidPassword');
			if (code === 'rate_limited') {
				const seconds = Math.max(1, Math.ceil(Number(error.retryAfterMs || 60000) / 1000));
				return t('error.rateLimited', { seconds });
			}
			if (code === 'network_error') return t('error.network');
			if (code === 'timeout') return t('error.timeout');
			if (code === 'reconnect_failed') return t('error.reconnectFailed');
			if (code === 'ws_closed') return t('error.wsClosed');
			if (code === 'closed') return t('error.closed');
			if (code === 'no_websocket') return t('error.noWebSocket');
			if (code === 'no_decompression') return t('error.noDecompression');
			if (code === 'no_token') return t('error.noToken');
			if (code === 'protocol_unsupported') return t('error.protocol', { version: error.protocol || '?' });
			if (code === 'address_required') return t('host.addressRequired');
			if (code === 'address_invalid') return t('host.addressInvalid');
			const parts = [];
			if (code) parts.push(String(code));
			if (error.message && error.message !== code) parts.push(String(error.message));
			return parts.length ? parts.join(': ') : t('error.unknown');
		}

		function humanSize(value) {
			const size = Number(value);
			if (!Number.isFinite(size) || size < 0) return '—';
			if (size < 1024) return size + ' B';
			const units = ['KB', 'MB', 'GB', 'TB'];
			let amount = size;
			let unit = -1;
			do {
				amount /= 1024;
				unit += 1;
			} while (amount >= 1024 && unit < units.length - 1);
			return (amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)) + ' ' + units[unit];
		}

		let cachedTimeFormatter = null;
		function formatMtime(ms) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value <= 0) return '—';
			try {
				if (cachedTimeFormatter === null) {
					cachedTimeFormatter = new Intl.DateTimeFormat(undefined, {
						year: 'numeric',
						month: '2-digit',
						day: '2-digit',
						hour: '2-digit',
						minute: '2-digit',
					});
				}
				return cachedTimeFormatter.format(new Date(value));
			} catch (error) {
				return '—';
			}
		}

		/** True for a Windows drive path (`C:\...` / `C:/...`) or a UNC path (`\\server\share`). */
		function isWindowsPath(path) {
			const value = String(path === undefined || path === null ? '' : path);
			return /^[A-Za-z]:[\\/]/.test(value) || value.indexOf('\\\\') === 0;
		}

		/**
		 * Join a directory and an entry name, keeping the platform's separator.
		 * The agent returns absolute paths, so a Windows root or `C:\Users\me`
		 * must stay a Windows path when the file drawer builds a child path.
		 */
		function joinPath(dir, name) {
			const rawBase = String(dir === undefined || dir === null ? '' : dir);
			const rawLeaf = String(name === undefined || name === null ? '' : name);
			if (isWindowsPath(rawBase)) {
				const base = rawBase.replace(/[\\/]+$/, '');
				const leaf = rawLeaf.replace(/^[\\/]+/, '');
				if (!leaf) return rawBase || '\\';
				return (base ? base + '\\' : '\\') + leaf;
			}
			const base = rawBase.replace(/\/+$/, '');
			const leaf = rawLeaf.replace(/^\/+/, '');
			if (!leaf) return base || '/';
			return (base === '/' ? '' : base) + '/' + leaf;
		}

		/**
		 * Breadcrumb rows for a path. Windows paths keep their drive (or UNC
		 * share) as the root crumb and use backslashes; POSIX and `~` paths keep
		 * the existing behaviour.
		 */
		function breadcrumbParts(path) {
			const raw = String(path === undefined || path === null ? '' : path);
			const parts = [];
			if (isWindowsPath(raw)) {
				if (raw.indexOf('\\\\') === 0) {
					const segments = raw.split(/[\\/]+/).filter(function notEmpty(segment) { return Boolean(segment); });
					if (segments.length >= 2) {
						const root = '\\\\' + segments[0] + '\\' + segments[1];
						parts.push({ label: root, path: root });
						let acc = root;
						for (const segment of segments.slice(2)) {
							acc += '\\' + segment;
							parts.push({ label: segment, path: acc });
						}
						return parts;
					}
				}
				const drive = raw.slice(0, 2);
				parts.push({ label: drive + '\\', path: drive + '\\' });
				let acc = drive;
				for (const segment of raw.slice(2).split(/[\\/]+/)) {
					if (!segment) continue;
					acc += '\\' + segment;
					parts.push({ label: segment, path: acc });
				}
				return parts;
			}
			if (raw === '~' || raw.indexOf('~/') === 0) {
				parts.push({ label: '~', path: '~' });
				let acc = '~';
				for (const segment of raw.slice(1).split('/')) {
					if (!segment) continue;
					acc += '/' + segment;
					parts.push({ label: segment, path: acc });
				}
				return parts;
			}
			parts.push({ label: '/', path: '/' });
			let acc = '';
			for (const segment of raw.split('/')) {
				if (!segment) continue;
				acc += '/' + segment;
				parts.push({ label: segment, path: acc });
			}
			return parts;
		}

		/** Localised name of the controlled platform (`welcome.agent.platform`). */
		function platformLabel(t, platform) {
			if (!platform) return '';
			const key = PLATFORM_LABEL_KEYS[platform];
			return key ? t(key) : platform;
		}

		/** Localised name of the current frame encoding (`tiles` or `jpeg`). */
		function encodingLabel(t, encoding) {
			if (encoding === 'jpeg') return t('toolbar.encodingJpeg');
			if (encoding === 'tiles') return t('toolbar.encodingTiles');
			return '';
		}

		function newHostId() {
			return 'host-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
		}

		/**
		 * Normalise whatever the user typed into HTTP/WS base URLs.
		 * Returns `{ display, httpBase, wsBase, host }` or throws an
		 * `address_required` / `address_invalid` coded error.
		 */
		function normalizeAddress(input) {
			const raw = String(input === undefined || input === null ? '' : input).trim();
			if (!raw) throw makeAddressError('address_required');
			const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
			if (schemeMatch) {
				const protocol = schemeMatch[1].toLowerCase();
				if (protocol !== 'http' && protocol !== 'https' && protocol !== 'ws' && protocol !== 'wss') {
					throw makeAddressError('address_invalid');
				}
				let url;
				try {
					url = new URL(raw);
				} catch (error) {
					throw makeAddressError('address_invalid');
				}
				if (url.username || url.password) throw makeAddressError('address_invalid');
				if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw makeAddressError('address_invalid');
				const secure = protocol === 'https' || protocol === 'wss';
				return {
					display: raw.replace(/\/+$/, ''),
					httpBase: (secure ? 'https://' : 'http://') + url.host,
					wsBase: (secure ? 'wss://' : 'ws://') + url.host,
					host: url.hostname,
				};
			}
			const trimmed = raw.replace(/\/+$/, '');
			if (!trimmed || /[\/?#@\s]/.test(trimmed)) throw makeAddressError('address_invalid');
			let host = trimmed;
			let port = '';
			if (trimmed.charAt(0) === '[') {
				const close = trimmed.indexOf(']');
				if (close < 0) throw makeAddressError('address_invalid');
				host = trimmed.slice(0, close + 1);
				const tail = trimmed.slice(close + 1);
				if (tail) {
					if (!/^:\d{1,5}$/.test(tail)) throw makeAddressError('address_invalid');
					port = tail.slice(1);
				}
			} else {
				const colon = trimmed.lastIndexOf(':');
				if (colon >= 0) {
					host = trimmed.slice(0, colon);
					port = trimmed.slice(colon + 1);
					if (!/^\d{1,5}$/.test(port)) throw makeAddressError('address_invalid');
				}
			}
			if (!host || /[^A-Za-z0-9._\-\[\]:]/.test(host)) throw makeAddressError('address_invalid');
			if (port && (Number(port) < 1 || Number(port) > 65535)) throw makeAddressError('address_invalid');
			const finalPort = port || String(DEFAULT_PORT);
			return {
				display: trimmed,
				httpBase: 'http://' + host + ':' + finalPort,
				wsBase: 'ws://' + host + ':' + finalPort,
				host: host.replace(/^\[/, '').replace(/\]$/, ''),
			};
		}

		function runtimeHost(host) {
			const normalized = normalizeAddress(host.address);
			return {
				id: host.id,
				name: host.name || normalized.host || host.address,
				address: host.address,
				password: host.password || '',
				createdAt: host.createdAt,
				httpBase: normalized.httpBase,
				wsBase: normalized.wsBase,
				serverLabel: normalized.host,
			};
		}

		// ==================================================================
		// 3. localStorage persistence (hosts + active selection)
		// ==================================================================

		function loadHosts() {
			try {
				const raw = window.localStorage.getItem(HOSTS_KEY);
				if (!raw) return [];
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				const hosts = [];
				for (const item of parsed) {
					if (!item || typeof item !== 'object') continue;
					if (typeof item.id !== 'string' || typeof item.address !== 'string') continue;
					hosts.push({
						id: item.id,
						name: typeof item.name === 'string' && item.name ? item.name : item.address,
						address: item.address,
						password: typeof item.password === 'string' ? item.password : '',
						createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
					});
				}
				return hosts;
			} catch (error) {
				return [];
			}
		}

		function saveHosts(hosts) {
			try {
				window.localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
				return true;
			} catch (error) {
				return false;
			}
		}

		function loadActiveHostId() {
			try {
				const value = window.localStorage.getItem(ACTIVE_KEY);
				return typeof value === 'string' && value ? value : null;
			} catch (error) {
				return null;
			}
		}

		function saveActiveHostId(id) {
			try {
				if (id) window.localStorage.setItem(ACTIVE_KEY, id);
				else window.localStorage.removeItem(ACTIVE_KEY);
			} catch (error) {
				/* storage may be unavailable; the panel still works in memory */
			}
		}

		// ==================================================================
		// 4. Frame decoding helpers (zlib deflate -> RGBA tiles)
		// ==================================================================

		async function inflateDeflate(bytes) {
			if (typeof DecompressionStream !== 'function') throw makeError('no_decompression');
			const stream = new DecompressionStream('deflate');
			const writer = stream.writable.getWriter();
			let writeError = null;
			const writeDone = (async () => {
				try {
					await writer.write(bytes);
					await writer.close();
				} catch (error) {
					writeError = error;
				}
			})();
			const reader = stream.readable.getReader();
			const chunks = [];
			let total = 0;
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					if (next.value) {
						chunks.push(next.value);
						total += next.value.byteLength;
					}
				}
			} catch (error) {
				try {
					await writer.abort();
				} catch (abortError) {
					/* already finished */
				}
				await writeDone;
				throw makeError('decode_failed', String((writeError && writeError.message) || (error && error.message) || error));
			}
			await writeDone;
			if (writeError) throw makeError('decode_failed', String(writeError.message || writeError));
			const output = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				output.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return output;
		}

		// ==================================================================
		// 4b. JPEG frame decoding (Windows backends send full-frame JPEG)
		// ==================================================================

		/**
		 * Draw one full-frame JPEG payload onto the screen canvas.
		 * `createImageBitmap` is the fast path (Blob -> ImageBitmap -> drawImage);
		 * browsers without it fall back to an HTMLImageElement + object URL. The
		 * bitmap is always closed so repeated frames do not leak GPU memory.
		 */
		async function drawJpegFrame(context, bytes, width, height) {
			if (!context) throw makeError('no_canvas');
			if (!bytes || !bytes.byteLength) throw makeError('bad_frame', 'empty JPEG payload');
			if (typeof Blob !== 'function') throw makeError('no_image_decoder', 'Blob is unavailable');
			const blob = new Blob([bytes], { type: 'image/jpeg' });
			if (typeof createImageBitmap === 'function') {
				let bitmap = null;
				try {
					bitmap = await createImageBitmap(blob);
					context.drawImage(bitmap, 0, 0, width, height);
				} catch (error) {
					throw makeError('decode_failed', String((error && error.message) || error));
				} finally {
					if (bitmap && typeof bitmap.close === 'function') {
						try {
							bitmap.close();
						} catch (error) {
							/* the bitmap is already gone */
						}
					}
				}
				return;
			}
			await drawJpegWithImage(context, blob, width, height);
		}

		/** HTMLImageElement fallback for browsers without createImageBitmap. */
		async function drawJpegWithImage(context, blob, width, height) {
			if (typeof Image !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
				throw makeError('no_image_decoder', 'no JPEG decoder is available');
			}
			const href = URL.createObjectURL(blob);
			try {
				const image = await new Promise(function loadImage(resolve, reject) {
					const element = new Image();
					element.onload = function onload() {
						resolve(element);
					};
					element.onerror = function onerror() {
						reject(makeError('decode_failed', 'JPEG image failed to load'));
					};
					element.src = href;
				});
				context.drawImage(image, 0, 0, width, height);
			} finally {
				try {
					URL.revokeObjectURL(href);
				} catch (error) {
					/* already revoked */
				}
			}
		}

		// ==================================================================
		// 5. RemoteClient — one browser session with one agent
		// ==================================================================

		const REMOTE_EVENTS = ['state', 'welcome', 'frame', 'shell-data', 'shell-started', 'shell-exit', 'error', 'screen-started'];

		class RemoteClient {
			constructor(host) {
				this.host = host;
				this.httpBase = host.httpBase;
				this.wsBase = host.wsBase;
				this.status = 'idle';
				this.welcome = null;
				this.token = null;
				this.ws = null;
				this.fps = 15;
				this.quality = DEFAULT_QUALITY;
				this.screenWanted = false;
				this.shellWanted = false;
				this.shellParams = null;
				this.intentional = false;
				this.disposed = false;
				this.generation = 0;
				this.attempts = 0;
				this.reconnectTimer = null;
				this.heartbeatTimer = null;
				this.lastMessageAt = 0;
				this.pingId = 0;
				this.handlers = new Map();
			}

			updateHost(host) {
				this.host = host;
				this.httpBase = host.httpBase;
				this.wsBase = host.wsBase;
			}

			on(event, callback) {
				if (typeof callback !== 'function') return function noop() {};
				let set = this.handlers.get(event);
				if (!set) {
					set = new Set();
					this.handlers.set(event, set);
				}
				set.add(callback);
				const self = this;
				return function off() {
					const current = self.handlers.get(event);
					if (current) current.delete(callback);
				};
			}

			_emit(event, payload) {
				const set = this.handlers.get(event);
				if (!set || set.size === 0) return;
				for (const callback of Array.from(set)) {
					try {
						callback(payload);
					} catch (error) {
						if (typeof console !== 'undefined' && console.error) console.error('remote-desktop: listener failed', error);
					}
				}
			}

			_setStatus(status, info) {
				this.status = status;
				this._emit('state', { status, info: info || null, client: this });
			}

			_clearReconnectTimer() {
				if (this.reconnectTimer !== null) {
					clearTimeout(this.reconnectTimer);
					this.reconnectTimer = null;
				}
			}

			_startHeartbeat() {
				this._stopHeartbeat();
				this.lastMessageAt = Date.now();
				const self = this;
				this.heartbeatTimer = setInterval(function heartbeat() {
					const socket = self.ws;
					if (!socket || socket.readyState !== 1) return;
					if (Date.now() - self.lastMessageAt > PING_STALE_MS) {
						try {
							socket.close();
						} catch (error) {
							/* close triggers the normal reconnect path */
						}
						return;
					}
					self._sendRaw({ t: 'ping', id: ++self.pingId });
				}, PING_INTERVAL_MS);
			}

			_stopHeartbeat() {
				if (this.heartbeatTimer !== null) {
					clearInterval(this.heartbeatTimer);
					this.heartbeatTimer = null;
				}
			}

			_closeSocket() {
				const socket = this.ws;
				this.ws = null;
				if (!socket) return;
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				try {
					if (socket.readyState === 0 || socket.readyState === 1) socket.close();
				} catch (error) {
					/* already closing */
				}
			}

			async connect() {
				this.disposed = false;
				this.intentional = false;
				this.attempts = 0;
				this._clearReconnectTimer();
				this._stopHeartbeat();
				this._closeSocket();
				const generation = ++this.generation;
				this._setStatus('connecting');
				try {
					this.token = await this._authenticate(generation);
					if (generation !== this.generation || this.intentional) return;
					await this._openSocket(generation);
				} catch (error) {
					if (generation !== this.generation || this.intentional) return;
					const failure = errorPayload(error);
					this._emit('error', failure);
					this._setStatus('error', { error: failure });
					this._closeSocket();
				}
			}

			async reconnect() {
				return this.connect();
			}

			disconnect() {
				this.intentional = true;
				this.generation += 1;
				this._clearReconnectTimer();
				this._stopHeartbeat();
				this._sendRaw({ t: 'releaseAll' });
				this._closeSocket();
				this.token = null;
				this.screenWanted = false;
				this.shellWanted = false;
				this.shellParams = null;
				this._setStatus('closed');
			}

			destroy() {
				this.disconnect();
				this.disposed = true;
				this.handlers.clear();
			}

			async _authenticate(generation) {
				if (typeof fetch !== 'function') throw makeError('network_error', 'fetch unavailable');
				const controller = typeof AbortController === 'function' ? new AbortController() : null;
				const timer = controller ? setTimeout(function abortAuth() { try { controller.abort(); } catch (error) { /* noop */ } }, 20000) : null;
				let response;
				try {
					response = await fetch(this.httpBase + '/api/auth', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ password: this.host.password || '' }),
						signal: controller ? controller.signal : undefined,
					});
				} catch (error) {
					if (generation !== this.generation) throw makeError('stale');
					if (error && error.name === 'AbortError') throw makeError('timeout');
					throw makeError('network_error', String((error && error.message) || error));
				} finally {
					if (timer !== null) clearTimeout(timer);
				}
				let body = null;
				try {
					body = await response.json();
				} catch (error) {
					body = null;
				}
				if (!response.ok) {
					const code = body && typeof body.error === 'string' ? body.error : 'http_' + response.status;
					const extra = { status: response.status };
					if (body && body.retryAfterMs !== undefined) extra.retryAfterMs = body.retryAfterMs;
					throw makeError(code, body && typeof body.message === 'string' ? body.message : '', extra);
				}
				if (!body || typeof body.token !== 'string' || !body.token) throw makeError('invalid_response', 'missing token');
				return body.token;
			}

			_openSocket(generation) {
				const self = this;
				if (typeof WebSocket !== 'function') return Promise.reject(makeError('no_websocket'));
				const url = this.wsBase + '/ws?token=' + encodeURIComponent(this.token || '');
				let socket;
				try {
					socket = new WebSocket(url);
				} catch (error) {
					return Promise.reject(makeError('network_error', String((error && error.message) || error)));
				}
				socket.binaryType = 'arraybuffer';
				this.ws = socket;
				return new Promise(function handshake(resolve, reject) {
					let settled = false;
					const timeout = setTimeout(function handshakeTimeout() {
						if (settled) return;
						settled = true;
						reject(makeError('timeout'));
						try {
							socket.close();
						} catch (error) {
							/* noop */
						}
					}, 15000);
					const settleOk = function settleOk() {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						resolve();
					};
					const settleError = function settleError(error) {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						reject(error);
					};
					socket.onopen = function onopen() {
						if (generation !== self.generation || self.intentional) {
							try {
								socket.close();
							} catch (error) {
								/* noop */
							}
							return;
						}
						self._sendRaw({ t: 'hello', client: 'remote-desktop-web', version: 1 });
					};
					socket.onmessage = function onmessage(event) {
						if (generation !== self.generation) return;
						self.lastMessageAt = Date.now();
						self._handleMessage(event.data, { onWelcome: settleOk, onFatal: settleError });
					};
					socket.onerror = function onerror() {
						/* the close event carries the outcome; keep the error silent */
					};
					socket.onclose = function onclose() {
						if (self.ws === socket) self.ws = null;
						self._stopHeartbeat();
						if (generation !== self.generation) {
							settleError(makeError('closed'));
							return;
						}
						if (self.intentional) {
							self._setStatus('closed');
							settleError(makeError('closed'));
							return;
						}
						if (!settled) {
							settleError(makeError('ws_closed'));
							return;
						}
						if (self.status !== 'error') self._scheduleReconnect();
					};
				});
			}

			_handleMessage(data, handshake) {
				if (typeof data === 'string') {
					let message;
					try {
						message = JSON.parse(data);
					} catch (error) {
						this._emit('error', { code: 'bad_message', message: 'invalid JSON control message' });
						return;
					}
					this._handleControl(message, handshake);
					return;
				}
				let bytes = null;
				if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
				else if (data && data.buffer instanceof ArrayBuffer) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				if (!bytes) {
					this._emit('error', { code: 'bad_message', message: 'unsupported binary message' });
					return;
				}
				this._handleBinary(bytes);
			}

			_handleControl(message, handshake) {
				if (!message || typeof message !== 'object') return;
				switch (message.t) {
					case 'welcome': {
						if (message.protocol !== undefined && message.protocol !== PROTOCOL_VERSION) {
							this._emit('error', { code: 'protocol_unsupported', protocol: message.protocol });
							this._setStatus('error', { error: { code: 'protocol_unsupported', protocol: message.protocol } });
							const socket = this.ws;
							this._closeSocket();
							if (handshake && typeof handshake.onFatal === 'function') {
								handshake.onFatal(makeError('protocol_unsupported', '', { protocol: message.protocol }));
							}
							if (socket) {
								try {
									socket.close();
								} catch (error) {
									/* noop */
								}
							}
							return;
						}
						this.welcome = message;
						this.attempts = 0;
						this._clearReconnectTimer();
						this._startHeartbeat();
						this._setStatus('connected');
						if (this.screenWanted) {
							this._sendRaw(this._screenStartMessage());
						}
						if (this.shellWanted && this.shellParams) {
							this._sendRaw({
								t: 'shell.start',
								cols: this.shellParams.cols,
								rows: this.shellParams.rows,
								cwd: this.shellParams.cwd,
							});
						}
						this._emit('welcome', message);
						if (handshake && typeof handshake.onWelcome === 'function') handshake.onWelcome();
						return;
					}
					case 'screen.started': {
						this._emit('screen-started', message);
						return;
					}
					case 'screen.stopped': {
						this._emit('screen-stopped', message);
						return;
					}
					case 'shell.started': {
						this._emit('shell-started', message);
						return;
					}
					case 'shell.exit': {
						this.shellWanted = false;
						this._emit('shell-exit', message);
						return;
					}
					case 'error': {
						this._emit('error', {
							code: message.code || 'agent_error',
							message: message.message || '',
							source: 'agent',
						});
						return;
					}
					case 'ping': {
						this._sendRaw({ t: 'pong' });
						return;
					}
					case 'pong': {
						return;
					}
					default: {
						this._emit('control', message);
					}
				}
			}

			_handleBinary(bytes) {
				if (bytes.byteLength < 4) return;
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				const headerLen = view.getUint32(0, true);
				if (!headerLen || headerLen > 1048576 || 4 + headerLen > bytes.byteLength) {
					this._emit('error', { code: 'bad_frame', message: 'invalid header length' });
					return;
				}
				let header;
				try {
					header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
				} catch (error) {
					this._emit('error', { code: 'bad_frame', message: 'invalid frame header' });
					return;
				}
				const payload = bytes.subarray(4 + headerLen);
				if (!header || typeof header !== 'object') return;
				if (header.t === 'frame') {
					this._emit('frame', { header, payload });
					return;
				}
				if (header.t === 'shell.data') {
					this._emit('shell-data', { stream: header.stream || 'stdout', data: payload });
				}
			}

			_scheduleReconnect() {
				if (this.intentional || this.disposed) return;
				if (this.status === 'error') return;
				if (this.reconnectTimer !== null) return;
				if (this.attempts >= MAX_RECONNECT) {
					const failure = { code: 'reconnect_failed' };
					this._emit('error', failure);
					this._setStatus('error', { error: failure });
					return;
				}
				this.attempts += 1;
				const attempt = this.attempts;
				const delay = RECONNECT_DELAYS[attempt - 1] || RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
				this._setStatus('reconnecting', { attempt, max: MAX_RECONNECT, delay });
				const self = this;
				this.reconnectTimer = setTimeout(function reconnectTick() {
					self.reconnectTimer = null;
					self._attemptReconnect();
				}, delay);
			}

			async _attemptReconnect() {
				if (this.intentional || this.disposed) return;
				const generation = ++this.generation;
				try {
					this.token = await this._authenticate(generation);
					if (generation !== this.generation || this.intentional) return;
					await this._openSocket(generation);
				} catch (error) {
					if (generation !== this.generation || this.intentional) return;
					this._emit('error', errorPayload(error));
					this._scheduleReconnect();
				}
			}

			_sendRaw(message) {
				const socket = this.ws;
				if (!socket || socket.readyState !== 1) return false;
				try {
					socket.send(JSON.stringify(message));
					return true;
				} catch (error) {
					return false;
				}
			}

			sendInput(message) {
				if (!message || typeof message !== 'object') return false;
				return this._sendRaw(message);
			}

			releaseAll() {
				return this._sendRaw({ t: 'releaseAll' });
			}

			_screenStartMessage() {
				return { t: 'screen.start', fps: this.fps, tile: 64, quality: this.quality };
			}

			setFps(fps) {
				const next = Number(fps);
				if (!Number.isFinite(next) || next <= 0) return;
				this.fps = next;
				if (this.screenWanted) this._sendRaw(this._screenStartMessage());
			}

			/**
			 * Change the JPEG quality (30..90). The agent records it per session,
			 * so a new `screen.start` updates the running capture without opening
			 * a second screen subscription. Tile backends simply ignore it.
			 */
			setQuality(quality) {
				const next = Math.round(Number(quality));
				if (!Number.isFinite(next)) return;
				this.quality = Math.max(30, Math.min(90, next));
				if (this.screenWanted) this._sendRaw(this._screenStartMessage());
			}

			startScreen(fps, quality) {
				if (typeof fps === 'number' && fps > 0) this.fps = fps;
				if (typeof quality === 'number' && Number.isFinite(quality)) {
					this.quality = Math.max(30, Math.min(90, Math.round(quality)));
				}
				this.screenWanted = true;
				return this._sendRaw(this._screenStartMessage());
			}

			stopScreen() {
				this.screenWanted = false;
				return this._sendRaw({ t: 'screen.stop' });
			}

			refreshScreen() {
				return this._sendRaw({ t: 'screen.refresh' });
			}

			startShell(cols, rows, cwd) {
				this.shellWanted = true;
				this.shellParams = {
					cols: Number(cols) > 0 ? Math.round(Number(cols)) : 120,
					rows: Number(rows) > 0 ? Math.round(Number(rows)) : 32,
					cwd: cwd || undefined,
				};
				return this._sendRaw({
					t: 'shell.start',
					cols: this.shellParams.cols,
					rows: this.shellParams.rows,
					cwd: this.shellParams.cwd,
				});
			}

			shellInput(data) {
				if (data === undefined || data === null) return false;
				return this._sendRaw({ t: 'shell.input', data: String(data) });
			}

			stopShell() {
				this.shellWanted = false;
				this.shellParams = null;
				return this._sendRaw({ t: 'shell.stop' });
			}

			// ---- HTTP file API -------------------------------------------------

			async _ensureToken() {
				if (this.token) return;
				this.token = await this._authenticate(this.generation);
			}

			async _api(path, init, retried) {
				if (typeof fetch !== 'function') throw makeError('network_error', 'fetch unavailable');
				await this._ensureToken();
				const headers = new Headers(init && init.headers ? init.headers : {});
				headers.set('Authorization', 'Bearer ' + (this.token || ''));
				let response;
				try {
					response = await fetch(this.httpBase + path, Object.assign({}, init, { headers }));
				} catch (error) {
					throw makeError('network_error', String((error && error.message) || error));
				}
				if (response.status === 401 && !retried) {
					this.token = null;
					await this._ensureToken();
					return this._api(path, init, true);
				}
				if (!response.ok) throw await this._responseError(response);
				return response;
			}

			async _responseError(response) {
				let body = null;
				try {
					body = await response.json();
				} catch (error) {
					body = null;
				}
				const code = body && typeof body.error === 'string' ? body.error : 'http_' + response.status;
				const message = body && typeof body.message === 'string' ? body.message : response.statusText || '';
				return makeError(code, message, { status: response.status });
			}

			async _json(path, init) {
				const response = await this._api(path, init);
				try {
					return await response.json();
				} catch (error) {
					throw makeError('invalid_response', 'the agent returned invalid JSON');
				}
			}

			async listFiles(path) {
				return this._json('/api/fs/list?path=' + encodeURIComponent(String(path || '/')));
			}

			async downloadFile(path) {
				const response = await this._api('/api/fs/download?path=' + encodeURIComponent(String(path)));
				const blob = await response.blob();
				const header = response.headers && response.headers.get ? response.headers.get('Content-Disposition') : null;
				let name = String(path).split(/[\\/]/).pop() || 'download';
				if (header) {
					const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
					const plain = /filename="?([^";]+)"?/i.exec(header);
					if (utf8 && utf8[1]) {
						try {
							name = decodeURIComponent(utf8[1]);
						} catch (error) {
							/* keep the path-derived name */
						}
					} else if (plain && plain[1]) {
						name = plain[1];
					}
				}
				if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
					throw makeError('unsupported', 'object URLs are unavailable');
				}
				const href = URL.createObjectURL(blob);
				try {
					const anchor = document.createElement('a');
					anchor.href = href;
					anchor.download = name;
					anchor.rel = 'noopener';
					anchor.click();
				} finally {
					setTimeout(function revoke() {
						try {
							URL.revokeObjectURL(href);
						} catch (error) {
							/* noop */
						}
					}, 10000);
				}
				return { name, size: blob.size };
			}

			async uploadFile(dir, file) {
				const target = joinPath(dir, file.name);
				const response = await this._api('/api/fs/upload?path=' + encodeURIComponent(target), {
					method: 'PUT',
					headers: { 'Content-Type': 'application/octet-stream' },
					body: file,
				});
				try {
					return await response.json();
				} catch (error) {
					return { path: target };
				}
			}

			async mkdir(path) {
				return this._json('/api/fs/mkdir', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path }),
				});
			}

			async rename(from, to) {
				return this._json('/api/fs/rename', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ from, to }),
				});
			}

			async remove(path, recursive) {
				return this._json('/api/fs/remove', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path, recursive: Boolean(recursive) }),
				});
			}
		}

		// Connected clients survive sidebar/panel switches, so coming back to the
		// panel reuses the live socket instead of reconnecting from scratch. The
		// plugin fiber tears them all down when the plugin unloads (see apply()).
		const clients = new Map();

		// ==================================================================
		// 6. Icons
		// ==================================================================

		const ICON_PATHS = {
			monitor: [
				h('rect', { key: 'a', x: 2.5, y: 4, width: 19, height: 13, rx: 2 }),
				h('path', { key: 'b', d: 'M8 21h8M12 17v4' }),
			],
			plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
			folder: [h('path', { key: 'a', d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' })],
			file: [
				h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
				h('path', { key: 'b', d: 'M14 3v5h5' }),
			],
			link: [
				h('path', { key: 'a', d: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1' }),
				h('path', { key: 'b', d: 'M13.5 10.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1' }),
			],
			refresh: [
				h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 6.3' }),
				h('path', { key: 'b', d: 'M20 5v6h-6' }),
			],
			upload: [
				h('path', { key: 'a', d: 'M12 16V4' }),
				h('path', { key: 'b', d: 'M7 9l5-5 5 5' }),
				h('path', { key: 'c', d: 'M4 20h16' }),
			],
			download: [
				h('path', { key: 'a', d: 'M12 4v12' }),
				h('path', { key: 'b', d: 'M7 11l5 5 5-5' }),
				h('path', { key: 'c', d: 'M4 20h16' }),
			],
			folderPlus: [
				h('path', { key: 'a', d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
				h('path', { key: 'b', d: 'M12 11v5M9.5 13.5h5' }),
			],
			edit: [
				h('path', { key: 'a', d: 'M4 20h4l10-10-4-4L4 16z' }),
				h('path', { key: 'b', d: 'M13 5l4 4' }),
			],
			trash: [
				h('path', { key: 'a', d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' }),
				h('path', { key: 'b', d: 'M10 11v6M14 11v6' }),
			],
			close: [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })],
			key: [
				h('circle', { key: 'a', cx: 8, cy: 15, r: 3.5 }),
				h('path', { key: 'b', d: 'M11 12l8-8M16 4h4v4' }),
			],
			refreshScreen: [h('path', { key: 'a', d: 'M4 5h16v11H4zM9 20h6M12 16v4' })],
			files: [h('path', { key: 'a', d: 'M4 6h6l2 2h8v11H4z' })],
			terminal: [
				h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 16, rx: 2 }),
				h('path', { key: 'b', d: 'M7 9l3 3-3 3M13 15h4' }),
			],
			keyboard: [
				h('rect', { key: 'a', x: 2.5, y: 6, width: 19, height: 12, rx: 2 }),
				h('path', { key: 'b', d: 'M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M9.5 13.5h.01M13 13.5h.01M16.5 13.5h.01M8 16h8' }),
			],
			paste: [
				h('rect', { key: 'a', x: 5, y: 4, width: 14, height: 17, rx: 2 }),
				h('path', { key: 'b', d: 'M9 4V3h6v1M9 10h6M9 14h6' }),
			],
			power: [
				h('path', { key: 'a', d: 'M12 3v8' }),
				h('path', { key: 'b', d: 'M7.5 6.5a7 7 0 1 0 9 0' }),
			],
			chevronRight: [h('path', { key: 'a', d: 'M9 5l7 7-7 7' })],
			arrowLeft: [h('path', { key: 'a', d: 'M19 12H5M11 6l-6 6 6 6' })],
			stop: [h('rect', { key: 'a', x: 6, y: 6, width: 12, height: 12, rx: 2 })],
			clear: [
				h('path', { key: 'a', d: 'M4 6h16l-2 13H6z' }),
				h('path', { key: 'b', d: 'M9 6V4h6v2M10 11l4 5M14 11l-4 5' }),
			],
			restart: [
				h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 6.3' }),
				h('path', { key: 'b', d: 'M20 5v6h-6' }),
			],
			copy: [
				h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 1.5 }),
				h('path', { key: 'b', d: 'M5 15V5a1.5 1.5 0 0 1 1.5-1.5H16' }),
			],
			up: [h('path', { key: 'a', d: 'M12 19V5M6 11l6-6 6 6' })],
		};

		function Icon(props) {
			const size = props.size || 16;
			const paths = ICON_PATHS[props.name] || ICON_PATHS.file;
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				paths,
			);
		}

		/** Sidebar glyph: a monitor with a mouse pointer, 24x24, currentColor. */
		function SidebarIcon(props) {
			const size = props && props.size ? props.size : 18;
			const active = props && props.active;
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					style: { opacity: active ? 1 : 0.92 },
				},
				h('rect', { key: 'screen', x: 2.5, y: 4, width: 19, height: 13, rx: 2 }),
				h('path', { key: 'stand', d: 'M8 21h8M12 17v4' }),
				h('path', { key: 'cursor', d: 'M11 7.5l7 4-3 .9 1.8 3.5-2 .9-1.7-3.5-2 2.3z' }),
			);
		}

		// ==================================================================
		// 7. Shared primitives (buttons, status dot, modal, fields)
		// ==================================================================

		function Btn(props) {
			const variant = props.variant || 'default';
			const cls = cx(
				'rdx-btn',
				variant !== 'default' ? 'rdx-btn-' + variant : null,
				props.size === 'sm' ? 'rdx-btn-sm' : null,
				props.block ? 'rdx-block' : null,
				!props.children ? 'rdx-btn-icon' : null,
				props.className,
			);
			const rest = {};
			for (const key of Object.keys(props)) {
				if (key === 'variant' || key === 'size' || key === 'block' || key === 'className' || key === 'icon' || key === 'iconSize' || key === 'children') continue;
				rest[key] = props[key];
			}
			const children = [];
			if (props.icon) children.push(h(Icon, { key: 'icon', name: props.icon, size: props.iconSize || 14 }));
			if (props.children) children.push(h('span', { key: 'label', className: 'rdx-btn-label' }, props.children));
			return h('button', Object.assign({ type: 'button', className: cls }, rest), children);
		}

		function StatusDot(props) {
			const state = props.state || 'idle';
			const title = props.title;
			return h('span', { className: 'rdx-status-dot', 'data-state': state, title: title, 'aria-hidden': 'true' });
		}

		function Spinner(props) {
			return h('span', { className: 'rdx-spinner', 'aria-hidden': 'true', style: props && props.size ? { width: props.size, height: props.size } : undefined });
		}

		function Modal(props) {
			const t = props.t;
			const onClose = props.onClose;
			useEffect(function listenEscape() {
				function onKeyDown(event) {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}
				window.addEventListener('keydown', onKeyDown, true);
				return function cleanup() {
					window.removeEventListener('keydown', onKeyDown, true);
				};
			}, [onClose]);
			const footer = props.footer
				? h('div', { className: 'rdx-dialog-footer' }, props.footer)
				: null;
			return h(
				'div',
				{
					className: 'rdx-dialog-overlay',
					onMouseDown: function onBackdrop(event) {
						if (event.target === event.currentTarget) onClose();
					},
				},
				h(
					'div',
					{
						className: 'rdx-dialog',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': props.title,
						style: props.width ? { maxWidth: props.width + 'px' } : undefined,
					},
					h(
						'div',
						{ className: 'rdx-dialog-header' },
						h('span', { className: 'rdx-dialog-title' }, props.title),
						h(
							'button',
							{
								type: 'button',
								className: 'rdx-iconbtn',
								title: t('common.close'),
								'aria-label': t('common.close'),
								onClick: onClose,
							},
							h(Icon, { name: 'close', size: 16 }),
						),
					),
					h('div', { className: 'rdx-dialog-body' }, props.children),
					footer,
				),
			);
		}

		// ==================================================================
		// 8. Host list, editor modal, deploy guide, connect card
		// ==================================================================

		function HostList(props) {
			const t = props.t;
			const hosts = props.hosts;
			const rows = hosts.map(function renderHost(host) {
				const selected = host.id === props.activeId;
				const status = props.statusOf(host.id);
				return h(
					'div',
					{
						key: host.id,
						className: cx('rdx-host', selected && 'rdx-host-active'),
						role: 'button',
						tabIndex: 0,
						onClick: function select() {
							props.onSelect(host.id);
						},
						onKeyDown: function onKey(event) {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								props.onSelect(host.id);
							}
						},
					},
					h(
						'div',
						{ className: 'rdx-host-main' },
						h('div', { className: 'rdx-host-name' }, h(StatusDot, { state: status, title: t('state.' + status) }), h('span', { className: 'rdx-host-label' }, host.name)),
						h('div', { className: 'rdx-host-addr' }, host.address),
					),
					h(
						'div',
						{ className: 'rdx-host-actions' },
						h(
							'button',
							{
								type: 'button',
								className: 'rdx-iconbtn',
								title: t('host.edit'),
								'aria-label': t('host.edit'),
								onClick: function edit(event) {
									event.stopPropagation();
									props.onEdit(host);
								},
							},
							h(Icon, { name: 'edit', size: 14 }),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'rdx-iconbtn rdx-iconbtn-danger',
								title: t('host.delete'),
								'aria-label': t('host.delete'),
								onClick: function remove(event) {
									event.stopPropagation();
									props.onDelete(host);
								},
							},
							h(Icon, { name: 'trash', size: 14 }),
						),
					),
				);
			});
			return h(
				'aside',
				{ className: 'rdx-hosts' },
				h('div', { className: 'rdx-hosts-head' }, t('host.listHead')),
				hosts.length === 0
					? h('div', { className: 'rdx-hosts-empty' }, t('host.none'))
					: h('div', { className: 'rdx-hosts-list' }, rows),
				h(
					'div',
					{ className: 'rdx-hosts-foot' },
					h(
						'button',
						{ type: 'button', className: 'rdx-btn rdx-btn-ghost rdx-block', onClick: props.onAdd },
						h(Icon, { name: 'plus', size: 14 }),
						h('span', { className: 'rdx-btn-label' }, t('panel.addHost')),
					),
				),
			);
		}

		function HostFormModal(props) {
			const t = props.t;
			const editing = props.mode === 'edit';
			const [name, setName] = useState(props.host ? props.host.name : '');
			const [address, setAddress] = useState(props.host ? props.host.address : '');
			const [password, setPassword] = useState(props.host ? props.host.password : '');
			const [error, setError] = useState(null);
			const nameRef = useRef(null);
			useEffect(function focusFirstField() {
				if (nameRef.current) nameRef.current.focus();
			}, []);
			const submit = function submit(event) {
				if (event) event.preventDefault();
				let normalized;
				try {
					normalized = normalizeAddress(address);
				} catch (failure) {
					setError(failure.code === 'address_required' ? t('host.addressRequired') : t('host.addressInvalid'));
					return;
				}
				const finalName = String(name || '').trim() || normalized.host || normalized.display;
				props.onSave({
					name: finalName,
					address: normalized.display,
					password: password,
				});
			};
			return h(
				Modal,
				{
					t: t,
					title: editing ? t('host.editTitle') : t('host.addTitle'),
					onClose: props.onClose,
					width: 440,
					footer: [
						h(Btn, { key: 'cancel', onClick: props.onClose }, t('common.cancel')),
						h(Btn, { key: 'save', variant: 'primary', onClick: submit }, t('host.save')),
					],
				},
				h(
					'form',
					{ className: 'rdx-form', onSubmit: submit },
					h('div', { className: 'rdx-field' }, h('span', { className: 'rdx-field-label' }, t('host.name')), h('input', { ref: nameRef, className: 'rdx-input', value: name, placeholder: t('host.namePlaceholder'), onChange: function change(event) { setName(event.target.value); } })),
					h('div', { className: 'rdx-field' }, h('span', { className: 'rdx-field-label' }, t('host.address')), h('input', { className: 'rdx-input', value: address, placeholder: t('host.addressPlaceholder'), spellCheck: false, onChange: function change(event) { setAddress(event.target.value); } }), h('span', { className: 'rdx-hint' }, t('host.addressHint'))),
					h('div', { className: 'rdx-field' }, h('span', { className: 'rdx-field-label' }, t('host.password')), h('input', { className: 'rdx-input', type: 'password', value: password, placeholder: t('host.passwordPlaceholder'), autoComplete: 'off', onChange: function change(event) { setPassword(event.target.value); } }), h('span', { className: 'rdx-hint' }, t('host.passwordHint'))),
					error ? h('div', { className: 'rdx-error-text' }, error) : null,
				),
			);
		}

		function DeployGuide(props) {
			const t = props.t;
			const [copied, setCopied] = useState(false);
			const [copyFailed, setCopyFailed] = useState(false);
			const command = t('deploy.command', { port: DEFAULT_PORT });
			useEffect(function resetCopiedState() {
				if (!copied) return undefined;
				const timer = setTimeout(function clearCopyLabel() {
					setCopied(false);
				}, 1600);
				return function cleanup() {
					clearTimeout(timer);
				};
			}, [copied]);
			const copy = function copyCommand() {
				setCopyFailed(false);
				if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(command).then(
						function done() {
							setCopied(true);
						},
						function failed() {
							setCopyFailed(true);
						},
					);
				} else {
					setCopyFailed(true);
				}
			};
			return h(
				'div',
				{ className: 'rdx-empty' },
				h('span', { className: 'rdx-empty-icon' }, h(Icon, { name: 'monitor', size: 40 })),
				h('h2', null, t('deploy.title')),
				h('p', null, t('deploy.intro')),
				h(
					'ol',
					null,
					h('li', null, t('deploy.step1')),
					h('li', null, t('deploy.step2')),
					h('li', null, t('deploy.step3')),
				),
				h(
					'details',
					{ className: 'rdx-guide' },
					h('summary', null, t('deploy.details')),
					h('pre', { className: 'rdx-code' }, command),
					h(
						'div',
						{ className: 'rdx-row' },
						h(Btn, { size: 'sm', icon: copied ? 'copy' : 'copy', onClick: copy }, copied ? t('common.copied') : t('common.copy')),
						copyFailed ? h('span', { className: 'rdx-error-text' }, t('common.copyFailed')) : null,
					),
					h('p', { className: 'rdx-hint' }, t('deploy.note')),
				),
				h(
					'button',
					{ type: 'button', className: 'rdx-btn rdx-btn-primary', onClick: props.onAdd },
					h(Icon, { name: 'plus', size: 14 }),
					h('span', { className: 'rdx-btn-label' }, t('panel.addHost')),
				),
			);
		}

		function ConnectCard(props) {
			const t = props.t;
			const host = props.host;
			const status = props.status || 'idle';
			const connecting = status === 'connecting';
			const showRetry = status === 'error' || status === 'closed';
			const errorText = props.notice ? describeError(t, props.notice.error) : '';
			return h(
				'div',
				{ className: 'rdx-main-empty' },
				h(
					'div',
					{ className: 'rdx-connect-card' },
					h('span', { className: 'rdx-empty-icon' }, h(Icon, { name: 'monitor', size: 40 })),
					h('h2', null, host.name),
					h('div', { className: 'rdx-addr' }, host.address),
					h('div', { className: 'rdx-row' }, h(StatusDot, { state: status }), h('span', { className: 'rdx-muted' }, t('state.' + status))),
					h('div', { className: 'rdx-row' }, h(Icon, { name: 'key', size: 14 }), h('span', { className: 'rdx-muted' }, host.password ? t('host.passwordSaved') : t('host.passwordMissing'))),
					errorText ? h('div', { className: 'rdx-error-text' }, errorText) : null,
					h(
						'div',
						{ className: 'rdx-row rdx-row-end' },
						h(Btn, { icon: 'edit', onClick: props.onEdit }, t('host.edit')),
						h(
							Btn,
							{ variant: 'primary', onClick: props.onConnect, disabled: connecting },
							connecting ? h(Spinner, { size: 13 }) : h(Icon, { name: showRetry ? 'refresh' : 'play', size: 14, key: 'action' }),
							h('span', { className: 'rdx-btn-label' }, connecting ? t('host.connecting') : showRetry ? t('host.reconnect') : t('host.connect')),
						),
					),
				),
			);
		}

		// ==================================================================
		// 9. ScreenSurface — canvas rendering + pointer/keyboard forwarding
		// ==================================================================

		function ScreenSurface(props) {
			const t = props.t;
			const client = props.client;
			const welcome = props.welcome;
			const captured = props.captured;
			const onCapturedChange = props.onCapturedChange;

			const wrapRef = useRef(null);
			const canvasRef = useRef(null);
			const cursorRef = useRef(null);
			const fitRef = useRef({ scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0, screenWidth: 0, screenHeight: 0 });
			const screenRef = useRef({ width: 0, height: 0 });
			const queueRef = useRef([]);
			const rafRef = useRef(0);
			const drawingRef = useRef(false);
			const decodeErrorRef = useRef(false);
			const [decodeError, setDecodeError] = useState(null);
			const [firstFrame, setFirstFrame] = useState(false);
			const firstFrameRef = useRef(false);
			const cursorDataRef = useRef({ x: 0, y: 0, buttons: 0, visible: false, have: false });
			const pointerInsideRef = useRef(false);
			const capturedRef = useRef(Boolean(captured));
			capturedRef.current = Boolean(captured);
			const pendingMoveRef = useRef(null);
			const moveRafRef = useRef(0);
			const aliveRef = useRef(true);
			const encodingRef = useRef(null);
			const onEncodingRef = useRef(props.onEncoding);
			onEncodingRef.current = props.onEncoding;
			useEffect(function trackAlive() {
				aliveRef.current = true;
				return function cleanup() {
					aliveRef.current = false;
				};
			}, []);

			const updateCursor = useCallback(function updateCursor() {
				const element = cursorRef.current;
				if (!element) return;
				const cursor = cursorDataRef.current;
				const fit = fitRef.current;
				if (!cursor.visible || !cursor.have || !fit.screenWidth || !fit.scale) {
					element.style.display = 'none';
					return;
				}
				element.style.display = 'block';
				element.style.left = fit.offsetX + cursor.x * fit.scale + 'px';
				element.style.top = fit.offsetY + cursor.y * fit.scale + 'px';
				element.setAttribute('data-down', cursor.buttons > 0 ? 'true' : 'false');
			}, []);

			const applyFit = useCallback(function applyFit() {
				const wrap = wrapRef.current;
				const canvas = canvasRef.current;
				if (!wrap || !canvas) return;
				const width = screenRef.current.width;
				const height = screenRef.current.height;
				if (!width || !height) return;
				const rect = wrap.getBoundingClientRect();
				const availableWidth = rect.width;
				const availableHeight = rect.height;
				if (!availableWidth || !availableHeight) return;
				const scale = Math.min(availableWidth / width, availableHeight / height);
				const drawWidth = width * scale;
				const drawHeight = height * scale;
				const offsetX = (availableWidth - drawWidth) / 2;
				const offsetY = (availableHeight - drawHeight) / 2;
				canvas.style.width = drawWidth + 'px';
				canvas.style.height = drawHeight + 'px';
				canvas.style.left = offsetX + 'px';
				canvas.style.top = offsetY + 'px';
				fitRef.current = {
					scale: scale,
					offsetX: offsetX,
					offsetY: offsetY,
					width: drawWidth,
					height: drawHeight,
					screenWidth: width,
					screenHeight: height,
				};
				updateCursor();
			}, [updateCursor]);

			// ---- canvas size from the agent's welcome -------------------------
			useEffect(function syncScreenSize() {
				const info = welcome && welcome.screen ? welcome.screen : null;
				const width = info && Number(info.width) > 0 ? Math.round(Number(info.width)) : 0;
				const height = info && Number(info.height) > 0 ? Math.round(Number(info.height)) : 0;
				if (!width || !height) return;
				const canvas = canvasRef.current;
				if (!canvas) return;
				if (screenRef.current.width !== width || screenRef.current.height !== height) {
					screenRef.current = { width: width, height: height };
					canvas.width = width;
					canvas.height = height;
					const context = canvas.getContext('2d', { alpha: false });
					if (context) {
						context.fillStyle = '#000000';
						context.fillRect(0, 0, width, height);
					}
				}
				applyFit();
			}, [welcome, applyFit]);

			// ---- letterbox fitting on container resize -----------------------
			useEffect(function observeContainer() {
				const wrap = wrapRef.current;
				if (!wrap) return undefined;
				let observer = null;
				if (typeof ResizeObserver === 'function') {
					observer = new ResizeObserver(function onResize() {
						applyFit();
					});
					observer.observe(wrap);
				}
				const onWindowResize = function onWindowResize() {
					applyFit();
				};
				window.addEventListener('resize', onWindowResize);
				applyFit();
				return function cleanup() {
					if (observer) observer.disconnect();
					window.removeEventListener('resize', onWindowResize);
				};
			}, [applyFit]);

			// ---- frame queue + rAF drain -------------------------------------
			const scheduleDrain = useCallback(function scheduleDrain() {
				if (rafRef.current) return;
				rafRef.current = requestAnimationFrame(function drainTick() {
					rafRef.current = 0;
					drainQueue();
				});
			}, []);

			const drawFrame = useCallback(async function drawFrame(item) {
				const canvas = canvasRef.current;
				if (!canvas || !item) return;
				const header = item.header;
				const payload = item.payload;
				const frameWidth = Number(header.width) > 0 ? Math.round(Number(header.width)) : 0;
				const frameHeight = Number(header.height) > 0 ? Math.round(Number(header.height)) : 0;
				if (frameWidth && frameHeight && (screenRef.current.width !== frameWidth || screenRef.current.height !== frameHeight)) {
					screenRef.current = { width: frameWidth, height: frameHeight };
					canvas.width = frameWidth;
					canvas.height = frameHeight;
					applyFit();
				}
				const context = canvas.getContext('2d', { alpha: false });
				if (!context) throw makeError('no_canvas');
				const encoding = header.encoding === 'jpeg' ? 'jpeg' : 'tiles';
				if (encoding === 'jpeg') {
					// Windows backends send one full JPEG frame per tick: no tiles,
					// no deflate stream, and the frame always covers the canvas.
					if (!canvas.width || !canvas.height) throw makeError('bad_frame', 'JPEG frame without a canvas size');
					await drawJpegFrame(context, payload, canvas.width, canvas.height);
				} else {
					const tiles = Array.isArray(header.tiles) ? header.tiles : [];
					for (const tile of tiles) {
						const tileWidth = Math.round(Number(tile.w));
						const tileHeight = Math.round(Number(tile.h));
						const offset = Math.round(Number(tile.off));
						const length = Math.round(Number(tile.len));
						if (!(tileWidth > 0) || !(tileHeight > 0) || !(length > 0) || offset < 0 || offset + length > payload.byteLength) {
							throw makeError('bad_tile', 'tile outside payload');
						}
						const rgba = await inflateDeflate(payload.subarray(offset, offset + length));
						const expected = tileWidth * tileHeight * 4;
						if (rgba.byteLength < expected) throw makeError('bad_tile', 'tile payload too small');
						let data;
						if (rgba.byteLength === expected) data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, expected);
						else data = new Uint8ClampedArray(rgba.slice(0, expected));
						context.putImageData(new ImageData(data, tileWidth, tileHeight), Math.round(Number(tile.x)), Math.round(Number(tile.y)));
					}
				}
				if (header.cursor) {
					cursorDataRef.current = {
						x: Number(header.cursor.x) || 0,
						y: Number(header.cursor.y) || 0,
						buttons: Number(header.cursor.buttons) || 0,
						visible: pointerInsideRef.current,
						have: true,
					};
					updateCursor();
				}
				if (decodeErrorRef.current) {
					// A later frame decoded fine (e.g. one corrupt JPEG): drop the
					// overlay without waiting for a manual retry.
					decodeErrorRef.current = false;
					if (aliveRef.current) setDecodeError(null);
				}
				if (!firstFrameRef.current) {
					firstFrameRef.current = true;
					if (aliveRef.current) setFirstFrame(true);
				}
			}, [applyFit, updateCursor]);

			const drainQueue = useCallback(async function drainQueue() {
				if (drawingRef.current) return;
				const canvas = canvasRef.current;
				if (!canvas) return;
				drawingRef.current = true;
				try {
					while (queueRef.current.length > 0 && aliveRef.current) {
						const item = queueRef.current.shift();
						await drawFrame(item);
					}
				} catch (error) {
					if (!decodeErrorRef.current) {
						decodeErrorRef.current = true;
						if (aliveRef.current) setDecodeError(errorPayload(error));
					}
					queueRef.current.length = 0;
				} finally {
					drawingRef.current = false;
				}
			}, [drawFrame]);

			useEffect(function subscribeFrames() {
				const offFrame = client.on('frame', function onFrame(item) {
					if (!item) return;
					const frameEncoding = item.header && item.header.encoding === 'jpeg' ? 'jpeg' : 'tiles';
					if (encodingRef.current !== frameEncoding) {
						encodingRef.current = frameEncoding;
						if (onEncodingRef.current) onEncodingRef.current(frameEncoding);
					}
					const queue = queueRef.current;
					if (frameEncoding === 'jpeg') {
						// A JPEG frame is a complete picture: when decoding falls
						// behind, only the newest one is worth painting.
						for (let index = queue.length - 1; index >= 0; index -= 1) {
							const queued = queue[index];
							if (queued && queued.header && queued.header.encoding === 'jpeg') queue.splice(index, 1);
						}
					}
					if (queue.length >= MAX_PENDING_FRAMES) {
						// We are too far behind to trust incremental tiles; drop the
						// backlog and ask for a fresh keyframe instead.
						queue.length = 0;
						client.refreshScreen();
					}
					queue.push(item);
					if (!rafRef.current && !drawingRef.current) scheduleDrain();
				});
				return function cleanup() {
					offFrame();
					if (rafRef.current) {
						cancelAnimationFrame(rafRef.current);
						rafRef.current = 0;
					}
					if (moveRafRef.current) {
						cancelAnimationFrame(moveRafRef.current);
						moveRafRef.current = 0;
					}
					queueRef.current.length = 0;
				};
			}, [client, scheduleDrain]);

			// ---- pointer input ------------------------------------------------
			useEffect(function bindPointerInput() {
				const canvas = canvasRef.current;
				if (!canvas) return undefined;
				const cleanups = [];
				const add = function add(target, type, handler, options) {
					target.addEventListener(type, handler, options);
					cleanups.push(function off() {
						target.removeEventListener(type, handler, options);
					});
				};
				const toRemote = function toRemote(clientX, clientY) {
					const fit = fitRef.current;
					if (!fit.scale || !fit.screenWidth || !fit.screenHeight) return null;
					const rect = canvas.getBoundingClientRect();
					if (!rect.width || !rect.height) return null;
					const x = Math.round((clientX - rect.left) / fit.scale);
					const y = Math.round((clientY - rect.top) / fit.scale);
					return {
						x: Math.max(0, Math.min(fit.screenWidth - 1, x)),
						y: Math.max(0, Math.min(fit.screenHeight - 1, y)),
					};
				};
				const sendMouse = function sendMouse(action, event, button) {
					const point = toRemote(event.clientX, event.clientY);
					if (!point) return;
					const message = { t: 'mouse', action: action, x: point.x, y: point.y };
					if (button !== undefined) message.button = button;
					client.sendInput(message);
				};
				add(
					canvas,
					'pointermove',
					function onPointerMove(event) {
						pendingMoveRef.current = { clientX: event.clientX, clientY: event.clientY };
						if (moveRafRef.current) return;
						moveRafRef.current = requestAnimationFrame(function flushMove() {
							moveRafRef.current = 0;
							const pending = pendingMoveRef.current;
							if (!pending) return;
							pendingMoveRef.current = null;
							sendMouse('move', pending);
						});
					},
					false,
				);
				add(canvas, 'pointerdown', function onPointerDown(event) {
					if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
					event.preventDefault();
					try {
						canvas.focus({ preventScroll: true });
					} catch (error) {
						try {
							canvas.focus();
						} catch (focusError) {
							/* noop */
						}
					}
					onCapturedChange(true);
					try {
						canvas.setPointerCapture(event.pointerId);
					} catch (error) {
						/* pointer capture is best-effort */
					}
					sendMouse('move', event);
					sendMouse('down', event, event.button);
				});
				add(canvas, 'pointerup', function onPointerUp(event) {
					event.preventDefault();
					sendMouse('up', event, event.button);
					try {
						if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
					} catch (error) {
						/* noop */
					}
				});
				add(canvas, 'pointercancel', function onPointerCancel(event) {
					sendMouse('up', event, event.button);
				});
				add(canvas, 'pointerenter', function onPointerEnter() {
					pointerInsideRef.current = true;
					cursorDataRef.current = Object.assign({}, cursorDataRef.current, { visible: true });
					updateCursor();
				});
				add(canvas, 'pointerleave', function onPointerLeave() {
					pointerInsideRef.current = false;
					cursorDataRef.current = Object.assign({}, cursorDataRef.current, { visible: false });
					updateCursor();
				});
				add(canvas, 'contextmenu', function onContextMenu(event) {
					event.preventDefault();
				});
				add(canvas, 'dragstart', function onDragStart(event) {
					event.preventDefault();
				});
				add(
					canvas,
					'wheel',
					function onWheel(event) {
						event.preventDefault();
						const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
						client.sendInput({
							t: 'wheel',
							dx: Math.round(event.deltaX * factor),
							dy: Math.round(event.deltaY * factor),
						});
					},
					{ passive: false },
				);
				return function cleanup() {
					for (const off of cleanups) off();
					if (moveRafRef.current) {
						cancelAnimationFrame(moveRafRef.current);
						moveRafRef.current = 0;
					}
				};
			}, [client, onCapturedChange, updateCursor]);

			// ---- keyboard capture --------------------------------------------
			useEffect(function bindKeyboard() {
				if (!captured) return undefined;
				const release = function release() {
					try {
						client.releaseAll();
					} catch (error) {
						/* socket may already be gone */
					}
					onCapturedChange(false);
				};
				const sendKey = function sendKey(event, down) {
					if (event.isComposing) return;
					event.preventDefault();
					event.stopPropagation();
					client.sendInput({
						t: 'key',
						code: event.code,
						key: event.key,
						down: down,
						mods: {
							shift: Boolean(event.shiftKey),
							ctrl: Boolean(event.ctrlKey),
							alt: Boolean(event.altKey),
							meta: Boolean(event.metaKey),
						},
					});
				};
				const onKeyDown = function onKeyDown(event) {
					sendKey(event, true);
				};
				const onKeyUp = function onKeyUp(event) {
					sendKey(event, false);
				};
				const onWindowBlur = function onWindowBlur() {
					release();
				};
				const onVisibilityChange = function onVisibilityChange() {
					if (document.visibilityState === 'hidden') release();
				};
				const onPointerDownOutside = function onPointerDownOutside(event) {
					const canvas = canvasRef.current;
					if (canvas && event.target && canvas.contains(event.target)) return;
					release();
				};
				window.addEventListener('keydown', onKeyDown, true);
				window.addEventListener('keyup', onKeyUp, true);
				window.addEventListener('blur', onWindowBlur);
				window.addEventListener('pointerdown', onPointerDownOutside, true);
				document.addEventListener('visibilitychange', onVisibilityChange);
				return function cleanup() {
					window.removeEventListener('keydown', onKeyDown, true);
					window.removeEventListener('keyup', onKeyUp, true);
					window.removeEventListener('blur', onWindowBlur);
					window.removeEventListener('pointerdown', onPointerDownOutside, true);
					document.removeEventListener('visibilitychange', onVisibilityChange);
				};
			}, [captured, client, onCapturedChange]);

			// Release every remote key when the capture ends or the surface goes away.
			const wasCapturedRef = useRef(false);
			useEffect(function releaseKeysOnCaptureEnd() {
				const was = wasCapturedRef.current;
				wasCapturedRef.current = captured;
				if (was && !captured) client.releaseAll();
			}, [captured, client]);
			useEffect(function releaseKeysOnUnmount() {
				return function cleanup() {
					if (capturedRef.current) client.releaseAll();
				};
			}, [client]);

			const screenMissing = Boolean(welcome && welcome.capabilities && welcome.capabilities.screen === false);
			const showWaiting = !firstFrame && !decodeError && !screenMissing;

			return h(
				'div',
				{ className: 'rdx-screen-wrap', ref: wrapRef },
				h('canvas', {
					ref: canvasRef,
					className: 'rdx-canvas',
					tabIndex: 0,
					style: { width: 0, height: 0, left: 0, top: 0 },
					'aria-label': props.canvasLabel,
				}),
				h(
					'svg',
					{
						ref: cursorRef,
						className: 'rdx-screen-cursor',
						viewBox: '0 0 16 16',
						width: 16,
						height: 16,
						'aria-hidden': 'true',
					},
					h('path', {
						d: 'M1 1l5.4 13.2 1.9-5.3 5.3-1.9z',
						fill: '#ffffff',
						stroke: '#000000',
						strokeWidth: 1.1,
						strokeLinejoin: 'round',
					}),
				),
				screenMissing
					? h('div', { className: 'rdx-screen-overlay' }, t('session.noScreen'))
					: null,
				decodeError
					? h(
							'div',
							{ className: 'rdx-screen-overlay' },
							h(
								'div',
								{ className: 'rdx-screen-error' },
								h('div', null, decodeError.code === 'no_decompression' ? t('session.decodeUnsupported') : decodeError.code === 'no_image_decoder' ? t('session.jpegUnsupported') : decodeError.code === 'decode_failed' ? t('session.decodeFailed') : describeError(t, decodeError)),
								h(Btn, { size: 'sm', icon: 'refresh', onClick: function reload() { decodeErrorRef.current = false; setDecodeError(null); client.refreshScreen(); } }, t('common.retry')),
							),
						)
					: null,
				showWaiting ? h('div', { className: 'rdx-screen-overlay rdx-pass-through' }, t('session.waitingFrame')) : null,
				h('div', { className: 'rdx-screen-hint' }, captured ? t('session.keyboardCaptured') : t('session.screenHint')),
			);
		}

		// ==================================================================
		// 10. FileBrowser drawer
		// ==================================================================

		function FileBrowser(props) {
			const t = props.t;
			const client = props.client;
			const onError = props.onError;
			const onPathChange = props.onPathChange;
			const initialPathRef = useRef(props.initialPath || '/');
			const entryPathRef = useRef(initialPathRef.current);

			const [pathInput, setPathInput] = useState(initialPathRef.current);
			const [entryPath, setEntryPath] = useState(initialPathRef.current);
			const [data, setData] = useState(null);
			const [loading, setLoading] = useState(false);
			const [busy, setBusy] = useState('');
			const [dialog, setDialog] = useState(null);
			const [dialogValue, setDialogValue] = useState('');
			const [dialogError, setDialogError] = useState('');
			const [dialogBusy, setDialogBusy] = useState(false);
			const uploadRef = useRef(null);
			const requestRef = useRef(0);

			const reportError = useCallback(function reportError(error) {
				onError(Object.assign({ source: 'files' }, errorPayload(error)));
			}, [onError]);

			const load = useCallback(async function load(target, quiet) {
				const request = ++requestRef.current;
				if (!quiet) setLoading(true);
				try {
					const result = await client.listFiles(target);
					if (requestRef.current !== request) return;
					const nextPath = (result && result.path) || target;
					setData(result || { entries: [] });
					setEntryPath(nextPath);
					entryPathRef.current = nextPath;
					setPathInput(nextPath);
					if (onPathChange) onPathChange(nextPath);
				} catch (error) {
					if (requestRef.current !== request) return;
					reportError(error);
				} finally {
					if (requestRef.current === request) setLoading(false);
				}
			}, [client, onPathChange, reportError]);

			useEffect(function loadInitialPath() {
				load(initialPathRef.current);
			}, [load]);

			const go = useCallback(function go(target) {
				if (!target) return;
				setPathInput(target);
				load(target);
			}, [load]);

			const goUp = function goUp() {
				const parent = data && data.parent ? data.parent : null;
				if (parent) go(parent);
			};

			const refresh = function refresh() {
				load(entryPathRef.current, true);
			};

			const download = async function download(entry) {
				setBusy(t('files.downloading', { name: entry.name }));
				try {
					await client.downloadFile(joinPath(entryPathRef.current, entry.name));
				} catch (error) {
					reportError(error);
				} finally {
					setBusy('');
				}
			};

			const onPickFiles = async function onPickFiles(event) {
				const files = Array.from(event.target.files || []);
				event.target.value = '';
				if (files.length === 0) return;
				const target = entryPathRef.current;
				for (const file of files) {
					setBusy(t('files.uploading', { name: file.name }));
					try {
						await client.uploadFile(target, file);
					} catch (error) {
						reportError(error);
						break;
					}
				}
				setBusy('');
				await load(target, true);
			};

			const openDialog = function openDialog(kind, entry) {
				setDialog({ kind: kind, entry: entry || null });
				setDialogValue(entry ? entry.name : '');
				setDialogError('');
				setDialogBusy(false);
			};

			const closeDialog = function closeDialog() {
				if (dialogBusy) return;
				setDialog(null);
				setDialogError('');
			};

			const submitDialog = async function submitDialog(event) {
				if (event) event.preventDefault();
				if (!dialog) return;
				const value = String(dialogValue || '').trim();
				if (!value) {
					setDialogError(t('files.nameRequired'));
					return;
				}
				if (value.indexOf('/') >= 0 || value === '.' || value === '..') {
					setDialogError(t('files.nameInvalid'));
					return;
				}
				const target = entryPathRef.current;
				setDialogBusy(true);
				try {
					if (dialog.kind === 'mkdir') await client.mkdir(joinPath(target, value));
					else if (dialog.kind === 'rename' && dialog.entry) await client.rename(joinPath(target, dialog.entry.name), joinPath(target, value));
					setDialog(null);
					setDialogError('');
					await load(target, true);
				} catch (error) {
					setDialogError(describeError(t, errorPayload(error)));
				} finally {
					setDialogBusy(false);
				}
			};

			const removeEntry = async function removeEntry(entry) {
				const full = joinPath(entryPathRef.current, entry.name);
				const isDir = entry.type === 'dir';
				if (!askConfirm(t('files.deleteConfirm', { name: entry.name }))) return;
				if (isDir && !askConfirm(t('files.deleteDirConfirm', { name: entry.name }))) return;
				setBusy(t('files.deleting', { name: entry.name }));
				try {
					await client.remove(full, isDir);
					await load(entryPathRef.current, true);
				} catch (error) {
					reportError(error);
				} finally {
					setBusy('');
				}
			};

			const crumbs = useMemo(function buildCrumbs() {
				return breadcrumbParts(entryPath);
			}, [entryPath]);

			const entries = data && Array.isArray(data.entries) ? data.entries : [];
			const root = client.welcome && client.welcome.fsRoot ? client.welcome.fsRoot : null;

			const rows = entries.map(function renderEntry(entry) {
				const isDir = entry.type === 'dir';
				const iconName = isDir ? 'folder' : entry.type === 'symlink' ? 'link' : 'file';
				return h(
					'div',
					{
						key: entry.name,
						className: 'rdx-file-row',
						onClick: function openEntry() {
							if (isDir) go(joinPath(entryPath, entry.name));
						},
						onDoubleClick: function onDouble() {
							if (!isDir) download(entry);
						},
						title: entry.name,
					},
					h('span', { className: 'rdx-file-icon' }, h(Icon, { name: iconName, size: 15 })),
					h('span', { className: 'rdx-file-name' }, entry.name),
					h('span', { className: 'rdx-file-size' }, isDir ? '—' : humanSize(entry.size)),
					h('span', { className: 'rdx-file-time' }, formatMtime(entry.mtimeMs)),
					h(
						'span',
						{ className: 'rdx-file-actions' },
						!isDir
							? h(
									'button',
									{
										type: 'button',
										className: 'rdx-iconbtn',
										title: t('files.download'),
										'aria-label': t('files.download'),
										onClick: function onDownload(event) {
											event.stopPropagation();
											download(entry);
										},
									},
									h(Icon, { name: 'download', size: 14 }),
								)
							: null,
						h(
							'button',
							{
								type: 'button',
								className: 'rdx-iconbtn',
								title: t('files.rename'),
								'aria-label': t('files.rename'),
								onClick: function onRename(event) {
									event.stopPropagation();
									openDialog('rename', entry);
								},
							},
							h(Icon, { name: 'edit', size: 14 }),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'rdx-iconbtn rdx-iconbtn-danger',
								title: t('files.delete'),
								'aria-label': t('files.delete'),
								onClick: function onDelete(event) {
									event.stopPropagation();
									removeEntry(entry);
								},
							},
							h(Icon, { name: 'trash', size: 14 }),
						),
					),
				);
			});

			const crumbNodes = [];
			crumbs.forEach(function addCrumb(crumb, index) {
				if (index > 0) crumbNodes.push(h('span', { key: 'sep-' + crumb.path, className: 'rdx-crumb-sep' }, '/'));
				crumbNodes.push(
					h(
						'button',
						{
							key: 'crumb-' + crumb.path,
							type: 'button',
							className: 'rdx-crumb',
							title: crumb.path,
							onClick: function openCrumb() {
								go(crumb.path);
							},
						},
						crumb.label,
					),
				);
			});

			return h(
				'div',
				{ className: 'rdx-files' },
				h(
					'div',
					{ className: 'rdx-pathbar' },
					h(
						'button',
						{ type: 'button', className: 'rdx-iconbtn', title: t('files.up'), 'aria-label': t('files.up'), onClick: goUp, disabled: !data || !data.parent },
						h(Icon, { name: 'arrowLeft', size: 15 }),
					),
					h('input', {
						className: 'rdx-input',
						value: pathInput,
						placeholder: t('files.pathPlaceholder'),
						spellCheck: false,
						onChange: function change(event) {
							setPathInput(event.target.value);
						},
						onKeyDown: function onKey(event) {
							if (event.key === 'Enter') {
								event.preventDefault();
								go(pathInput);
							}
						},
					}),
					h(
						'button',
						{ type: 'button', className: 'rdx-iconbtn', title: t('files.refresh'), 'aria-label': t('files.refresh'), onClick: refresh },
						h(Icon, { name: 'refresh', size: 15 }),
					),
					h(
						'button',
						{ type: 'button', className: 'rdx-iconbtn', title: t('files.upload'), 'aria-label': t('files.upload'), onClick: function pick() { if (uploadRef.current) uploadRef.current.click(); } },
						h(Icon, { name: 'upload', size: 15 }),
					),
					h(
						'button',
						{ type: 'button', className: 'rdx-iconbtn', title: t('files.mkdir'), 'aria-label': t('files.mkdir'), onClick: function mkdir() { openDialog('mkdir', null); } },
						h(Icon, { name: 'folderPlus', size: 15 }),
					),
					h('input', { ref: uploadRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: onPickFiles }),
				),
				h('div', { className: 'rdx-crumbs' }, crumbNodes),
				h(
					'div',
					{ className: 'rdx-filelist' },
					loading && entries.length === 0 ? h('div', { className: 'rdx-files-empty' }, t('files.loading')) : null,
					!loading && entries.length === 0 ? h('div', { className: 'rdx-files-empty' }, t('files.empty')) : null,
					rows,
				),
				busy ? h('div', { className: 'rdx-files-status' }, h(Spinner, { size: 12 }), busy) : null,
				root ? h('div', { className: 'rdx-files-status' }, t('files.root', { root: root })) : null,
				dialog
					? h(
							Modal,
							{
								t: t,
								title: dialog.kind === 'mkdir' ? t('files.newFolderTitle') : t('files.renameTitle'),
								onClose: closeDialog,
								footer: [
									h(Btn, { key: 'cancel', onClick: closeDialog }, t('common.cancel')),
									h(Btn, { key: 'ok', variant: 'primary', onClick: submitDialog, disabled: dialogBusy }, dialog.kind === 'mkdir' ? t('common.create') : t('common.save')),
								],
							},
							h(
								'form',
								{ className: 'rdx-form', onSubmit: submitDialog },
								h('div', { className: 'rdx-field' }, h('span', { className: 'rdx-field-label' }, t('files.nameLabel')), h('input', { className: 'rdx-input', value: dialogValue, autoFocus: true, onChange: function change(event) { setDialogValue(event.target.value); } })),
								dialogError ? h('div', { className: 'rdx-error-text' }, dialogError) : null,
							),
						)
					: null,
			);
		}

		// ==================================================================
		// 11. MiniVT + TerminalConsole drawer
		// ==================================================================

		/**
		 * Minimal VT100-ish line buffer. It intentionally models the stream as a
		 * scrollback of lines (not a fixed-size screen): CR returns to column 0,
		 * LF opens the next line, BS moves back, and CSI K/J/H plus SGR are
		 * recognised; every other CSI/OSC/ESC sequence is stripped. That is enough
		 * for a command shell whose output must stay readable.
		 */
		class MiniVT {
			constructor(limit) {
				this.limit = limit || SHELL_SCROLLBACK_LIMIT;
				this.lines = [''];
				this.row = 0;
				this.col = 0;
				this.pending = '';
			}

			clear() {
				this.lines = [''];
				this.row = 0;
				this.col = 0;
				this.pending = '';
			}

			toString() {
				return this.lines.join('\n');
			}

			_trim() {
				if (this.lines.length <= this.limit) return;
				const drop = this.lines.length - this.limit;
				this.lines.splice(0, drop);
				this.row = Math.max(0, this.row - drop);
			}

			_put(text) {
				if (!text) return;
				const line = this.lines[this.row] || '';
				let next;
				if (line.length >= this.col) {
					next = line.slice(0, this.col) + text + line.slice(this.col + text.length);
				} else {
					next = line + ' '.repeat(this.col - line.length) + text;
				}
				this.lines[this.row] = next;
				this.col += text.length;
			}

			_newLine() {
				if (this.row < this.lines.length - 1) {
					this.row += 1;
					this.col = 0;
					return;
				}
				this.lines.push('');
				this.row = this.lines.length - 1;
				this.col = 0;
				this._trim();
			}

			_eraseLine(mode) {
				const line = this.lines[this.row] || '';
				if (mode === 1) this.lines[this.row] = ' '.repeat(this.col) + line.slice(this.col);
				else if (mode === 2) this.lines[this.row] = '';
				else this.lines[this.row] = line.slice(0, this.col);
			}

			_eraseDisplay(mode) {
				if (mode === 2 || mode === 3) {
					this.clear();
					return;
				}
				if (mode === 1) {
					for (let index = 0; index < this.row; index += 1) this.lines[index] = '';
					this.lines[this.row] = (this.lines[this.row] || '').slice(this.col);
					return;
				}
				this.lines[this.row] = (this.lines[this.row] || '').slice(0, this.col);
				this.lines.length = this.row + 1;
			}

			_csi(final, params) {
				if (final === 'K') {
					this._eraseLine(params.length ? Number(params[0]) || 0 : 0);
					return;
				}
				if (final === 'J') {
					this._eraseDisplay(params.length ? Number(params[0]) || 0 : 0);
					return;
				}
				if (final === 'H' || final === 'f') {
					// Scrollback model: CUP can only place the column; a following
					// clear already reset the welcome position to the last line.
					this.row = this.lines.length - 1;
					this.col = 0;
					return;
				}
				if (final === 'm') return;
			}

			write(chunk) {
				if (!chunk) return;
				const data = this.pending + chunk;
				this.pending = '';
				let index = 0;
				while (index < data.length) {
					const character = data.charAt(index);
					if (character === '\x1b') {
						const next = this._escape(data, index);
						if (next === null) {
							this.pending = data.slice(index);
							if (this.pending.length > 256) this.pending = '';
							return;
						}
						index = next;
						continue;
					}
					if (character === '\r') {
						this.col = 0;
						index += 1;
						continue;
					}
					if (character === '\n') {
						this._newLine();
						index += 1;
						continue;
					}
					if (character === '\b') {
						this.col = Math.max(0, this.col - 1);
						index += 1;
						continue;
					}
					if (character === '\t') {
						const spaces = 4 - (this.col % 4);
						this._put(' '.repeat(spaces));
						index += 1;
						continue;
					}
					if (character === '\x07') {
						index += 1;
						continue;
					}
					if (character < ' ') {
						index += 1;
						continue;
					}
					this._put(character);
					index += 1;
				}
			}

			_escape(data, start) {
				const next = data.charAt(start + 1);
				if (!next) return null;
				if (next === '[') {
					let cursor = start + 2;
					while (cursor < data.length) {
						const code = data.charCodeAt(cursor);
						if (code >= 0x40 && code <= 0x7e) {
							const body = data.slice(start + 2, cursor);
							this._csi(data.charAt(cursor), body ? body.replace(/^[?]/, '').split(';') : []);
							return cursor + 1;
						}
						if (!((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f))) {
							return cursor + 1;
						}
						cursor += 1;
					}
					return null;
				}
				if (next === ']') {
					let cursor = start + 2;
					while (cursor < data.length) {
						const character = data.charAt(cursor);
						if (character === '\x07') return cursor + 1;
						if (character === '\x1b' && data.charAt(cursor + 1) === '\\') return cursor + 2;
						cursor += 1;
					}
					return null;
				}
				return start + 2;
			}
		}

		function askConfirm(message) {
			if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
			try {
				return window.confirm(message);
			} catch (error) {
				return true;
			}
		}

		function TerminalConsole(props) {
			const t = props.t;
			const client = props.client;
			const capabilities = props.capabilities || {};
			const cwd = props.cwd || '/';
			const supported = capabilities.shell !== false;

			const vtRef = useRef(null);
			if (vtRef.current === null) vtRef.current = new MiniVT(SHELL_SCROLLBACK_LIMIT);
			const decoderRef = useRef(null);
			if (decoderRef.current === null && typeof TextDecoder === 'function') decoderRef.current = new TextDecoder('utf-8');
			const outputRef = useRef(null);
			const [text, setText] = useState('');
			const [running, setRunning] = useState(false);
			const [starting, setStarting] = useState(false);
			const [exitCode, setExitCode] = useState(null);
			const [command, setCommand] = useState('');
			const [history, setHistory] = useState([]);
			const historyIndexRef = useRef(-1);
			const stickRef = useRef(true);
			const flushPendingRef = useRef(false);
			const rafRef = useRef(0);
			const unmountedRef = useRef(false);

			const scheduleFlush = useCallback(function scheduleFlush() {
				if (flushPendingRef.current) return;
				flushPendingRef.current = true;
				rafRef.current = requestAnimationFrame(function flush() {
					rafRef.current = 0;
					flushPendingRef.current = false;
					if (unmountedRef.current || !vtRef.current) return;
					setText(vtRef.current.toString());
				});
			}, []);

			useEffect(function subscribeShell() {
				unmountedRef.current = false;
				const offData = client.on('shell-data', function onShellData(payload) {
					if (unmountedRef.current || !vtRef.current || !payload) return;
					let decoded = '';
					try {
						decoded = decoderRef.current ? decoderRef.current.decode(payload.data, { stream: true }) : new TextDecoder().decode(payload.data);
					} catch (error) {
						decoded = '';
					}
					vtRef.current.write(decoded);
					scheduleFlush();
				});
				const offStarted = client.on('shell-started', function onShellStarted() {
					if (unmountedRef.current) return;
					setRunning(true);
					setStarting(false);
					setExitCode(null);
				});
				const offExit = client.on('shell-exit', function onShellExit(message) {
					if (unmountedRef.current) return;
					setRunning(false);
					setStarting(false);
					setExitCode(message && typeof message.code === 'number' ? message.code : 0);
				});
				const offError = client.on('error', function onShellError(error) {
					if (unmountedRef.current || !error) return;
					if (error.code === 'no_shell') setStarting(false);
				});
				return function cleanup() {
					unmountedRef.current = true;
					offData();
					offStarted();
					offExit();
					offError();
					if (rafRef.current) {
						cancelAnimationFrame(rafRef.current);
						rafRef.current = 0;
					}
				};
			}, [client, scheduleFlush]);

			useEffect(function startShellOnMount() {
				if (!supported) return undefined;
				setStarting(true);
				client.startShell(120, 32, cwd);
				return function stopShellOnUnmount() {
					client.stopShell();
				};
			}, [client, supported]);

			useEffect(function followOutput() {
				const element = outputRef.current;
				if (!element || !stickRef.current) return;
				element.scrollTop = element.scrollHeight;
			}, [text]);

			const shellInput = function shellInput(data) {
				if (!supported) return;
				client.shellInput(data);
			};

			const runCommand = function runCommand(value) {
				const line = String(value || '');
				if (!line) return;
				shellInput(line + '\r');
				setHistory(function push(item) {
					const next = item.concat([line]);
					return next.length > 100 ? next.slice(next.length - 100) : next;
				});
				historyIndexRef.current = -1;
				setCommand('');
			};

			const onCommandSubmit = function onCommandSubmit(event) {
				if (event) event.preventDefault();
				runCommand(command);
			};

			const onOutputKeyDown = function onOutputKeyDown(event) {
				if (event.isComposing) return;
				const key = event.key;
				let data = null;
				if (event.ctrlKey && (key === 'c' || key === 'C')) data = '\x03';
				else if (event.ctrlKey && (key === 'l' || key === 'L')) data = '\x0c';
				else if (event.ctrlKey) return;
				else if (key === 'Enter') data = '\r';
				else if (key === 'Backspace') data = '\x7f';
				else if (key === 'Tab') data = '\t';
				else if (key === 'Escape') data = '\x1b';
				else if (key === 'ArrowUp') data = '\x1b[A';
				else if (key === 'ArrowDown') data = '\x1b[B';
				else if (key === 'ArrowRight') data = '\x1b[C';
				else if (key === 'ArrowLeft') data = '\x1b[D';
				else if (key === 'Home') data = '\x1b[H';
				else if (key === 'End') data = '\x1b[F';
				else if (key === 'Delete') data = '\x1b[3~';
				else if (key === 'PageUp') data = '\x1b[5~';
				else if (key === 'PageDown') data = '\x1b[6~';
				else if (key.length === 1) data = key;
				else return;
				event.preventDefault();
				event.stopPropagation();
				shellInput(data);
			};

			const onCommandKeyDown = function onCommandKeyDown(event) {
				if (event.key === 'ArrowUp') {
					if (history.length === 0) return;
					event.preventDefault();
					const current = historyIndexRef.current < 0 ? history.length : historyIndexRef.current;
					const next = Math.max(0, current - 1);
					historyIndexRef.current = next;
					setCommand(history[next] || '');
					return;
				}
				if (event.key === 'ArrowDown') {
					if (historyIndexRef.current < 0) return;
					event.preventDefault();
					const next = historyIndexRef.current + 1;
					if (next >= history.length) {
						historyIndexRef.current = -1;
						setCommand('');
					} else {
						historyIndexRef.current = next;
						setCommand(history[next] || '');
					}
				}
			};

			const clearOutput = function clearOutput() {
				if (vtRef.current) vtRef.current.clear();
				setText('');
			};

			const restartShell = function restartShell() {
				if (!supported) return;
				setStarting(true);
				setExitCode(null);
				client.stopShell();
				client.startShell(120, 32, cwd);
			};

			const stopShell = function stopShell() {
				if (!supported) return;
				client.stopShell();
				setRunning(false);
				setStarting(false);
			};

			const onScroll = function onScroll() {
				const element = outputRef.current;
				if (!element) return;
				stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
			};

			if (!supported) {
				return h('div', { className: 'rdx-terminal' }, h('div', { className: 'rdx-term-unsupported' }, h(Icon, { name: 'terminal', size: 22 }), h('div', null, t('terminal.unsupported'))));
			}

			const statusText = running ? t('terminal.running') : starting ? t('terminal.starting') : exitCode !== null ? t('terminal.exited', { code: exitCode }) : t('terminal.stopped');

			return h(
				'div',
				{ className: 'rdx-terminal' },
				h(
					'div',
					{ className: 'rdx-term-toolbar' },
					h(StatusDot, { state: running ? 'connected' : starting ? 'connecting' : 'idle' }),
					h('span', { className: 'rdx-term-status-text' }, statusText),
					h('span', { className: 'rdx-toolbar-spacer' }),
					h(Btn, { size: 'sm', icon: 'clear', title: t('terminal.clear'), onClick: clearOutput }, t('terminal.clear')),
					h(Btn, { size: 'sm', icon: 'restart', title: t('terminal.restart'), onClick: restartShell }, t('terminal.restart')),
					h(Btn, { size: 'sm', icon: 'stop', title: t('terminal.stop'), onClick: stopShell, disabled: !running && !starting }, t('terminal.stop')),
				),
				h('pre', {
					ref: outputRef,
					className: 'rdx-term-output',
					tabIndex: 0,
					onKeyDown: onOutputKeyDown,
					onScroll: onScroll,
					role: 'log',
					'aria-label': t('terminal.title'),
				}, text),
				h(
					'form',
					{ className: 'rdx-term-form', onSubmit: onCommandSubmit },
					h('span', { className: 'rdx-term-prompt' }, '>'),
					h('input', {
						className: 'rdx-input',
						value: command,
						placeholder: t('terminal.commandPlaceholder'),
						autoComplete: 'off',
						spellCheck: false,
						onChange: function change(event) {
							setCommand(event.target.value);
						},
						onKeyDown: onCommandKeyDown,
					}),
					h(Btn, { type: 'submit', size: 'sm', icon: 'play', title: t('terminal.send') }, t('terminal.send')),
				),
				h('div', { className: 'rdx-term-hint' }, t('terminal.hint')),
			);
		}

		// ==================================================================
		// 12. SessionView (toolbar + screen + drawers + error bar)
		// ==================================================================

		function SessionView(props) {
			const t = props.t;
			const client = props.client;
			const host = props.host;
			const status = props.status;
			const stateInfo = props.stateInfo;
			const welcome = props.welcome;
			const notice = props.notice;
			const onClearError = props.onClearError;
			const onDisconnect = props.onDisconnect;
			const onError = props.onError;

			const [fps, setFps] = useState(function initialFps() {
				return client && client.fps ? client.fps : 15;
			});
			const [quality, setQuality] = useState(function initialQuality() {
				return client && client.quality ? client.quality : DEFAULT_QUALITY;
			});
			const [encoding, setEncoding] = useState(null);
			const [drawer, setDrawer] = useState(null);
			const [captured, setCaptured] = useState(false);
			const [pasteOpen, setPasteOpen] = useState(false);
			const [cwd, setCwd] = useState(function initialCwd() {
				return welcome && welcome.fsRoot ? welcome.fsRoot : '/';
			});
			const cwdRef = useRef(cwd);
			cwdRef.current = cwd;
			const qualityRef = useRef(quality);
			qualityRef.current = quality;
			const screenAvailable = Boolean(welcome && welcome.screen);
			const platformName = platformLabel(t, welcome && welcome.agent ? welcome.agent.platform : null);
			const encodingName = encodingLabel(t, encoding);

			const handleCapturedChange = useCallback(function handleCapturedChange(next) {
				setCaptured(Boolean(next));
			}, []);

			useEffect(function driveScreenSubscription() {
				if (status !== 'connected' && status !== 'reconnecting') return undefined;
				client.startScreen(fps, qualityRef.current);
				return function stopScreen() {
					client.stopScreen();
				};
			}, [client, status]);

			useEffect(function releaseWhenNotConnected() {
				if (status !== 'connected' && status !== 'reconnecting' && captured) setCaptured(false);
			}, [status, captured]);

			const changeFps = function changeFps(value) {
				const next = Number(value);
				if (!Number.isFinite(next)) return;
				setFps(next);
				client.setFps(next);
			};

			const changeQuality = function changeQuality(value) {
				const next = Number(value);
				if (!Number.isFinite(next)) return;
				setQuality(next);
				// Re-sending screen.start updates the running session's quality without
				// opening a second subscription (the agent records quality per session).
				client.setQuality(next);
			};

			const releaseKeyboard = function releaseKeyboard() {
				setCaptured(false);
			};

			const toggleDrawer = function toggleDrawer(name) {
				if (pasteOpen) setPasteOpen(false);
				setDrawer(function swap(current) {
					return current === name ? null : name;
				});
			};

			const confirmDisconnect = function confirmDisconnect() {
				if (!askConfirm(t('host.disconnectConfirm'))) return;
				onDisconnect();
			};

			const sendPaste = function sendPaste(value) {
				if (!value) return;
				client.sendInput({ t: 'text', text: value });
			};

			const openPaste = function openPaste() {
				setPasteOpen(true);
			};

			const closePaste = function closePaste() {
				setPasteOpen(false);
			};

			const reconnecting = status === 'reconnecting';

			return h(
				'div',
				{ className: 'rdx-session' },
				h(
					'div',
					{ className: 'rdx-toolbar' },
					h(
						'div',
						{ className: 'rdx-toolbar-title' },
						h(StatusDot, { state: status }),
						h('span', { className: 'rdx-toolbar-host' }, host.name),
						platformName || encodingName
							? h(
									'span',
									{ className: 'rdx-toolbar-meta' },
									platformName ? h('span', { className: 'rdx-toolbar-chip', title: t('toolbar.platform') }, platformName) : null,
									encodingName ? h('span', { className: 'rdx-toolbar-chip', title: t('toolbar.encoding') }, encodingName) : null,
								)
							: null,
						reconnecting
							? h('span', { className: 'rdx-muted rdx-toolbar-note' }, t('session.reconnecting', {
									attempt: stateInfo && stateInfo.attempt ? stateInfo.attempt : 1,
									max: stateInfo && stateInfo.max ? stateInfo.max : MAX_RECONNECT,
								}))
							: null,
					),
					h('span', { className: 'rdx-toolbar-spacer' }),
					h(
						'label',
						{ className: 'rdx-fps' },
						h('span', { className: 'rdx-muted' }, t('toolbar.fps')),
						h(
							'select',
							{
								className: 'rdx-select',
								value: String(fps),
								onChange: function change(event) {
									changeFps(event.target.value);
								},
							},
							FPS_OPTIONS.map(function renderOption(option) {
								return h('option', { key: option, value: String(option) }, t('toolbar.fpsOption', { fps: option }));
							}),
						),
					),
					screenAvailable
						? h(
								'label',
								{ className: 'rdx-fps', title: t('toolbar.qualityHint') },
								h('span', { className: 'rdx-muted' }, t('toolbar.quality')),
								h(
									'select',
									{
										className: 'rdx-select',
										value: String(quality),
										onChange: function change(event) {
											changeQuality(event.target.value);
										},
									},
									QUALITY_OPTIONS.map(function renderQuality(option) {
										return h('option', { key: option, value: String(option) }, t(QUALITY_LABEL_KEYS[option] || 'toolbar.quality65', { value: option }));
									}),
								),
							)
						: null,
					h(Btn, { size: 'sm', icon: 'refreshScreen', title: t('toolbar.refresh'), 'aria-label': t('toolbar.refresh'), onClick: function refresh() { client.refreshScreen(); } }),
					h(Btn, {
						size: 'sm',
						icon: 'files',
						title: t('toolbar.files'),
						'aria-label': t('toolbar.files'),
						className: drawer === 'files' ? 'rdx-btn-active' : undefined,
						onClick: function files() { toggleDrawer('files'); },
					}),
					h(Btn, {
						size: 'sm',
						icon: 'terminal',
						title: t('toolbar.terminal'),
						'aria-label': t('toolbar.terminal'),
						className: drawer === 'terminal' ? 'rdx-btn-active' : undefined,
						onClick: function terminal() { toggleDrawer('terminal'); },
					}),
					h(Btn, {
						size: 'sm',
						icon: 'keyboard',
						title: t('toolbar.releaseKeyboard'),
						'aria-label': t('toolbar.releaseKeyboard'),
						disabled: !captured,
						onClick: releaseKeyboard,
					}),
					h(Btn, { size: 'sm', icon: 'paste', title: t('toolbar.paste'), 'aria-label': t('toolbar.paste'), onClick: openPaste }),
					h(Btn, { size: 'sm', icon: 'power', title: t('host.disconnect'), 'aria-label': t('host.disconnect'), onClick: confirmDisconnect }),
				),
				notice
					? h(
							'div',
							{ className: 'rdx-errorbar', role: 'alert' },
							h('span', { className: 'rdx-errorbar-source' }, t(SOURCE_LABEL_KEYS[notice.source] || 'error.source.connection')),
							h('span', { className: 'rdx-errorbar-text' }, describeError(t, notice.error)),
							h(
								'button',
								{ type: 'button', className: 'rdx-iconbtn', title: t('common.close'), 'aria-label': t('common.close'), onClick: onClearError },
								h(Icon, { name: 'close', size: 14 }),
							),
						)
					: null,
				h(
					'div',
					{ className: 'rdx-session-body' },
					h(ScreenSurface, {
						t: t,
						client: client,
						welcome: welcome,
						captured: captured,
						onCapturedChange: handleCapturedChange,
						onEncoding: setEncoding,
						canvasLabel: t('session.screenHint'),
					}),
					drawer
						? h(
								'aside',
								{ className: 'rdx-drawer' },
								h(
									'div',
									{ className: 'rdx-drawer-header' },
									h('span', { className: 'rdx-drawer-title' }, drawer === 'files' ? t('files.title') : t('terminal.title')),
									h(
										'button',
										{ type: 'button', className: 'rdx-iconbtn', title: t('toolbar.close'), 'aria-label': t('toolbar.close'), onClick: function close() { setDrawer(null); } },
										h(Icon, { name: 'close', size: 15 }),
									),
								),
								h(
									'div',
									{ className: 'rdx-drawer-body' },
									drawer === 'files'
										? h(FileBrowser, {
												t: t,
												client: client,
												initialPath: cwdRef.current,
												onPathChange: setCwd,
												onError: onError,
											})
										: h(TerminalConsole, {
												t: t,
												client: client,
												cwd: cwdRef.current,
												capabilities: welcome && welcome.capabilities ? welcome.capabilities : {},
												onError: onError,
											}),
								),
							)
						: null,
				),
				pasteOpen
					? h(PasteModal, {
							t: t,
							onClose: closePaste,
							onSend: sendPaste,
							textUnavailable: Boolean(welcome && welcome.capabilities && welcome.capabilities.text === false),
						})
					: null,
			);
		}

		const SOURCE_LABEL_KEYS = {
			connection: 'error.source.connection',
			files: 'error.source.files',
			terminal: 'error.source.terminal',
		};

		function PasteModal(props) {
			const t = props.t;
			const [value, setValue] = useState('');
			const areaRef = useRef(null);
			useEffect(function focusArea() {
				if (areaRef.current) areaRef.current.focus();
			}, []);
			const submit = function submit() {
				if (!value) return;
				props.onSend(value);
				props.onClose();
			};
			return h(
				Modal,
				{
					t: t,
					title: t('session.pasteTitle'),
					onClose: props.onClose,
					footer: [
						h(Btn, { key: 'cancel', onClick: props.onClose }, t('common.cancel')),
						h(Btn, { key: 'send', variant: 'primary', onClick: submit, disabled: !value }, t('session.send')),
					],
				},
				h(
					'div',
					{ className: 'rdx-form' },
					h('div', { className: 'rdx-field' }, h('span', { className: 'rdx-field-label' }, t('session.pasteHint')), h('textarea', {
						ref: areaRef,
						className: 'rdx-input rdx-textarea',
						value: value,
						placeholder: t('session.pastePlaceholder'),
						onChange: function change(event) { setValue(event.target.value); },
						onKeyDown: function onKey(event) {
							if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
								event.preventDefault();
								submit();
							}
						},
					})),
					props.textUnavailable ? h('div', { className: 'rdx-hint' }, t('session.textUnavailable')) : null,
				),
			);
		}

		// ==================================================================
		// 13. Root panel
		// ==================================================================

		function RemoteDesktopPanel(slotProps) {
			const t = slotProps && typeof slotProps.t === 'function' ? slotProps.t : function fallbackT(key) { return key; };
			const [hosts, setHosts] = useState(loadHosts);
			const [activeId, setActiveId] = useState(loadActiveHostId);
			const [activeClient, setActiveClient] = useState(null);
			const [status, setStatus] = useState('idle');
			const [stateInfo, setStateInfo] = useState(null);
			const [welcome, setWelcome] = useState(null);
			const [notice, setNotice] = useState(null);
			const [editor, setEditor] = useState(null);

			useEffect(function persistHosts() {
				saveHosts(hosts);
			}, [hosts]);
			useEffect(function persistActive() {
				saveActiveHostId(activeId);
			}, [activeId]);
			useEffect(function repairActiveSelection() {
				const known = activeId && hosts.some(function same(host) { return host.id === activeId; });
				if (!known) setActiveId(hosts.length > 0 ? hosts[0].id : null);
			}, [hosts, activeId]);
			useEffect(function attachPooledClient() {
				const pooled = activeId ? clients.get(activeId) : null;
				setActiveClient(pooled || null);
				if (pooled) {
					setStatus(pooled.status);
					setWelcome(pooled.welcome || null);
				} else {
					setStatus('idle');
					setWelcome(null);
				}
				setStateInfo(null);
			}, [activeId]);

			useEffect(function subscribeActiveClient() {
				if (!activeClient) return undefined;
				setStatus(activeClient.status);
				setWelcome(activeClient.welcome || null);
				const offState = activeClient.on('state', function onState(event) {
					setStatus(event.status);
					setStateInfo(event.info || null);
				});
				const offWelcome = activeClient.on('welcome', function onWelcome(message) {
					setWelcome(message);
					setStateInfo(null);
					setNotice(null);
				});
				const offError = activeClient.on('error', function onError(error) {
					const source = error && error.code === 'no_shell' ? 'terminal' : 'connection';
					setNotice({ source: source, error: error });
				});
				return function cleanup() {
					offState();
					offWelcome();
					offError();
				};
			}, [activeClient]);

			const activeHost = useMemo(function findActiveHost() {
				return hosts.find(function same(host) { return host.id === activeId; }) || null;
			}, [hosts, activeId]);

			const clearNotice = useCallback(function clearNotice() {
				setNotice(null);
			}, []);

			const reportSessionError = useCallback(function reportSessionError(payload) {
				setNotice(Object.assign({ source: 'files' }, payload || {}));
			}, []);

			const connectHost = useCallback(async function connectHost() {
				const host = hosts.find(function same(item) { return item.id === activeId; });
				if (!host) return;
				let runtime;
				try {
					runtime = runtimeHost(host);
				} catch (error) {
					setNotice({ source: 'connection', error: errorPayload(error) });
					return;
				}
				setNotice(null);
				let client = clients.get(host.id);
				if (!client) {
					client = new RemoteClient(runtime);
					clients.set(host.id, client);
				} else {
					client.updateHost(runtime);
				}
				setActiveClient(client);
				setStatus(client.status === 'idle' ? 'connecting' : client.status);
				setWelcome(client.welcome || null);
				await client.connect();
			}, [hosts, activeId]);

			const disconnectHost = useCallback(function disconnectHost() {
				if (!activeId) return;
				const client = clients.get(activeId);
				if (client) {
					client.disconnect();
					clients.delete(activeId);
				}
				setActiveClient(null);
				setStatus('idle');
				setWelcome(null);
				setStateInfo(null);
				setNotice(null);
			}, [activeId]);

			const selectHost = useCallback(function selectHost(hostId) {
				setActiveId(hostId);
				setNotice(null);
			}, []);

			const openAddEditor = useCallback(function openAddEditor() {
				setEditor({ mode: 'add', host: null });
			}, []);

			const openEditEditor = useCallback(function openEditEditor(host) {
				setEditor({ mode: 'edit', host: host });
			}, []);

			const closeEditor = useCallback(function closeEditor() {
				setEditor(null);
			}, []);

			const saveHost = useCallback(function saveHost(draft) {
				if (editor && editor.mode === 'edit' && editor.host) {
					const targetId = editor.host.id;
					const existing = clients.get(targetId);
					if (existing) {
						existing.disconnect();
						clients.delete(targetId);
						if (targetId === activeId) {
							setActiveClient(null);
							setStatus('idle');
							setWelcome(null);
							setStateInfo(null);
						}
					}
					setHosts(function replaceHosts(current) {
						return current.map(function replace(host) {
							return host.id === targetId ? Object.assign({}, host, { name: draft.name, address: draft.address, password: draft.password }) : host;
						});
					});
				} else {
					const created = {
						id: newHostId(),
						name: draft.name,
						address: draft.address,
						password: draft.password,
						createdAt: Date.now(),
					};
					setHosts(function appendHost(current) {
						return current.concat([created]);
					});
					setActiveId(created.id);
					setActiveClient(null);
					setStatus('idle');
					setWelcome(null);
				}
				setNotice(null);
				setEditor(null);
			}, [editor, activeId]);

			const deleteHost = useCallback(function deleteHost(host) {
				if (!askConfirm(t('host.deleteConfirm', { name: host.name }))) return;
				const client = clients.get(host.id);
				if (client) {
					client.disconnect();
					clients.delete(host.id);
				}
				setHosts(function removeHost(current) {
					return current.filter(function keep(item) { return item.id !== host.id; });
				});
				if (host.id === activeId) {
					setActiveClient(null);
					setStatus('idle');
					setWelcome(null);
					setStateInfo(null);
					setNotice(null);
				}
			}, [activeId, t]);

			const statusOf = useCallback(function statusOf(hostId) {
				if (hostId === activeId) return status;
				const client = clients.get(hostId);
				return client ? client.status : 'idle';
			}, [activeId, status]);

			const showSession = Boolean(activeClient) && (status === 'connected' || status === 'reconnecting');

			const main = !activeHost
				? h(DeployGuide, { t: t, onAdd: openAddEditor })
				: showSession
					? h(SessionView, {
							t: t,
							client: activeClient,
							host: activeHost,
							status: status,
							stateInfo: stateInfo,
							welcome: welcome,
							notice: notice,
							onClearError: clearNotice,
							onDisconnect: disconnectHost,
							onError: reportSessionError,
						})
					: h(ConnectCard, {
							t: t,
							host: activeHost,
							status: status,
							notice: notice,
							onConnect: connectHost,
							onEdit: function editActiveHost() { openEditEditor(activeHost); },
							onDisconnect: disconnectHost,
						});

			return h(
				'div',
				{ className: 'rdx-panel', 'data-plugin': PANEL_ID },
				h('style', null, PANEL_CSS),
				h(
					'header',
					{ className: 'rdx-header' },
					h('span', { className: 'rdx-header-icon' }, h(SidebarIcon, { size: 18, active: true })),
					h('span', { className: 'rdx-header-title' }, t('panel.title')),
					activeHost
						? h(
								'span',
								{ className: 'rdx-header-host' },
								h(StatusDot, { state: status, title: t('state.' + status) }),
								h('span', null, activeHost.name),
							)
						: null,
					h('span', { className: 'rdx-header-spacer' }),
					h(
						'button',
						{ type: 'button', className: 'rdx-btn rdx-btn-primary', onClick: openAddEditor },
						h(Icon, { name: 'plus', size: 14 }),
						h('span', { className: 'rdx-btn-label' }, t('panel.addHost')),
					),
				),
				h(
					'div',
					{ className: 'rdx-body' },
					h(HostList, {
						t: t,
						hosts: hosts,
						activeId: activeId,
						statusOf: statusOf,
						onSelect: selectHost,
						onAdd: openAddEditor,
						onEdit: openEditEditor,
						onDelete: deleteHost,
					}),
					h('div', { className: 'rdx-main' }, main),
				),
				editor
					? h(HostFormModal, {
							t: t,
							mode: editor.mode,
							host: editor.host,
							onSave: saveHost,
							onClose: closeEditor,
						})
					: null,
			);
		}

		// ==================================================================
		// 14. Stylesheet (theme tokens only; rdx- prefix)
		// ==================================================================

		const PANEL_CSS = [
			'.rdx-panel{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}',
			'.rdx-panel *,.rdx-panel *::before,.rdx-panel *::after{box-sizing:border-box}',
			'.rdx-header{height:48px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
			'.rdx-header-icon{display:inline-flex;color:var(--dsw-alias-brand-primary)}',
			'.rdx-header-title{font-size:13px;font-weight:600;white-space:nowrap}',
			'.rdx-header-host{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:320px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-header-spacer{flex:1;min-width:8px}',
			'.rdx-body{flex:1;min-height:0;display:flex}',
			'.rdx-hosts{width:220px;flex:none;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}',
			'.rdx-hosts-head{padding:10px 14px 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-hosts-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:2px 8px 8px}',
			'.rdx-hosts-empty{padding:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-hosts-foot{padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
			'.rdx-host{display:flex;align-items:center;gap:6px;min-width:0;padding:7px 8px;border:1px solid transparent;border-radius:6px;cursor:pointer}',
			'.rdx-host:hover{background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-host-active{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}',
			'.rdx-host-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
			'.rdx-host-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;font-weight:500}',
			'.rdx-host-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.rdx-host-addr{padding-left:13px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-host-actions{display:flex;flex:none;opacity:0}',
			'.rdx-host:hover .rdx-host-actions,.rdx-host-active .rdx-host-actions{opacity:1}',
			'.rdx-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-base)}',
			'.rdx-main-empty{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px}',
			'.rdx-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;width:100%;max-width:600px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-empty-icon{display:inline-flex;color:var(--dsw-alias-brand-primary)}',
			'.rdx-empty h2{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.rdx-empty p{margin:0;font-size:12px}',
			'.rdx-empty ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px}',
			'.rdx-guide{width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-guide summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}',
			'.rdx-code{margin:8px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text}',
			'.rdx-connect-card{display:flex;flex-direction:column;align-items:flex-start;gap:10px;width:100%;max-width:520px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-connect-card h2{margin:0;font-size:15px;font-weight:600}',
			'.rdx-addr{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
			'.rdx-row{display:flex;align-items:center;gap:8px;font-size:12px}',
			'.rdx-row-end{justify-content:flex-end;width:100%;margin-top:6px}',
			'.rdx-muted{color:var(--dsw-alias-label-secondary)}',
			'.rdx-session{flex:1;min-height:0;display:flex;flex-direction:column}',
			'.rdx-toolbar{height:40px;flex:none;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;overflow-y:hidden;white-space:nowrap}',
			'.rdx-toolbar-title{display:flex;align-items:center;gap:6px;min-width:0;max-width:460px;font-size:12px}',
			'.rdx-toolbar-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
			'.rdx-toolbar-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.rdx-toolbar-meta{display:flex;align-items:center;gap:4px;flex:none;min-width:0;overflow:hidden}',
			'.rdx-toolbar-chip{display:inline-block;max-width:120px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-toolbar-spacer{flex:1;min-width:8px}',
			'.rdx-fps{display:flex;align-items:center;gap:4px;flex:none;font-size:12px}',
			'.rdx-select{height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
			'.rdx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;user-select:none}',
			'.rdx-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
			'.rdx-btn:disabled{opacity:.5;cursor:default}',
			'.rdx-btn-sm{height:28px;padding:0 8px}',
			'.rdx-btn-icon{width:28px;padding:0}',
			'.rdx-btn-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
			'.rdx-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary);opacity:.88}',
			'.rdx-btn-ghost{border-color:transparent;background:transparent}',
			'.rdx-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-btn-active{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}',
			'.rdx-btn-label{display:inline-block}',
			'.rdx-block{width:100%;justify-content:center}',
			'.rdx-btn-primary .rdx-btn-label{color:inherit}',
			'.rdx-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
			'.rdx-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
			'.rdx-iconbtn:disabled{opacity:.4;cursor:default}',
			'.rdx-iconbtn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
			'.rdx-status-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
			'.rdx-status-dot[data-state="connecting"],.rdx-status-dot[data-state="reconnecting"]{background:var(--dsw-alias-state-warn-primary);animation:rdx-pulse 1.2s ease-in-out infinite}',
			'.rdx-status-dot[data-state="connected"]{background:var(--dsw-alias-state-success-primary)}',
			'.rdx-status-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary)}',
			'.rdx-errorbar{flex:none;display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px}',
			'.rdx-errorbar-source{flex:none;color:var(--dsw-alias-label-secondary)}',
			'.rdx-errorbar-text{flex:1;min-width:0;word-break:break-word}',
			'.rdx-session-body{flex:1;min-height:0;display:flex;position:relative}',
			'.rdx-screen-wrap{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;outline:none;background:#000000}',
			'.rdx-canvas{position:absolute;outline:none;background:#000000;cursor:none;touch-action:none;user-select:none}',
			'.rdx-screen-cursor{position:absolute;display:none;width:16px;height:16px;pointer-events:none;z-index:2;transform-origin:0 0}',
			'.rdx-screen-cursor[data-down="true"]{transform:scale(.86)}',
			'.rdx-screen-hint{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);max-width:90%;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;z-index:3}',
			'.rdx-screen-meta{position:absolute;left:10px;bottom:10px;color:var(--dsw-alias-label-secondary);font-size:11px;pointer-events:none;z-index:2}',
			'.rdx-screen-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;z-index:4}',
			'.rdx-screen-overlay.rdx-pass-through{pointer-events:none}',
			'.rdx-screen-error{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:520px}',
			'.rdx-drawer{width:380px;flex:none;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
			'.rdx-drawer-header{height:36px;flex:none;display:flex;align-items:center;gap:6px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
			'.rdx-drawer-title{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-drawer-body{flex:1;min-height:0;display:flex;flex-direction:column}',
			'.rdx-files{flex:1;min-height:0;display:flex;flex-direction:column}',
			'.rdx-pathbar{flex:none;display:flex;align-items:center;gap:4px;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
			'.rdx-input{min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
			'.rdx-pathbar .rdx-input{flex:1}',
			'.rdx-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
			'.rdx-input::placeholder{color:var(--dsw-alias-label-secondary)}',
			'.rdx-textarea{height:140px;padding:8px;resize:vertical;font-size:12px}',
			'.rdx-crumbs{flex:none;display:flex;align-items:center;gap:1px;padding:0 8px 6px;overflow-x:auto;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-crumb{max-width:160px;padding:2px 4px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-crumb:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
			'.rdx-crumb-sep{opacity:.6}',
			'.rdx-filelist{flex:1;min-height:0;overflow-y:auto}',
			'.rdx-file-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px}',
			'.rdx-file-row:hover{background:var(--dsw-alias-bg-layer-1)}',
			'.rdx-file-row:hover .rdx-file-actions,.rdx-file-row:focus-within .rdx-file-actions{opacity:1}',
			'.rdx-file-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}',
			'.rdx-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.rdx-file-size{flex:none;width:62px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-file-time{flex:none;width:104px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-file-actions{display:flex;flex:none;opacity:0}',
			'.rdx-files-empty{padding:24px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-files-status{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-terminal{flex:1;min-height:0;display:flex;flex-direction:column}',
			'.rdx-term-toolbar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);overflow-x:auto;white-space:nowrap}',
			'.rdx-term-status-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.rdx-term-output{flex:1;min-height:0;margin:0;padding:8px 10px;overflow-y:auto;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.35;white-space:pre-wrap;word-break:break-word;cursor:text;user-select:text}',
			'.rdx-term-output:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
			'.rdx-term-form{flex:none;display:flex;align-items:center;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
			'.rdx-term-form .rdx-input{flex:1}',
			'.rdx-term-prompt{flex:none;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
			'.rdx-term-hint{flex:none;padding:0 10px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-term-unsupported{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:24px 14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-form{display:flex;flex-direction:column;gap:10px}',
			'.rdx-dialog-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay)}',
			'.rdx-dialog{display:flex;flex-direction:column;width:100%;max-width:420px;max-height:90vh;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.rdx-dialog-header{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 16px}',
			'.rdx-dialog-title{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.rdx-dialog-body{display:flex;flex-direction:column;gap:10px;padding:4px 16px 12px;overflow-y:auto}',
			'.rdx-dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px}',
			'.rdx-field{display:flex;flex-direction:column;gap:4px}',
			'.rdx-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.rdx-field .rdx-input{width:100%}',
			'.rdx-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.rdx-error-text{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
			'.rdx-spinner{display:inline-block;flex:none;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:rdx-spin .8s linear infinite}',
			'@keyframes rdx-spin{to{transform:rotate(360deg)}}',
			'@keyframes rdx-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			'@media (max-width:900px){.rdx-drawer{position:absolute;top:0;right:0;bottom:0;width:min(380px,100%);z-index:5;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}}',
			'@media (hover:none){.rdx-host-actions,.rdx-file-actions{opacity:1}}',
		].join('\n');

		// ==================================================================
		// 15. Plugin wiring
		// ==================================================================

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(function registerDictionaries() {
				return ctx.locale.register(NS, { en: en, zh: zh });
			}, 'remote-desktop: dictionaries');
			const t = ctx.locale.bind(NS);

			ctx.effect(function registerSessionCleanup() {
				return function disposeSessions() {
					for (const client of clients.values()) {
						try {
							client.destroy();
						} catch (error) {
							/* keep disposing the remaining sessions */
						}
					}
					clients.clear();
				};
			}, 'remote-desktop: sessions');

			ctx.slots.inject('sidebar.panellist', function injectSidebarEntry() {
				return ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: 5,
						label: function sidebarLabel() {
							return t('sidebar.label');
						},
						locale: NS,
					},
					SidebarIcon,
				);
			});

			ctx.slots.inject('main', function injectMainPanel() {
				return ctx.slots.register(
					{
						name: 'main',
						key: PANEL_ID,
						locale: NS,
					},
					RemoteDesktopPanel,
				);
			});
		}

		return { inject: inject, apply: apply };
	},
});
