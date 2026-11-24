const fs = require("fs");
const path = require("path");
let electronApp;
try {
  electronApp = require("electron").app;
} catch {}

function getLogsDir() {
  if (electronApp && electronApp.isReady()) {
    return path.join(electronApp.getPath("userData"), "logs");
  }
  return path.join(__dirname, "logs");
}

function ensureLogsDir() {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

function getTodayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getLogFilePath(dateKey) {
  ensureLogsDir();
  return path.join(getLogsDir(), `${dateKey}.json`);
}

function loadTimers(dateKey) {
  const key = dateKey || getTodayKey();
  const filePath = getLogFilePath(key);

  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.error("Error loading timers:", error);
    }
  }

  // Read logs created by older versions from the application directory once.
  const legacyPath = path.join(__dirname, "logs", `${key}.json`);
  if (legacyPath !== filePath && fs.existsSync(legacyPath)) {
    try {
      const legacyData = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      saveTimers(legacyData, key);
      return legacyData;
    } catch (error) {
      console.error("Error loading legacy timers:", error);
    }
  }

  // Migrate the pre multi-day log file to today's date on first access.
  if (key === getTodayKey()) {
    const singleDayPath = path.join(__dirname, "jiraLogger.json");
    if (singleDayPath !== filePath && fs.existsSync(singleDayPath)) {
      try {
        const oldData = JSON.parse(fs.readFileSync(singleDayPath, "utf8"));
        if (oldData && typeof oldData === "object" && Object.keys(oldData).length) {
          saveTimers(oldData, key);
          return oldData;
        }
      } catch (error) {
        console.error("Error loading legacy single-day timers:", error);
      }
    }
  }

  return {};
}

function saveTimers(data, dateKey) {
  const key = dateKey || getTodayKey();
  const filePath = getLogFilePath(key);

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving timers:", error);
  }
}

function clearTimers(dateKey) {
  const key = dateKey || getTodayKey();
  const filePath = getLogFilePath(key);

  if (fs.existsSync(filePath)) {
    try {
      fs.writeFileSync(filePath, "{}", "utf8");
    } catch (error) {
      console.error("Error clearing timers:", error);
    }
  }
}

function deleteDayLog(dateKey) {
  if (!dateKey) return false;
  const filePath = getLogFilePath(dateKey);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error("Error deleting day log:", error);
      return false;
    }
  }

  return false;
}

function listLogs() {
  ensureLogsDir();
  const logsDir = getLogsDir();
  try {
    return fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort();
  } catch (error) {
    console.error("Error listing logs:", error);
    return [];
  }
}

module.exports = {
  loadTimers,
  saveTimers,
  clearTimers,
  deleteDayLog,
  listLogs,
  getTodayKey,
};
