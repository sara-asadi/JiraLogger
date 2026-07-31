const axios = require("axios");
const { ipcRenderer } = require("electron");

// Force Node http adapter so Electron session cookies are not sent.
// Cookie auth triggers Jira's XSRF check ("XSRF check failed" 403).
const jiraAxios = axios.create({
  adapter: "http",
  timeout: 30000,
});

const jiraInfo = {
  baseUrl: "https://mars-jira.systemgroup.net",
  project: "",
  auth: {},
};

class Issue {
  constructor(key, id, title, parentKey, parentTitle, issueType, state) {
    this.key = key;
    this.id = id;
    this.title = title;
    this.parentKey = parentKey;
    this.parentTitle = parentTitle;
    this.issueType = issueType;
    this.state = state;
  }
}

let configReadyPromise = null;

function applyConfig(config) {
  jiraInfo.auth = {
    token: config.token,
    username: config.username,
    password: config.password,
    // "bearer" | "basic" | "basic-token" — set on login; optional in store
    authType: config.authType || null,
  };
  jiraInfo.project = config.project || "";
  jiraInfo.accountId = config.accountId;
  jiraInfo.name = config.name;
  jiraInfo.userDisplayName = config.displayName;
}

function initConfig() {
  configReadyPromise = new Promise((resolve) => {
    ipcRenderer.once("send-config", (_event, config) => {
      applyConfig(config);
      resolve(config);
    });
    ipcRenderer.send("get-config");
  });

  ipcRenderer.on("send-config", (_event, config) => {
    applyConfig(config);
  });

  ipcRenderer.on("upadte-config", (_event, config) => {
    if (config.project !== undefined) {
      jiraInfo.project = config.project || "";
    }
  });
}

initConfig();

async function ensureConfig() {
  if (jiraInfo.auth.token || (jiraInfo.auth.username && jiraInfo.auth.password)) {
    return;
  }
  if (configReadyPromise) {
    await configReadyPromise;
  }
}

function getAuthHeaders(auth = jiraInfo.auth) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Atlassian-Token": "no-check",
  };

  const authType =
    auth.authType ||
    (auth.username && auth.password
      ? "basic"
      : auth.token
        ? "bearer"
        : null);

  if (authType === "basic" && auth.username && auth.password) {
    const basic = Buffer.from(`${auth.username}:${auth.password}`).toString(
      "base64"
    );
    return { ...headers, Authorization: `Basic ${basic}` };
  }

  if (authType === "basic-token" && auth.username && auth.token) {
    const basic = Buffer.from(`${auth.username}:${auth.token}`).toString(
      "base64"
    );
    return { ...headers, Authorization: `Basic ${basic}` };
  }

  if (auth.token) {
    return { ...headers, Authorization: `Bearer ${auth.token}` };
  }

  if (auth.username && auth.password) {
    const basic = Buffer.from(`${auth.username}:${auth.password}`).toString(
      "base64"
    );
    return { ...headers, Authorization: `Basic ${basic}` };
  }

  throw new Error("No Jira credentials configured.");
}

function getBasicTokenHeaders(auth) {
  const passwordOrToken = auth.password || auth.token;
  const basic = Buffer.from(`${auth.username}:${passwordOrToken}`).toString(
    "base64"
  );
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Atlassian-Token": "no-check",
  };
}

async function requestMyself(headers) {
  return jiraAxios.get(`${jiraInfo.baseUrl}/rest/api/2/myself`, { headers });
}

async function validateJiraCredentials(config) {
  let response;
  let authType;

  if (config.username && config.password) {
    authType = "basic";
    response = await requestMyself(
      getAuthHeaders({
        username: config.username,
        password: config.password,
        authType,
      })
    );
  } else if (config.token) {
    try {
      authType = "bearer";
      response = await requestMyself(
        getAuthHeaders({ token: config.token, authType })
      );
    } catch (bearerError) {
      if (!config.username) {
        throw bearerError;
      }
      authType = "basic-token";
      response = await requestMyself(
        getBasicTokenHeaders({
          username: config.username,
          token: config.token,
        })
      );
    }
  } else {
    throw new Error(
      "Provide username and password, or an API token / PAT."
    );
  }

  jiraInfo.auth = {
    token: config.token || null,
    username: config.username || null,
    password: config.password || null,
    authType,
  };

  const user = response.data;
  jiraInfo.accountId = user.accountId || user.key || user.name;
  jiraInfo.name = user.name;
  jiraInfo.userDisplayName = user.displayName;

  return { ...user, authType };
}

async function getProjects() {
  await ensureConfig();
  const url = `${jiraInfo.baseUrl}/rest/api/2/project`;
  try {
    const response = await jiraAxios.get(url, { headers: getAuthHeaders() });
    return response.data;
  } catch (error) {
    console.error("Error loading projects:", error);
    return [];
  }
}

function buildSearchJql() {
  let jql =
    "assignee = currentUser() AND resolution = Unresolved AND statusCategory != Done AND sprint in openSprints() ORDER BY rank";
  if (jiraInfo.project) {
    jql = `project = "${jiraInfo.project}" AND ${jql}`;
  }
  return jql;
}

function formatJiraError(error) {
  const status = error.response && error.response.status;
  const data = error.response && error.response.data;
  const messages = []
    .concat((data && data.errorMessages) || [])
    .concat(
      data && data.errors
        ? Object.values(data.errors)
        : []
    )
    .filter(Boolean);

  const detail = messages.join(" ") || (data && data.message) || error.message;
  return status ? `Jira ${status}: ${detail}` : detail;
}

async function searchIssues(jql) {
  await ensureConfig();

  const fields = ["summary", "issuetype", "status", "parent"];
  const maxResults = 100;
  const body = { jql, fields, maxResults };
  const headers = getAuthHeaders();
  const base = jiraInfo.baseUrl;

  const attempts = [
    // GET is the classic Server/DC path; some proxies/WAF reject POST with 403
    () =>
      jiraAxios.get(`${base}/rest/api/2/search`, {
        headers,
        params: { jql, fields: fields.join(","), maxResults },
      }),
    () => jiraAxios.post(`${base}/rest/api/2/search`, body, { headers }),
    () => jiraAxios.post(`${base}/rest/api/3/search`, body, { headers }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const response = await attempt();
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response && error.response.status;
      // Try next variant for method/endpoint mismatches
      if (status === 404 || status === 405 || status === 403) {
        continue;
      }
      throw new Error(formatJiraError(error));
    }
  }
  throw new Error(formatJiraError(lastError));
}

function mapIssue(issue) {
  const fields = issue.fields || {};
  const parent = fields.parent;
  const status = fields.status || {};
  return new Issue(
    issue.key,
    issue.id,
    fields.summary || "",
    parent ? parent.key : "",
    parent && parent.fields ? parent.fields.summary || "" : "",
    fields.issuetype ? fields.issuetype.name : "",
    status.name || ""
  );
}

function isClosedIssue(issue) {
  const status = (issue.fields && issue.fields.status) || {};
  const categoryKey =
    status.statusCategory && String(status.statusCategory.key || "").toLowerCase();
  if (categoryKey === "done") return true;

  const name = String(status.name || "").toLowerCase();
  return (
    name === "closed" ||
    name === "done" ||
    name === "resolved" ||
    name === "cancelled" ||
    name === "canceled"
  );
}

async function fetchOpenSprintIssues() {
  await ensureConfig();
  const data = await searchIssues(buildSearchJql());
  const issues = (data.issues || []).filter((i) => !isClosedIssue(i)).map(mapIssue);
  if (!issues.length) {
    throw new Error("No open-sprint issues assigned to you.");
  }
  return issues;
}

function formatJiraStarted(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.000${sign}${oh}${om}`
  );
}

async function logTimeForWorkItem(issueKey, timer) {
  const minutesSpent = Math.round(timer.time / 60);
  if (minutesSpent === 0) return false;

  const payload = {
    timeSpent: `${minutesSpent}m`,
    started: formatJiraStarted(),
  };

  if (timer.comment) {
    payload.comment = timer.comment;
  }

  try {
    const response = await jiraAxios.post(
      `${jiraInfo.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog`,
      payload,
      { headers: getAuthHeaders() }
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error("Worklog request failed.");
    }

    console.log(`Logged time for issue ${issueKey}`);
    return true;
  } catch (error) {
    console.error("Log error:", error);
    alert(`Logging failed for issue ${issueKey}`);
    return false;
  }
}

module.exports = {
  fetchOpenSprintIssues,
  logTimeForWorkItem,
  validateJiraCredentials,
  getProjects,
};
