const { execFileSync } = require("child_process");
const { powerMonitor } = require("electron");
const log = require("electron-log");

let lastActivityAt = Date.now();

function recordActivity() {
  lastActivityAt = Date.now();
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readGnomeIdleMs() {
  const out = runCommand("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.gnome.Mutter.IdleMonitor",
    "--object-path",
    "/org/gnome/Mutter/IdleMonitor/Core",
    "--method",
    "org.gnome.Mutter.IdleMonitor.GetIdletime",
  ]);
  if (!out) return null;

  const match = out.match(/uint64\s+(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function readKdeIdleMs() {
  const out = runCommand("qdbus", [
    "org.kde.screensaver",
    "/ScreenSaver",
    "GetIdleTime",
  ]);
  if (!out) return null;

  const ms = parseInt(out, 10);
  return Number.isNaN(ms) ? null : ms;
}

function readX11IdleMs() {
  const out = runCommand("xprintidle", []);
  if (!out) return null;

  const ms = parseInt(out, 10);
  return Number.isNaN(ms) ? null : ms;
}

function readLinuxIdleMs() {
  const gnomeIdleMs = readGnomeIdleMs();
  if (gnomeIdleMs !== null) return gnomeIdleMs;

  const kdeIdleMs = readKdeIdleMs();
  if (kdeIdleMs !== null) return kdeIdleMs;

  if (process.env.XDG_SESSION_TYPE !== "wayland") {
    return readX11IdleMs();
  }

  return null;
}

function getIdleSeconds() {
  let idleSeconds = powerMonitor.getSystemIdleTime();
  let linuxIdleMs = null;

  if (process.platform === "linux") {
    linuxIdleMs = readLinuxIdleMs();
    if (linuxIdleMs !== null) {
      idleSeconds = Math.max(idleSeconds, Math.floor(linuxIdleMs / 1000));
    }
  }

  if (idleSeconds > 0) {
    return idleSeconds;
  }

  if (
    process.platform === "linux" &&
    process.env.XDG_SESSION_TYPE === "wayland" &&
    linuxIdleMs === null
  ) {
    return Math.floor((Date.now() - lastActivityAt) / 1000);
  }

  return 0;
}

function isUserActive(idleSeconds) {
  const idle = idleSeconds ?? getIdleSeconds();
  return idle < 5;
}

recordActivity();
log.info(
  "Idle monitor ready (session=%s, platform=%s)",
  process.env.XDG_SESSION_TYPE || "unknown",
  process.platform
);

module.exports = {
  getIdleSeconds,
  recordActivity,
  isUserActive,
};
