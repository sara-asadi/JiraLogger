const fs = require("fs");
const path = require("path");

const logsDir = path.join(__dirname, "logs");

function ensureLogsDir() {
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
  return path.join(logsDir, `${dateKey}.json`);
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
