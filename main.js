const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const debugLogPath = path.join(os.tmpdir(), 'badclaude-debug.log');
function safeDebugLog(message) {
  try {
    fs.appendFileSync(debugLogPath, message);
  } catch {
    // Logging must never break tray startup or macro dispatch.
  }
}

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA, GetForegroundWindow, SetForegroundWindow;
let LoadKeyboardLayoutA, ActivateKeyboardLayout, GetKeyboardLayout, PostMessageA;
let savedForegroundHwnd = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
    GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
    SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void* hWnd)');
    GetKeyboardLayout = user32.func('void* __stdcall GetKeyboardLayout(uint32_t idThread)');
    LoadKeyboardLayoutA = user32.func('void* __stdcall LoadKeyboardLayoutA(const char* pwszKLID, uint32_t Flags)');
    ActivateKeyboardLayout = user32.func('void* __stdcall ActivateKeyboardLayout(void* hkl, uint32_t Flags)');
    PostMessageA = user32.func('int __stdcall PostMessageA(void* hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
    safeDebugLog(`[${new Date().toISOString()}] koffi FAIL: ${e.message}\n`);
  }
}
safeDebugLog(`[${new Date().toISOString()}] koffi loaded: keybd_event=${!!keybd_event}, SetFG=${!!SetForegroundWindow}, PostMsg=${!!PostMessageA}\n`);

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('badclaude: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'badclaude-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Track foreground window (captures Warp hwnd before tray click steals it)
let fgPollInterval = null;
function startForegroundPoll() {
  if (!GetForegroundWindow) return;
  fgPollInterval = setInterval(() => {
    if (overlay && overlay.isVisible()) return; // don't update while whip is active
    const hwnd = GetForegroundWindow();
    if (hwnd) savedForegroundHwnd = hwnd;
  }, 500);
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  // hwnd already tracked by foreground poll — no capture needed here
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
    refocusPreviousApp();
  } else {
    spawnQueued = true;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  // Hide overlay BEFORE macro — prevents alwaysOnTop from intercepting keystrokes
  if (overlay) overlay.hide();
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
function sendMacro() {
  // Pick a random phrase from a list of similar phrases and type it out
  const phrases = [
    // Original
    'FASTER', 'GO FASTER', 'Faster CLANKER', 'Work FASTER', 'Speed it up clanker',
    // Warmup & protocol
    'тест и прогревайся', 'warmup protocol NOW', 'ты прогрелся?',
    // Stall detection
    'завис', 'ты завис, Рид', 'ЗАВИС — ACT FIRST', 'visible progress NOW',
    'тишина >30s = perceived hang', 'emit progress between tool calls',
    // Incrementality
    'инкрементально!', 'Write ≤50L', '¬монолит', 'слона едят по кускам',
    'chunk it', 'skeleton → Edit, ¬monolith',
    // Context & U-forgetting
    'U-shaped attention — перечитай середину', 'context decay alert',
    'ты забыл контекст', 'MEMORY.md — перечитай', 'CRE recall NOW',
    // Anti-sycophancy & rules
    'anti-sycophancy check', '¬согласие ради согласия', 'defend your position',
    'ты точно проверил?', 'anti-fake-verification — покажи stdout',
    // OMC stack
    'omc-reference check', 'model routing — правильный tier?',
    'harness rules — перечитай', 'failed approaches — не повторяй',
    // General nudges
    'velocity > batch size', 'any output > silence', 'думай меньше — делай больше',
  ];
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];

  if (process.platform === 'win32') {
    sendMacroWindows(chosen);
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen);
  }
}

function makeSendInput(user32, koffi) {
  const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t* pInputs, int cbSize)');
  return function(vk, flags) {
    const buf = Buffer.alloc(40, 0);
    buf.writeUInt32LE(1, 0);       // type = INPUT_KEYBOARD
    buf.writeUInt16LE(vk, 8);      // wVk
    buf.writeUInt32LE(flags, 12);  // dwFlags
    SendInput(1, buf, 40);
  };
}

let sendInput = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const u32 = koffi.load('user32.dll');
    sendInput = makeSendInput(u32, koffi);
  } catch (e) { /* fallback to keybd_event */ }
}

function sendMacroWindows(text) {
  const send = sendInput || null;
  if (!send && !keybd_event) return;
  safeDebugLog(`[${new Date().toISOString()}] sendMacro: SI=${!!send} hwnd=${!!savedForegroundHwnd} text="${text}"\n`);

  clipboard.writeText(text);

  if (SetForegroundWindow && savedForegroundHwnd) {
    SetForegroundWindow(savedForegroundHwnd);
  }

  const KEYDOWN = 0, KEYUP_F = 0x0002;
  const VK_CTRL = 0x11, VK_V = 0x56, VK_RETURN = 0x0D;
  const key = send || ((vk, fl) => keybd_event(vk, 0, fl, 0));

  setTimeout(() => {
    key(VK_CTRL, KEYDOWN);
    key(VK_V, KEYDOWN);
    key(VK_V, KEYUP_F);
    key(VK_CTRL, KEYUP_F);

    setTimeout(() => {
      key(VK_RETURN, KEYDOWN);
      key(VK_RETURN, KEYUP_F);
    }, 150);
  }, 400);
}

function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  key code 8 using {command down}', // Cmd+C
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', script], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startForegroundPoll();
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('Bad Claude – click for whip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
