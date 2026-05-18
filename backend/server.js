const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");

loadEnvFile(path.join(__dirname, "..", ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "localhost";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:4173";
const ACCESS_KEY = process.env.OPTIMUS_ACCESS_KEY || "optimus";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024;
const OUTPUTS_DIR = path.join(__dirname, "..", "Outputs");
const DATA_DIR = path.join(__dirname, "..", "data");
const TOOL_CATALOG_PATH = path.join(DATA_DIR, "tool-catalog.json");
const PADELOG_MATCHES_PATH = path.join(DATA_DIR, "padelog-matches.json");
const BETLOG_BETS_PATH = path.join(DATA_DIR, "betlog-bets.json");
const NOTELOG_NOTES_PATH = path.join(DATA_DIR, "notelog-notes.json");
const NOTES_OUTPUT_DIR = path.join(OUTPUTS_DIR, "Notes");
const NOTELOG_PAGE_WIDTH = 1414;
const NOTELOG_PAGE_HEIGHT = 1000;
const execFileAsync = promisify(execFile);
const HOSTED_TOOLS = [
  {
    id: "padelog",
    title: "Padelog",
    description: "Track padel match results, import CSV batches, and review month, year, or custom-period performance.",
  },
  {
    id: "betlog",
    title: "Betlog",
    description: "Log placed bets, import CSV batches, and review stake, returns, profit, and hit-rate performance.",
  },
  {
    id: "notelog",
    title: "Notelog",
    description: "Capture handwritten pen-tablet notes on editable pages and export them as local PDFs.",
  },
  {
    id: "demo-builder",
    title: "Demo Builder",
    description: "Create a branded, configurable agent demo template with scenarios, messages, docs, and logs.",
  },
  {
    id: "presentation-suite",
    title: "Presentation Suite Builder",
    description: "Create a tabbed presentation suite HTML file with a deck tab and demo tabs.",
  },
  {
    id: "html-base64",
    title: "HTML to iframe Base64",
    description: "Convert an HTML file into an iframe-ready Base64 data string and save it to Outputs.",
  },
  {
    id: "pdf-base64",
    title: "PDF to iframe Base64",
    description: "Convert a PDF file into an iframe-ready Base64 data string and save it to Outputs.",
  },
  {
    id: "token-usage",
    title: "Check My Token Usage",
    description: "Check OpenAI and Anthropic token usage for month-to-date, year-to-date, and a custom range.",
  },
];
const DEFAULT_TOOL_CATALOG_CONFIG = {
  groups: [
    { id: "builders", name: "Builders", displayOrder: 1 },
    { id: "utilities", name: "Utilities", displayOrder: 2 },
  ],
  tools: [
    { id: "padelog", groupId: "utilities", displayOrder: 1, enabled: true },
    { id: "betlog", groupId: "utilities", displayOrder: 2, enabled: true },
    { id: "notelog", groupId: "utilities", displayOrder: 3, enabled: true },
    { id: "demo-builder", groupId: "builders", displayOrder: 1, enabled: true },
    { id: "presentation-suite", groupId: "builders", displayOrder: 2, enabled: true },
    { id: "html-base64", groupId: "utilities", displayOrder: 4, enabled: true },
    { id: "pdf-base64", groupId: "utilities", displayOrder: 5, enabled: true },
    { id: "token-usage", groupId: "utilities", displayOrder: 6, enabled: true },
  ],
};

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

async function appVersion() {
  try {
    const { stdout } = await execFileAsync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: path.join(__dirname, ".."),
      timeout: 2000,
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
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

async function sortedToolCatalog() {
  const catalog = await loadToolCatalogConfig();
  const groupsById = new Map(catalog.groups.map((group) => [group.id, group]));
  const tools = catalog.tools
    .filter((tool) => tool.enabled)
    .map((tool) => {
      const hostedTool = hostedToolById(tool.id);
      const group = groupsById.get(tool.groupId) || catalog.groups[0];
      return {
        ...hostedTool,
        group: group.name,
        groupId: group.id,
        groupOrder: group.displayOrder,
        displayOrder: tool.displayOrder,
        enabled: tool.enabled,
      };
    });

  return tools.sort(compareCatalogTools);
}

async function adminToolCatalog() {
  const catalog = await loadToolCatalogConfig();
  const toolConfigById = new Map(catalog.tools.map((tool) => [tool.id, tool]));
  return {
    groups: catalog.groups,
    tools: HOSTED_TOOLS.map((tool) => ({
      ...tool,
      ...toolConfigById.get(tool.id),
    })),
  };
}

async function loadToolCatalogConfig() {
  try {
    const contents = await fs.readFile(TOOL_CATALOG_PATH, "utf8");
    return normalizeToolCatalogConfig(JSON.parse(contents));
  } catch (error) {
    if (error.code === "ENOENT") {
      return normalizeToolCatalogConfig(DEFAULT_TOOL_CATALOG_CONFIG);
    }
    throw error;
  }
}

async function saveToolCatalogConfig(payload) {
  const catalog = normalizeToolCatalogConfig(payload, { strict: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOOL_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return adminToolCatalog();
}

function normalizeToolCatalogConfig(config, options = {}) {
  const groups = normalizeToolGroups(config?.groups);
  const groupIds = new Set(groups.map((group) => group.id));
  const defaultGroupId = groups[0].id;
  const toolConfigById = new Map(
    (Array.isArray(config?.tools) ? config.tools : []).map((tool) => [String(tool.id || ""), tool]),
  );

  return {
    groups,
    tools: HOSTED_TOOLS.map((hostedTool, index) => {
      const fallback = DEFAULT_TOOL_CATALOG_CONFIG.tools.find((tool) => tool.id === hostedTool.id) || {};
      const tool = toolConfigById.get(hostedTool.id) || fallback;
      const groupId = String(tool.groupId || fallback.groupId || defaultGroupId);

      if (options.strict && !groupIds.has(groupId)) {
        throw new Error(`${hostedTool.title} must belong to an existing group`);
      }

      return {
        id: hostedTool.id,
        groupId: groupIds.has(groupId) ? groupId : defaultGroupId,
        displayOrder: cleanPositiveInteger(tool.displayOrder, index + 1),
        enabled: tool.enabled !== false,
      };
    }),
  };
}

function normalizeToolGroups(groups) {
  const source = Array.isArray(groups) && groups.length ? groups : DEFAULT_TOOL_CATALOG_CONFIG.groups;
  const seenIds = new Set();

  return source.slice(0, 20).map((rawGroup, index) => {
    const group = rawGroup || {};
    const id = uniqueCatalogId(group.id || group.name || `group-${index + 1}`, seenIds);
    return {
      id,
      name: cleanText(group.name, `Group ${index + 1}`, 80),
      displayOrder: cleanPositiveInteger(group.displayOrder, index + 1),
    };
  });
}

function uniqueCatalogId(value, seenIds) {
  const baseId = String(value || "group")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "group";
  let id = baseId;
  let suffix = 2;

  while (seenIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  seenIds.add(id);
  return id;
}

function cleanPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }

  return Math.round(number);
}

function hostedToolById(id) {
  const tool = HOSTED_TOOLS.find((item) => item.id === id);
  if (!tool) {
    throw new Error(`Unknown hosted tool: ${id}`);
  }

  return tool;
}

function compareCatalogTools(left, right) {
  return (
    left.groupOrder - right.groupOrder ||
    left.group.localeCompare(right.group) ||
    left.displayOrder - right.displayOrder ||
    left.title.localeCompare(right.title)
  );
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

function outputPdfFileName(fileName) {
  const parsed = path.parse(fileName || "document.pdf");
  const baseName = parsed.name || "document";
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `base64-pdf-${safeBaseName || "document"}.txt`;
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

function defaultGlossaryCategories() {
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

function defaultDemoGlossary(scenarios) {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    title: `${scenario.label} Glossary`,
    categories: defaultGlossaryCategories(),
  }));
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

function normalizeDemoGlossary(glossaryJson, scenarios) {
  if (!String(glossaryJson || "").trim()) {
    return defaultDemoGlossary(scenarios);
  }

  let parsed;
  try {
    parsed = JSON.parse(glossaryJson);
  } catch {
    throw new Error("Glossary JSON is not valid JSON");
  }

  const glossary = Array.isArray(parsed) ? parsed : parsed.glossary;
  if (!Array.isArray(glossary)) {
    throw new Error("Glossary JSON must be an array or an object with a glossary array");
  }

  if (glossary.some((item) => Array.isArray(item.categories))) {
    const defaults = defaultDemoGlossary(scenarios);
    const byScenario = new Map(glossary.map((entry) => [String(entry.scenarioId || ""), entry]));
    return scenarios.map((scenario, index) => {
      const entry = byScenario.get(scenario.id) || glossary[index] || {};
      return {
        scenarioId: scenario.id,
        title: cleanText(entry.title, `${scenario.label} Glossary`, 100),
        categories: normalizeGlossaryCategories(entry.categories),
      };
    });
  }

  return [
    {
      scenarioId: "*",
      title: "Glossary",
      categories: normalizeGlossaryCategories(glossary),
    },
  ];
}

function normalizeGlossaryCategories(categories) {
  const source = Array.isArray(categories) && categories.length ? categories : defaultGlossaryCategories();
  return source.slice(0, 12).map((category) => ({
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

function tokenUsageRanges({ from, to } = {}) {
  const now = new Date();
  const tomorrowStart = localDateStart(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const customRange = customTokenUsageRange(from, to);

  const ranges = [
    {
      id: "monthToDate",
      label: "Month to date",
      start: localDateStart(now.getFullYear(), now.getMonth(), 1),
      end: tomorrowStart,
    },
    {
      id: "yearToDate",
      label: "Year to date",
      start: localDateStart(now.getFullYear(), 0, 1),
      end: tomorrowStart,
    },
  ];

  if (customRange) {
    ranges.push(customRange);
  }

  return ranges.map((range) => ({
    ...range,
    startingAt: range.start.toISOString(),
    endingAt: range.end.toISOString(),
  }));
}

function customTokenUsageRange(from, to) {
  const fromText = String(from || "").trim();
  const toText = String(to || "").trim();
  if (!fromText && !toText) {
    return null;
  }

  if (!fromText || !toText) {
    throw new Error("Choose both a start and end date for the custom range");
  }

  const start = parseDateInput(fromText);
  const endDate = parseDateInput(toText);
  const end = localDateStart(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
  if (end <= start) {
    throw new Error("Custom range end date must be on or after the start date");
  }

  return {
    id: "customRange",
    label: `Custom range (${formatDateInput(start)} to ${formatDateInput(endDate)})`,
    start,
    end,
  };
}

function parseDateInput(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error("Choose a valid date");
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = localDateStart(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    throw new Error("Choose a valid date");
  }

  return date;
}

function localDateStart(year, month, day) {
  return new Date(year, month, day, 0, 0, 0, 0);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function checkTokenUsage(payload = {}) {
  const ranges = tokenUsageRanges(payload);
  const providerResults = await Promise.all([
    usageProviderResult("openai", "OpenAI", ranges, getOpenAiUsage),
    usageProviderResult("anthropic", "Anthropic", ranges, getAnthropicUsage),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    ranges: ranges.map(({ id, label, startingAt, endingAt }) => ({ id, label, startingAt, endingAt })),
    providers: providerResults,
  };
}

async function usageProviderResult(id, name, ranges, loader) {
  try {
    return {
      id,
      name,
      ok: true,
      ranges: await Promise.all(ranges.map((range) => loader(range))),
    };
  } catch (error) {
    return {
      id,
      name,
      ok: false,
      error: error.message || `Could not load ${name} usage`,
      ranges: [],
    };
  }
}

async function getOpenAiUsage(range) {
  const apiKey = openAiAdminKey();

  const buckets = await fetchOpenAiUsageBuckets(range, apiKey);
  const totals = emptyOpenAiTotals();
  const byModel = new Map();

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      addOpenAiUsage(totals, result);
      const model = result.model || "All models";
      if (!byModel.has(model)) {
        byModel.set(model, emptyOpenAiTotals(model));
      }
      addOpenAiUsage(byModel.get(model), result);
    }
  }

  return {
    rangeId: range.id,
    label: range.label,
    startingAt: range.startingAt,
    endingAt: range.endingAt,
    totals,
    models: Array.from(byModel.values()).sort((left, right) => right.totalTokens - left.totalTokens),
  };
}

function openAiAdminKey() {
  const apiKey = String(process.env.OPENAI_ADMIN_KEY || "").trim();
  if (!apiKey) {
    if (process.env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI usage reports require OPENAI_ADMIN_KEY in .env. OPENAI_API_KEY is only valid for model calls.",
      );
    }

    throw new Error("Set OPENAI_ADMIN_KEY in .env");
  }

  return apiKey;
}

async function fetchOpenAiUsageBuckets(range, apiKey) {
  const buckets = [];
  let page = "";

  do {
    const url = new URL("https://api.openai.com/v1/organization/usage/completions");
    url.searchParams.set("start_time", Math.floor(range.start.getTime() / 1000));
    url.searchParams.set("end_time", Math.floor(range.end.getTime() / 1000));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by[]", "model");
    if (page) {
      url.searchParams.set("page", page);
    }

    const payload = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    buckets.push(...(payload.data || []));
    page = payload.has_more ? payload.next_page : "";
  } while (page);

  return buckets;
}

function emptyOpenAiTotals(model = "") {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    requests: 0,
    totalTokens: 0,
  };
}

function addOpenAiUsage(target, result = {}) {
  target.inputTokens += cleanUsageNumber(result.input_tokens);
  target.outputTokens += cleanUsageNumber(result.output_tokens);
  target.cachedInputTokens += cleanUsageNumber(result.input_cached_tokens);
  target.inputAudioTokens += cleanUsageNumber(result.input_audio_tokens);
  target.outputAudioTokens += cleanUsageNumber(result.output_audio_tokens);
  target.requests += cleanUsageNumber(result.num_model_requests);
  target.totalTokens =
    target.inputTokens + target.outputTokens + target.inputAudioTokens + target.outputAudioTokens;
}

async function getAnthropicUsage(range) {
  const apiKey = anthropicAdminKey();

  const buckets = await fetchAnthropicUsageBuckets(range, apiKey);
  const totals = emptyAnthropicTotals();
  const byModel = new Map();

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      addAnthropicUsage(totals, result);
      const model = result.model || "All models";
      if (!byModel.has(model)) {
        byModel.set(model, emptyAnthropicTotals(model));
      }
      addAnthropicUsage(byModel.get(model), result);
    }
  }

  return {
    rangeId: range.id,
    label: range.label,
    startingAt: range.startingAt,
    endingAt: range.endingAt,
    totals,
    models: Array.from(byModel.values()).sort((left, right) => right.totalTokens - left.totalTokens),
  };
}

function anthropicAdminKey() {
  const apiKey = String(process.env.ANTHROPIC_ADMIN_KEY || "").trim();
  if (!apiKey) {
    if (process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Anthropic usage reports require ANTHROPIC_ADMIN_KEY in .env. ANTHROPIC_API_KEY is only valid for model calls.",
      );
    }

    throw new Error("Set ANTHROPIC_ADMIN_KEY in .env");
  }

  if (!apiKey.startsWith("sk-ant-admin")) {
    throw new Error("ANTHROPIC_ADMIN_KEY must be an Anthropic Admin API key starting with sk-ant-admin...");
  }

  return apiKey;
}

async function fetchAnthropicUsageBuckets(range, apiKey) {
  const buckets = [];
  let page = "";

  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
    url.searchParams.set("starting_at", range.startingAt);
    url.searchParams.set("ending_at", range.endingAt);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by[]", "model");
    if (page) {
      url.searchParams.set("page", page);
    }

    const payload = await fetchJson(url, {
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
    });
    buckets.push(...(payload.data || []));
    page = payload.has_more ? payload.next_page : "";
  } while (page);

  return buckets;
}

function emptyAnthropicTotals(model = "") {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    requests: 0,
    totalTokens: 0,
  };
}

function addAnthropicUsage(target, result = {}) {
  const cacheCreationInputTokens = Object.values(result.cache_creation || {}).reduce(
    (sum, value) => sum + cleanUsageNumber(value),
    0,
  );
  const uncachedInputTokens = cleanUsageNumber(result.uncached_input_tokens);
  const cacheReadInputTokens = cleanUsageNumber(result.cache_read_input_tokens);

  target.inputTokens += uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  target.outputTokens += cleanUsageNumber(result.output_tokens);
  target.cacheCreationInputTokens += cacheCreationInputTokens;
  target.cacheReadInputTokens += cacheReadInputTokens;
  target.requests += cleanUsageNumber(result.requests || result.num_model_requests);
  target.totalTokens = target.inputTokens + target.outputTokens;
}

function cleanUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, response.status));
  }

  return payload;
}

function apiErrorMessage(payload, status) {
  const message =
    payload?.error?.message ||
    payload?.error?.error?.message ||
    payload?.message ||
    payload?.error ||
    `Provider returned HTTP ${status}`;
  return typeof message === "string" ? message : `Provider returned HTTP ${status}`;
}

function normalizePadelogMatch(rawMatch = {}) {
  const date = cleanPadelogDate(rawMatch.date || rawMatch.Date);

  const resultInput = cleanText(rawMatch.result || rawMatch.Result, "", 12).toLowerCase();
  const result = resultInput ? resultInput.charAt(0).toUpperCase() + resultInput.slice(1) : "";
  if (!["Won", "Lost", "Draw"].includes(result)) {
    throw new Error("Result must be Won, Lost, or Draw");
  }

  return {
    id: cleanText(rawMatch.id, crypto.randomUUID(), 80),
    club: cleanText(rawMatch.club || rawMatch.padelClub || rawMatch["Padel Club"], "Padel Club", 120),
    date,
    teammate: cleanText(rawMatch.teammate || rawMatch.teamate || rawMatch.Teamate || rawMatch.Teammate, "Teammate", 120),
    opponents: cleanText(rawMatch.opponents || rawMatch.Opponents, "Opponents", 200),
    result,
    sets: cleanPadelogSetScore(rawMatch.sets || rawMatch.Sets),
    createdAt: cleanText(rawMatch.createdAt, new Date().toISOString(), 40),
  };
}

function cleanPadelogDate(value) {
  const date = String(value || "").trim();
  const isoMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return validPadelogDateParts(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const slashMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slashMatch) {
    const [, day, month, rawYear] = slashMatch;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return validPadelogDateParts(year, month, day);
  }

  throw new Error("Match date must use YYYY-MM-DD or D/M/YY");
}

function validPadelogDateParts(year, month, day) {
  const normalizedDate = [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
  const parsedDate = new Date(`${normalizedDate}T00:00:00Z`);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getUTCFullYear() !== Number(year) ||
    parsedDate.getUTCMonth() + 1 !== Number(month) ||
    parsedDate.getUTCDate() !== Number(day)
  ) {
    throw new Error("Match date is not a valid calendar date");
  }

  return normalizedDate;
}

function cleanPadelogSetScore(value) {
  const score = String(value || "").trim().replace(/\s+/g, "");
  if (!/^\d+-\d+$/.test(score)) {
    throw new Error("Sets must be a set score such as 1-0, 2-1, 1-1, or 2-2");
  }

  return score.slice(0, 12);
}

function sortPadelogMatches(matches) {
  return [...matches].sort((left, right) => {
    const dateOrder = right.date.localeCompare(left.date);
    if (dateOrder) {
      return dateOrder;
    }

    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  });
}

async function loadPadelogMatches() {
  try {
    const contents = await fs.readFile(PADELOG_MATCHES_PATH, "utf8");
    const parsed = JSON.parse(contents);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : Array.isArray(parsed) ? parsed : [];
    return sortPadelogMatches(matches.map(normalizePadelogMatch));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function savePadelogMatches(matches) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    PADELOG_MATCHES_PATH,
    `${JSON.stringify({ matches: sortPadelogMatches(matches) }, null, 2)}\n`,
    "utf8",
  );
}

async function addPadelogMatches(payload) {
  const incoming = Array.isArray(payload?.matches) ? payload.matches : [payload?.match || payload];
  if (!incoming.length) {
    throw new Error("Add at least one match");
  }

  const existingMatches = await loadPadelogMatches();
  const normalizedMatches = incoming.map(normalizePadelogMatch);
  const matches = sortPadelogMatches([...normalizedMatches, ...existingMatches]);
  await savePadelogMatches(matches);

  return {
    imported: normalizedMatches.length,
    matches,
  };
}

async function updatePadelogMatch(payload = {}) {
  const id = String(payload.id || payload.match?.id || "").trim();
  if (!id) {
    throw new Error("Choose a match to edit");
  }

  const matches = await loadPadelogMatches();
  const matchIndex = matches.findIndex((match) => match.id === id);
  if (matchIndex === -1) {
    throw new Error("Match not found");
  }

  const updatedMatch = normalizePadelogMatch({
    ...matches[matchIndex],
    ...(payload.match || payload),
    id,
    createdAt: matches[matchIndex].createdAt,
  });
  matches[matchIndex] = updatedMatch;
  const sortedMatches = sortPadelogMatches(matches);
  await savePadelogMatches(sortedMatches);

  return { matches: sortedMatches };
}

async function deletePadelogMatch(matchId) {
  const id = String(matchId || "").trim();
  if (!id) {
    throw new Error("Choose a match to delete");
  }

  const matches = await loadPadelogMatches();
  const nextMatches = matches.filter((match) => match.id !== id);
  if (nextMatches.length === matches.length) {
    throw new Error("Match not found");
  }

  await savePadelogMatches(nextMatches);
  return { matches: nextMatches };
}

function normalizeBetlogBet(rawBet = {}) {
  const date = cleanPadelogDate(rawBet.date || rawBet.Date);
  const time = cleanBetlogTime(rawBet.time || rawBet.Time);
  const stake = cleanMoney(rawBet.stake || rawBet.Stake);
  const returnAmount = cleanMoney(
    rawBet.return_amount ?? rawBet.returnAmount ?? rawBet.Return ?? rawBet["Return Amount"],
    0,
  );
  const odds = cleanPositiveDecimal(rawBet.odds || rawBet.Odds, "Odds must be a positive number");
  const legs = cleanPositiveInteger(rawBet.legs || rawBet.Legs, 1);

  return {
    id: cleanText(rawBet.id, crypto.randomUUID(), 80),
    date,
    time,
    betId: cleanText(rawBet.bet_id || rawBet.betId || rawBet["Bet ID"], "Bet ID", 80),
    betType: cleanText(rawBet.bet_type || rawBet.betType || rawBet["Bet Type"], "Single", 80),
    stake,
    freeBet: cleanBoolean(rawBet.free_bet ?? rawBet.freeBet ?? rawBet["Free Bet"]),
    status: cleanText(rawBet.status || rawBet.Status, "Open", 80),
    returnAmount,
    selection: cleanText(rawBet.selection || rawBet.Selection, "Selection", 200),
    odds,
    market: cleanText(rawBet.market || rawBet.Market, "Market", 180),
    match: cleanText(rawBet.match || rawBet.Match, "Match", 220),
    score: cleanText(rawBet.score ?? rawBet.Score, "", 80),
    outcomeType: cleanText(rawBet.outcome_type || rawBet.outcomeType || rawBet["Outcome Type"], "single", 80),
    legs,
    createdAt: cleanText(rawBet.createdAt, new Date().toISOString(), 40),
  };
}

function cleanBetlogTime(value) {
  const time = String(value || "").trim();
  const match = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    throw new Error("Bet time must use HH:MM");
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error("Bet time is not valid");
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanMoney(value, fallback = null) {
  const rawValue = value ?? fallback;
  const number = Number(String(rawValue ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Stake and return amount must be non-negative numbers");
  }

  return Math.round(number * 100) / 100;
}

function cleanPositiveDecimal(value, message) {
  const number = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(message);
  }

  return Math.round(number * 10000) / 10000;
}

function cleanBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "free", "ναι"].includes(normalized);
}

function sortBetlogBets(bets) {
  return [...bets].sort((left, right) => {
    const dateOrder = right.date.localeCompare(left.date);
    if (dateOrder) {
      return dateOrder;
    }

    const timeOrder = right.time.localeCompare(left.time);
    if (timeOrder) {
      return timeOrder;
    }

    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  });
}

async function loadBetlogBets() {
  try {
    const contents = await fs.readFile(BETLOG_BETS_PATH, "utf8");
    const parsed = JSON.parse(contents);
    const bets = Array.isArray(parsed?.bets) ? parsed.bets : Array.isArray(parsed) ? parsed : [];
    return sortBetlogBets(bets.map(normalizeBetlogBet));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveBetlogBets(bets) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    BETLOG_BETS_PATH,
    `${JSON.stringify({ bets: sortBetlogBets(bets) }, null, 2)}\n`,
    "utf8",
  );
}

async function addBetlogBets(payload) {
  const incoming = Array.isArray(payload?.bets) ? payload.bets : [payload?.bet || payload];
  if (!incoming.length) {
    throw new Error("Add at least one bet");
  }

  const existingBets = await loadBetlogBets();
  const normalizedBets = incoming.map(normalizeBetlogBet);
  const bets = sortBetlogBets([...normalizedBets, ...existingBets]);
  await saveBetlogBets(bets);

  return {
    imported: normalizedBets.length,
    bets,
  };
}

async function updateBetlogBet(payload = {}) {
  const id = String(payload.id || payload.bet?.id || "").trim();
  if (!id) {
    throw new Error("Choose a bet to edit");
  }

  const bets = await loadBetlogBets();
  const betIndex = bets.findIndex((bet) => bet.id === id);
  if (betIndex === -1) {
    throw new Error("Bet not found");
  }

  const updatedBet = normalizeBetlogBet({
    ...bets[betIndex],
    ...(payload.bet || payload),
    id,
    createdAt: bets[betIndex].createdAt,
  });
  bets[betIndex] = updatedBet;
  const sortedBets = sortBetlogBets(bets);
  await saveBetlogBets(sortedBets);

  return { bets: sortedBets };
}

async function deleteBetlogBet(betRowId) {
  const id = String(betRowId || "").trim();
  if (!id) {
    throw new Error("Choose a bet row to delete");
  }

  const bets = await loadBetlogBets();
  const nextBets = bets.filter((bet) => bet.id !== id);
  if (nextBets.length === bets.length) {
    throw new Error("Bet not found");
  }

  await saveBetlogBets(nextBets);
  return { bets: nextBets };
}

function defaultNotelogPage() {
  return {
    id: crypto.randomUUID(),
    width: NOTELOG_PAGE_WIDTH,
    height: NOTELOG_PAGE_HEIGHT,
    background: "grid",
    strokes: [],
  };
}

function normalizeNotelogNote(rawNote = {}) {
  const createdAt = cleanText(rawNote.createdAt, new Date().toISOString(), 40);
  const updatedAt = cleanText(rawNote.updatedAt, createdAt, 40);
  const pages = Array.isArray(rawNote.pages) && rawNote.pages.length
    ? rawNote.pages.slice(0, 120).map(normalizeNotelogPage)
    : [defaultNotelogPage()];

  return {
    id: cleanText(rawNote.id, crypto.randomUUID(), 80),
    title: cleanText(rawNote.title, "Untitled note", 120),
    createdAt,
    updatedAt,
    pages,
    exportedFileName: cleanText(rawNote.exportedFileName, "", 180),
    exportedAt: cleanText(rawNote.exportedAt, "", 40),
  };
}

function normalizeNotelogPage(rawPage = {}) {
  const rawWidth = cleanBoundedNumber(rawPage.width, NOTELOG_PAGE_WIDTH, 300, 3000);
  const rawHeight = cleanBoundedNumber(rawPage.height, NOTELOG_PAGE_HEIGHT, 300, 5000);
  const isPortrait = rawHeight > rawWidth;
  const width = isPortrait ? NOTELOG_PAGE_WIDTH : rawWidth;
  const height = isPortrait ? NOTELOG_PAGE_HEIGHT : rawHeight;
  const scaleX = width / rawWidth;
  const scaleY = height / rawHeight;
  const background = ["blank", "ruled", "grid", "dots", "cornell", "meeting"].includes(rawPage.background)
    ? rawPage.background
    : "grid";
  const strokes = Array.isArray(rawPage.strokes)
    ? rawPage.strokes.slice(0, 15000).map((stroke) => normalizeNotelogStroke(stroke, { scaleX, scaleY }))
    : [];

  return {
    id: cleanText(rawPage.id, crypto.randomUUID(), 80),
    width,
    height,
    background,
    strokes,
  };
}

function normalizeNotelogStroke(rawStroke = {}, options = {}) {
  const tool = rawStroke.tool === "eraser" ? "eraser" : "pen";
  const color = safeHexColor(rawStroke.color, "#111827");
  const size = cleanBoundedNumber(rawStroke.size, 4, 1, 80);
  const points = Array.isArray(rawStroke.points)
    ? rawStroke.points.slice(0, 3000).map((point) => normalizeNotelogPoint(point, options))
    : [];

  return { tool, color, size, points };
}

function normalizeNotelogPoint(rawPoint = {}, options = {}) {
  const scaleX = Number.isFinite(options.scaleX) ? options.scaleX : 1;
  const scaleY = Number.isFinite(options.scaleY) ? options.scaleY : 1;
  return {
    x: cleanBoundedNumber(Number(rawPoint.x) * scaleX, 0, -10000, 10000),
    y: cleanBoundedNumber(Number(rawPoint.y) * scaleY, 0, -10000, 10000),
    pressure: cleanBoundedNumber(rawPoint.pressure, 0.5, 0, 1),
  };
}

function cleanBoundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(number * 1000) / 1000));
}

function sortNotelogNotes(notes) {
  return [...notes].sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

async function loadNotelogNotes() {
  try {
    const contents = await fs.readFile(NOTELOG_NOTES_PATH, "utf8");
    const parsed = JSON.parse(contents);
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : Array.isArray(parsed) ? parsed : [];
    return sortNotelogNotes(notes.map(normalizeNotelogNote));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveNotelogNotes(notes) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    NOTELOG_NOTES_PATH,
    `${JSON.stringify({ notes: sortNotelogNotes(notes) }, null, 2)}\n`,
    "utf8",
  );
}

async function upsertNotelogNote(payload = {}) {
  const note = normalizeNotelogNote({
    ...(payload.note || payload),
    updatedAt: new Date().toISOString(),
  });
  const notes = await loadNotelogNotes();
  const existingIndex = notes.findIndex((item) => item.id === note.id);
  if (existingIndex >= 0) {
    note.createdAt = notes[existingIndex].createdAt;
    note.exportedFileName = notes[existingIndex].exportedFileName;
    note.exportedAt = notes[existingIndex].exportedAt;
    notes[existingIndex] = note;
  } else {
    notes.unshift(note);
  }

  const sortedNotes = sortNotelogNotes(notes);
  await saveNotelogNotes(sortedNotes);
  return { note, notes: sortedNotes };
}

async function deleteNotelogNote(noteId) {
  const id = String(noteId || "").trim();
  if (!id) {
    throw new Error("Choose a note to delete");
  }

  const notes = await loadNotelogNotes();
  const nextNotes = notes.filter((note) => note.id !== id);
  if (nextNotes.length === notes.length) {
    throw new Error("Note not found");
  }

  await saveNotelogNotes(nextNotes);
  return { notes: nextNotes };
}

async function exportNotelogNote(payload = {}) {
  const id = String(payload.id || payload.note?.id || "").trim();
  if (!id) {
    throw new Error("Choose a note to export");
  }

  const notes = await loadNotelogNotes();
  const noteIndex = notes.findIndex((note) => note.id === id);
  if (noteIndex === -1) {
    throw new Error("Note not found");
  }

  if (!notes[noteIndex].pages.length) {
    throw new Error("Add at least one page before exporting");
  }

  const pdf = buildNotelogVectorPdf(notes[noteIndex].pages);
  const fileName = notelogPdfFileName(notes[noteIndex].title);
  const outputPath = path.join(NOTES_OUTPUT_DIR, fileName);

  await fs.mkdir(NOTES_OUTPUT_DIR, { recursive: true });
  await fs.writeFile(outputPath, pdf);

  notes[noteIndex] = {
    ...notes[noteIndex],
    exportedFileName: fileName,
    exportedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sortedNotes = sortNotelogNotes(notes);
  await saveNotelogNotes(sortedNotes);

  return {
    fileName,
    outputPath,
    previewUrl: `/api/outputs/notes/${encodeURIComponent(fileName)}`,
    notes: sortedNotes,
    note: notes[noteIndex],
  };
}

function notelogPdfFileName(title) {
  const safeBaseName = String(title || "note")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "note";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeBaseName}-${stamp}.pdf`;
}

function buildNotelogVectorPdf(pages) {
  const chunks = [];
  const offsets = [0];
  const pageWidth = 841.89;
  const pageHeight = 595.28;
  let objectNumber = 1;
  const catalogObject = objectNumber++;
  const pagesObject = objectNumber++;
  const pageObjects = [];
  const contentObjects = [];

  for (let index = 0; index < pages.length; index += 1) {
    pageObjects.push(objectNumber++);
    contentObjects.push(objectNumber++);
  }

  function push(value) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "binary"));
  }

  function writeObject(number, body) {
    offsets[number] = Buffer.concat(chunks).length;
    push(`${number} 0 obj\n${body}\nendobj\n`);
  }

  function writeStreamObject(number, dictionary, stream) {
    offsets[number] = Buffer.concat(chunks).length;
    push(`${number} 0 obj\n${dictionary}\nstream\n`);
    push(stream);
    push("\nendstream\nendobj\n");
  }

  push("%PDF-1.4\n");
  writeObject(catalogObject, `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  writeObject(
    pagesObject,
    `<< /Type /Pages /Kids [${pageObjects.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`,
  );

  pages.forEach((page, index) => {
    const contentObject = contentObjects[index];
    const content = Buffer.from(notelogPdfPageContent(page, pageWidth, pageHeight), "binary");

    writeObject(
      pageObjects[index],
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << >> /Contents ${contentObject} 0 R >>`,
    );
    writeStreamObject(contentObject, `<< /Length ${content.length} >>`, content);
  });

  const xrefOffset = Buffer.concat(chunks).length;
  push(`xref\n0 ${objectNumber}\n0000000000 65535 f \n`);
  for (let index = 1; index < objectNumber; index += 1) {
    push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectNumber} /Root ${catalogObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

function notelogPdfPageContent(page, pdfWidth, pdfHeight) {
  const width = page.width || NOTELOG_PAGE_WIDTH;
  const height = page.height || NOTELOG_PAGE_HEIGHT;
  const scaleX = pdfWidth / width;
  const scaleY = pdfHeight / height;
  const commands = [
    "q",
    "1 1 1 rg",
    `0 0 ${pdfNumber(pdfWidth)} ${pdfNumber(pdfHeight)} re f`,
    ...notelogPdfBackgroundCommands(page, pdfWidth, pdfHeight, scaleX, scaleY),
    ...notelogPdfStrokeCommands(page, pdfWidth, pdfHeight, scaleX, scaleY),
    "Q",
  ];

  return `${commands.join("\n")}\n`;
}

function notelogPdfBackgroundCommands(page, pdfWidth, pdfHeight, scaleX, scaleY) {
  const commands = [];
  const lineColor = "0.86 0.91 0.96";
  const strongLineColor = "0.78 0.85 0.94";
  const addLine = (x1, y1, x2, y2, color = lineColor, width = 0.45) => {
    commands.push(
      `${color} RG`,
      `${pdfNumber(width)} w`,
      `${pdfPoint(x1, y1, scaleX, scaleY, pdfHeight)} m ${pdfPoint(x2, y2, scaleX, scaleY, pdfHeight)} l S`,
    );
  };

  if (page.background === "ruled" || page.background === "cornell" || page.background === "meeting") {
    for (let y = 96; y < page.height; y += 44) {
      addLine(72, y, page.width - 72, y);
    }
  } else if (page.background === "dots") {
    commands.push(`${lineColor} rg`);
    for (let y = 52; y < page.height; y += 32) {
      for (let x = 52; x < page.width; x += 32) {
        const cx = x * scaleX;
        const cy = pdfHeight - y * scaleY;
        commands.push(`${pdfNumber(cx - 0.8)} ${pdfNumber(cy - 0.8)} 1.6 1.6 re f`);
      }
    }
  } else if (page.background === "grid") {
    for (let x = 50; x < page.width; x += 32) {
      addLine(x, 0, x, page.height);
    }
    for (let y = 50; y < page.height; y += 32) {
      addLine(0, y, page.width, y);
    }
  }

  if (page.background === "cornell") {
    addLine(330, 70, 330, page.height - 190, strongLineColor, 1);
    addLine(72, page.height - 190, page.width - 72, page.height - 190, strongLineColor, 1);
  }

  if (page.background === "meeting") {
    addLine(72, 92, page.width - 72, 92, strongLineColor, 1);
    addLine(72, 150, page.width - 72, 150, strongLineColor, 1);
    addLine(page.width - 360, 92, page.width - 360, 150, strongLineColor, 1);
    addLine(page.width - 360, page.height - 220, page.width - 72, page.height - 220, strongLineColor, 1);
    addLine(page.width - 360, 210, page.width - 360, page.height - 72, strongLineColor, 1);
  }

  return commands;
}

function notelogPdfStrokeCommands(page, pdfWidth, pdfHeight, scaleX, scaleY) {
  return (page.strokes || []).flatMap((stroke) => {
    const points = stroke.points || [];
    if (points.length < 2) {
      return [];
    }

    const color = stroke.tool === "eraser" ? "#ffffff" : stroke.color || "#111827";
    const [r, g, b] = hexToPdfRgb(color);
    const commands = [
      `${r} ${g} ${b} RG`,
      "1 J",
      "1 j",
    ];

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const pressure = Math.max(0.22, ((previous.pressure || 0.5) + (current.pressure || 0.5)) / 2);
      const width = Math.max(0.3, (stroke.size || 4) * (0.55 + pressure) * scaleY);
      commands.push(
        `${pdfNumber(width)} w`,
        `${pdfPoint(previous.x, previous.y, scaleX, scaleY, pdfHeight)} m ${pdfPoint(current.x, current.y, scaleX, scaleY, pdfHeight)} l S`,
      );
    }

    return commands;
  });
}

function pdfPoint(x, y, scaleX, scaleY, pdfHeight) {
  return `${pdfNumber(x * scaleX)} ${pdfNumber(pdfHeight - y * scaleY)}`;
}

function pdfNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function hexToPdfRgb(hexColor) {
  const match = String(hexColor || "").match(/^#([0-9a-f]{6})$/i);
  const hex = match ? match[1] : "111827";
  return [0, 2, 4].map((index) => pdfNumber(parseInt(hex.slice(index, index + 2), 16) / 255));
}

async function readNotelogPdf(fileName) {
  const candidate = String(fileName || "").trim();
  if (!candidate || path.basename(candidate) !== candidate || path.extname(candidate).toLowerCase() !== ".pdf") {
    throw new Error("Choose a valid Notelog PDF");
  }

  return fs.readFile(path.join(NOTES_OUTPUT_DIR, candidate));
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

  if (
    !iframeSource.startsWith("data:text/html;base64,") &&
    !iframeSource.startsWith("data:application/pdf;base64,")
  ) {
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
  const glossary = normalizeDemoGlossary(options.glossaryJson, scenarios);

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
html, body { width: 100%; height: 100%; }
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
.main { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: minmax(320px, 42%) minmax(0, 1fr); }
.chat { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--chat-bg); color: var(--chat-text); border-right: 1px solid var(--border); }
.chat-head { flex: 0 0 auto; padding: 12px 14px; border-bottom: 1px solid #d8dde8; background: #fff; }
.chat-head strong { display: block; font-size: 12px; }
.chat-head span { color: #64748b; font-size: 11px; }
.messages { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.messages > *, .logs > * { flex: 0 0 auto; }
.msg { display: grid; grid-template-columns: 28px minmax(0, 1fr) 28px; align-items: start; gap: 8px; max-width: 100%; }
.msg.user { align-self: stretch; }
.msg.agent { align-self: stretch; }
.avatar { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: var(--brand); color: #fff; font-size: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.16); }
.avatar.user { grid-column: 3; background: #475569; }
.avatar.agent { grid-column: 1; }
.bubble { grid-column: 2; width: fit-content; max-width: min(680px, 100%); padding: 10px 12px; border-radius: 12px; line-height: 1.55; background: #fff; border: 1px solid #d8dde8; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
.msg.agent .bubble { border-top-left-radius: 4px; }
.msg.user .bubble { justify-self: end; background: var(--brand); color: #fff; border-color: var(--brand); border-top-right-radius: 4px; }
.chat-input-area { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-top: 1px solid #d8dde8; background: #fff; }
.chat-input-area input { flex: 1; min-width: 0; height: 34px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 10px; background: #f8fafc; color: #64748b; outline: none; }
.chat-input-area button { flex: 0 0 auto; border: 0; border-radius: 6px; padding: 8px 13px; background: color-mix(in srgb, var(--brand) 58%, white); color: #fff; font-weight: 800; cursor: default; }
.right { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg-secondary); overflow: hidden; }
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
.docs, .logs { min-height: 0; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.messages::-webkit-scrollbar, .docs::-webkit-scrollbar, .logs::-webkit-scrollbar { width: 6px; }
.messages::-webkit-scrollbar-thumb, .docs::-webkit-scrollbar-thumb, .logs::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
.messages::-webkit-scrollbar-track, .docs::-webkit-scrollbar-track, .logs::-webkit-scrollbar-track { background: transparent; }
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
    <div class="chat-input-area">
      <input readonly placeholder="Write your message here..." />
      <button type="button">Send</button>
    </div>
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
  - Use one object per scenario: { scenarioId, title, categories: [{ category, entries: [{ term, definition }] }] }.

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
  const glossary = glossaryForScenario(currentScenario()?.id);
  const categories = Array.isArray(glossary.categories) ? glossary.categories : [];
  glossaryBody.innerHTML = '<div class="glossary-category">' + escapeHtml(glossary.title || "Glossary") + '</div>' + categories.map((category) => '<div class="glossary-category">' + escapeHtml(category.category) + '</div>' + (category.entries || []).map((entry) => '<div class="glossary-entry"><div class="glossary-term">' + escapeHtml(entry.term) + '</div><div class="glossary-definition">' + escapeHtml(entry.definition) + '</div></div>').join("")).join("");
}

function glossaryForScenario(scenarioId) {
  const entries = Array.isArray(TEMPLATE_CONFIG.glossary) ? TEMPLATE_CONFIG.glossary : [];
  return entries.find((entry) => entry.scenarioId === scenarioId) || entries.find((entry) => entry.scenarioId === "*") || entries[0] || { title: "Glossary", categories: [] };
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
  renderGlossary();
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
  const role = message.role === "user" ? "user" : "agent";
  const avatar = role === "user" ? "👤" : "🤖";
  return '<div class="msg ' + escapeAttribute(role) + '">' + (role === "agent" ? '<div class="avatar agent">' + avatar + '</div>' : '<div></div>') + '<div class="bubble">' + message.text + '</div>' + (role === "user" ? '<div class="avatar user">' + avatar + '</div>' : '<div></div>') + '</div>';
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

async function savePdfIframeSource({ fileName, base64 }) {
  if (!fileName || typeof base64 !== "string") {
    throw new Error("A PDF file is required");
  }

  const compactBase64 = base64.trim();
  if (!compactBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
    throw new Error("PDF content must be a Base64 string");
  }

  const pdfBuffer = Buffer.from(compactBase64, "base64");
  if (pdfBuffer.length < 5 || pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Choose a valid PDF file");
  }

  const iframeSource = `data:application/pdf;base64,${compactBase64}`;
  const savedFileName = outputPdfFileName(fileName);
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

  if (request.method === "GET" && url.pathname === "/api/version") {
    sendJson(response, 200, { version: await appVersion() });
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

  if (request.method === "GET" && url.pathname === "/api/tools") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, { tools: await sortedToolCatalog() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/tool-catalog") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, await adminToolCatalog());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/tool-catalog") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJson(request);
    sendJson(response, 200, await saveToolCatalogConfig(payload));
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

  if (request.method === "GET" && url.pathname === "/api/tools/padelog/matches") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, { matches: await loadPadelogMatches() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/padelog/matches") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await addPadelogMatches(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Padelog matches" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/padelog/delete") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await deletePadelogMatch(payload.id));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not delete Padelog match" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/padelog/update") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await updatePadelogMatch(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not update Padelog match" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/betlog/bets") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, { bets: await loadBetlogBets() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/betlog/bets") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await addBetlogBets(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Betlog bets" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/betlog/delete") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await deleteBetlogBet(payload.id));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not delete Betlog bet" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/betlog/update") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await updateBetlogBet(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not update Betlog bet" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/notelog/notes") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, { notes: await loadNotelogNotes() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/notelog/notes") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await upsertNotelogNote(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save note" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/notelog/delete") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await deleteNotelogNote(payload.id));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not delete note" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/notelog/export") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await exportNotelogNote(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not export note" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/outputs/notes/")) {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const fileName = decodeURIComponent(url.pathname.replace("/api/outputs/notes/", ""));
      const pdf = await readNotelogPdf(fileName);
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${path.basename(fileName).replace(/"/g, "")}"`,
        ...corsHeaders(),
      });
      response.end(pdf);
    } catch (error) {
      sendJson(response, 404, { error: error.message || "Notelog PDF not found" });
    }
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

  if (request.method === "POST" && url.pathname === "/api/tools/pdf-base64") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const payload = await readJson(request);
    const result = await savePdfIframeSource(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/token-usage") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await checkTokenUsage(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not check token usage" });
    }
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
