const fs = require("fs");

let savedTimers = {};

const filePath = "./jiraLogger.json";

function loadTimers() {
  if (fs.existsSync(filePath)) {
    try {
      savedTimers = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.error("Error loading timers:", error);
      savedTimers = {};
    }
  }

  return savedTimers;
}

function clearTimers() {
  if (fs.existsSync(filePath)) {
    try {
      fs.writeFileSync(filePath, "", "utf8");
    } catch (error) {
      console.error("Error clearing timers:", error);
    }
  }
}

module.exports = { loadTimers, clearTimers };
