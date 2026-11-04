const { app, BrowserWindow, ipcMain, powerMonitor } = require("electron");
const fs = require("fs");
const path = require("node:path");
const Store = require("electron-store");
const log = require("electron-log");
const { getIdleSeconds, recordActivity, isUserActive } = require("./idleMonitor");

process.on("uncaughtException", (error) => {
  log.error("Uncaught Exception:", error);
});

log.info("App starting...");

const configStore = new Store({ name: "config" });
const timerFilePath = "./jiraLogger.json";

const IDLE_STOP_SECONDS = 300;
const IDLE_CHECK_INTERVAL_MS = 10000;

let mainWindow = null;
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
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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

app.whenReady().then(() => {
  createMainWindow();
  startIdleMonitoring();
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.on("save-timers", (_event, updatedTimers) => {
  fs.writeFileSync(timerFilePath, JSON.stringify(updatedTimers, null, 2));
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
