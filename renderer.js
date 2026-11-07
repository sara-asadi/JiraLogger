const { loadTimers, clearTimers } = require("./fileManager");
const {
  fetchOpenSprintIssues,
  logTimeForWorkItem,
  validateJiraCredentials,
  getProjects,
  createSubtask,
  fetchOpenSprintStories,
  getSubtaskRequiredOptions,
} = require("./jira");
const { ipcRenderer } = require("electron");

const timers = {};
let onGoingIssueKey = null;

function toggleDarkTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("darkTheme", document.body.classList.contains("dark"));
}

function stopAllRunningTimers() {
  if (onGoingIssueKey != null) {
    stopTimer(onGoingIssueKey);
    return;
  }

  for (const [key, timer] of Object.entries(timers)) {
    if (timer.interval) {
      stopTimer(key);
    }
  }
}

function reportUserActivity() {
  ipcRenderer.send("user-activity");
}

function setupActivityTracking() {
  let lastSent = 0;
  const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];

  for (const eventName of events) {
    window.addEventListener(
      eventName,
      () => {
        const now = Date.now();
        if (now - lastSent < 1000) return;
        lastSent = now;
        reportUserActivity();
      },
      { passive: true }
    );
  }
}

window.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("darkTheme") === "true") {
    document.body.classList.add("dark");
  }
  setupActivityTracking();
});

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderIssues() {
  try {
    const issues = await fetchOpenSprintIssues();

    const tableBody = document.getElementById("issues-table");
    if (!tableBody) {
      return console.error("Element #issues-table not found!");
    }

    const savedTimers = loadTimers();
    tableBody.innerHTML = "";

    for (const item of issues) {
      const key = item.key;
      const row = document.createElement("tr");
      const parentLabel = item.parentKey
        ? `${item.parentKey}${item.parentTitle ? ` — ${item.parentTitle}` : ""}`
        : "";

      row.innerHTML = `
          <td>${escapeHtml(key)}</td>
          <td>${escapeHtml(parentLabel)}</td>
          <td>${escapeHtml(item.title)}</td>
          <td>${escapeHtml(item.issueType)}</td>
          <td>${escapeHtml(item.state)}</td>
          <td id="timer-${escapeHtml(key)}" contenteditable="true">00:00:00</td>
          <td>
            <button class="button action is-success" id="start-${escapeHtml(key)}" onclick="startTimer('${key}')">Start</button>
            <button class="button action is-warning is-hidden" id="stop-${escapeHtml(key)}" onclick="stopTimer('${key}')">Stop</button>
            <button class="button action is-danger" id="reset-${escapeHtml(key)}" onclick="resetTimer('${key}')">Reset</button>
          </td>`;

      tableBody.appendChild(row);

      if (!timers[key]) {
        timers[key] = {
          time: savedTimers[key]?.time || 0,
          interval: null,
          title: item.title || "Unknown",
        };
      }
      updateTimerDisplay(key);
    }
  } catch (error) {
    console.error("Failed to load issues:", error);
    if (error.isAuthError) {
      openCredentialsModal(
        "Authentication failed. Please enter your current password."
      );
      return;
    }
    alert(error.message || "Failed to load issues.");
  }
}

async function openSettings() {
  document.getElementById("settings-modal").classList.add("is-active");

  const projectSelector = document.getElementById("projectSelector");
  projectSelector.disabled = true;
  projectSelector.innerHTML = "<option>Loading projects...</option>";

  const projects = await getProjects();

  projectSelector.innerHTML = "";
  projectSelector.appendChild(new Option("All projects", ""));

  (projects || []).forEach((project) => {
    const option = new Option(
      `${project.key} — ${project.name}`,
      project.key
    );
    projectSelector.appendChild(option);
  });

  ipcRenderer.once("send-config", (_event, config) => {
    if (config.project) {
      projectSelector.value = config.project;
    }
  });
  ipcRenderer.send("get-config");

  projectSelector.disabled = false;
}

async function submitProject() {
  const projectSelector = document.getElementById("projectSelector");
  const selectedProjectKey = projectSelector.value;

  ipcRenderer.send("update-config", {
    project: selectedProjectKey,
  });

  closeSettings();
}

async function loadParentOptions() {
  const select = document.getElementById("subtask-parent-input");
  const errorEl = document.getElementById("subtask-error");
  select.disabled = true;
  select.innerHTML = '<option value="">Loading issues...</option>';
  errorEl.innerText = "";

  try {
    const stories = await fetchOpenSprintStories();
    select.innerHTML = '<option value="">Select a parent issue</option>';
    if (!stories.length) {
      errorEl.innerText = "No open issues in the current sprint.";
    }
    for (const issue of stories) {
      select.appendChild(
        new Option(`${issue.key} [${issue.issueType}] — ${issue.title}`, issue.key)
      );
    }
    select.disabled = false;
  } catch (error) {
    console.error("Failed to load parent issues:", error);
    select.innerHTML = '<option value="">No issues available</option>';
    errorEl.innerText = error.message || "Failed to load sprint issues.";
  }
}

async function loadSubtaskFields() {
  const parentKey = document.getElementById("subtask-parent-input").value;
  const container = document.getElementById("subtask-extra-fields");
  const errorEl = document.getElementById("subtask-error");
  container.innerHTML = "";
  errorEl.innerText = "";
  if (!parentKey) return;

  try {
    const fields = await getSubtaskRequiredOptions(parentKey);
    for (const field of fields) {
      const wrapper = document.createElement("div");
      wrapper.className = "field";

      const label = document.createElement("label");
      label.className = "label";
      label.textContent = `${field.name} (required)`;

      const control = document.createElement("div");
      control.className = "select is-fullwidth";

      const select = document.createElement("select");
      select.dataset.fieldId = field.fieldId;
      select.dataset.fieldName = field.name;
      select.appendChild(new Option(`Select ${field.name}`, ""));
      for (const opt of field.options) {
        select.appendChild(new Option(opt.label, opt.id));
      }

      control.appendChild(select);
      wrapper.append(label, control);
      container.appendChild(wrapper);
    }
  } catch (error) {
    console.error("Failed to load sub-task fields:", error);
    errorEl.innerText = error.message || "Failed to load sub-task fields.";
  }
}

document
  .getElementById("subtask-parent-input")
  .addEventListener("change", loadSubtaskFields);

function openSubtaskForm() {
  document.getElementById("subtask-modal").classList.add("is-active");
  document.getElementById("subtask-summary-input").value = "";
  document.getElementById("subtask-extra-fields").innerHTML = "";
  document.getElementById("subtask-error").innerText = "";
  loadParentOptions();
}

function closeSubtaskModal() {
  document.getElementById("subtask-modal").classList.remove("is-active");
}

async function submitSubtask() {
  const parentSelect = document.getElementById("subtask-parent-input");
  const summaryInput = document.getElementById("subtask-summary-input");
  const errorEl = document.getElementById("subtask-error");
  errorEl.innerText = "";

  if (!parentSelect.value) {
    errorEl.innerText = "Please select a parent issue.";
    return;
  }

  const extraFields = {};
  for (const select of document.querySelectorAll("#subtask-extra-fields select")) {
    if (!select.value) {
      errorEl.innerText = `Please select ${select.dataset.fieldName}.`;
      return;
    }
    extraFields[select.dataset.fieldId] = { id: select.value };
  }

  try {
    const created = await createSubtask(
      parentSelect.value,
      summaryInput.value,
      extraFields
    );
    alert(`Created sub-task ${created.key}`);
    parentSelect.value = "";
    summaryInput.value = "";
    document.getElementById("subtask-extra-fields").innerHTML = "";
  } catch (error) {
    if (error.isAuthError) {
      closeSubtaskModal();
      openCredentialsModal(
        "Authentication failed. Please enter your current password."
      );
      return;
    }
    errorEl.innerText = error.message || "Failed to create sub-task.";
  }
}

async function closeSettings() {
  document.getElementById("settings-modal").classList.remove("is-active");
}

async function logAllTimers() {
  for (const [key, timer] of Object.entries(timers)) {
    timer.time = getTimerTimeFromText(key);
    if (timer.time <= 0) continue;

    try {
      const success = await logTimeForWorkItem(key, timer);
      if (success) resetTimer(key);
    } catch {}
  }

  clearTimers();
}

function startTimer(key) {
  if (onGoingIssueKey != null) {
    stopTimer(onGoingIssueKey);
  }

  onGoingIssueKey = key;
  reportUserActivity();

  timers[key].time = getTimerTimeFromText(key);

  if (timers[key].interval) return;

  timers[key].startTime = Date.now() - (timers[key].time * 1000 || 0);

  timers[key].interval = setInterval(() => {
    timers[key].time = Math.floor((Date.now() - timers[key].startTime) / 1000);
    updateTimerDisplay(key);
  }, 1000);

  toggleButtons(key, true);
}

function stopTimer(key) {
  if (!timers[key]) return;

  if (timers[key].interval && timers[key].startTime) {
    timers[key].time = Math.floor((Date.now() - timers[key].startTime) / 1000);
    updateTimerDisplay(key);
  }

  clearInterval(timers[key].interval);
  timers[key].interval = null;
  toggleButtons(key, false);
  if (onGoingIssueKey === key) {
    onGoingIssueKey = null;
  }
}

function resetTimer(key) {
  stopTimer(key);
  timers[key].time = 0;
  updateTimerDisplay(key);
}

function getTimerTimeFromText(key) {
  const timer = document.getElementById(`timer-${key}`);
  if (timer == null) {
    return 0;
  }

  const [hours, minutes, seconds] = timer.innerText.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function updateTimerDisplay(key) {
  const el = document.getElementById(`timer-${key}`);
  if (!el || !timers[key]) return;

  const totalSeconds = timers[key].time;
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");

  el.textContent = `${h}:${m}:${s}`;
}

function toggleButtons(key, isRunning) {
  const startBtn = document.getElementById(`start-${key}`);
  const stopBtn = document.getElementById(`stop-${key}`);

  if (startBtn && stopBtn) {
    startBtn.classList.toggle("is-hidden", isRunning);
    stopBtn.classList.toggle("is-hidden", !isRunning);
  }
}

function togglePasswordVisibility() {
  const passwordInput = document.getElementById("password-input");
  const showing = document.getElementById("show-password").checked;
  passwordInput.type = showing ? "text" : "password";
}

function openCredentialsModal(message = "") {
  const errorEl = document.getElementById("config-error");
  errorEl.innerText = message;
  document.getElementById("password-input").value = "";
  document.getElementById("show-password").checked = false;
  togglePasswordVisibility();

  ipcRenderer.once("send-config", (_event, config) => {
    if (config.username) {
      document.getElementById("username-input").value = config.username;
    }
  });
  ipcRenderer.send("get-config");

  document.getElementById("config-modal").classList.add("is-active");
}

async function submitCredentials() {
  const username = document.getElementById("username-input").value.trim();
  const password = document.getElementById("password-input").value.trim();
  const errorEl = document.getElementById("config-error");

  if (!(username && password)) {
    return alert("Please enter username and password.");
  }

  try {
    const profile = await validateJiraCredentials({
      username,
      password,
    });
    ipcRenderer.send("save-config", {
      token: "",
      username,
      password,
      authType: profile.authType,
      accountId: profile.accountId || profile.key || profile.name,
      name: profile.name,
      displayName: profile.displayName,
    });

    errorEl.innerText = "";
    document.getElementById("config-modal").classList.remove("is-active");
    renderIssues();
  } catch {
    errorEl.innerText = "Authentication failed. Please check your credentials.";
  }
}

async function saveTimers() {
  try {
    const activeTimers = Object.fromEntries(
      Object.entries(timers).filter(([key, t]) => {
        t.time = getTimerTimeFromText(key);
        return t.time > 0;
      })
    );
    ipcRenderer.send("save-timers", activeTimers);
  } catch (err) {
    console.error("Failed to save timers:", err);
  }
}

function closeIdleAlert() {
  document.getElementById("idle-alert-modal").classList.remove("is-active");
}

function showIdleAlert() {
  document.getElementById("idle-alert-modal").classList.add("is-active");
}

document
  .getElementById("on-meeting-label")
  .addEventListener("click", function () {
    const onMeetingCheckbox = document.getElementById("on-meeting");
    onMeetingCheckbox.checked = !onMeetingCheckbox.checked;
    this.classList.toggle("active", onMeetingCheckbox.checked);

    ipcRenderer.send("toggle-ideling", onMeetingCheckbox.checked);
  });

window.addEventListener("beforeunload", () => {
  saveTimers();
});

ipcRenderer.on("load-finished", () => {
  renderIssues();
});

ipcRenderer.on("load-timers", (_event, saved) => {
  Object.assign(timers, saved);
  Object.keys(saved).forEach(updateTimerDisplay);
});

ipcRenderer.on("show-config-modal", () => {
  openCredentialsModal();
});

ipcRenderer.on("show-idle-alert", () => {
  showIdleAlert();
});

ipcRenderer.on("stop-timer", () => {
  stopAllRunningTimers();
});

ipcRenderer.on("saving-timers", () => {
  saveTimers();
});

window.closeIdleAlert = closeIdleAlert;
window.startTimer = startTimer;
window.stopTimer = stopTimer;
window.resetTimer = resetTimer;
window.submitCredentials = submitCredentials;
window.togglePasswordVisibility = togglePasswordVisibility;
window.renderIssues = renderIssues;
window.logAllTimers = logAllTimers;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.submitProject = submitProject;
window.submitSubtask = submitSubtask;
window.openSubtaskForm = openSubtaskForm;
window.closeSubtaskModal = closeSubtaskModal;
window.toggleDarkTheme = toggleDarkTheme;
