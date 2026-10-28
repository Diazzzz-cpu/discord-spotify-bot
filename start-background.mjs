import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_EXE = path.join(BIN_DIR, 'yt-dlp.exe');
const YTDLP_BAK = path.join(BIN_DIR, 'yt-dlp.bak.exe');
const PID_FILE = path.join(DATA_DIR, 'supervisor.pid');
const BOT_LOG = path.join(DATA_DIR, 'bot-bg.log');
const LAVALINK_DIR = path.join(__dirname, 'lavalink');

const MAX_LOG_BYTES = 512 * 1024; // 512 KB cap
const KEEP_LOG_BYTES = 256 * 1024; // Keep latest 256 KB on trim

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function capLogFileSize() {
  try {
    if (!fs.existsSync(BOT_LOG)) return;
    const st = fs.statSync(BOT_LOG);
    if (st.size <= MAX_LOG_BYTES) return;

    const fd = fs.openSync(BOT_LOG, 'r');
    const buffer = Buffer.alloc(KEEP_LOG_BYTES);
    fs.readSync(fd, buffer, 0, KEEP_LOG_BYTES, st.size - KEEP_LOG_BYTES);
    fs.closeSync(fd);

    const text = buffer.toString('utf-8');
    const firstNewline = text.indexOf('\n');
    const cleanTail = firstNewline !== -1 ? text.slice(firstNewline + 1) : text;
    fs.writeFileSync(
      BOT_LOG,
      `[${new Date().toISOString()}] [Supervisor] Log rotated (capped at 512 KB).\n` + cleanTail,
      'utf-8'
    );
  } catch {
    // ignore if locked
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    capLogFileSize();
    fs.appendFileSync(BOT_LOG, line);
  } catch {
    // ignore
  }
}

// Periodic log size check every 30 minutes
setInterval(() => {
  capLogFileSize();
}, 30 * 60 * 1000).unref();

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 1. Prevent duplicate supervisor instances
if (fs.existsSync(PID_FILE)) {
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (existingPid && existingPid !== process.pid && isProcessRunning(existingPid)) {
      process.exit(0);
    }
  } catch {
    // stale pid file
  }
}
fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');

/**
 * Safely auto-updates yt-dlp.exe on startup (and every 24h) with automatic backup & rollback
 * so YouTube extractor changes never break playback.
 */
function ensureYtDlpUpdated() {
  if (!fs.existsSync(YTDLP_EXE)) return;
  try {
    // Save working backup before updating
    fs.copyFileSync(YTDLP_EXE, YTDLP_BAK);
    log('[Supervisor] Checking for yt-dlp updates...');
    const out = execFileSync(YTDLP_EXE, ['-U'], {
      timeout: 25000,
      windowsHide: true,
      encoding: 'utf-8',
    });
    const summary = (out || '').trim().split(/\r?\n/).pop() || 'up to date';
    log(`[Supervisor] yt-dlp update status: ${summary}`);

    // Verify binary still runs cleanly after update
    execFileSync(YTDLP_EXE, ['--version'], { timeout: 5000, windowsHide: true });
  } catch (err) {
    log(`[Supervisor] yt-dlp update check note: ${err?.message || err}`);
    // Verify binary; restore backup if corrupted
    try {
      execFileSync(YTDLP_EXE, ['--version'], { timeout: 5000, windowsHide: true });
    } catch {
      if (fs.existsSync(YTDLP_BAK)) {
        try {
          fs.copyFileSync(YTDLP_BAK, YTDLP_EXE);
          log('[Supervisor] Restored yt-dlp.exe from backup.');
        } catch {}
      }
    }
  }
}

// Re-check yt-dlp updates every 24 hours in the background
setInterval(() => {
  ensureYtDlpUpdated();
}, 24 * 60 * 60 * 1000).unref();

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

let lavalinkProc = null;
let botProc = null;
let shuttingDown = false;

async function ensureLavalink() {
  const alreadyUp = await checkPort(2333);
  if (alreadyUp) {
    log('[Supervisor] Lavalink already listening on port 2333.');
    return;
  }

  log('[Supervisor] Starting Lavalink v4 server in background...');
  lavalinkProc = spawn('java', ['-jar', 'Lavalink.jar'], {
    cwd: LAVALINK_DIR,
    windowsHide: true,
    stdio: 'ignore',
  });

  lavalinkProc.on('exit', (code) => {
    log(`[Supervisor] Lavalink exited with code ${code}.`);
    lavalinkProc = null;
    if (!shuttingDown) {
      setTimeout(() => ensureLavalink(), 5000);
    }
  });

  // Wait up to 40s for Lavalink port 2333 to open
  for (let i = 0; i < 40; i++) {
    if (await checkPort(2333)) {
      log('[Supervisor] Lavalink is ready on port 2333!');
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function startBot() {
  if (shuttingDown || botProc) return;

  log('[Supervisor] Starting Spotbot (dist/index.js)...');
  const outStream = fs.openSync(BOT_LOG, 'a');

  botProc = spawn(process.execPath, [path.join(__dirname, 'dist', 'index.js')], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ['ignore', outStream, outStream],
  });

  botProc.on('exit', (code) => {
    log(`[Supervisor] Spotbot process exited (code ${code}). Restarting in 5s...`);
    botProc = null;
    if (!shuttingDown) {
      setTimeout(() => startBot(), 5000);
    }
  });
}

function cleanup() {
  shuttingDown = true;
  try {
    if (botProc) botProc.kill();
  } catch {}
  try {
    if (lavalinkProc) lavalinkProc.kill();
  } catch {}
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function run() {
  log('=========================================');
  log('[Supervisor] Spotbot Auto-Start Daemon initialized.');
  ensureYtDlpUpdated();
  await ensureLavalink();
  startBot();
}

run();
