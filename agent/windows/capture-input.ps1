# =============================================================================
# capture-input.ps1 - Windows screen capture + input injection helper
# =============================================================================
# Part of the DSH remote desktop agent (Windows v1).
#
# The Node agent starts this script once and talks to it over stdin/stdout with
# one JSON request per line and one JSON response per line (see docs/WINDOWS.md
# section 2).  The script compiles a small inline C# class (DsRemoteNative) with
# Add-Type; that class does GDI screen capture (JPEG) and SendInput injection.
#
# Diagnostic modes (used by static validation and by hand when troubleshooting):
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-input.ps1
#       then type:  {"id":1,"cmd":"info"}     (Enter)
#                   {"id":9,"cmd":"selftest"} (Enter)
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-input.ps1 `
#       --dump-csharp C:\temp\Helper.cs
#   set DS_REMOTE_DUMP_CSHARP=C:\temp\Helper.cs
#
# Compatibility: Windows PowerShell 5.1 (.NET Framework 4.5), PowerShell 7.
# This file must stay PURE ASCII (no BOM needed) so that Windows PowerShell 5.1
# never mis-decodes it on systems with a non-UTF-8 ANSI code page.
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

# ---- optional: dump the inline C# source, then exit ------------------------
# Supports:
#   --dump-csharp <path>     write the C# source to <path>
#   --dump-csharp            write the C# source to stdout
#   --dump-csharp=<path>     same as --dump-csharp <path>
#   DS_REMOTE_DUMP_CSHARP=<path>   environment variable form
$script:DumpToStdout = $false
$script:DumpPath = $null
$script:ArgIndex = 0
while ($script:ArgIndex -lt $args.Count) {
    $script:ArgValue = [string]$args[$script:ArgIndex]
    if ($script:ArgValue -eq '--dump-csharp') {
        if (($script:ArgIndex + 1) -lt $args.Count) {
            $script:NextValue = [string]$args[$script:ArgIndex + 1]
            if (-not $script:NextValue.StartsWith('-')) {
                $script:DumpPath = $script:NextValue
                $script:ArgIndex = $script:ArgIndex + 1
            } else {
                $script:DumpToStdout = $true
            }
        } else {
            $script:DumpToStdout = $true
        }
    } elseif ($script:ArgValue.StartsWith('--dump-csharp=')) {
        $script:DumpPath = $script:ArgValue.Substring(14)
    }
    $script:ArgIndex = $script:ArgIndex + 1
}
if ($null -ne $env:DS_REMOTE_DUMP_CSHARP) {
    if ([string]$env:DS_REMOTE_DUMP_CSHARP -ne '' -and $null -eq $script:DumpPath) {
        $script:DumpPath = [string]$env:DS_REMOTE_DUMP_CSHARP
    }
}

# ---- inline C# (.NET Framework 4.5 API surface, C# 5 syntax only) ----------
$csharp = @'
// DsRemoteNative - Windows capture/input helper for the DSH remote desktop agent.
// Target: .NET Framework 4.5 / Windows PowerShell 5.1 (Add-Type) - C# 5 syntax only.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DsRemoteNative
{
    public const string HelperVersion = "1.0.0";

    // GetSystemMetrics indexes
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;
    private const int SM_CMONITORS = 80;
    private const int LOGPIXELSX = 88;

    // SendInput constants
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    // Virtual keys used by GetAsyncKeyState / VK based injection
    private const int VK_LBUTTON = 0x01;
    private const int VK_RBUTTON = 0x02;
    private const int VK_MBUTTON = 0x04;
    private const int VK_RETURN = 0x0D;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    // INPUT is a tagged union: type + (MOUSEINPUT | KEYBDINPUT). Sized correctly for
    // both x86 (28 bytes) and x64 (40 bytes) because Marshal.SizeOf is used below.
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public MOUSEINPUT mi;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT pt);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern int GetDeviceCaps(IntPtr hdc, int index);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    private static int _dpi = 96;
    private static int _primaryWidth;
    private static int _primaryHeight;
    private static int _virtualX;
    private static int _virtualY;
    private static int _virtualWidth;
    private static int _virtualHeight;
    private static int _monitors = 1;

    private static readonly HashSet<int> _pressedScan = new HashSet<int>();
    private static readonly HashSet<int> _pressedVk = new HashSet<int>();
    private static readonly HashSet<int> _pressedButtons = new HashSet<int>();

    private static Dictionary<string, int[]> _keyMap;

    static DsRemoteNative()
    {
        _keyMap = BuildKeyMap();
    }

    // ------------------------------------------------------------------ setup

    public static int InitDpi()
    {
        try
        {
            // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Windows 10 1703+)
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
        catch (Exception)
        {
            try { SetProcessDPIAware(); }
            catch (Exception) { }
        }

        try
        {
            uint dpi = GetDpiForSystem();
            if (dpi >= 48 && dpi <= 1000) { _dpi = (int)dpi; }
        }
        catch (Exception)
        {
            try
            {
                IntPtr hdc = GetDC(IntPtr.Zero);
                if (hdc != IntPtr.Zero)
                {
                    int dpi = GetDeviceCaps(hdc, LOGPIXELSX);
                    ReleaseDC(IntPtr.Zero, hdc);
                    if (dpi >= 48 && dpi <= 1000) { _dpi = dpi; }
                }
            }
            catch (Exception) { }
        }

        if (_dpi <= 0) { _dpi = 96; }
        RefreshMetrics();
        return _dpi;
    }

    private static void RefreshMetrics()
    {
        _primaryWidth = GetSystemMetrics(SM_CXSCREEN);
        _primaryHeight = GetSystemMetrics(SM_CYSCREEN);
        _virtualX = GetSystemMetrics(SM_XVIRTUALSCREEN);
        _virtualY = GetSystemMetrics(SM_YVIRTUALSCREEN);
        _virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        _virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        _monitors = GetSystemMetrics(SM_CMONITORS);
        if (_virtualWidth <= 0) { _virtualWidth = _primaryWidth; }
        if (_virtualHeight <= 0) { _virtualHeight = _primaryHeight; }
        if (_monitors <= 0) { _monitors = 1; }
    }

    /// <summary>Returns {primaryWidth, primaryHeight, virtualX, virtualY, virtualWidth,
    /// virtualHeight, monitorCount, dpi}.</summary>
    public static int[] GetMetrics()
    {
        RefreshMetrics();
        return new int[]
        {
            _primaryWidth, _primaryHeight, _virtualX, _virtualY,
            _virtualWidth, _virtualHeight, _monitors, _dpi
        };
    }

    // ---------------------------------------------------------------- capture

    public static byte[] CaptureJpeg(int quality, out int width, out int height)
    {
        RefreshMetrics();
        width = _primaryWidth;
        height = _primaryHeight;
        if (width <= 0 || height <= 0)
        {
            throw new InvalidOperationException("no interactive desktop (screen metrics are zero)");
        }
        if (quality < 10) { quality = 10; }
        if (quality > 95) { quality = 95; }

        Bitmap bmp = null;
        Graphics gfx = null;
        MemoryStream stream = null;
        EncoderParameters parameters = null;
        try
        {
            bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            gfx = Graphics.FromImage(bmp);
            gfx.CopyFromScreen(0, 0, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);

            ImageCodecInfo jpegCodec = null;
            ImageCodecInfo[] encoders = ImageCodecInfo.GetImageEncoders();
            for (int i = 0; i < encoders.Length; i++)
            {
                if (encoders[i].FormatID == ImageFormat.Jpeg.Guid)
                {
                    jpegCodec = encoders[i];
                    break;
                }
            }
            if (jpegCodec == null) { throw new InvalidOperationException("no JPEG encoder available"); }

            stream = new MemoryStream(256 * 1024);
            parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            bmp.Save(stream, jpegCodec, parameters);
            return stream.ToArray();
        }
        finally
        {
            if (parameters != null) { parameters.Dispose(); }
            if (stream != null) { stream.Dispose(); }
            if (gfx != null) { gfx.Dispose(); }
            if (bmp != null) { bmp.Dispose(); }
        }
    }

    // ----------------------------------------------------------------- cursor

    /// <summary>Returns {x, y, buttons} with buttons bitmask 1=left, 2=right, 4=middle.</summary>
    public static int[] GetCursor()
    {
        int[] result = new int[3];
        POINT pt;
        if (GetCursorPos(out pt))
        {
            result[0] = pt.x;
            result[1] = pt.y;
        }
        int buttons = 0;
        if ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0) { buttons |= 1; }
        if ((GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0) { buttons |= 2; }
        if ((GetAsyncKeyState(VK_MBUTTON) & 0x8000) != 0) { buttons |= 4; }
        result[2] = buttons;
        return result;
    }

    // ------------------------------------------------------------------ mouse

    /// <summary>Moves the pointer to a primary-screen pixel coordinate.</summary>
    public static void MoveMouseAbsolute(int x, int y)
    {
        RefreshMetrics();
        int vw = _virtualWidth;
        int vh = _virtualHeight;
        if (vw <= 1) { vw = 1; }
        if (vh <= 1) { vh = 1; }
        int spanX = vw - 1;
        int spanY = vh - 1;
        if (spanX < 1) { spanX = 1; }
        if (spanY < 1) { spanY = 1; }

        long nx = ((long)(x - _virtualX) * 65535L) / spanX;
        long ny = ((long)(y - _virtualY) * 65535L) / spanY;
        if (nx < 0) { nx = 0; }
        if (nx > 65535) { nx = 65535; }
        if (ny < 0) { ny = 0; }
        if (ny > 65535) { ny = 65535; }

        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.mi.dx = (int)nx;
        input.mi.dy = (int)ny;
        input.mi.mouseData = 0;
        input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInputs(new INPUT[] { input });
    }

    /// <summary>button: 0=left, 1=middle, 2=right (remote protocol numbering).</summary>
    public static void MouseButton(int button, bool down)
    {
        if (button < 0 || button > 2) { return; }
        EmitMouseButton(button, down);
        if (down) { _pressedButtons.Add(button); }
        else { _pressedButtons.Remove(button); }
    }

    private static void EmitMouseButton(int button, bool down)
    {
        uint flag;
        if (button == 0) { flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; }
        else if (button == 1) { flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; }
        else if (button == 2) { flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; }
        else { return; }
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.mi.dx = 0;
        input.mi.dy = 0;
        input.mi.mouseData = 0;
        input.mi.dwFlags = flag;
        SendInputs(new INPUT[] { input });
    }

    private static int WheelClicks(int delta)
    {
        if (delta == 0) { return 0; }
        int magnitude = delta < 0 ? -delta : delta;
        int clicks = (int)Math.Round((double)magnitude / 120.0, MidpointRounding.AwayFromZero);
        if (clicks < 1) { clicks = 1; }
        if (clicks > 10) { clicks = 10; }
        return clicks;
    }

    /// <summary>dx/dy are pixel deltas as sent by the browser (positive = right/down).</summary>
    public static void Wheel(int dx, int dy)
    {
        int vertical = WheelClicks(dy);
        if (vertical > 0)
        {
            int delta = dy > 0 ? -(vertical * 120) : (vertical * 120);
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.mi.mouseData = unchecked((uint)delta);
            input.mi.dwFlags = MOUSEEVENTF_WHEEL;
            SendInputs(new INPUT[] { input });
        }
        int horizontal = WheelClicks(dx);
        if (horizontal > 0)
        {
            int delta = dx > 0 ? (horizontal * 120) : -(horizontal * 120);
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.mi.mouseData = unchecked((uint)delta);
            input.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            SendInputs(new INPUT[] { input });
        }
    }

    // --------------------------------------------------------------- keyboard

    private static void SendInputs(INPUT[] inputs)
    {
        if (inputs == null || inputs.Length == 0) { return; }
        int size = Marshal.SizeOf(typeof(INPUT));
        // A partial send (e.g. blocked by UIPI for elevated windows) is not fatal:
        // the helper stays alive and simply reports nothing. v1 limitation.
        SendInput((uint)inputs.Length, inputs, size);
    }

    private static INPUT MakeKey(ushort scan, ushort vk, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = vk;
        input.ki.wScan = scan;
        input.ki.dwFlags = flags;
        return input;
    }

    /// <summary>Injects a physical scan code (layout independent).</summary>
    public static void KeyScan(int scanCode, bool extended, bool down)
    {
        int key = (scanCode & 0xFFFF) | (extended ? 0x10000 : 0);
        if (down) { if (!_pressedScan.Add(key)) { return; } }
        else { if (!_pressedScan.Remove(key)) { return; } }
        EmitScan((ushort)(scanCode & 0xFF), extended, down);
    }

    private static void EmitScan(ushort scanCode, bool extended, bool down)
    {
        uint flags = KEYEVENTF_SCANCODE;
        if (extended) { flags |= KEYEVENTF_EXTENDEDKEY; }
        if (!down) { flags |= KEYEVENTF_KEYUP; }
        SendInputs(new INPUT[] { MakeKey(scanCode, 0, flags) });
    }

    /// <summary>Injects a virtual-key event; used for keys without a usable scan code (Pause).</summary>
    public static void KeyVirtual(int vk, bool down)
    {
        int key = vk & 0xFF;
        if (down) { if (!_pressedVk.Add(key)) { return; } }
        else { if (!_pressedVk.Remove(key)) { return; } }
        EmitVk((ushort)(vk & 0xFF), down);
    }

    private static void EmitVk(ushort vk, bool down)
    {
        uint flags = down ? 0u : KEYEVENTF_KEYUP;
        SendInputs(new INPUT[] { MakeKey(0, vk, flags) });
    }

    /// <summary>Injects text as KEYEVENTF_UNICODE events, one UTF-16 code unit at a time.</summary>
    public static void KeyUnicode(string text)
    {
        if (text == null || text.Length == 0) { return; }
        List<INPUT> batch = new List<INPUT>(128);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if ((int)c == 13) { continue; }
            if ((int)c == 10)
            {
                batch.Add(MakeKey(0, (ushort)VK_RETURN, 0));
                batch.Add(MakeKey(0, (ushort)VK_RETURN, KEYEVENTF_KEYUP));
            }
            else
            {
                batch.Add(MakeKey((ushort)c, 0, KEYEVENTF_UNICODE));
                batch.Add(MakeKey((ushort)c, 0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            if (batch.Count >= 128) { FlushKeys(batch); }
        }
        FlushKeys(batch);
    }

    private static void FlushKeys(List<INPUT> batch)
    {
        if (batch.Count == 0) { return; }
        INPUT[] inputs = batch.ToArray();
        batch.Clear();
        SendInputs(inputs);
    }

    /// <summary>Releases every key and mouse button this helper pressed down.</summary>
    public static void ReleaseAll()
    {
        if (_pressedScan.Count > 0)
        {
            int[] keys = new int[_pressedScan.Count];
            _pressedScan.CopyTo(keys);
            _pressedScan.Clear();
            for (int i = 0; i < keys.Length; i++)
            {
                EmitScan((ushort)(keys[i] & 0xFFFF), (keys[i] & 0x10000) != 0, false);
            }
        }
        if (_pressedVk.Count > 0)
        {
            int[] vks = new int[_pressedVk.Count];
            _pressedVk.CopyTo(vks);
            _pressedVk.Clear();
            for (int i = 0; i < vks.Length; i++)
            {
                EmitVk((ushort)(vks[i] & 0xFF), false);
            }
        }
        if (_pressedButtons.Count > 0)
        {
            int[] buttons = new int[_pressedButtons.Count];
            _pressedButtons.CopyTo(buttons);
            _pressedButtons.Clear();
            for (int i = 0; i < buttons.Length; i++)
            {
                EmitMouseButton(buttons[i], false);
            }
        }
    }

    // ------------------------------------------------------------- key mapping

    /// <summary>Maps a browser KeyboardEvent.code to {scanCode, extended(0|1), virtualKey}
    /// where virtualKey != 0 means the key must be injected as a virtual key.</summary>
    public static int[] MapKey(string code)
    {
        if (code == null) { return null; }
        int[] found;
        if (_keyMap.TryGetValue(code, out found)) { return found; }
        return null;
    }

    private static void Add(Dictionary<string, int[]> map, string code, int scan, bool extended)
    {
        map[code] = new int[] { scan, extended ? 1 : 0, 0 };
    }

    private static void AddVk(Dictionary<string, int[]> map, string code, int vk)
    {
        map[code] = new int[] { 0, 0, vk };
    }

    private static Dictionary<string, int[]> BuildKeyMap()
    {
        Dictionary<string, int[]> m = new Dictionary<string, int[]>(StringComparer.Ordinal);

        // Letters (PC/AT set 1 scan codes)
        Add(m, "KeyQ", 0x10, false); Add(m, "KeyW", 0x11, false); Add(m, "KeyE", 0x12, false);
        Add(m, "KeyR", 0x13, false); Add(m, "KeyT", 0x14, false); Add(m, "KeyY", 0x15, false);
        Add(m, "KeyU", 0x16, false); Add(m, "KeyI", 0x17, false); Add(m, "KeyO", 0x18, false);
        Add(m, "KeyP", 0x19, false); Add(m, "KeyA", 0x1E, false); Add(m, "KeyS", 0x1F, false);
        Add(m, "KeyD", 0x20, false); Add(m, "KeyF", 0x21, false); Add(m, "KeyG", 0x22, false);
        Add(m, "KeyH", 0x23, false); Add(m, "KeyJ", 0x24, false); Add(m, "KeyK", 0x25, false);
        Add(m, "KeyL", 0x26, false); Add(m, "KeyZ", 0x2C, false); Add(m, "KeyX", 0x2D, false);
        Add(m, "KeyC", 0x2E, false); Add(m, "KeyV", 0x2F, false); Add(m, "KeyB", 0x30, false);
        Add(m, "KeyN", 0x31, false); Add(m, "KeyM", 0x32, false);

        // Digits
        Add(m, "Digit1", 0x02, false); Add(m, "Digit2", 0x03, false); Add(m, "Digit3", 0x04, false);
        Add(m, "Digit4", 0x05, false); Add(m, "Digit5", 0x06, false); Add(m, "Digit6", 0x07, false);
        Add(m, "Digit7", 0x08, false); Add(m, "Digit8", 0x09, false); Add(m, "Digit9", 0x0A, false);
        Add(m, "Digit0", 0x0B, false);

        // Function keys
        Add(m, "F1", 0x3B, false); Add(m, "F2", 0x3C, false); Add(m, "F3", 0x3D, false);
        Add(m, "F4", 0x3E, false); Add(m, "F5", 0x3F, false); Add(m, "F6", 0x40, false);
        Add(m, "F7", 0x41, false); Add(m, "F8", 0x42, false); Add(m, "F9", 0x43, false);
        Add(m, "F10", 0x44, false); Add(m, "F11", 0x57, false); Add(m, "F12", 0x58, false);

        // Editing / navigation (extended keys)
        Add(m, "Escape", 0x01, false);
        Add(m, "Backspace", 0x0E, false);
        Add(m, "Tab", 0x0F, false);
        Add(m, "Enter", 0x1C, false);
        Add(m, "Space", 0x39, false);
        Add(m, "CapsLock", 0x3A, false);
        Add(m, "NumLock", 0x45, false);
        Add(m, "ScrollLock", 0x46, false);
        Add(m, "PrintScreen", 0x37, true);
        Add(m, "Insert", 0x52, true);
        Add(m, "Delete", 0x53, true);
        Add(m, "Home", 0x47, true);
        Add(m, "End", 0x4F, true);
        Add(m, "PageUp", 0x49, true);
        Add(m, "PageDown", 0x51, true);
        Add(m, "ArrowUp", 0x48, true);
        Add(m, "ArrowDown", 0x50, true);
        Add(m, "ArrowLeft", 0x4B, true);
        Add(m, "ArrowRight", 0x4D, true);

        // Modifiers
        Add(m, "ShiftLeft", 0x2A, false);
        Add(m, "ShiftRight", 0x36, false);
        Add(m, "ControlLeft", 0x1D, false);
        Add(m, "ControlRight", 0x1D, true);
        Add(m, "AltLeft", 0x38, false);
        Add(m, "AltRight", 0x38, true);
        Add(m, "MetaLeft", 0x5B, true);
        Add(m, "MetaRight", 0x5C, true);
        Add(m, "ContextMenu", 0x5D, true);

        // Punctuation
        Add(m, "Minus", 0x0C, false);
        Add(m, "Equal", 0x0D, false);
        Add(m, "BracketLeft", 0x1A, false);
        Add(m, "BracketRight", 0x1B, false);
        Add(m, "Backslash", 0x2B, false);
        Add(m, "Semicolon", 0x27, false);
        Add(m, "Quote", 0x28, false);
        Add(m, "Backquote", 0x29, false);
        Add(m, "Comma", 0x33, false);
        Add(m, "Period", 0x34, false);
        Add(m, "Slash", 0x35, false);

        // Numpad
        Add(m, "Numpad0", 0x52, false); Add(m, "Numpad1", 0x4F, false); Add(m, "Numpad2", 0x50, false);
        Add(m, "Numpad3", 0x51, false); Add(m, "Numpad4", 0x4B, false); Add(m, "Numpad5", 0x4C, false);
        Add(m, "Numpad6", 0x4D, false); Add(m, "Numpad7", 0x47, false); Add(m, "Numpad8", 0x48, false);
        Add(m, "Numpad9", 0x49, false);
        Add(m, "NumpadAdd", 0x4E, false);
        Add(m, "NumpadSubtract", 0x4A, false);
        Add(m, "NumpadMultiply", 0x37, false);
        Add(m, "NumpadDivide", 0x35, true);
        Add(m, "NumpadDecimal", 0x53, false);
        Add(m, "NumpadEnter", 0x1C, true);

        // Japanese / ISO extras (harmless if unused)
        Add(m, "IntlBackslash", 0x56, false);
        Add(m, "IntlRo", 0x73, false);
        Add(m, "IntlYen", 0x7D, false);
        Add(m, "KanaMode", 0x70, false);
        Add(m, "NonConvert", 0x7B, false);
        Add(m, "Convert", 0x79, false);

        // Pause has no simple set-1 scan code (E1 sequence); inject by virtual key.
        AddVk(m, "Pause", 0x13);

        return m;
    }
}
'@

# `--dump-csharp` / DS_REMOTE_DUMP_CSHARP: emit the C# source and stop before
# touching the screen or reading stdin (used for static compile checks).
if ($script:DumpToStdout -or $null -ne $script:DumpPath) {
    $script:DumpEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    if ($null -ne $script:DumpPath) {
        $script:DumpFullPath = [System.IO.Path]::GetFullPath($script:DumpPath)
        [System.IO.File]::WriteAllText($script:DumpFullPath, $csharp + [char]10, $script:DumpEncoding)
        [Console]::Error.WriteLine('csharp dumped to ' + $script:DumpFullPath)
    } else {
        [Console]::Out.Write($csharp + [char]10)
        [Console]::Out.Flush()
    }
    exit 0
}

# ---- UTF-8 on stdin/stdout ------------------------------------------------
# The Node agent speaks UTF-8 JSON Lines; Windows PowerShell defaults to the
# console code page when redirected, so pin both directions explicitly.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
try { [Console]::InputEncoding = $script:Utf8NoBom } catch { }
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }

$script:HelperVersion = '1.0.0'

# ---- compile the inline C# ------------------------------------------------
try { Add-Type -AssemblyName System.Drawing -ErrorAction Stop } catch { }
try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { }

if (-not ('DsRemoteNative' -as [type])) {
    $compiled = $false
    $firstError = ''
    try {
        Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' -ErrorAction Stop
        $compiled = $true
    } catch {
        $firstError = $_.Exception.Message
    }
    if (-not $compiled) {
        # Minimal Windows images may not ship System.Windows.Forms. The helper
        # only uses System.Drawing, so retry with that reference alone.
        try {
            Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.Drawing', 'System' -ErrorAction Stop
            $compiled = $true
        } catch {
            [Console]::Error.WriteLine('helper_init_failed: Add-Type failed: ' + $firstError + ' / retry: ' + $_.Exception.Message)
            exit 2
        }
    }
}

# ---- DPI awareness + screen metrics --------------------------------------
$script:Dpi = 96
try {
    $script:Dpi = [int][DsRemoteNative]::InitDpi()
} catch {
    [Console]::Error.WriteLine('helper_init_failed: InitDpi failed: ' + $_.Exception.Message)
    exit 3
}

$script:Metrics = [DsRemoteNative]::GetMetrics()
$script:ScreenWidth = [int]$script:Metrics[0]
$script:ScreenHeight = [int]$script:Metrics[1]
$script:ScreenCount = [int]$script:Metrics[6]

if ($script:ScreenWidth -le 0 -or $script:ScreenHeight -le 0) {
    [Console]::Error.WriteLine('helper_init_failed: no interactive desktop session (screen metrics are ' + $script:ScreenWidth + 'x' + $script:ScreenHeight + '); log in to the PC and start the agent from the logged-in desktop')
    exit 4
}

# ---- JSON helpers (hand built: avoids ConvertTo-Json costs and PS quirks) --
function Escape-JsonText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $builder = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        $code = [int]$ch
        if ($ch -eq '"') {
            [void]$builder.Append('\"')
        } elseif ($ch -eq '\') {
            [void]$builder.Append('\\')
        } elseif ($code -lt 32) {
            [void]$builder.Append(('\u{0:x4}' -f $code))
        } else {
            [void]$builder.Append($ch)
        }
    }
    return $builder.ToString()
}

function Build-IdPrefix {
    param([object]$Id)
    if ($null -eq $Id) { return '' }
    # Fast path: JSON numbers are the normal case for `id`.
    if (($Id -is [int]) -or ($Id -is [long]) -or ($Id -is [double]) -or ($Id -is [decimal])) {
        return '"id":' + [string]$Id + ','
    }
    $idJson = '0'
    try { $idJson = ConvertTo-Json -InputObject $Id -Compress -ErrorAction Stop } catch { $idJson = '0' }
    return '"id":' + $idJson + ','
}

function Build-OkLine {
    param([object]$Id, [string]$Fields)
    return '{' + (Build-IdPrefix $Id) + '"ok":true' + $Fields + '}'
}

function Build-ErrorLine {
    param([object]$Id, [string]$Code, [string]$Message)
    return '{' + (Build-IdPrefix $Id) + '"ok":false,"error":"' + (Escape-JsonText $Code) + '","message":"' + (Escape-JsonText $Message) + '"}'
}

function Write-ProtocolLine {
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

function Clamp-Value {
    param([int]$Value, [int]$Minimum, [int]$Maximum)
    if ($Value -lt $Minimum) { return $Minimum }
    if ($Value -gt $Maximum) { return $Maximum }
    return $Value
}

function Build-HelloFields {
    $metrics = [DsRemoteNative]::GetMetrics()
    return ',"hello":{"helper":"' + $script:HelperVersion + '","width":' + [int]$metrics[0] + ',"height":' + [int]$metrics[1] + ',"screens":' + [int]$metrics[6] + ',"format":"jpeg","dpi":' + [int]$metrics[7] + '}'
}

# ---- startup hello (unsolicited first line, see WINDOWS.md section 2) ------
Write-ProtocolLine (Build-OkLine $null (Build-HelloFields))

# ---- main request loop ----------------------------------------------------
$script:Running = $true
while ($script:Running) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) {
        # stdin EOF: the Node agent went away.
        break
    }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    $request = $null
    try {
        $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    } catch {
        Write-ProtocolLine '{"ok":false,"error":"bad_json","message":"request is not valid JSON"}'
        continue
    }

    $id = $null
    $cmd = ''
    if ($null -ne $request) {
        $id = $request.id
        if ($null -ne $request.cmd) { $cmd = [string]$request.cmd }
    }

    try {
        switch ($cmd) {
            'hello' {
                Write-ProtocolLine (Build-OkLine $id (Build-HelloFields))
            }

            'info' {
                $metrics = [DsRemoteNative]::GetMetrics()
                $cursor = [DsRemoteNative]::GetCursor()
                $fields = ',"width":' + [int]$metrics[0] + ',"height":' + [int]$metrics[1] + ',"screens":' + [int]$metrics[6] + ',"cursor":{"x":' + [int]$cursor[0] + ',"y":' + [int]$cursor[1] + '},"buttons":' + [int]$cursor[2]
                Write-ProtocolLine (Build-OkLine $id $fields)
            }

            'capture' {
                $quality = 65
                if ($null -ne $request.quality) {
                    try { $quality = [int]$request.quality } catch { $quality = 65 }
                }
                $quality = Clamp-Value $quality 10 95

                $frameWidth = 0
                $frameHeight = 0
                $jpeg = $null
                $base64 = ''
                $captureError = ''
                $watch = [System.Diagnostics.Stopwatch]::StartNew()
                try {
                    $jpeg = [DsRemoteNative]::CaptureJpeg($quality, [ref]$frameWidth, [ref]$frameHeight)
                    $watch.Stop()
                    if ($null -eq $jpeg -or $jpeg.Length -lt 2) {
                        throw 'capture returned no image data'
                    }
                    $base64 = [Convert]::ToBase64String($jpeg)
                    # Contract: a single base64 frame should stay under 8 MB; if it
                    # does not, retry once at lower quality.
                    $maxBase64 = 8388608
                    if ($base64.Length -gt $maxBase64 -and $quality -gt 25) {
                        $quality = 25
                        $watch.Restart()
                        $jpeg = [DsRemoteNative]::CaptureJpeg($quality, [ref]$frameWidth, [ref]$frameHeight)
                        $watch.Stop()
                        if ($null -eq $jpeg -or $jpeg.Length -lt 2) {
                            throw 'retry capture returned no image data'
                        }
                        $base64 = [Convert]::ToBase64String($jpeg)
                    }
                } catch {
                    $captureError = $_.Exception.Message
                    $jpeg = $null
                }
                if ($null -ne $jpeg -and $jpeg.Length -ge 2) {
                    $cursor = [DsRemoteNative]::GetCursor()
                    $prefix = '{' + (Build-IdPrefix $id) + '"ok":true,"width":' + [int]$frameWidth + ',"height":' + [int]$frameHeight + ',"format":"jpeg","data":"'
                    $suffix = '","cursor":{"x":' + [int]$cursor[0] + ',"y":' + [int]$cursor[1] + '},"buttons":' + [int]$cursor[2] + ',"encodeMs":' + $watch.ElapsedMilliseconds + '}'
                    # NOTE: base64 contains only A-Za-z0-9+/= so it is JSON safe and a
                    # plain concatenation is both correct and much cheaper than
                    # ConvertTo-Json for a 300 KB+ string.
                    Write-ProtocolLine ($prefix + $base64 + $suffix)
                } else {
                    # Keep the helper alive: a locked session or a GDI failure must
                    # not kill the whole remote desktop.
                    if ($null -ne $id) {
                        Write-ProtocolLine (Build-ErrorLine $id 'capture_failed' $captureError)
                    } else {
                        [Console]::Error.WriteLine('capture_failed: ' + $captureError)
                    }
                }
            }

            'mouse' {
                $metrics = [DsRemoteNative]::GetMetrics()
                $maxX = [int]$metrics[0] - 1
                $maxY = [int]$metrics[1] - 1
                if ($maxX -lt 0) { $maxX = 0 }
                if ($maxY -lt 0) { $maxY = 0 }
                $action = ''
                if ($null -ne $request.action) { $action = ([string]$request.action).ToLowerInvariant() }
                $mouseOk = $true
                $mouseError = ''
                if ($action -eq 'move' -or $action -eq 'down' -or $action -eq 'up') {
                    if ($null -ne $request.x -and $null -ne $request.y) {
                        $targetX = Clamp-Value ([int]$request.x) 0 $maxX
                        $targetY = Clamp-Value ([int]$request.y) 0 $maxY
                        [DsRemoteNative]::MoveMouseAbsolute($targetX, $targetY)
                    } elseif ($action -eq 'move') {
                        $mouseOk = $false
                        $mouseError = 'bad_coordinates'
                    }
                    if ($action -eq 'down' -or $action -eq 'up') {
                        $button = 0
                        if ($null -ne $request.button) {
                            try { $button = [int]$request.button } catch { $button = -1 }
                        }
                        if ($button -lt 0 -or $button -gt 2) {
                            $mouseOk = $false
                            $mouseError = 'bad_button'
                        } else {
                            [DsRemoteNative]::MouseButton($button, ($action -eq 'down'))
                        }
                    }
                } else {
                    $mouseOk = $false
                    $mouseError = 'bad_action'
                }
                if ($null -ne $id) {
                    if ($mouseOk) { Write-ProtocolLine (Build-OkLine $id '') }
                    else { Write-ProtocolLine (Build-ErrorLine $id $mouseError ('invalid mouse command: action=' + $action)) }
                }
            }

            'wheel' {
                $dx = 0
                $dy = 0
                if ($null -ne $request.dx) { try { $dx = [int]$request.dx } catch { $dx = 0 } }
                if ($null -ne $request.dy) { try { $dy = [int]$request.dy } catch { $dy = 0 } }
                # dx/dy are pixel deltas as defined by the browser protocol; the
                # C# layer converts them to wheel notches (120 units each).
                [DsRemoteNative]::Wheel($dx, $dy)
                if ($null -ne $id) { Write-ProtocolLine (Build-OkLine $id '') }
            }

            'key' {
                $code = ''
                if ($null -ne $request.code) { $code = [string]$request.code }
                $down = $true
                if ($null -ne $request.down) { $down = [bool]$request.down }
                $mapping = $null
                if ($code.Length -gt 0) { $mapping = [DsRemoteNative]::MapKey($code) }
                if ($null -eq $mapping) {
                    if ($null -ne $id) {
                        Write-ProtocolLine (Build-ErrorLine $id 'unsupported_key' ('no scan code for KeyboardEvent.code=' + $code))
                    }
                } else {
                    $scanCode = [int]$mapping[0]
                    $isExtended = ([int]$mapping[1] -ne 0)
                    $virtualKey = [int]$mapping[2]
                    if ($virtualKey -gt 0) {
                        [DsRemoteNative]::KeyVirtual($virtualKey, $down)
                    } else {
                        [DsRemoteNative]::KeyScan($scanCode, $isExtended, $down)
                    }
                    if ($null -ne $id) { Write-ProtocolLine (Build-OkLine $id '') }
                }
            }

            'text' {
                $text = ''
                if ($null -ne $request.text) { $text = [string]$request.text }
                if ($text.Length -gt 0) { [DsRemoteNative]::KeyUnicode($text) }
                if ($null -ne $id) { Write-ProtocolLine (Build-OkLine $id '') }
            }

            'releaseAll' {
                [DsRemoteNative]::ReleaseAll()
                if ($null -ne $id) { Write-ProtocolLine (Build-OkLine $id '') }
            }

            'shutdown' {
                try { [DsRemoteNative]::ReleaseAll() } catch { }
                Write-ProtocolLine (Build-OkLine $id '')
                $script:Running = $false
            }

            'selftest' {
                $tests = @()
                $allOk = $true
                $metrics = [DsRemoteNative]::GetMetrics()
                $testWidth = [int]$metrics[0]
                $testHeight = [int]$metrics[1]
                $testDpi = [int]$metrics[7]
                $testScreens = [int]$metrics[6]

                if ($testDpi -ge 96) {
                    $tests += '{"name":"dpi","ok":true,"dpi":' + $testDpi + '}'
                } else {
                    $tests += '{"name":"dpi","ok":false,"dpi":' + $testDpi + '}'
                    $allOk = $false
                }

                if ($testWidth -gt 0 -and $testHeight -gt 0) {
                    $tests += '{"name":"screen","ok":true,"width":' + $testWidth + ',"height":' + $testHeight + ',"screens":' + $testScreens + '}'
                } else {
                    $tests += '{"name":"screen","ok":false,"width":' + $testWidth + ',"height":' + $testHeight + '}'
                    $allOk = $false
                }

                $captureOk = $false
                $captureMs = 0
                $captureBytes = 0
                $captureWidth = 0
                $captureHeight = 0
                try {
                    $captureWatch = [System.Diagnostics.Stopwatch]::StartNew()
                    $captureJpeg = [DsRemoteNative]::CaptureJpeg(60, [ref]$captureWidth, [ref]$captureHeight)
                    $captureWatch.Stop()
                    $captureMs = $captureWatch.ElapsedMilliseconds
                    $captureBytes = $captureJpeg.Length
                    if ($captureJpeg.Length -gt 100 -and $captureJpeg[0] -eq 0xFF -and $captureJpeg[1] -eq 0xD8 -and $captureJpeg[$captureJpeg.Length - 2] -eq 0xFF -and $captureJpeg[$captureJpeg.Length - 1] -eq 0xD9) {
                        $captureOk = $true
                    }
                } catch {
                    $captureOk = $false
                }
                if ($captureOk) {
                    $tests += '{"name":"capture","ok":true,"width":' + $captureWidth + ',"height":' + $captureHeight + ',"bytes":' + $captureBytes + ',"encodeMs":' + $captureMs + '}'
                } else {
                    $tests += '{"name":"capture","ok":false,"bytes":' + $captureBytes + '}'
                    $allOk = $false
                }

                $cursorOk = $false
                try {
                    $testCursor = [DsRemoteNative]::GetCursor()
                    if ($null -ne $testCursor -and $testCursor.Length -eq 3) { $cursorOk = $true }
                } catch {
                    $cursorOk = $false
                }
                if ($cursorOk) {
                    $tests += '{"name":"cursor","ok":true,"x":' + [int]$testCursor[0] + ',"y":' + [int]$testCursor[1] + ',"buttons":' + [int]$testCursor[2] + '}'
                } else {
                    $tests += '{"name":"cursor","ok":false}'
                    $allOk = $false
                }

                $keymapOk = $false
                try {
                    $testKeyA = [DsRemoteNative]::MapKey('KeyA')
                    $testKeyPause = [DsRemoteNative]::MapKey('Pause')
                    $testKeyMissing = [DsRemoteNative]::MapKey('NoSuchKey')
                    if ($null -ne $testKeyA -and [int]$testKeyA[0] -eq 30 -and [int]$testKeyA[1] -eq 0 -and $null -ne $testKeyPause -and [int]$testKeyPause[2] -eq 0x13 -and $null -eq $testKeyMissing) {
                        $keymapOk = $true
                    }
                } catch {
                    $keymapOk = $false
                }
                if ($keymapOk) {
                    $tests += '{"name":"keymap","ok":true,"mapped":true}'
                } else {
                    $tests += '{"name":"keymap","ok":false}'
                    $allOk = $false
                }

                $testsJson = '[' + ($tests -join ',') + ']'
                $fields = ',"tests":' + $testsJson
                if ($allOk) {
                    Write-ProtocolLine (Build-OkLine $id $fields)
                } else {
                    Write-ProtocolLine ('{' + (Build-IdPrefix $id) + '"ok":false' + $fields + '}')
                }
            }

            default {
                if ($null -ne $id) {
                    Write-ProtocolLine (Build-ErrorLine $id 'unknown_cmd' ('unknown cmd: ' + $cmd))
                } else {
                    [Console]::Error.WriteLine('unknown cmd: ' + $cmd)
                }
            }
        }
    } catch {
        if ($null -ne $id) {
            Write-ProtocolLine (Build-ErrorLine $id 'internal_error' $_.Exception.Message)
        } else {
            [Console]::Error.WriteLine('internal_error: ' + $_.Exception.Message)
        }
    }
}

# ---- clean shutdown -------------------------------------------------------
try { [DsRemoteNative]::ReleaseAll() } catch { }
exit 0
