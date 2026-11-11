const { app, BrowserWindow, ipcMain, powerMonitor, Menu, Tray, nativeImage } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("node:path");
const Store = require("electron-store");
const log = require("electron-log");
const { getIdleSeconds, recordActivity, isUserActive } = require("./idleMonitor");
const { loadTimers, saveTimers, deleteDayLog, listLogs, getTodayKey } = require("./fileManager");

process.on("uncaughtException", (error) => {
  log.error("Uncaught Exception:", error);
});

log.info("App starting...");

const configStore = new Store({ name: "config" });

const IDLE_STOP_SECONDS = 300;
const IDLE_CHECK_INTERVAL_MS = 10000;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasBeenIdle = false;
let idelingEnabled = true;
let idleStopSent = false;
let idleMonitoringStarted = false;

function isMainWindowAlive() {
  return mainWindow && !mainWindow.isDestroyed();
}

function sendToRenderer(channel, ...args) {
  if (!isMainWindowAlive()) return;
  mainWindow.webContents.send(channel, ...args);
}

function createMainWindow() {
  if (isMainWindowAlive()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: iconPath,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  log.info("BrowserWindow created");

  mainWindow.loadURL(`file://${__dirname}/index.html`);

  mainWindow.webContents.on("did-finish-load", () => {
    if (!isMainWindowAlive()) return;

    const hasToken = configStore.get("token");
    const hasCreds =
      configStore.get("username") && configStore.get("password");
    if (!hasToken && !hasCreds) {
      sendToRenderer("show-config-modal");
    } else {
      sendToRenderer("load-finished");
    }
  });

  mainWindow.on("minimize", () => {
    mainWindow.hide();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    sendToRenderer("saving-timers");
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip("Jira Logger");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Jira Logger", click: createMainWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", createMainWindow);
}

function stopTimerDueToIdle() {
  if (!idelingEnabled || idleStopSent || !isMainWindowAlive()) return;

  idleStopSent = true;
  hasBeenIdle = true;
  log.info("Stopping timer due to %ss of inactivity", getIdleSeconds());
  sendToRenderer("stop-timer");
  sendToRenderer("saving-timers");
}

function resetIdleTracking() {
  idleStopSent = false;
}

function notifyUserReturnedFromIdle() {
  if (!hasBeenIdle || !isMainWindowAlive()) return;

  hasBeenIdle = false;
  resetIdleTracking();
  recordActivity();

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendToRenderer("show-idle-alert");
}

function startIdleMonitoring() {
  if (idleMonitoringStarted) return;
  idleMonitoringStarted = true;

  powerMonitor.on("lock-screen", stopTimerDueToIdle);
  powerMonitor.on("suspend", stopTimerDueToIdle);

  setInterval(() => {
    if (!idelingEnabled || !isMainWindowAlive()) return;

    const idleTime = getIdleSeconds();
    if (!idleStopSent && idleTime >= IDLE_STOP_SECONDS) {
      stopTimerDueToIdle();
      return;
    }

    if (hasBeenIdle && isUserActive(idleTime)) {
      notifyUserReturnedFromIdle();
    }
  }, IDLE_CHECK_INTERVAL_MS);

  setInterval(() => {
    sendToRenderer("saving-timers");
  }, 300000);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createMainWindow();
  });
}

ipcMain.on("toggle-ideling", (_event, onMeeting) => {
  idelingEnabled = !onMeeting;
  if (onMeeting) {
    hasBeenIdle = false;
    idleStopSent = false;
  }
});

ipcMain.on("user-activity", () => {
  recordActivity();
});

const LOG_API_PORT = 3456;

function startLogApiServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    const url = new URL(req.url, `http://localhost:${LOG_API_PORT}`);
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

    if (segments[0] !== "logs") {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: "Not found. Use /logs" }));
    }

    const dateParam = segments[1] || null;

    if (req.method === "GET") {
      if (dateParam) {
        const data = loadTimers(dateParam);
        res.writeHead(200);
        return res.end(JSON.stringify({ date: dateParam, data }));
      }
      const days = listLogs();
      const all = {};
      for (const d of days) {
        all[d] = loadTimers(d);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ days, logs: all }));
    }

    if (req.method === "DELETE") {
      const target = dateParam || getTodayKey();
      const deleted = deleteDayLog(target);
      res.writeHead(deleted ? 200 : 404);
      return res.end(JSON.stringify({ date: target, deleted }));
    }

    if (req.method === "POST" || req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const target = dateParam || getTodayKey();
          const existing = loadTimers(target);
          const merged = { ...existing, ...data };
          saveTimers(merged, target);
          res.writeHead(200);
          res.end(JSON.stringify({ date: target, data: merged }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
  });

  server.listen(LOG_API_PORT, () => {
    log.info(`Log API server running on http://localhost:${LOG_API_PORT}`);
  });
}

app.whenReady().then(() => {
  createTray();
  createMainWindow();
  startIdleMonitoring();
  startLogApiServer();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.on("save-timers", (_event, updatedTimers, dateKey) => {
  saveTimers(updatedTimers, dateKey);
});

ipcMain.on("save-config", (_event, config) => {
  if (config.username && config.password) {
    configStore.set("username", config.username);
    configStore.set("password", config.password);
    configStore.delete("token");
  }
  if (config.authType) {
    configStore.set("authType", config.authType);
  }
  configStore.set("accountId", config.accountId);
  configStore.set("name", config.name);
  configStore.set("displayName", config.displayName);
});

ipcMain.on("update-config", (event, config) => {
  if (config.project !== undefined) {
    configStore.set("project", config.project);
  }

  event.reply("upadte-config", config);
});

ipcMain.on("get-config", (event) => {
  const config = {
    token: configStore.get("token"),
    username: configStore.get("username"),
    password: configStore.get("password"),
    authType: configStore.get("authType"),
    accountId: configStore.get("accountId"),
    name: configStore.get("name"),
    displayName: configStore.get("displayName"),
    project: configStore.get("project"),
  };

  event.reply("send-config", config);
});
