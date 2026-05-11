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

function defaultDemoScenarios(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `scenario-${index + 1}`,
    label: `Scenario ${index + 1} - Placeholder`,
    messages: [
      {
        role: "agent",
        text: `Welcome. This is the opening assistant message for scenario ${index + 1}.`,
        delayMs: 0,
      },
      {
        role: "user",
        text: "Replace this with the user's business question or prompt.",
        delayMs: 900,
      },
      {
        role: "agent",
        text: "Replace this with the agent response. Use <strong>HTML</strong> for emphasis when needed.",
        delayMs: 1200,
      },
    ],
    docs: [
      {
        title: "Document Template",
        subtitle: "Evidence, assumptions, outputs, or preview content",
        icon: "DOC",
        revealAfterMessageIndex: 2,
        delayMs: 250,
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
      { type: "info", group: "Scenario processing", text: "Intent detected - replace with scenario-specific processing step.", delayMs: 320 },
      { type: "data", group: "Scenario processing", text: "Data source checked - replace with CRM, docs, API, or file reference.", delayMs: 420 },
      { type: "success", group: "Scenario processing", text: "Scenario output prepared.", delayMs: 520 },
    ],
  }));
}

function defaultDemoSizing(scenarios) {
  return scenarios.map((scenario, index) => ({
    scenarioId: scenario.id,
    title: "Deployment Prerequisites",
    subtitle: `${scenario.label} · ${index === 0 ? "SOLO" : "AEON"}`,
    capabilityTier: index === 0 ? "SOLO" : "AEON",
    commercialTier: "Tier 1 - Starter",
    connectedDataSources: 5,
    connectedEnterpriseSystems: 1,
    implementationSize: "Medium (75-120 man-days)",
    knowledgeDataSources: [
      "Ingested (unstructured): Primary domain documentation (PDF)",
      "Ingested (structured): Program calendar or source table (JSON/CSV)",
      "Live structured: CRM or member profile API (read-only)",
    ],
    enterpriseSystemConnections: [
      "CRM - Read access: profile, history, status, and metadata",
    ],
    regulatoryFrameworks: [
      "Relevant policy / compliance framework",
      "Internal review and approval rules",
    ],
    clientSidePrerequisites: [
      "API credentials for connected systems",
      "Validated source documents and current profile data",
      "Named human reviewer for edge cases",
    ],
    keySizingDrivers: [
      "1 enterprise system connector",
      "5 knowledge sources - multi-framework",
      "Approval workflow requires human review",
      "Data mapping and normalization",
    ],
  }));
}

function defaultDemoGlossary() {
  return [
    {
      category: "Systems & Data",
      entries: [
        {
          term: "CRM",
          definition: "Customer relationship management system containing profile, history, and account data.",
        },
        {
          term: "RAG",
          definition: "Retrieval-augmented generation: the agent searches trusted sources before composing an answer.",
        },
      ],
    },
    {
      category: "Delivery Terms",
      entries: [
        {
          term: "Capability Tier",
          definition: "Operational complexity level for the use case, such as SOLO or AEON.",
        },
        {
          term: "Commercial Tier",
          definition: "Commercial packaging level used for sizing, pricing, or rollout planning.",
        },
      ],
    },
  ];
}

function normalizeDemoScenarios(contentJson, fallbackCount) {
  if (!String(contentJson || "").trim()) {
    return defaultDemoScenarios(fallbackCount);
  }

  let parsed;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    throw new Error("Content JSON is not valid JSON");
  }

  const scenarios = Array.isArray(parsed) ? parsed : parsed.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 8) {
    throw new Error("Content JSON must contain between 1 and 8 scenarios");
  }

  return scenarios.map((scenario, scenarioIndex) => ({
    id: cleanText(scenario.id, `scenario-${scenarioIndex + 1}`, 48),
    label: cleanText(scenario.label, `Scenario ${scenarioIndex + 1}`, 90),
    messages: normalizeMessages(scenario.messages),
    docs: normalizeDocs(scenario.docs),
    logs: normalizeLogs(scenario.logs),
  }));
}

function normalizeDemoSizing(sizingJson, scenarios) {
  const defaults = defaultDemoSizing(scenarios);
  if (!String(sizingJson || "").trim()) {
    return defaults;
  }

  let parsed;
  try {
    parsed = JSON.parse(sizingJson);
  } catch {
    throw new Error("Sizing JSON is not valid JSON");
  }

  const entries = Array.isArray(parsed) ? parsed : parsed.sizing;
  if (!Array.isArray(entries)) {
    throw new Error("Sizing JSON must be an array or an object with a sizing array");
  }

  const byScenario = new Map(entries.map((entry) => [String(entry.scenarioId || ""), entry]));
  return scenarios.map((scenario, index) => normalizeSizingEntry(byScenario.get(scenario.id), defaults[index], scenario));
}

function normalizeDemoGlossary(glossaryJson) {
  if (!String(glossaryJson || "").trim()) {
    return defaultDemoGlossary();
  }

  let parsed;
  try {
    parsed = JSON.parse(glossaryJson);
  } catch {
    throw new Error("Glossary JSON is not valid JSON");
  }

  const categories = Array.isArray(parsed) ? parsed : parsed.glossary;
  if (!Array.isArray(categories)) {
    throw new Error("Glossary JSON must be an array or an object with a glossary array");
  }

  return categories.slice(0, 12).map((category) => ({
    category: cleanText(category.category, "Glossary", 100),
    entries: normalizeGlossaryEntries(category.entries),
  }));
}

function normalizeGlossaryEntries(entries) {
  const source = Array.isArray(entries) && entries.length ? entries : [{ term: "Term", definition: "Definition" }];
  return source.slice(0, 30).map((entry) => ({
    term: cleanText(entry.term, "Term", 80),
    definition: cleanText(entry.definition, "Definition", 500),
  }));
}

function normalizeSizingEntry(entry = {}, fallback, scenario) {
  return {
    scenarioId: scenario.id,
    title: cleanText(entry.title, fallback.title, 100),
    subtitle: cleanText(entry.subtitle, fallback.subtitle, 160),
    capabilityTier: cleanText(entry.capabilityTier, fallback.capabilityTier, 40),
    commercialTier: cleanText(entry.commercialTier, fallback.commercialTier, 80),
    connectedDataSources: cleanNumber(entry.connectedDataSources, fallback.connectedDataSources),
    connectedEnterpriseSystems: cleanNumber(entry.connectedEnterpriseSystems, fallback.connectedEnterpriseSystems),
    implementationSize: cleanText(entry.implementationSize, fallback.implementationSize, 120),
    knowledgeDataSources: normalizeStringList(entry.knowledgeDataSources, fallback.knowledgeDataSources),
    enterpriseSystemConnections: normalizeStringList(entry.enterpriseSystemConnections, fallback.enterpriseSystemConnections),
    regulatoryFrameworks: normalizeStringList(entry.regulatoryFrameworks, fallback.regulatoryFrameworks),
    clientSidePrerequisites: normalizeStringList(entry.clientSidePrerequisites, fallback.clientSidePrerequisites),
    keySizingDrivers: normalizeStringList(entry.keySizingDrivers, fallback.keySizingDrivers),
  };
}

function cleanText(value, fallback, maxLength) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.round(number);
}

function cleanDelay(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.min(30000, Math.round(number));
}

function cleanOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.round(number);
}

function normalizeStringList(items, fallback) {
  const source = Array.isArray(items) && items.length ? items : fallback;
  return source.slice(0, 20).map((item) => cleanText(item, "Placeholder item", 300));
}

function normalizeMessages(messages) {
  const safeMessages = Array.isArray(messages) && messages.length ? messages : defaultDemoScenarios(1)[0].messages;
  return safeMessages.slice(0, 20).map((message) => ({
    role: ["agent", "user"].includes(message.role) ? message.role : "agent",
    text: cleanText(message.text, "Placeholder message", 3000),
    delayMs: cleanDelay(message.delayMs, 900),
  }));
}

function normalizeDocs(docs) {
  const safeDocs = Array.isArray(docs) && docs.length ? docs : defaultDemoScenarios(1)[0].docs;
  return safeDocs.slice(0, 12).map((doc) => ({
    title: cleanText(doc.title, "Document Template", 100),
    subtitle: cleanText(doc.subtitle, "Evidence, assumptions, outputs, or preview content", 140),
    icon: cleanText(doc.icon, "DOC", 16),
    revealAfterMessageIndex: cleanOptionalNumber(doc.revealAfterMessageIndex),
    revealAfterLogIndex: cleanOptionalNumber(doc.revealAfterLogIndex),
    revealAtMs: cleanOptionalNumber(doc.revealAtMs),
    delayMs: cleanDelay(doc.delayMs, 250),
    sections: normalizeDocSections(doc.sections),
  }));
}

function normalizeDocSections(sections) {
  const safeSections = Array.isArray(sections) && sections.length
    ? sections
    : defaultDemoScenarios(1)[0].docs[0].sections;

  return safeSections.slice(0, 10).map((section) => ({
    heading: cleanText(section.heading, "Placeholder Section", 100),
    rows: normalizeDocRows(section.rows),
  }));
}

function normalizeDocRows(rows) {
  const safeRows = Array.isArray(rows) && rows.length ? rows : defaultDemoScenarios(1)[0].docs[0].sections[0].rows;
  return safeRows.slice(0, 20).map((row) => ({
    label: cleanText(row.label, "Field", 80),
    value: cleanText(row.value, "Placeholder value", 300),
    tone: ["neutral", "ok", "warn", "danger"].includes(row.tone) ? row.tone : "neutral",
  }));
}

function normalizeLogs(logs) {
  const safeLogs = Array.isArray(logs) && logs.length ? logs : defaultDemoScenarios(1)[0].logs;
  return safeLogs.slice(0, 40).map((log) => ({
    type: cleanText(log.type, "info", 24).toLowerCase(),
    group: cleanText(log.group, "", 80),
    text: cleanText(log.text, "Placeholder log entry", 300),
    delayMs: cleanDelay(log.delayMs, 420),
  }));
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
  const scenarios = normalizeDemoScenarios(options.contentJson, scenarioCount);
  const sizing = normalizeDemoSizing(options.sizingJson, scenarios);
  const glossary = normalizeDemoGlossary(options.glossaryJson);

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
  --text-muted: #64748b;
  --chat-bg: #f8f9fb;
  --chat-text: #1a2030;
  --brand: ${brandColor};
  --accent: ${accentColor};
  --accent-blue: #5b7cfa;
  --accent-cyan: #22d3ee;
  --accent-purple: #a78bfa;
  --accent-pink: #f472b6;
  --accent-yellow: #fbbf24;
  --accent-green: #34d399;
  --accent-red: #f87171;
  --accent-indigo: #818cf8;
  --accent-orange: #fb923c;
  --accent-teal: #2dd4bf;
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
.scenario-area { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.scenario-picker { display: flex; align-items: center; gap: 8px; }
.scenario-picker[hidden], .scenario-title[hidden] { display: none; }
.scenario-picker span, .scenario-title span { color: rgba(255,255,255,.62); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
.scenario-picker select { min-width: min(320px, 42vw); height: 32px; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 0 10px; background: rgba(255,255,255,.1); color: #fff; outline: none; }
.scenario-title { display: flex; align-items: center; gap: 8px; min-height: 32px; color: #fff; font-size: 11px; font-weight: 800; }
.glossary-button { border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 7px 10px; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; font-weight: 800; }
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
.right { min-width: 0; display: flex; flex-direction: column; background: var(--bg-secondary); overflow: hidden; }
.right-tabs { height: 40px; flex: 0 0 auto; display: flex; align-items: stretch; border-bottom: 1px solid var(--border); background: var(--bg-card); }
.right-tab { display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; padding: 0 14px; background: transparent; color: var(--text-muted); cursor: pointer; font-weight: 800; font-size: 11px; }
.right-tab.active { color: var(--text-primary); border-bottom-color: var(--brand); background: var(--bg-secondary); }
.right-view { flex: 1; min-height: 0; display: none; flex-direction: column; overflow: hidden; }
.right-view.active { display: flex; }
.split-view { display: none; }
.split-view.active { display: flex; }
.split-docs { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-bottom: 2px solid var(--accent); }
.split-log { height: 210px; flex: 0 0 auto; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-primary); }
.split-log-head { flex: 0 0 auto; padding: 5px 12px; border-bottom: 1px solid var(--border); background: var(--bg-card); color: var(--text-muted); display: flex; align-items: center; gap: 8px; font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.live-dot.active { background: var(--accent-green); animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.75); } }
.doc-tabs { flex: 0 0 auto; display: flex; min-height: 32px; overflow-x: auto; border-bottom: 1px solid var(--border); background: var(--bg-card); }
.doc-tab { flex: 0 0 auto; border: 0; border-right: 1px solid var(--border); border-bottom: 2px solid transparent; padding: 7px 11px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; }
.doc-tab.active { color: var(--text-primary); border-bottom-color: var(--brand); background: var(--bg-secondary); }
.docs, .logs { min-height: 0; overflow: auto; }
.docs { flex: 1; padding: 14px; }
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
.checklist-item { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,.07); color: var(--text-secondary); line-height: 1.45; }
.check-icon { width: 16px; height: 16px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: rgba(52,211,153,.15); color: var(--success); font-size: 10px; font-weight: 900; }
.logs { flex: 1; padding: 8px 10px; background: var(--bg-primary); display: flex; flex-direction: column; gap: 1px; font: 10.5px var(--font-mono); }
.log-entry { display: flex; align-items: flex-start; gap: 7px; padding: 3px 0; border-bottom: 1px solid rgba(42,53,80,.25); line-height: 1.4; }
.log-time { min-width: 52px; flex: 0 0 auto; color: var(--text-muted); }
.log-type { min-width: 52px; flex: 0 0 auto; padding: 1px 4px; border-radius: 3px; text-align: center; color: var(--accent); background: rgba(200,168,75,.14); font-size: 9px; font-weight: 800; line-height: 1.35; letter-spacing: .5px; text-transform: uppercase; }
.log-text { flex: 1; color: var(--text-secondary); }
.log-type.process { background: rgba(167,139,250,.15); color: var(--accent-purple); }
.log-type.rag { background: rgba(244,114,182,.15); color: var(--accent-pink); }
.log-type.info { background: rgba(91,124,250,.15); color: var(--accent-blue); }
.log-type.success { background: rgba(52,211,153,.15); color: var(--accent-green); }
.log-type.warn, .log-type.decision { background: rgba(251,191,36,.15); color: var(--accent-yellow); }
.log-type.escalate, .log-type.error { background: rgba(248,113,113,.15); color: var(--accent-red); }
.log-type.api { background: rgba(34,211,238,.15); color: var(--accent-cyan); }
.log-type.action { background: rgba(129,140,248,.15); color: var(--accent-indigo); }
.log-type.data { background: rgba(251,146,60,.15); color: var(--accent-orange); }
.log-type.ml { background: rgba(45,212,191,.15); color: var(--accent-teal); }
.demo-bar { flex: 0 0 auto; min-height: 46px; display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--bg-card); }
.simulation-controls, .speed-control { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.demo-label { color: var(--text-muted); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
.demo-bar button { border: 0; border-radius: 6px; padding: 7px 11px; background: var(--brand); color: #fff; font-weight: 800; cursor: pointer; }
.demo-bar button:disabled { opacity: .45; cursor: default; }
.speed-control button { padding: 5px 8px; border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-secondary); font: 10px var(--font-mono); }
.speed-control button.active { border-color: var(--brand); background: var(--brand); color: #fff; }
.sizing-info { margin-left: auto; color: var(--text-secondary); font: 11px var(--font-mono); white-space: nowrap; }
.glossary-overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(5,8,20,.72); z-index: 10; }
.glossary-overlay.active { display: flex; }
.glossary-modal { width: min(560px, 100%); max-height: 78vh; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); box-shadow: 0 24px 70px rgba(0,0,0,.45); }
.glossary-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.glossary-head h2 { margin: 0; font-size: 14px; }
.glossary-close { border: 0; background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
.glossary-body { overflow: auto; padding: 12px 16px 16px; }
.glossary-category { margin: 12px 0 6px; color: var(--text-muted); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
.glossary-entry { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.07); }
.glossary-term { color: var(--accent); font: 700 11px var(--font-mono); }
.glossary-definition { color: var(--text-secondary); line-height: 1.45; }
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
  <div class="scenario-area">
    <div class="scenario-title" id="scenarioTitle"><span>Scenario</span><strong id="scenarioTitleText"></strong></div>
    <label class="scenario-picker" id="scenarioPicker" hidden>
      <span>Scenario</span>
      <select id="scenarioSelect"></select>
    </label>
  </div>
  <button type="button" class="glossary-button" id="glossaryButton">ⓘ Glossary</button>
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
    <div class="right-tabs">
      <button type="button" class="right-tab active" data-view="split">Docs + Agent Log</button>
      <button type="button" class="right-tab" data-view="docs">Docs only</button>
      <button type="button" class="right-tab" data-view="log">Agent Log only</button>
    </div>
    <div class="right-view split-view active" id="splitView">
      <div class="split-docs">
        <div class="doc-tabs" id="docTabsSplit"></div>
        <div class="docs" id="docsSplit"></div>
      </div>
      <div class="split-log">
        <div class="split-log-head"><span class="live-dot" id="liveDot"></span><span>Agent Log — Live Processing</span></div>
        <div class="logs" id="logsSplit"></div>
      </div>
    </div>
    <div class="right-view" id="docsView">
      <div class="doc-tabs" id="docTabsFull"></div>
      <div class="docs" id="docsFull"></div>
    </div>
    <div class="right-view" id="logView">
      <div class="logs" id="logsFull"></div>
    </div>
  </section>
</main>

<footer class="demo-bar">
  <div class="simulation-controls">
    <span class="demo-label">SIMULATION</span>
    <button type="button" id="startButton">Start</button>
    <button type="button" id="pauseButton" disabled>Pause</button>
  </div>
  <div class="sizing-info" id="sizingInfo"></div>
  <div class="speed-control" aria-label="Simulation speed">
    <span class="demo-label">Speed</span>
    <button type="button" class="speed-button" data-speed="0.5">0.5x</button>
    <button type="button" class="speed-button active" data-speed="1">1x</button>
    <button type="button" class="speed-button" data-speed="2">2x</button>
    <button type="button" class="speed-button" data-speed="3">3x</button>
  </div>
</footer>

<div class="glossary-overlay" id="glossaryOverlay">
  <div class="glossary-modal" role="dialog" aria-modal="true" aria-labelledby="glossaryTitle">
    <div class="glossary-head">
      <h2 id="glossaryTitle">Glossary</h2>
      <button type="button" class="glossary-close" id="glossaryClose" aria-label="Close glossary">×</button>
    </div>
    <div class="glossary-body" id="glossaryBody"></div>
  </div>
</div>

<script>
/*
  DEMO BUILDER CONFIG

  Edit this object to create a new client demo.

  Brand placeholders:
  - logoText: text badge fallback.
  - logoImage: optional URL/path. Leave blank to use logoText.

  Sizing placeholders:
  - sizing belongs to the shell, not the scenario content JSON.
  - Later Demo Builder will expose these through a dedicated form.

  Glossary placeholders:
  - glossary belongs to the shell, not the scenario content JSON.
  - Edit categories and entries to control the top-right glossary modal.

  Scenario placeholders:
  - Add/remove objects in scenarios to control the number showcased.
  - Each scenario contains messages, docs, and logs.

  Message template:
  { role: "agent" | "user", text: "HTML-enabled message", delayMs: 900 }

  Document template:
  {
    title: "Tab/card title",
    subtitle: "Source or context",
    icon: "DOC",
    revealAfterMessageIndex: 2,
    revealAfterLogIndex: null,
    revealAtMs: null,
    delayMs: 250,
    sections: [{ heading: "Section", rows: [{ label: "Name", value: "Value", tone: "ok|warn|danger|neutral" }] }]
  }

  Log entry template:
  { type: "info|data|api|decision|warn|success|error", group: "Optional run group", text: "Processing detail", delayMs: 420 }
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
      sizing,
      glossary,
      scenarios,
    },
  )};

let activeScenario = TEMPLATE_CONFIG.scenarios[0]?.id;
let logClock = 0;
let speedMultiplier = 1;
let docHistory = [];
let scenarioDocs = [];
let activeDocIndex = 0;
let playbackTimer = null;
let playbackEvents = [];
let playbackIndex = 0;
let playbackClock = 0;
let currentEventDueAt = 0;
let currentEventDelay = 0;
let pausedRemainingDelay = 0;
let isPlaying = false;
let isPaused = false;

const logo = document.getElementById("brandLogo");
const title = document.getElementById("demoTitle");
const subtitle = document.getElementById("demoSubtitle");
const agentName = document.getElementById("agentName");
const scenarioTitle = document.getElementById("scenarioTitle");
const scenarioTitleText = document.getElementById("scenarioTitleText");
const scenarioPicker = document.getElementById("scenarioPicker");
const scenarioSelect = document.getElementById("scenarioSelect");
const messages = document.getElementById("messages");
const docsSplit = document.getElementById("docsSplit");
const docsFull = document.getElementById("docsFull");
const logsSplit = document.getElementById("logsSplit");
const logsFull = document.getElementById("logsFull");
const sizingInfo = document.getElementById("sizingInfo");
const glossaryOverlay = document.getElementById("glossaryOverlay");
const glossaryBody = document.getElementById("glossaryBody");
const startButton = document.getElementById("startButton");
const pauseButton = document.getElementById("pauseButton");
const liveDot = document.getElementById("liveDot");

function applyBrand() {
  if (TEMPLATE_CONFIG.brand.logoImage) {
    logo.innerHTML = '<img class="logo-image" src="' + escapeAttribute(TEMPLATE_CONFIG.brand.logoImage) + '" alt="">';
  } else {
    logo.innerHTML = '<div class="logo-text">' + escapeHtml(TEMPLATE_CONFIG.brand.logoText) + '</div>';
  }
  title.textContent = TEMPLATE_CONFIG.brand.title;
  subtitle.textContent = TEMPLATE_CONFIG.brand.subtitle;
  agentName.textContent = TEMPLATE_CONFIG.brand.agentName;
  renderSizingInfo();
  renderGlossary();
}

function renderSizingInfo() {
  const sizing = sizingForScenario(currentScenario()?.id);
  sizingInfo.textContent = (sizing.capabilityTier || "SOLO") + " · " + sizing.connectedDataSources + " data sources · " + sizing.connectedEnterpriseSystems + " enterprise systems • " + (sizing.commercialTier || "Tier 1 - Starter");
}

function renderGlossary() {
  const categories = Array.isArray(TEMPLATE_CONFIG.glossary) ? TEMPLATE_CONFIG.glossary : [];
  glossaryBody.innerHTML = categories.map((category) => '<div class="glossary-category">' + escapeHtml(category.category) + '</div>' + (category.entries || []).map((entry) => '<div class="glossary-entry"><div class="glossary-term">' + escapeHtml(entry.term) + '</div><div class="glossary-definition">' + escapeHtml(entry.definition) + '</div></div>').join("")).join("");
}

function toggleGlossary(force) {
  glossaryOverlay.classList.toggle("active", typeof force === "boolean" ? force : !glossaryOverlay.classList.contains("active"));
}

function sizingForScenario(scenarioId) {
  const entries = Array.isArray(TEMPLATE_CONFIG.sizing) ? TEMPLATE_CONFIG.sizing : [];
  return entries.find((entry) => entry.scenarioId === scenarioId) || entries[0] || {
    title: "Deployment Prerequisites",
    subtitle: "Scenario prerequisites",
    capabilityTier: "SOLO",
    commercialTier: "Tier 1 - Starter",
    connectedDataSources: 0,
    connectedEnterpriseSystems: 0,
    implementationSize: "TBD",
    knowledgeDataSources: [],
    enterpriseSystemConnections: [],
    regulatoryFrameworks: [],
    clientSidePrerequisites: [],
    keySizingDrivers: [],
  };
}

function populateScenarios() {
  const hasMultipleScenarios = TEMPLATE_CONFIG.scenarios.length > 1;
  scenarioPicker.hidden = !hasMultipleScenarios;
  scenarioTitle.hidden = hasMultipleScenarios;
  if (!hasMultipleScenarios) {
    scenarioSelect.innerHTML = "";
    scenarioTitleText.textContent = currentScenario()?.label || "";
    return;
  }
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
  stopPlayback(true);
  docHistory = [
    { title: "Prerequisites", html: renderPrerequisitesDoc(sizingForScenario(scenario.id)) },
  ];
  scenarioDocs = scenario.docs.map((doc, index) => ({ index, title: doc.title, html: renderDoc(doc) }));
  activeDocIndex = 0;
  renderDocTabs();
  showDoc(0);
  logsSplit.innerHTML = "";
  logsFull.innerHTML = "";
  logClock = 0;
  renderSizingInfo();
}

function renderDocTabs() {
  [document.getElementById("docTabsSplit"), document.getElementById("docTabsFull")].forEach((container) => {
    container.innerHTML = docHistory.map((doc, index) => '<button type="button" class="doc-tab' + (index === activeDocIndex ? " active" : "") + '" data-doc-index="' + index + '">' + escapeHtml(doc.title) + '</button>').join("");
  });
}

function showDoc(index) {
  activeDocIndex = index;
  const doc = docHistory[index];
  if (!doc) return;
  docsSplit.innerHTML = doc.html;
  docsFull.innerHTML = doc.html;
  renderDocTabs();
}

function revealDoc(docIndex) {
  const existingIndex = docHistory.findIndex((doc) => doc.sourceIndex === docIndex);
  if (existingIndex >= 0) {
    showDoc(existingIndex);
    return;
  }
  const doc = scenarioDocs.find((item) => item.index === docIndex);
  if (!doc) return;
  docHistory.push({ sourceIndex: doc.index, title: doc.title, html: doc.html });
  showDoc(docHistory.length - 1);
}

function buildPlaybackEvents(scenario) {
  const events = [];
  const messageTimes = [];
  const logTimes = [];
  let messageAt = 0;
  let logAt = 320;
  scenario.messages.forEach((message, index) => {
    if (index > 0) {
      messageAt += Math.max(0, Number(message.delayMs) || 900);
    }
    messageTimes[index] = messageAt;
    events.push({ at: messageAt, kind: "message", payload: message });
  });
  scenario.logs.forEach((entry, index) => {
    if (index > 0) {
      logAt += Math.max(0, Number(entry.delayMs) || 420);
    }
    logTimes[index] = logAt;
    events.push({ at: logAt, kind: "log", payload: entry });
  });
  const agentAnswerTimes = scenario.messages
    .map((message, index) => ({ message, at: messageTimes[index] }))
    .filter((item, index) => item.message.role === "agent" && index > 0)
    .map((item) => item.at);
  const fallbackDocTimes = agentAnswerTimes.length ? agentAnswerTimes : (messageTimes.length ? messageTimes : logTimes);
  let lastDocRevealAt = 0;
  scenario.docs.forEach((doc, index) => {
    const delay = Math.max(0, Number(doc.delayMs) || 250);
    let revealAt = hasTimelineNumber(doc.revealAtMs) ? Number(doc.revealAtMs) : null;
    if (revealAt === null && hasTimelineNumber(doc.revealAfterMessageIndex)) {
      const messageIndex = Math.min(messageTimes.length - 1, Math.max(0, Number(doc.revealAfterMessageIndex)));
      revealAt = (messageTimes[messageIndex] ?? 0) + delay;
    }
    if (revealAt === null && hasTimelineNumber(doc.revealAfterLogIndex)) {
      const logIndex = Math.min(logTimes.length - 1, Math.max(0, Number(doc.revealAfterLogIndex)));
      revealAt = (logTimes[logIndex] ?? 0) + delay;
    }
    if (revealAt === null) {
      const baseTime = fallbackDocTimes[Math.min(index, fallbackDocTimes.length - 1)] ?? lastDocRevealAt;
      revealAt = baseTime + delay;
    }
    if (index > 0) {
      revealAt = Math.max(revealAt, lastDocRevealAt + 900);
    }
    lastDocRevealAt = revealAt;
    events.push({ at: revealAt, kind: "doc", payload: index });
  });
  return events.sort((left, right) => left.at - right.at);
}

function hasTimelineNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function startPlayback() {
  const scenario = currentScenario();
  stopPlayback(true);
  playbackEvents = buildPlaybackEvents(scenario);
  playbackIndex = 0;
  playbackClock = 0;
  isPlaying = true;
  isPaused = false;
  startButton.textContent = "Start";
  pauseButton.disabled = playbackEvents.length === 0;
  pauseButton.textContent = "Pause";
  liveDot.classList.add("active");
  scheduleNextPlaybackEvent();
}

function stopPlayback(resetContent) {
  if (playbackTimer) {
    window.clearTimeout(playbackTimer);
    playbackTimer = null;
  }
  isPlaying = false;
  isPaused = false;
  playbackEvents = [];
  playbackIndex = 0;
  playbackClock = 0;
  currentEventDueAt = 0;
  currentEventDelay = 0;
  pausedRemainingDelay = 0;
  startButton.textContent = "Start";
  pauseButton.disabled = true;
  pauseButton.textContent = "Pause";
  liveDot.classList.remove("active");
  if (resetContent) {
    messages.innerHTML = "";
    logsSplit.innerHTML = "";
    logsFull.innerHTML = "";
    logClock = 0;
  }
}

function scheduleNextPlaybackEvent(delayOverride) {
  if (!isPlaying || isPaused) return;
  if (playbackIndex >= playbackEvents.length) {
    finishPlayback();
    return;
  }
  const event = playbackEvents[playbackIndex];
  const naturalDelay = Math.max(0, event.at - playbackClock) / speedMultiplier;
  currentEventDelay = typeof delayOverride === "number" ? delayOverride : naturalDelay;
  currentEventDueAt = Date.now() + currentEventDelay;
  playbackTimer = window.setTimeout(runNextPlaybackEvent, currentEventDelay);
}

function runNextPlaybackEvent() {
  playbackTimer = null;
  if (!isPlaying || isPaused) return;
  const event = playbackEvents[playbackIndex];
  if (!event) {
    finishPlayback();
    return;
  }
  playbackClock = event.at;
  playbackIndex += 1;
  if (event.kind === "message") {
    addMessage(event.payload);
  } else if (event.kind === "log") {
    addLog(event.payload);
  } else if (event.kind === "doc") {
    revealDoc(event.payload);
  }
  scheduleNextPlaybackEvent();
}

function togglePause() {
  if (!isPlaying) return;
  if (!isPaused) {
    if (playbackTimer) {
      pausedRemainingDelay = Math.max(0, currentEventDueAt - Date.now());
      window.clearTimeout(playbackTimer);
      playbackTimer = null;
    }
    isPaused = true;
    pauseButton.textContent = "Resume";
    return;
  }
  isPaused = false;
  pauseButton.textContent = "Pause";
  scheduleNextPlaybackEvent(pausedRemainingDelay);
}

function finishPlayback() {
  if (playbackTimer) {
    window.clearTimeout(playbackTimer);
    playbackTimer = null;
  }
  isPlaying = false;
  isPaused = false;
  pauseButton.disabled = true;
  pauseButton.textContent = "Pause";
  startButton.textContent = "Replay";
  liveDot.classList.remove("active");
}

function replayLogs() {
  startPlayback();
}

function setSpeed(speed) {
  const previousSpeed = speedMultiplier;
  speedMultiplier = speed;
  document.querySelectorAll(".speed-button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speed) === speed);
  });
  if (isPlaying && !isPaused && playbackTimer) {
    const remainingAtBaseSpeed = Math.max(0, currentEventDueAt - Date.now()) * previousSpeed;
    window.clearTimeout(playbackTimer);
    playbackTimer = null;
    scheduleNextPlaybackEvent(remainingAtBaseSpeed / speedMultiplier);
  }
}

function addMessage(message) {
  messages.insertAdjacentHTML("beforeend", renderMessage(message));
  messages.scrollTop = messages.scrollHeight;
}

function clearLogs() {
  logsSplit.innerHTML = "";
  logsFull.innerHTML = "";
  logClock = 0;
}

function renderMessage(message) {
  return '<div class="msg ' + escapeAttribute(message.role) + '"><div class="bubble">' + message.text + '</div></div>';
}

function renderDoc(doc) {
  return '<article class="doc-card"><div class="doc-head"><div class="doc-icon">' + escapeHtml(doc.icon) + '</div><div><div class="doc-title">' + escapeHtml(doc.title) + '</div><div class="doc-subtitle">' + escapeHtml(doc.subtitle) + '</div></div></div><div class="doc-body">' + doc.sections.map(renderSection).join("") + '</div></article>';
}

function renderPrerequisitesDoc(sizing) {
  return '<article class="doc-card"><div class="doc-head"><div class="doc-icon">⚙️</div><div><div class="doc-title">' + escapeHtml(sizing.title) + '</div><div class="doc-subtitle">' + escapeHtml(sizing.subtitle) + '</div></div></div><div class="doc-body">' +
    renderChecklistSection("Knowledge / Data Sources", sizing.knowledgeDataSources) +
    renderChecklistSection("Enterprise System Connections", sizing.enterpriseSystemConnections) +
    renderChecklistSection("Regulatory / Compliance Frameworks", sizing.regulatoryFrameworks) +
    renderChecklistSection("Client-Side Prerequisites", sizing.clientSidePrerequisites) +
    '<h3>Project Sizing</h3><div class="row"><div class="row-label">Scope</div><div class="row-value ok">' + escapeHtml(sizing.implementationSize) + '</div></div>' +
    '<div class="row"><div class="row-label">Capability</div><div class="row-value">' + escapeHtml(sizing.capabilityTier) + '</div></div>' +
    '<div class="row"><div class="row-label">Commercial</div><div class="row-value">' + escapeHtml(sizing.commercialTier) + '</div></div>' +
    renderChecklistSection("Key Sizing Drivers", sizing.keySizingDrivers) +
  '</div></article>';
}

function renderChecklistSection(heading, items) {
  return '<h3>' + escapeHtml(heading) + '</h3>' + (items || []).map((item) => '<div class="checklist-item"><span class="check-icon">✓</span><span>' + escapeHtml(item) + '</span></div>').join("");
}

function renderSection(section) {
  return '<h3>' + escapeHtml(section.heading) + '</h3>' + section.rows.map((row) => '<div class="row"><div class="row-label">' + escapeHtml(row.label) + '</div><div class="row-value ' + escapeAttribute(row.tone || "neutral") + '">' + escapeHtml(row.value) + '</div></div>').join("");
}

function addLog(entry) {
  logClock += Math.floor(Math.random() * 250 + 180);
  const seconds = Math.floor(logClock / 1000);
  const millis = String(logClock % 1000).padStart(3, "0");
  const type = normalizeLogType(entry.type);
  const text = groupedLogText(entry);
  const html = '<div class="log-entry"><span class="log-time">' + seconds + "." + millis + 's</span><span class="log-type ' + escapeAttribute(type) + '">' + escapeHtml(type) + '</span><span class="log-text">' + escapeHtml(text) + '</span></div>';
  [logsSplit, logsFull].forEach((container) => {
    container.insertAdjacentHTML("beforeend", html);
    container.scrollTop = container.scrollHeight;
  });
}

function groupedLogText(entry) {
  const text = String(entry.text || "");
  if (/^(┌|│|└|━━━)/.test(text)) return text;
  const group = String(entry.group || "").trim();
  if (!group) return text;
  const groupEntries = currentScenario().logs.filter((item) => String(item.group || "").trim() === group);
  const index = groupEntries.indexOf(entry);
  if (index === 0 && groupEntries.length === 1) return "┌─ " + group + " · " + text;
  if (index === 0) return "┌─ " + group + " · " + text;
  if (index === groupEntries.length - 1) return "└─ " + text;
  return "│  " + text;
}

function normalizeLogType(type) {
  return String(type || "info").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "info";
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
startButton.addEventListener("click", replayLogs);
pauseButton.addEventListener("click", togglePause);
document.querySelectorAll(".right-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".right-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.getElementById("splitView").classList.toggle("active", button.dataset.view === "split");
    document.getElementById("docsView").classList.toggle("active", button.dataset.view === "docs");
    document.getElementById("logView").classList.toggle("active", button.dataset.view === "log");
  });
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest(".doc-tab");
  if (tab) showDoc(Number(tab.dataset.docIndex));
});
document.getElementById("glossaryButton").addEventListener("click", () => toggleGlossary(true));
document.getElementById("glossaryClose").addEventListener("click", () => toggleGlossary(false));
glossaryOverlay.addEventListener("click", (event) => {
  if (event.target === glossaryOverlay) toggleGlossary(false);
});
document.querySelectorAll(".speed-button").forEach((button) => {
  button.addEventListener("click", () => setSpeed(Number(button.dataset.speed)));
});

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

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Optimus API could not start because http://${HOST}:${PORT} is already in use.`);
    console.error(`Stop the existing process or start this service with PORT=<other-port>.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Optimus API listening on http://${HOST}:${PORT}`);
});
