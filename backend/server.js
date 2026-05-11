const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

loadEnvFile(path.join(__dirname, "..", ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "localhost";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:4173";
const ACCESS_KEY = process.env.OPTIMUS_ACCESS_KEY || "optimus";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
const OUTPUTS_DIR = path.join(__dirname, "..", "Outputs");

const sessions = new Map();

function loadEnvFile(filePath) {
  try {
    const contents = require("node:fs").readFileSync(filePath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");

      if (key && !Object.hasOwn(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      body += chunk;
      if (bytes > MAX_JSON_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function requireSession(request, response) {
  const session = currentSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Unauthorized" });
    return null;
  }

  return session;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function currentSession(request) {
  const { optimus_session: token } = parseCookies(request.headers.cookie);
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  return { token, ...session };
}

function sessionCookie(token) {
  return [
    `optimus_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ");
}

function expiredSessionCookie() {
  return "optimus_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

function outputFileName(fileName) {
  const parsed = path.parse(fileName || "page.html");
  const baseName = parsed.name || "page";
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `base62-${safeBaseName || "page"}.txt`;
}

function outputHtmlFileName(fileName, fallback = "output") {
  const parsed = path.parse(fileName || `${fallback}.html`);
  const baseName = parsed.name || fallback;
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `${safeBaseName || fallback}.html`;
}

function escapeTemplateHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character],
  );
}

function formatSuiteDate(date = new Date()) {
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  const year = String(date.getFullYear()).slice(-2);
  return `${month} ${year}`;
}

function tabIdForIndex(index) {
  if (index === 0) {
    return "deck";
  }

  return index === 1 ? "demo" : `demo${index}`;
}

function safeHexColor(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function safeCssFont(value, fallback) {
  const font = String(value || "").trim();
  if (!font || /[<>{};]/.test(font)) {
    return fallback;
  }

  return font.slice(0, 120);
}

function scriptJson(value) {
  return JSON.stringify(value, null, 2).replace(/<\//g, "<\\/").replace(/<!--/g, "\\u003c!--");
}

function safeOutputTxtFileName(fileName) {
  const candidate = String(fileName || "").trim();
  if (!candidate || path.basename(candidate) !== candidate || path.extname(candidate) !== ".txt") {
    throw new Error("Choose a valid TXT output file");
  }

  return candidate;
}

async function listIframeSourceFiles() {
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  const entries = await fs.readdir(OUTPUTS_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readIframeSourceFile(fileName) {
  const safeFileName = safeOutputTxtFileName(fileName);
  const contents = await fs.readFile(path.join(OUTPUTS_DIR, safeFileName), "utf8");
  const iframeSource = contents.trim();

  if (!iframeSource.startsWith("data:text/html;base64,")) {
    throw new Error(`${safeFileName} is not an iframe-ready Base64 data string`);
  }

  return iframeSource;
}

function buildPresentationSuiteHtml({ tabs, dateLabel = formatSuiteDate() }) {
  const normalizedTabs = tabs.map((tab, index) => ({
    id: tabIdForIndex(index),
    label: escapeTemplateHtml(tab.label),
    iframeSource: tab.iframeSource,
    isActive: index === 0,
  }));

  const buttons = normalizedTabs
    .map(
      (tab) =>
        `    <button class="tab-btn${tab.isActive ? " active" : ""}" onclick="switchTab('${tab.id}',this)"><span class="tab-dot"></span>${tab.label}</button>`,
    )
    .join("\n");

  const panels = normalizedTabs
    .map((tab) => {
      const iframe = tab.iframeSource
        ? `\n    <iframe src="${escapeTemplateHtml(tab.iframeSource)}" title="${tab.label}"></iframe>\n  `
        : "";

      return `  <div class="panel${tab.isActive ? " active" : ""}" id="panel-${tab.id}">${iframe}</div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Presentation Suite</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'DM Sans',sans-serif; background:#f4f6fb; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  .topbar { background:#1a2744; height:56px; display:flex; align-items:center; padding:0 24px; flex-shrink:0; box-shadow:0 2px 12px rgba(26,39,68,0.25); z-index:100; }
  .tab-nav { display:flex; gap:4px; flex:1; overflow-x:auto; }
  .tab-btn { display:flex; align-items:center; gap:8px; padding:8px 18px; border-radius:8px; border:none; background:transparent; color:rgba(255,255,255,0.6); font-family:'DM Sans',sans-serif; font-size:13.5px; font-weight:500; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
  .tab-btn:hover { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.9); }
  .tab-btn.active { background:rgba(45,156,219,0.2); color:#fff; font-weight:600; }
  .tab-btn.active .tab-dot { background:#2d9cdb; }
  .tab-dot { width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,0.3); transition:background 0.2s; flex:0 0 auto; }
  .topbar-badge { margin-left:auto; padding-left:16px; font-size:11px; color:rgba(255,255,255,0.35); letter-spacing:0.5px; text-transform:uppercase; white-space:nowrap; }
  .content-area { flex:1; overflow:hidden; position:relative; }
  .panel { position:absolute; inset:0; display:none; flex-direction:column; }
  .panel.active { display:flex; }
  .panel iframe { width:100%; height:100%; border:none; flex:1; }
</style>
</head>
<body>
<div class="topbar">
  <nav class="tab-nav">
${buttons}
  </nav>
  <div class="topbar-badge">${escapeTemplateHtml(dateLabel)}</div>
</div>
<div class="content-area">
${panels}
</div>
<script>
function switchTab(tab, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

function buildDemoBuilderHtml(options) {
  const scenarioCount = Math.min(8, Math.max(1, Number(options.scenarioCount) || 1));
  const title = String(options.title || "Demo Builder Template").trim().slice(0, 100);
  const subtitle = String(options.subtitle || "Configurable agent simulation").trim().slice(0, 140);
  const logoText = String(options.logoText || "LOGO").trim().slice(0, 24);
  const fontUi = safeCssFont(options.fontUi, "Inter, system-ui, sans-serif");
  const fontMono = safeCssFont(options.fontMono, "JetBrains Mono, monospace");
  const brandColor = safeHexColor(options.brandColor, "#003a7d");
  const accentColor = safeHexColor(options.accentColor, "#c8a84b");
  const backgroundColor = safeHexColor(options.backgroundColor, "#0e1117");
  const fontColor = safeHexColor(options.fontColor, "#e8eaf0");
  const scenarios = Array.from({ length: scenarioCount }, (_, index) => ({
    id: `scenario-${index + 1}`,
    label: `Scenario ${index + 1} - Placeholder`,
    capability: index === 0 ? "SOLO" : "AEON",
    messages: [
      {
        role: "agent",
        text: `Welcome. This is the opening assistant message for scenario ${index + 1}.`,
      },
      {
        role: "user",
        text: "Replace this with the user's business question or prompt.",
      },
      {
        role: "agent",
        text: "Replace this with the agent response. Use <strong>HTML</strong> for emphasis when needed.",
      },
    ],
    docs: [
      {
        title: "Document Template",
        subtitle: "Evidence, assumptions, outputs, or preview content",
        icon: "DOC",
        sections: [
          {
            heading: "Placeholder Section",
            rows: [
              { label: "Field", value: "Placeholder value", tone: "neutral" },
              { label: "Status", value: "Ready for editing", tone: "ok" },
            ],
          },
        ],
      },
    ],
    logs: [
      { type: "info", text: "Intent detected - replace with scenario-specific processing step." },
      { type: "data", text: "Data source checked - replace with CRM, docs, API, or file reference." },
      { type: "success", text: "Scenario output prepared." },
    ],
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeTemplateHtml(title)}</title>
<style>
/*
  DEMO BUILDER THEME PLACEHOLDERS
  - Logo: edit TEMPLATE_CONFIG.brand.logoText or logoImage.
  - Colors: edit these CSS variables or TEMPLATE_CONFIG.theme values.
  - Fonts: edit --font-ui / --font-mono and the optional Google Fonts import.
*/
:root {
  --bg-primary: ${backgroundColor};
  --bg-secondary: #141820;
  --bg-card: #1e2638;
  --border: #2a3550;
  --text-primary: ${fontColor};
  --text-secondary: #9aa5b8;
  --chat-bg: #f8f9fb;
  --chat-text: #1a2030;
  --brand: ${brandColor};
  --accent: ${accentColor};
  --success: #34d399;
  --warn: #fbbf24;
  --danger: #f87171;
  --font-ui: ${fontUi};
  --font-mono: ${fontMono};
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { min-width: 320px; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-primary); color: var(--text-primary); font: 13px var(--font-ui); }
button, select { font: inherit; }
.header { height: 58px; flex: 0 0 auto; display: flex; align-items: center; gap: 14px; padding: 0 20px; background: var(--brand); border-bottom: 2px solid var(--accent); }
.logo-text { display: inline-flex; align-items: center; justify-content: center; min-width: 42px; min-height: 28px; padding: 4px 9px; border-radius: 4px; background: #fff; color: var(--brand); font-weight: 900; letter-spacing: 1px; }
.logo-image { max-width: 116px; max-height: 34px; object-fit: contain; }
.title h1 { font-size: 14px; line-height: 1.2; }
.title p { margin-top: 2px; color: rgba(255,255,255,.68); font-size: 11px; }
.scenario-picker { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.scenario-picker span { color: rgba(255,255,255,.62); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
.scenario-picker select { min-width: min(320px, 42vw); height: 32px; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 0 10px; background: rgba(255,255,255,.1); color: #fff; outline: none; }
.main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 42%) minmax(0, 1fr); }
.chat { min-width: 0; display: flex; flex-direction: column; background: var(--chat-bg); color: var(--chat-text); border-right: 1px solid var(--border); }
.chat-head { flex: 0 0 auto; padding: 12px 14px; border-bottom: 1px solid #d8dde8; background: #fff; }
.chat-head strong { display: block; font-size: 12px; }
.chat-head span { color: #64748b; font-size: 11px; }
.messages { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.msg { display: flex; max-width: 92%; }
.msg.user { align-self: flex-end; }
.msg.agent { align-self: flex-start; }
.bubble { padding: 10px 12px; border-radius: 12px; line-height: 1.55; background: #fff; border: 1px solid #d8dde8; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
.msg.user .bubble { background: var(--brand); color: #fff; border-color: var(--brand); }
.right { min-width: 0; display: grid; grid-template-rows: minmax(0, 1fr) 190px; background: var(--bg-secondary); }
.docs, .logs { min-height: 0; overflow: auto; }
.docs { padding: 14px; }
.doc-card { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.doc-head { display: flex; gap: 10px; align-items: center; padding: 11px 13px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,.03); }
.doc-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 6px; background: rgba(255,255,255,.08); color: var(--accent); font: 10px var(--font-mono); }
.doc-title { font-weight: 800; font-size: 12px; }
.doc-subtitle { margin-top: 2px; color: var(--text-secondary); font-size: 11px; }
.doc-body { padding: 12px 13px; }
.doc-body h3 { margin: 4px 0 8px; color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
.row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.07); }
.row-label { color: var(--text-secondary); }
.row-value.ok { color: var(--success); font-weight: 800; }
.row-value.warn { color: var(--warn); font-weight: 800; }
.row-value.danger { color: var(--danger); font-weight: 800; }
.logs { border-top: 2px solid var(--accent); padding: 10px 12px; background: #0b0f16; font: 11px var(--font-mono); }
.log-entry { display: grid; grid-template-columns: 58px 70px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.log-time { color: #64748b; }
.log-type { color: var(--accent); font-weight: 900; text-transform: uppercase; }
.log-text { color: var(--text-secondary); }
.demo-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--bg-card); }
.demo-bar button { border: 0; border-radius: 6px; padding: 8px 13px; background: var(--brand); color: #fff; font-weight: 800; cursor: pointer; }
.demo-bar span { color: var(--text-secondary); font: 11px var(--font-mono); }
@media (max-width: 820px) {
  body { overflow: auto; height: auto; }
  .header { height: auto; align-items: flex-start; flex-wrap: wrap; padding: 14px; }
  .scenario-picker { width: 100%; margin-left: 0; }
  .scenario-picker select { flex: 1; min-width: 0; }
  .main { grid-template-columns: 1fr; min-height: 760px; }
}
</style>
</head>
<body>
<header class="header">
  <div id="brandLogo"></div>
  <div class="title">
    <h1 id="demoTitle"></h1>
    <p id="demoSubtitle"></p>
  </div>
  <label class="scenario-picker" id="scenarioPicker">
    <span>Scenario</span>
    <select id="scenarioSelect"></select>
  </label>
</header>

<main class="main">
  <section class="chat">
    <div class="chat-head">
      <strong id="agentName"></strong>
      <span id="agentStatus">Ready</span>
    </div>
    <div class="messages" id="messages"></div>
  </section>
  <section class="right">
    <div class="docs" id="docs"></div>
    <div class="logs" id="logs"></div>
  </section>
</main>

<footer class="demo-bar">
  <button type="button" id="startButton">Start / replay</button>
  <span id="scenarioMeta"></span>
</footer>

<script>
/*
  DEMO BUILDER CONFIG

  Edit this object to create a new client demo.

  Brand placeholders:
  - logoText: text badge fallback.
  - logoImage: optional URL/path. Leave blank to use logoText.

  Scenario placeholders:
  - Add/remove objects in scenarios to control the number showcased.
  - Each scenario contains messages, docs, and logs.

  Message template:
  { role: "agent" | "user", text: "HTML-enabled message" }

  Document template:
  {
    title: "Tab/card title",
    subtitle: "Source or context",
    icon: "DOC",
    sections: [{ heading: "Section", rows: [{ label: "Name", value: "Value", tone: "ok|warn|danger|neutral" }] }]
  }

  Log entry template:
  { type: "info|data|api|decision|warn|success|error", text: "Processing detail" }
*/
const TEMPLATE_CONFIG = ${scriptJson(
    {
      brand: {
        logoText,
        logoImage: "",
        title,
        subtitle,
        agentName: "Demo Agent",
      },
      theme: {
        fontUi,
        fontMono,
        brandColor,
        accentColor,
        backgroundColor,
        fontColor,
      },
      scenarios,
    },
  )};

let activeScenario = TEMPLATE_CONFIG.scenarios[0]?.id;
let logClock = 0;

const logo = document.getElementById("brandLogo");
const title = document.getElementById("demoTitle");
const subtitle = document.getElementById("demoSubtitle");
const agentName = document.getElementById("agentName");
const scenarioPicker = document.getElementById("scenarioPicker");
const scenarioSelect = document.getElementById("scenarioSelect");
const messages = document.getElementById("messages");
const docs = document.getElementById("docs");
const logs = document.getElementById("logs");
const scenarioMeta = document.getElementById("scenarioMeta");

function applyBrand() {
  if (TEMPLATE_CONFIG.brand.logoImage) {
    logo.innerHTML = '<img class="logo-image" src="' + escapeAttribute(TEMPLATE_CONFIG.brand.logoImage) + '" alt="">';
  } else {
    logo.innerHTML = '<div class="logo-text">' + escapeHtml(TEMPLATE_CONFIG.brand.logoText) + '</div>';
  }
  title.textContent = TEMPLATE_CONFIG.brand.title;
  subtitle.textContent = TEMPLATE_CONFIG.brand.subtitle;
  agentName.textContent = TEMPLATE_CONFIG.brand.agentName;
}

function populateScenarios() {
  scenarioPicker.hidden = TEMPLATE_CONFIG.scenarios.length <= 1;
  scenarioSelect.innerHTML = TEMPLATE_CONFIG.scenarios
    .map((scenario) => '<option value="' + escapeAttribute(scenario.id) + '">' + escapeHtml(scenario.label) + '</option>')
    .join("");
  scenarioSelect.value = activeScenario;
}

function currentScenario() {
  return TEMPLATE_CONFIG.scenarios.find((scenario) => scenario.id === activeScenario) || TEMPLATE_CONFIG.scenarios[0];
}

function renderScenario() {
  const scenario = currentScenario();
  if (!scenario) return;
  messages.innerHTML = scenario.messages.map(renderMessage).join("");
  docs.innerHTML = scenario.docs.map(renderDoc).join("");
  logs.innerHTML = "";
  logClock = 0;
  scenarioMeta.textContent = scenario.capability + " · " + scenario.messages.length + " messages · " + scenario.docs.length + " docs · " + scenario.logs.length + " logs";
}

function replayLogs() {
  const scenario = currentScenario();
  logs.innerHTML = "";
  logClock = 0;
  scenario.logs.forEach((entry, index) => {
    window.setTimeout(() => addLog(entry), 240 * index);
  });
}

function renderMessage(message) {
  return '<div class="msg ' + escapeAttribute(message.role) + '"><div class="bubble">' + message.text + '</div></div>';
}

function renderDoc(doc) {
  return '<article class="doc-card"><div class="doc-head"><div class="doc-icon">' + escapeHtml(doc.icon) + '</div><div><div class="doc-title">' + escapeHtml(doc.title) + '</div><div class="doc-subtitle">' + escapeHtml(doc.subtitle) + '</div></div></div><div class="doc-body">' + doc.sections.map(renderSection).join("") + '</div></article>';
}

function renderSection(section) {
  return '<h3>' + escapeHtml(section.heading) + '</h3>' + section.rows.map((row) => '<div class="row"><div class="row-label">' + escapeHtml(row.label) + '</div><div class="row-value ' + escapeAttribute(row.tone || "neutral") + '">' + escapeHtml(row.value) + '</div></div>').join("");
}

function addLog(entry) {
  logClock += 320;
  const seconds = Math.floor(logClock / 1000);
  const millis = String(logClock % 1000).padStart(3, "0");
  logs.insertAdjacentHTML("beforeend", '<div class="log-entry"><span class="log-time">' + seconds + "." + millis + 's</span><span class="log-type">' + escapeHtml(entry.type) + '</span><span class="log-text">' + escapeHtml(entry.text) + '</span></div>');
  logs.scrollTop = logs.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\x60/g, "&#096;");
}

scenarioSelect.addEventListener("change", () => {
  activeScenario = scenarioSelect.value;
  renderScenario();
});
document.getElementById("startButton").addEventListener("click", replayLogs);

applyBrand();
populateScenarios();
renderScenario();
</script>
</body>
</html>`;
}

async function saveIframeSource({ fileName, html }) {
  if (!fileName || typeof html !== "string") {
    throw new Error("An HTML file is required");
  }

  const iframeSource = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
  const savedFileName = outputFileName(fileName);
  const outputPath = path.join(OUTPUTS_DIR, savedFileName);

  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.writeFile(outputPath, iframeSource, "utf8");

  return {
    fileName: savedFileName,
    outputPath,
    iframeSource,
  };
}

async function savePresentationSuite({ fileName, tabCount, labels, sourceFiles = [] }) {
  const count = Number(tabCount);
  if (!Number.isInteger(count) || count < 1 || count > 12) {
    throw new Error("Choose between 1 and 12 tabs");
  }

  if (!Array.isArray(labels) || labels.length !== count) {
    throw new Error("Provide one label for each tab");
  }

  const cleanLabels = labels.map((label, index) => {
    const trimmed = String(label || "").trim();
    if (trimmed) {
      return trimmed.slice(0, 80);
    }

    return index === 0 ? "Deck" : `Demo ${index}`;
  });

  if (!Array.isArray(sourceFiles) || sourceFiles.length !== count) {
    throw new Error("Provide one content choice for each tab");
  }

  const tabs = await Promise.all(
    cleanLabels.map(async (label, index) => {
      const sourceFile = String(sourceFiles[index] || "").trim();
      return {
        label,
        iframeSource: sourceFile ? await readIframeSourceFile(sourceFile) : "",
      };
    }),
  );

  const savedFileName = outputHtmlFileName(fileName, "presentation-suite");
  const outputPath = path.join(OUTPUTS_DIR, savedFileName);
  const html = buildPresentationSuiteHtml({ tabs });

  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");

  return {
    fileName: savedFileName,
    outputPath,
    html,
  };
}

async function saveDemoBuilderTemplate(payload) {
  const count = Number(payload.scenarioCount);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error("Choose between 1 and 8 scenarios");
  }

  const savedFileName = outputHtmlFileName(payload.fileName || "demo-builder-template.html", "demo-builder-template");
  const outputPath = path.join(OUTPUTS_DIR, savedFileName);
  const html = buildDemoBuilderHtml(payload);

  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");

  return {
    fileName: savedFileName,
    outputPath,
    html,
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, {
      user: { name: session.name },
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/outputs/iframe-sources") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const files = await listIframeSourceFiles();
    sendJson(response, 200, { files });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/html-base64") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJson(request);
    const result = await saveIframeSource(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/presentation-suite") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJson(request);
    const result = await savePresentationSuite(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/demo-builder") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJson(request);
    const result = await saveDemoBuilderTemplate(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const { name, accessKey } = await readJson(request);

    if (!name || !accessKey || !constantTimeEqual(String(accessKey), ACCESS_KEY)) {
      sendJson(response, 401, { error: "Invalid credentials" });
      return;
    }

    cleanExpiredSessions();
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { name: String(name).trim(), expiresAt });

    sendJson(
      response,
      200,
      { user: { name: String(name).trim() }, expiresAt },
      { "Set-Cookie": sessionCookie(token) },
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = currentSession(request);
    if (session) {
      sessions.delete(session.token);
    }

    sendJson(response, 200, { ok: true }, { "Set-Cookie": expiredSessionCookie() });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    sendJson(response, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Optimus API listening on http://${HOST}:${PORT}`);
});
