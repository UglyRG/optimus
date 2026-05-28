const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const zlib = require("node:zlib");
const { PDFDocument } = require("pdf-lib");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

loadEnvFile(path.join(__dirname, "..", ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "localhost";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:4173";
const ACCESS_KEY = process.env.OPTIMUS_ACCESS_KEY || "optimus";
const PUBLIC_API_KEY = process.env.OPTIMUS_PUBLIC_API_KEY || process.env.OPTIMUS_API_KEY || ACCESS_KEY;
const ANTHROPIC_ANALYSIS_MODEL =
  process.env.ANTHROPIC_ANALYSIS_MODEL || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const OPENAI_OLYMPIACOS_NEWS_MODEL =
  process.env.OPENAI_OLYMPIACOS_NEWS_MODEL || process.env.OPENAI_SEARCH_MODEL || "gpt-5";
const KNOWLEDGE_EXPERT_CHAT_MODEL =
  process.env.KNOWLEDGE_EXPERT_CHAT_MODEL || process.env.ANTHROPIC_MODEL || ANTHROPIC_ANALYSIS_MODEL;
const KNOWLEDGE_EXPERT_EMBED_MODEL = process.env.KNOWLEDGE_EXPERT_EMBED_MODEL || "text-embedding-3-small";
const KNOWLEDGE_EXPERT_DECLINE = "I don't see that in the Knowledge Expert knowledge base.";
const KNOWLEDGE_EXPERT_TOP_K = 5;
const KNOWLEDGE_EXPERT_ENUMERATIVE_TOP_K = 15;
const KNOWLEDGE_EXPERT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const KNOWLEDGE_EXPERT_SYNTHESIZE_QUESTIONS = process.env.KNOWLEDGE_EXPERT_SYNTHESIZE_QUESTIONS || "auto";
const KNOWLEDGE_EXPERT_QUERY_REWRITE_ENABLED = process.env.KNOWLEDGE_EXPERT_QUERY_REWRITE_ENABLED === "true";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_JSON_BODY_BYTES = 200 * 1024 * 1024;
const OUTPUTS_DIR = path.join(__dirname, "..", "Outputs");
const DATA_DIR = path.join(__dirname, "..", "data");
const DATABASE_PATH = process.env.OPTIMUS_DATABASE_PATH || path.join(DATA_DIR, "optimus.db");
const SQLITE_BIN = process.env.SQLITE_BIN || "sqlite3";
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000);
const TOOL_CATALOG_PATH = path.join(DATA_DIR, "tool-catalog.json");
const PADELOG_MATCHES_PATH = path.join(DATA_DIR, "padelog-matches.json");
const BETLOG_BETS_PATH = path.join(DATA_DIR, "betlog-bets.json");
const NOTELOG_NOTES_PATH = path.join(DATA_DIR, "notelog-notes.json");
const PERFORMANCE_INSIGHTS_PATH = path.join(DATA_DIR, "performance-insights.json");
const OLYMPIACOS_NEWS_PATH = path.join(DATA_DIR, "olympiacos-news.json");
const NOTES_OUTPUT_DIR = path.join(OUTPUTS_DIR, "Notes");
const NOTELOG_PAGE_WIDTH = 1414;
const NOTELOG_PAGE_HEIGHT = 1000;
const COMBINE_PDF_MIN_DOCUMENTS = 2;
const COMBINE_PDF_MAX_DOCUMENTS = 5;
const PDF_HEADER_SEARCH_BYTES = 1024;
const execFileAsync = promisify(execFile);
const BACKUP_FILES = [
  { name: "tool-catalog.json", path: TOOL_CATALOG_PATH },
  { name: "padelog-matches.json", path: PADELOG_MATCHES_PATH },
  { name: "betlog-bets.json", path: BETLOG_BETS_PATH },
  { name: "notelog-notes.json", path: NOTELOG_NOTES_PATH },
];
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
    id: "combine-pdfs",
    title: "Combine PDFs",
    description: "Combine two to five PDF files into one new PDF while preserving page sizes.",
  },
  {
    id: "csv-json-rows",
    title: "CSV to JSON Rows",
    description: "Convert every row in a CSV file into matching JSON files saved inside an Outputs subfolder.",
  },
  {
    id: "token-usage",
    title: "Check My Token Usage",
    description: "Check OpenAI and Anthropic token usage for month-to-date, year-to-date, and a custom range.",
  },
  {
    id: "olympiacos-news",
    title: "Olympiacos News",
    description: "Search Greek sports sites for the latest Olympiacos FC and BC news in the last 24 hours.",
  },
  {
    id: "knowledge-expert",
    title: "Knowledge Expert",
    description: "Upload a small knowledge base and ask grounded questions with source citations.",
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
    { id: "combine-pdfs", groupId: "utilities", displayOrder: 6, enabled: true },
    { id: "csv-json-rows", groupId: "utilities", displayOrder: 7, enabled: true },
    { id: "token-usage", groupId: "utilities", displayOrder: 8, enabled: true },
    { id: "olympiacos-news", groupId: "utilities", displayOrder: 9, enabled: true },
    { id: "knowledge-expert", groupId: "utilities", displayOrder: 10, enabled: true },
  ],
};

const sessions = new Map();
let databaseReadyPromise = null;
let databaseQueue = Promise.resolve();

const DATA_STORES = {
  toolCatalog: "tool_catalog",
  padelogMatches: "padelog_matches",
  betlogBets: "betlog_bets",
  notelogNotes: "notelog_notes",
  performanceInsights: "performance_insights",
  olympiacosNews: "olympiacos_news",
  knowledgeExpert: "knowledge_expert",
};

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

async function runDatabaseSql(sql) {
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(SQLITE_BIN, [DATABASE_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`Could not start SQLite (${SQLITE_BIN}): ${error.message}`));
    });
    child.on("close", (code) => {
      if (code) {
        reject(new Error(stderr.trim() || `SQLite exited with status ${code}`));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(`.timeout ${SQLITE_BUSY_TIMEOUT_MS}\n${sql}`);
  });
}

function queueDatabaseOperation(operation) {
  const run = databaseQueue.then(operation, operation);
  databaseQueue = run.catch(() => {});
  return run;
}

async function ensureDatabase() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = queueDatabaseOperation(() =>
      runDatabaseSql(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `),
    );
  }

  await databaseReadyPromise;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTextLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

async function readStoreValue(storeKey) {
  await ensureDatabase();
  const stdout = await queueDatabaseOperation(() =>
    runDatabaseSql(`
      SELECT value
      FROM app_data
      WHERE key = ${sqlString(storeKey)}
      LIMIT 1;
    `),
  );

  return stdout ? stdout.replace(/\n$/, "") : null;
}

async function writeStoreValue(storeKey, value) {
  await ensureDatabase();
  await queueDatabaseOperation(() =>
    runDatabaseSql(`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${sqlString(storeKey)}, ${sqlTextLiteral(value)}, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at;
    `),
  );
}

async function loadJsonStore(storeKey, legacyPath, fallbackValue) {
  const storedValue = await readStoreValue(storeKey);
  if (storedValue !== null) {
    return JSON.parse(storedValue);
  }

  try {
    const contents = await fs.readFile(legacyPath, "utf8");
    const parsed = JSON.parse(contents);
    await saveJsonStore(storeKey, parsed);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function saveJsonStore(storeKey, value) {
  await writeStoreValue(storeKey, JSON.stringify(value));
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendSse(response, event, payload = {}) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
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

function requirePublicApiKey(request, response) {
  const suppliedKey = publicApiKeyFromRequest(request);
  if (!PUBLIC_API_KEY || !suppliedKey || !constantTimeEqual(suppliedKey, PUBLIC_API_KEY)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return false;
  }

  return true;
}

function publicApiKeyFromRequest(request) {
  const authHeader = String(request.headers.authorization || "").trim();
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  return String(request.headers["x-api-key"] || "").trim();
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
  const parsed = await loadJsonStore(DATA_STORES.toolCatalog, TOOL_CATALOG_PATH, DEFAULT_TOOL_CATALOG_CONFIG);
  return normalizeToolCatalogConfig(parsed);
}

async function saveToolCatalogConfig(payload) {
  const catalog = normalizeToolCatalogConfig(payload, { strict: true });
  await saveJsonStore(DATA_STORES.toolCatalog, catalog);
  return adminToolCatalog();
}

async function createBackupArchive() {
  const catalog = normalizeToolCatalogConfig(await loadToolCatalogConfig());
  const files = [
    { name: "data/tool-catalog.json", data: `${JSON.stringify(catalog, null, 2)}\n` },
    { name: "data/padelog-matches.json", data: `${JSON.stringify({ matches: await loadPadelogMatches() }, null, 2)}\n` },
    { name: "data/betlog-bets.json", data: `${JSON.stringify({ bets: await loadBetlogBets() }, null, 2)}\n` },
    { name: "data/notelog-notes.json", data: `${JSON.stringify({ notes: await loadNotelogNotes() }, null, 2)}\n` },
    { name: "data/performance-insights.json", data: `${JSON.stringify({ insights: await loadPerformanceInsights() }, null, 2)}\n` },
    { name: "data/olympiacos-news.json", data: `${JSON.stringify(await loadOlympiacosNewsStore(), null, 2)}\n` },
    { name: "data/knowledge-expert.json", data: `${JSON.stringify(await loadKnowledgeExpertStore(), null, 2)}\n` },
  ];
  const date = new Date().toISOString().slice(0, 10);

  return {
    fileName: `optimus-backup-${date}.zip`,
    mimeType: "application/zip",
    base64: createStoredZip(files).toString("base64"),
  };
}

async function restoreBackupArchive(payload) {
  const compactBase64 = String(payload?.base64 || "").trim();
  if (!compactBase64) {
    throw new Error("Choose a backup zip file first.");
  }

  const entries = readZipEntries(Buffer.from(compactBase64, "base64"));
  const filesByName = new Map();
  for (const [entryName, contents] of entries) {
    filesByName.set(path.basename(entryName), contents.toString("utf8"));
  }

  const missing = BACKUP_FILES.filter((file) => !filesByName.has(file.name)).map((file) => file.name);
  if (missing.length) {
    throw new Error(`Backup is missing: ${missing.join(", ")}`);
  }

  const catalog = normalizeToolCatalogConfig(JSON.parse(filesByName.get("tool-catalog.json")), { strict: true });
  const padelog = parseBackupCollection(filesByName.get("padelog-matches.json"), "matches").map(normalizePadelogMatch);
  const betlog = parseBackupCollection(filesByName.get("betlog-bets.json"), "bets").map(normalizeBetlogBet);
  const notelog = parseBackupCollection(filesByName.get("notelog-notes.json"), "notes").map(normalizeNotelogNote);
  const insights = filesByName.has("performance-insights.json")
    ? parseBackupCollection(filesByName.get("performance-insights.json"), "insights").map(normalizePerformanceInsight)
    : [];
  const olympiacosNews = filesByName.has("olympiacos-news.json")
    ? normalizeOlympiacosNewsStore(JSON.parse(filesByName.get("olympiacos-news.json")))
    : defaultOlympiacosNewsStore();
  const knowledgeExpert = filesByName.has("knowledge-expert.json")
    ? normalizeKnowledgeExpertStore(JSON.parse(filesByName.get("knowledge-expert.json")))
    : defaultKnowledgeExpertStore();

  await saveJsonStore(DATA_STORES.toolCatalog, catalog);
  await savePadelogMatches(padelog);
  await saveBetlogBets(betlog);
  await saveNotelogNotes(notelog);
  await savePerformanceInsights(insights);
  await saveOlympiacosNewsStore(olympiacosNews);
  await saveKnowledgeExpertStore(knowledgeExpert);

  return {
    ok: true,
    restored: {
      matches: padelog.length,
      bets: betlog.length,
      notes: notelog.length,
      insights: insights.length,
      olympiacosNewsRuns: olympiacosNews.runs.length,
      knowledgeExpertEntries: knowledgeExpert.entries.length,
    },
    catalog: await adminToolCatalog(),
  };
}

function parseBackupCollection(contents, key) {
  const parsed = JSON.parse(contents);
  const values = Array.isArray(parsed?.[key]) ? parsed[key] : Array.isArray(parsed) ? parsed : null;
  if (!Array.isArray(values)) {
    throw new Error(`${key} backup file must contain an array.`);
  }
  return values;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const dataBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(dataBuffer);
    const localHeader = Buffer.alloc(30);
    const centralHeader = Buffer.alloc(46);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    writeZipDateTime(localHeader, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);

    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    writeZipDateTime(centralHeader, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBuffer, dataBuffer);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (flags & 0x08) {
      throw new Error("Zip files with data descriptors are not supported.");
    }
    if (dataEnd > buffer.length) {
      throw new Error("Backup zip is incomplete.");
    }

    const entryName = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const rawData = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? rawData : method === 8 ? zlib.inflateRawSync(rawData) : null;
    if (!data) {
      throw new Error(`Unsupported zip compression method for ${entryName}.`);
    }
    if (!entryName.endsWith("/")) {
      entries.set(entryName, data);
    }

    offset = dataEnd;
  }

  if (!entries.size) {
    throw new Error("Backup zip does not contain any files.");
  }
  return entries;
}

function writeZipDateTime(buffer, offset, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  buffer.writeUInt16LE(dosTime, offset);
  buffer.writeUInt16LE(dosDate, offset + 2);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

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

function outputCombinedPdfFileName(fileName) {
  const parsed = path.parse(fileName || "combined.pdf");
  const baseName = parsed.name || "combined";
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `${safeBaseName || "combined"}.pdf`;
}

function outputCsvJsonBaseName(fileName) {
  const parsed = path.parse(fileName || "table.csv");
  const baseName = parsed.name || "table";
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return safeBaseName || "table";
}

function hasPdfHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return false;
  }

  const headerIndex = buffer.indexOf("%PDF-");
  return headerIndex >= 0 && headerIndex <= PDF_HEADER_SEARCH_BYTES;
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
  const text = typeof message === "string" ? message : `Provider returned HTTP ${status}`;
  return text.startsWith("model:")
    ? `${text}. Check ANTHROPIC_ANALYSIS_MODEL in .env or use claude-haiku-4-5-20251001.`
    : text;
}

function anthropicModelKey() {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY in .env");
  }

  return apiKey;
}

async function fetchAnthropicMessage({ system, user, maxTokens = 1000 }) {
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": anthropicModelKey(),
    },
    body: JSON.stringify({
      model: ANTHROPIC_ANALYSIS_MODEL,
      max_tokens: maxTokens,
      temperature: 0.3,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const text = extractAnthropicText(payload).trim();
  if (!text) {
    throw new Error("Anthropic returned no insight text. Try again, or check the configured ANTHROPIC_ANALYSIS_MODEL.");
  }
  if (isModelOnlyInsight(text)) {
    throw new Error("Anthropic returned metadata instead of analysis text. Try again.");
  }

  return text;
}

function extractAnthropicText(payload = {}) {
  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (!Array.isArray(payload.content)) {
    return "";
  }

  return payload.content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (typeof part?.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function defaultKnowledgeExpertStore() {
  return {
    entries: [],
    uploads: [],
    conversations: [],
    turns: [],
  };
}

async function loadKnowledgeExpertStore() {
  const parsed = await loadJsonStore(DATA_STORES.knowledgeExpert, path.join(DATA_DIR, "knowledge-expert.json"), defaultKnowledgeExpertStore());
  return normalizeKnowledgeExpertStore(parsed);
}

async function saveKnowledgeExpertStore(store) {
  await saveJsonStore(DATA_STORES.knowledgeExpert, normalizeKnowledgeExpertStore(store));
}

function normalizeKnowledgeExpertStore(store = {}) {
  const conversations = Array.isArray(store.conversations)
    ? store.conversations.map(normalizeKnowledgeConversation).slice(0, 100)
    : [];
  const hasLegacyTurns = Array.isArray(store.turns) && store.turns.some((turn) => !turn?.conversationId);
  if (!conversations.length && hasLegacyTurns) {
    conversations.push(
      normalizeKnowledgeConversation({
        id: "default",
        title: "Knowledge chat",
        createdAt: store.turns[store.turns.length - 1]?.createdAt,
        updatedAt: store.turns[0]?.createdAt,
      }),
    );
  }
  const fallbackConversationId = conversations[0]?.id || "default";
  return {
    entries: Array.isArray(store.entries) ? store.entries.map(normalizeKnowledgeEntry) : [],
    uploads: Array.isArray(store.uploads) ? store.uploads.map(normalizeKnowledgeUpload) : [],
    conversations,
    turns: Array.isArray(store.turns)
      ? store.turns.map((turn) => normalizeKnowledgeTurn(turn, fallbackConversationId)).slice(0, 500)
      : [],
  };
}

function normalizeKnowledgeConversation(rawConversation = {}) {
  const now = new Date().toISOString();
  return {
    id: cleanText(rawConversation.id, crypto.randomUUID(), 80),
    title: cleanText(rawConversation.title, "New chat", 120),
    summary: cleanText(rawConversation.summary, "", 1800),
    createdBy: cleanText(rawConversation.createdBy, "", 120),
    createdAt: cleanText(rawConversation.createdAt, now, 40),
    updatedAt: cleanText(rawConversation.updatedAt, rawConversation.createdAt || now, 40),
  };
}

function normalizeKnowledgeEntry(rawEntry = {}) {
  return {
    id: cleanText(rawEntry.id, crypto.randomUUID(), 80),
    category: cleanText(rawEntry.category, "General", 200),
    question: cleanText(rawEntry.question, "", 500),
    answer: cleanText(rawEntry.answer, "", 8000),
    link: cleanText(rawEntry.link, "", 1000),
    sourceDoc: cleanText(rawEntry.sourceDoc || rawEntry.source_doc, "", 300),
    sourcePage: rawEntry.sourcePage || rawEntry.source_page || null,
    questionSource: cleanText(rawEntry.questionSource || rawEntry.question_source, "original", 40),
    sortOrder: cleanPositiveInteger(rawEntry.sortOrder || rawEntry.sort_order, 1),
    embedding: Array.isArray(rawEntry.embedding) ? rawEntry.embedding.map(Number).filter(Number.isFinite) : null,
    createdAt: cleanText(rawEntry.createdAt, new Date().toISOString(), 40),
  };
}

function normalizeKnowledgeUpload(rawUpload = {}) {
  return {
    id: cleanText(rawUpload.id, crypto.randomUUID(), 80),
    fileName: cleanText(rawUpload.fileName, "knowledge-base", 300),
    fileType: cleanText(rawUpload.fileType, "text", 20),
    rowCount: cleanPositiveInteger(rawUpload.rowCount, 0),
    uploadedBy: cleanText(rawUpload.uploadedBy, "", 120),
    uploadedAt: cleanText(rawUpload.uploadedAt, new Date().toISOString(), 40),
  };
}

function normalizeKnowledgeTurn(rawTurn = {}, fallbackConversationId = "default") {
  return {
    id: cleanText(rawTurn.id, crypto.randomUUID(), 80),
    conversationId: cleanText(rawTurn.conversationId, fallbackConversationId, 80),
    userName: cleanText(rawTurn.userName, "", 120),
    userMessage: cleanText(rawTurn.userMessage, "", 4000),
    assistantResponse: cleanText(rawTurn.assistantResponse, "", 12000),
    grounded: Boolean(rawTurn.grounded),
    error: cleanText(rawTurn.error, "", 1000),
    citations: Array.isArray(rawTurn.citations) ? rawTurn.citations : [],
    retrievedEntryIds: Array.isArray(rawTurn.retrievedEntryIds) ? rawTurn.retrievedEntryIds.map(String) : [],
    userMessageEmbedding: Array.isArray(rawTurn.userMessageEmbedding)
      ? rawTurn.userMessageEmbedding.map(Number).filter(Number.isFinite)
      : null,
    traceEvents: Array.isArray(rawTurn.traceEvents) ? rawTurn.traceEvents : [],
    feedbackRating: Number(rawTurn.feedbackRating) || 0,
    createdAt: cleanText(rawTurn.createdAt, new Date().toISOString(), 40),
    durationMs: cleanPositiveInteger(rawTurn.durationMs, 0),
    chatModel: cleanText(rawTurn.chatModel, KNOWLEDGE_EXPERT_CHAT_MODEL, 140),
    embedModel: cleanText(rawTurn.embedModel, KNOWLEDGE_EXPERT_EMBED_MODEL, 140),
  };
}

function knowledgeConversationTitle(message) {
  const text = cleanText(message, "New chat", 90).replace(/\s+/g, " ").trim();
  if (text.length <= 46) {
    return text || "New chat";
  }
  return `${text.slice(0, 43).trim()}...`;
}

function activeKnowledgeConversation(store, requestedConversationId = "") {
  const requestedId = cleanText(requestedConversationId, "", 80);
  const found = requestedId ? store.conversations.find((conversation) => conversation.id === requestedId) : null;
  if (found) {
    return found;
  }
  if (store.conversations.length) {
    return [...store.conversations].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  }
  return normalizeKnowledgeConversation({
    id: "default",
    title: "Knowledge chat",
  });
}

function knowledgeConversationTurns(store, conversationId, limit = 30) {
  return store.turns.filter((turn) => turn.conversationId === conversationId).slice(0, limit);
}

async function knowledgeExpertSnapshot(conversationId = "") {
  const store = await loadKnowledgeExpertStore();
  const conversation = activeKnowledgeConversation(store, conversationId);
  return {
    entries: store.entries.map(({ embedding, answer, ...entry }) => ({
      ...entry,
      answerPreview: answer.slice(0, 320),
      hasEmbedding: Array.isArray(embedding) && embedding.length > 0,
    })),
    uploads: store.uploads,
    conversations: store.conversations.length ? store.conversations : [conversation],
    activeConversationId: conversation.id,
    turns: knowledgeConversationTurns(store, conversation.id, 30),
    models: {
      chat: KNOWLEDGE_EXPERT_CHAT_MODEL,
      embed: KNOWLEDGE_EXPERT_EMBED_MODEL,
    },
  };
}

async function createKnowledgeConversation(payload = {}, userName = "") {
  const store = await loadKnowledgeExpertStore();
  const now = new Date().toISOString();
  const conversation = normalizeKnowledgeConversation({
    id: crypto.randomUUID(),
    title: cleanText(payload.title, "New chat", 120),
    createdBy: userName,
    createdAt: now,
    updatedAt: now,
  });
  await saveKnowledgeExpertStore({
    ...store,
    conversations: [conversation, ...store.conversations].slice(0, 100),
  });
  return { conversation };
}

async function updateKnowledgeConversation(payload = {}, userName = "") {
  const conversationId = cleanText(payload.conversationId, "", 80);
  const title = cleanText(payload.title, "", 120);
  if (!conversationId || !title) {
    throw new Error("Choose a conversation and enter a title.");
  }
  const store = await loadKnowledgeExpertStore();
  const conversations = store.conversations.map((conversation) =>
    conversation.id === conversationId
      ? { ...conversation, title, updatedAt: new Date().toISOString(), createdBy: conversation.createdBy || userName }
      : conversation,
  );
  if (!conversations.some((conversation) => conversation.id === conversationId)) {
    throw new Error("Conversation not found.");
  }
  await saveKnowledgeExpertStore({ ...store, conversations });
  return { conversation: conversations.find((conversation) => conversation.id === conversationId) };
}

async function clearKnowledgeConversation(payload = {}) {
  const conversationId = cleanText(payload.conversationId, "", 80);
  if (!conversationId) {
    throw new Error("Choose a conversation to clear.");
  }
  const store = await loadKnowledgeExpertStore();
  const now = new Date().toISOString();
  const conversations = store.conversations.map((conversation) =>
    conversation.id === conversationId ? { ...conversation, summary: "", updatedAt: now } : conversation,
  );
  await saveKnowledgeExpertStore({
    ...store,
    conversations,
    turns: store.turns.filter((turn) => turn.conversationId !== conversationId),
  });
  return { ok: true };
}

async function deleteKnowledgeConversation(payload = {}) {
  const conversationId = cleanText(payload.conversationId, "", 80);
  if (!conversationId) {
    throw new Error("Choose a conversation to delete.");
  }
  const store = await loadKnowledgeExpertStore();
  const conversations = store.conversations.filter((conversation) => conversation.id !== conversationId);
  await saveKnowledgeExpertStore({
    ...store,
    conversations,
    turns: store.turns.filter((turn) => turn.conversationId !== conversationId),
  });
  return { ok: true, activeConversationId: conversations[0]?.id || "" };
}

async function replaceKnowledgeExpertDataset(payload = {}, userName = "") {
  const mode = payload.mode === "append" ? "append" : "replace";
  const incomingFiles = knowledgeExpertPayloadFiles(payload);
  const parsedFiles = await Promise.all(incomingFiles.map(parseKnowledgeExpertFile));
  const entries = parsedFiles.flatMap((file) => file.entries);
  const polishedEntries = await synthesizeKnowledgeQuestions(entries);
  const texts = polishedEntries.map((entry) => knowledgeExpertEmbeddingText(entry));
  const embeddings = await embedKnowledgeTexts(texts);
  const now = new Date().toISOString();
  const store = await loadKnowledgeExpertStore();
  const existingCount = mode === "append" ? store.entries.length : 0;
  const normalizedEntries = polishedEntries.map((entry, index) =>
    normalizeKnowledgeEntry({
      ...entry,
      id: crypto.randomUUID(),
      sortOrder: existingCount + index + 1,
      embedding: embeddings[index] || null,
      createdAt: now,
    }),
  );
  const uploadFileName = parsedFiles.length === 1
    ? parsedFiles[0].fileName
    : `${parsedFiles.length} files`;
  const uploadFileType = parsedFiles.length === 1
    ? parsedFiles[0].fileType
    : "mixed";
  const upload = normalizeKnowledgeUpload({
    id: crypto.randomUUID(),
    fileName: uploadFileName,
    fileType: uploadFileType,
    rowCount: normalizedEntries.length,
    uploadedBy: userName,
    uploadedAt: now,
  });
  const nextStore = {
    entries: mode === "append" ? [...store.entries, ...normalizedEntries] : normalizedEntries,
    uploads: [upload, ...store.uploads].slice(0, 20),
    conversations: store.conversations,
    turns: store.turns,
  };
  await saveKnowledgeExpertStore(nextStore);

  return {
    mode,
    upload,
    fileCount: parsedFiles.length,
    addedEntryCount: normalizedEntries.length,
    entryCount: nextStore.entries.length,
    embeddedCount: normalizedEntries.filter((entry) => Array.isArray(entry.embedding)).length,
    entries: nextStore.entries.map(({ embedding, answer, ...entry }) => ({
      ...entry,
      answerPreview: answer.slice(0, 320),
      hasEmbedding: Array.isArray(embedding),
    })),
  };
}

async function parseKnowledgeExpertFile(filePayload = {}) {
  const fileName = cleanText(filePayload.fileName, "knowledge-base.txt", 300);
  const fileType = knowledgeExpertFileType(fileName);
  const fileBuffer = knowledgeExpertPayloadBuffer(filePayload);
  const rawText = await knowledgeExpertPayloadText(filePayload, fileType, fileBuffer);
  return {
    fileName,
    fileType,
    entries: parseKnowledgeExpertEntries(rawText, fileName, fileType),
  };
}

function knowledgeExpertPayloadFiles(payload = {}) {
  const files = Array.isArray(payload.files) && payload.files.length
    ? payload.files
    : [{ fileName: payload.fileName, base64: payload.base64, text: payload.text }];
  if (!files.length || files.length > 20) {
    throw new Error("Choose between 1 and 20 knowledge-base files.");
  }
  return files;
}

function knowledgeExpertFileType(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".docx") {
    return "docx";
  }
  if ([".csv"].includes(ext)) {
    return "csv";
  }
  if ([".html", ".htm"].includes(ext)) {
    return "html";
  }
  if ([".json"].includes(ext)) {
    return "json";
  }
  if ([".md", ".markdown"].includes(ext)) {
    return "markdown";
  }
  return "text";
}

function knowledgeExpertPayloadBuffer(payload = {}) {
  if (typeof payload.text === "string") {
    return Buffer.from(payload.text, "utf8");
  }
  const compactBase64 = String(payload.base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!compactBase64) {
    throw new Error("Choose a knowledge-base file first.");
  }
  const buffer = Buffer.from(compactBase64, "base64");
  if (buffer.length > KNOWLEDGE_EXPERT_MAX_FILE_BYTES) {
    throw new Error("Knowledge base files must be 5 MB or smaller.");
  }
  return buffer;
}

async function knowledgeExpertPayloadText(payload, fileType, fileBuffer = null) {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  const buffer = fileBuffer || knowledgeExpertPayloadBuffer(payload);
  if (fileType === "pdf") {
    return extractKnowledgePdfText(buffer);
  }
  if (fileType === "docx") {
    return extractKnowledgeDocxText(buffer);
  }
  if (fileType === "text" && hasPdfHeader(buffer)) {
    throw new Error("PDF parsing is not in this MVP yet. Upload CSV, HTML, TXT, Markdown, or JSON.");
  }
  return buffer.toString("utf8");
}

async function extractKnowledgePdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractKnowledgeDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
}

function parseKnowledgeExpertEntries(rawText, fileName, fileType) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("The knowledge base file is empty.");
  }

  let entries;
  if (fileType === "csv") {
    entries = parseKnowledgeCsv(text, fileName);
  } else if (fileType === "html") {
    entries = parseKnowledgeHtml(text, fileName);
  } else if (fileType === "json") {
    entries = parseKnowledgeJson(text, fileName);
  } else {
    entries = parseKnowledgeText(text, fileName);
  }

  const validEntries = entries
    .map((entry, index) =>
      normalizeKnowledgeEntry({
        ...entry,
        sortOrder: index + 1,
        sourceDoc: entry.sourceDoc || fileName,
      }),
    )
    .filter((entry) => entry.question && entry.answer);

  if (!validEntries.length) {
    throw new Error("No usable knowledge entries were found.");
  }
  return validEntries.slice(0, 1000);
}

function parseKnowledgeCsv(csv, fileName) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) {
    throw new Error("CSV needs a header row and at least one data row.");
  }
  const headers = rows[0].map((header) => String(header || "").trim().toLowerCase());
  const findHeader = (aliases) => aliases.map((alias) => headers.indexOf(alias)).find((index) => index >= 0) ?? -1;
  const categoryIndex = findHeader(["category", "cat"]);
  const questionIndex = findHeader(["question", "q"]);
  const answerIndex = findHeader(["answer", "a", "text"]);
  const linkIndex = findHeader(["link", "url", "resource"]);
  if (questionIndex === -1) {
    throw new Error("CSV needs a question column.");
  }
  return rows.slice(1).map((row) => ({
    category: categoryIndex >= 0 ? row[categoryIndex] : "General",
    question: row[questionIndex],
    answer: answerIndex >= 0 ? row[answerIndex] : "",
    link: linkIndex >= 0 ? row[linkIndex] : "",
    sourceDoc: fileName,
    questionSource: "original",
  }));
}

function parseKnowledgeJson(text, fileName) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
  if (!rows.length) {
    throw new Error("JSON must be an array or an object with an entries array.");
  }
  return rows.map((row) => ({
    category: row.category || "General",
    question: row.question || row.q || row.title || "",
    answer: row.answer || row.a || row.text || "",
    link: row.link || row.url || "",
    sourceDoc: fileName,
    questionSource: row.question || row.q ? "original" : "heuristic",
  }));
}

function parseKnowledgeHtml(html, fileName) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(h[1-4])[^>]*>/gi, "\n\n## ")
    .replace(/<\/h[1-4]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|tr|div|section|article)>/gi, "\n")
    .replace(/<a\s+[^>]*href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi, "$3 ($2)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  return parseKnowledgeText(stripped, fileName);
}

function parseKnowledgeText(text, fileName) {
  const blocks = String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const entries = [];
  let currentHeading = "General";

  for (const block of blocks) {
    const heading = block.replace(/^#+\s*/, "").trim();
    if (/^#+\s+/.test(block) || (block.length <= 120 && !/[.!?]\s/.test(block) && !block.includes(":"))) {
      currentHeading = heading || currentHeading;
      continue;
    }

    const qaMatch = block.match(/^(?:q(?:uestion)?[:.)]\s*)([\s\S]*?)(?:\n|$)(?:a(?:nswer)?[:.)]\s*)([\s\S]*)$/i);
    if (qaMatch) {
      entries.push({
        category: currentHeading,
        question: qaMatch[1].trim(),
        answer: qaMatch[2].trim(),
        sourceDoc: fileName,
        questionSource: "extracted",
      });
      continue;
    }

    const [firstLine, ...rest] = block.split("\n");
    const question = firstLine.endsWith("?") || firstLine.length <= 140 ? firstLine : firstSentence(firstLine);
    const answer = rest.length ? rest.join("\n").trim() : block;
    entries.push({
      category: currentHeading,
      question,
      answer,
      sourceDoc: fileName,
      questionSource: "heuristic",
    });
  }

  return entries;
}

function firstSentence(text) {
  const match = String(text || "").match(/^(.{20,180}?[.!?])\s/);
  return (match ? match[1] : String(text || "").slice(0, 140)).trim();
}

function knowledgeExpertEmbeddingText(entry) {
  return `${entry.category}\n${entry.question}\n${entry.answer}`;
}

async function embedKnowledgeTexts(texts) {
  if (!String(process.env.OPENAI_API_KEY || "").trim()) {
    return texts.map(() => null);
  }
  const payload = await fetchJson("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiModelKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: KNOWLEDGE_EXPERT_EMBED_MODEL,
      input: texts.map((text) => text.slice(0, 12000)),
    }),
  });
  const byIndex = new Map((payload.data || []).map((item) => [item.index, item.embedding]));
  return texts.map((_, index) => byIndex.get(index) || null);
}

async function synthesizeKnowledgeQuestions(entries) {
  if (KNOWLEDGE_EXPERT_SYNTHESIZE_QUESTIONS === "never" || !String(process.env.ANTHROPIC_API_KEY || "").trim()) {
    return entries;
  }
  const shouldSynthesize = (entry) =>
    KNOWLEDGE_EXPERT_SYNTHESIZE_QUESTIONS === "always" ||
    (KNOWLEDGE_EXPERT_SYNTHESIZE_QUESTIONS === "auto" && entry.questionSource === "heuristic");

  return Promise.all(
    entries.map(async (entry) => {
      if (!shouldSynthesize(entry)) {
        return entry;
      }
      try {
        const question = await fetchKnowledgeAnthropicMessage({
          system: [
            "Given a passage from a knowledge base, output one short natural-language question.",
            "Use 12 words or fewer.",
            "Return only the question. No preamble, no quotes, no answer.",
          ].join(" "),
          user: String(entry.answer || "").slice(0, 900),
          maxTokens: 40,
        });
        const cleanQuestion = question.replace(/^["']|["']$/g, "").trim();
        return cleanQuestion ? { ...entry, question: cleanQuestion, questionSource: "synthesized" } : entry;
      } catch {
        return entry;
      }
    }),
  );
}

async function chatWithKnowledgeExpert(payload = {}, userName = "", options = {}) {
  const startedAt = Date.now();
  const trace = [];
  const addTrace = (type, summary, metadata = {}) => {
    const event = { seq: trace.length + 1, type, summary, tsMsOffset: Date.now() - startedAt, metadata };
    trace.push(event);
    if (typeof options.onTrace === "function") {
      options.onTrace(event);
    }
  };
  const userMessage = cleanText(payload.message, "", 4000);
  if (!userMessage) {
    throw new Error("Ask a question first.");
  }

  const store = await loadKnowledgeExpertStore();
  const conversation = activeKnowledgeConversation(store, payload.conversationId);
  const recentTurns = knowledgeConversationTurns(store, conversation.id, 8).reverse();
  if (!store.entries.length) {
    addTrace("empty_kb", "No knowledge entries are available.");
    return persistKnowledgeTurn(store, {
      startedAt,
      conversationId: conversation.id,
      userName,
      userMessage,
      assistantResponse: KNOWLEDGE_EXPERT_DECLINE,
      grounded: false,
      citations: [],
      retrievedEntryIds: [],
      traceEvents: trace,
    });
  }

  const rewrite = await rewriteKnowledgeQuery(userMessage, payload.history || recentTurns, conversation.summary);
  addTrace("rewrite_query", rewrite.mode === "rewritten" ? "Rewrote follow-up query for retrieval." : "Using original query for retrieval.", rewrite);
  addTrace("embed_query", "Prepared search query.");
  const [queryEmbedding] = await embedKnowledgeTexts([rewrite.query]);
  const topK = inferKnowledgeTopK(userMessage);
  const retrieval = retrieveKnowledgeEntries(store.entries, rewrite.query, queryEmbedding, topK);
  addTrace("retrieve_kb", `Retrieved ${retrieval.entries.length} entries.`, {
    topK,
    vectorHits: retrieval.vectorHits,
    keywordHits: retrieval.keywordHits,
  });

  if (!retrieval.entries.length) {
    addTrace("decline", "No matching entries found.");
    const conversationSummary = await summarizeKnowledgeConversation(conversation, recentTurns, userMessage, KNOWLEDGE_EXPERT_DECLINE);
    addTrace("summarize_memory", conversationSummary.changed ? "Updated conversation summary." : "Kept existing conversation summary.");
    return persistKnowledgeTurn(store, {
      startedAt,
      conversationId: conversation.id,
      conversationSummary: conversationSummary.summary,
      userName,
      userMessage,
      assistantResponse: KNOWLEDGE_EXPERT_DECLINE,
      grounded: false,
      citations: [],
      retrievedEntryIds: [],
      traceEvents: trace,
    });
  }

  const context = retrieval.entries.map(formatKnowledgeContextEntry).join("\n\n");
  const conversationMemory = formatKnowledgeConversationMemory(conversation.summary, recentTurns);
  const system = [
    "You are Knowledge Expert, a citation-enforced Q&A assistant.",
    "Use only the provided knowledge base entries.",
    "Conversation memory may only clarify references in the latest question; never use it as a factual source.",
    `If the entries do not answer the question, reply exactly: ${KNOWLEDGE_EXPERT_DECLINE}`,
    "Every grounded answer must end with one trailing citation block like [cite:uuid1,uuid2].",
    "Only cite IDs that appear in the provided entries.",
    "For list or count questions, include every relevant retrieved entry and state the actual count.",
  ].join(" ");
  const user = `CONVERSATION MEMORY (not a source of truth):\n\n${conversationMemory}\n\nKNOWLEDGE BASE ENTRIES:\n\n${context}\n\nUSER QUESTION:\n${userMessage}`;
  addTrace("llm_call", "Asked Claude to answer from retrieved entries.");
  const rawAnswer = await fetchKnowledgeAnthropicMessage({ system, user, maxTokens: 1600 });
  const parsed = parseKnowledgeCitations(rawAnswer, new Set(retrieval.entries.map((entry) => entry.id)));
  const grounded = parsed.citations.length > 0 && !parsed.text.includes(KNOWLEDGE_EXPERT_DECLINE);
  const assistantResponse = grounded ? parsed.text : KNOWLEDGE_EXPERT_DECLINE;
  const citations = parsed.citations.map((id) => citationForKnowledgeEntry(retrieval.entries.find((entry) => entry.id === id))).filter(Boolean);
  addTrace("parse_citations", grounded ? `Validated ${citations.length} citation(s).` : "No valid citation found.");
  if (typeof options.onTextDelta === "function") {
    await emitKnowledgeTextDeltas(assistantResponse, options.onTextDelta);
  }
  const conversationSummary = await summarizeKnowledgeConversation(conversation, recentTurns, userMessage, assistantResponse);
  addTrace("summarize_memory", conversationSummary.changed ? "Updated conversation summary." : "Kept existing conversation summary.");

  return persistKnowledgeTurn(store, {
    startedAt,
    conversationId: conversation.id,
    conversationSummary: conversationSummary.summary,
    userName,
    userMessage,
    assistantResponse,
    grounded,
    citations,
    retrievedEntryIds: retrieval.entries.map((entry) => entry.id),
    userMessageEmbedding: queryEmbedding,
    traceEvents: trace,
  });
}

function formatKnowledgeConversationMemory(summary = "", recentTurns = []) {
  const recent = recentTurns
    .slice(-8)
    .map((turn) => `User: ${cleanText(turn.userMessage, "", 500)}\nAssistant: ${cleanText(turn.assistantResponse, "", 700)}`)
    .join("\n\n");
  return [
    summary ? `Summary:\n${summary}` : "Summary:\nNone yet.",
    recent ? `Recent turns:\n${recent}` : "Recent turns:\nNone yet.",
  ].join("\n\n");
}

async function rewriteKnowledgeQuery(userMessage, history = [], summary = "") {
  if (!KNOWLEDGE_EXPERT_QUERY_REWRITE_ENABLED) {
    return { mode: "disabled", query: userMessage };
  }
  const text = String(userMessage || "").trim();
  const selfContained = text.split(/\s+/).length >= 8 && !/^(and|also|what about|how about|that|those|them|it|this)\b/i.test(text);
  if (!Array.isArray(history) || !history.length || selfContained) {
    return { mode: selfContained ? "passthrough_self_contained" : "passthrough_first_turn", query: userMessage };
  }
  try {
    const recent = history.slice(-6).map((turn) => ({
      user: cleanText(turn.userMessage || turn.user || "", "", 500),
      assistant: cleanText(turn.assistantResponse || turn.assistant || "", "", 700),
    }));
    const query = await fetchKnowledgeAnthropicMessage({
      system: "Rewrite the user's latest message into one self-contained search query using the prior turns. Return only the query.",
      user: JSON.stringify({ summary, recent, latest: userMessage }),
      maxTokens: 80,
    });
    return { mode: "rewritten", query: query.trim() || userMessage };
  } catch (error) {
    return { mode: "fallback_error", query: userMessage, error: error.message || "rewrite failed" };
  }
}

async function summarizeKnowledgeConversation(conversation, recentTurns, userMessage, assistantResponse) {
  const previousSummary = cleanText(conversation.summary, "", 1800);
  if (!String(process.env.ANTHROPIC_API_KEY || "").trim()) {
    return { summary: previousSummary, changed: false };
  }
  try {
    const recent = recentTurns.slice(-8).map((turn) => ({
      user: cleanText(turn.userMessage, "", 500),
      assistant: cleanText(turn.assistantResponse, "", 700),
    }));
    const summary = await fetchKnowledgeAnthropicMessage({
      system: [
        "Maintain a concise running summary of this Knowledge Expert conversation.",
        "Capture user goals, named entities, decisions, and references needed to understand follow-up questions.",
        "Do not add facts from the knowledge base unless the user explicitly discussed them.",
        "Use 120 words or fewer. Return only the summary.",
      ].join(" "),
      user: JSON.stringify({
        previousSummary,
        recent,
        latest: {
          user: cleanText(userMessage, "", 900),
          assistant: cleanText(assistantResponse, "", 1200),
        },
      }),
      maxTokens: 220,
    });
    const cleanSummary = cleanText(summary, previousSummary, 1800);
    return { summary: cleanSummary, changed: cleanSummary !== previousSummary };
  } catch {
    return { summary: previousSummary, changed: false };
  }
}

async function emitKnowledgeTextDeltas(text, onTextDelta) {
  const chunks = String(text || "").match(/[\s\S]{1,80}/g) || [""];
  for (const chunk of chunks) {
    onTextDelta(chunk);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

async function fetchKnowledgeAnthropicMessage({ system, user, maxTokens }) {
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": anthropicModelKey(),
    },
    body: JSON.stringify({
      model: KNOWLEDGE_EXPERT_CHAT_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const text = extractAnthropicText(payload).trim();
  if (!text) {
    throw new Error("Anthropic returned an empty Knowledge Expert response.");
  }
  return text;
}

function inferKnowledgeTopK(query) {
  const text = String(query || "").toLowerCase();
  const numberMatch = text.match(/\b(?:list|show|give me|tell me)?\s*(\d{1,2})\b/);
  const requested = numberMatch ? Number(numberMatch[1]) + 3 : 0;
  const enumerative = /\b(how many|what are|list of|tell me all|give me all|all|list|every|each|many)\b/.test(text);
  return Math.min(25, Math.max(KNOWLEDGE_EXPERT_TOP_K, requested, enumerative ? KNOWLEDGE_EXPERT_ENUMERATIVE_TOP_K : 0));
}

function retrieveKnowledgeEntries(entries, query, queryEmbedding, topK) {
  const scoredVector = Array.isArray(queryEmbedding)
    ? entries
        .filter((entry) => Array.isArray(entry.embedding) && entry.embedding.length === queryEmbedding.length)
        .map((entry) => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, topK)
    : [];
  const keywordTokens = meaningfulTokens(query).slice(0, 5);
  const keywordHits = entries
    .map((entry) => ({ entry, score: keywordScore(entry, keywordTokens) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.sortOrder - right.entry.sortOrder)
    .slice(0, topK);
  const seen = new Set();
  const merged = [];
  for (const item of [...scoredVector, ...keywordHits]) {
    if (!seen.has(item.entry.id)) {
      seen.add(item.entry.id);
      merged.push(item.entry);
    }
  }
  return {
    entries: merged.slice(0, Math.max(topK, KNOWLEDGE_EXPERT_TOP_K)),
    vectorHits: scoredVector.length,
    keywordHits: keywordHits.length,
  };
}

function meaningfulTokens(text) {
  const stopwords = new Set(["the", "and", "for", "with", "that", "this", "what", "how", "are", "can", "you", "about", "from", "into", "all"]);
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function keywordScore(entry, tokens) {
  if (!tokens.length) {
    return 0;
  }
  const haystack = `${entry.category} ${entry.question} ${entry.answer}`.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function formatKnowledgeContextEntry(entry) {
  return [
    `ID: ${entry.id}`,
    `Category: ${entry.category}`,
    `Question: ${entry.question}`,
    `Answer: ${entry.answer}`,
    entry.link ? `Link: ${entry.link}` : "",
    entry.sourceDoc ? `Source: ${entry.sourceDoc}${entry.sourcePage ? ` page ${entry.sourcePage}` : ""}` : "",
  ].filter(Boolean).join("\n");
}

function parseKnowledgeCitations(answer, allowedIds) {
  const citeMatch = String(answer || "").match(/\[cite:\s*([0-9a-fA-F,\-\s]+)\]\s*$/);
  const text = String(answer || "").replace(/\s*\[cite:\s*([0-9a-fA-F,\-\s]+)\]\s*$/, "").trim();
  const citations = citeMatch
    ? citeMatch[1].split(",").map((id) => id.trim()).filter((id) => allowedIds.has(id))
    : [];
  return { text, citations: Array.from(new Set(citations)) };
}

function citationForKnowledgeEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    id: entry.id,
    label: entry.question,
    category: entry.category,
    link: entry.link,
    sourceDoc: entry.sourceDoc,
    sourcePage: entry.sourcePage,
  };
}

async function persistKnowledgeTurn(store, turnInput) {
  const durationMs = Date.now() - turnInput.startedAt;
  const conversationId = cleanText(turnInput.conversationId, activeKnowledgeConversation(store).id, 80);
  const turn = normalizeKnowledgeTurn({
    id: crypto.randomUUID(),
    conversationId,
    userName: turnInput.userName,
    userMessage: turnInput.userMessage,
    assistantResponse: turnInput.assistantResponse,
    grounded: turnInput.grounded,
    error: turnInput.error || "",
    citations: turnInput.citations,
    retrievedEntryIds: turnInput.retrievedEntryIds,
    traceEvents: [
      ...(turnInput.traceEvents || []),
      { seq: (turnInput.traceEvents || []).length + 1, type: "done", summary: "Knowledge Expert turn completed.", tsMsOffset: durationMs, metadata: {} },
    ],
    createdAt: new Date().toISOString(),
    durationMs,
    chatModel: KNOWLEDGE_EXPERT_CHAT_MODEL,
    embedModel: KNOWLEDGE_EXPERT_EMBED_MODEL,
  });
  const now = new Date().toISOString();
  const hasConversation = store.conversations.some((conversation) => conversation.id === conversationId);
  const conversations = (hasConversation
    ? store.conversations
    : [
        normalizeKnowledgeConversation({
          id: conversationId,
          title: knowledgeConversationTitle(turnInput.userMessage),
          createdBy: turnInput.userName,
          createdAt: now,
        }),
        ...store.conversations,
      ]
  ).map((conversation) => {
    if (conversation.id !== conversationId) {
      return conversation;
    }
    const shouldRetitle = !conversation.title || conversation.title === "New chat" || conversation.title === "Knowledge chat";
    return {
      ...conversation,
      title: shouldRetitle ? knowledgeConversationTitle(turnInput.userMessage) : conversation.title,
      summary: cleanText(turnInput.conversationSummary, conversation.summary, 1800),
      updatedAt: now,
    };
  });
  await saveKnowledgeExpertStore({
    entries: store.entries,
    uploads: store.uploads,
    conversations,
    turns: [turn, ...store.turns].slice(0, 500),
  });
  return turn;
}

async function persistKnowledgeErrorTurn(userMessage, userName, error, conversationId = "") {
  const store = await loadKnowledgeExpertStore();
  const conversation = activeKnowledgeConversation(store, conversationId);
  const startedAt = Date.now();
  return persistKnowledgeTurn(store, {
    startedAt,
    conversationId: conversation.id,
    userName,
    userMessage,
    assistantResponse: KNOWLEDGE_EXPERT_DECLINE,
    grounded: false,
    citations: [],
    retrievedEntryIds: [],
    traceEvents: [{ seq: 1, type: "error", summary: error.message || "Knowledge Expert error", tsMsOffset: 0, metadata: {} }],
    error: error.message || "Knowledge Expert error",
  });
}

async function rateKnowledgeExpertTurn(payload = {}, userName = "") {
  const traceId = String(payload.traceId || payload.id || "").trim();
  const rating = Math.max(-1, Math.min(1, Number(payload.rating) || 0));
  if (!traceId) {
    throw new Error("Choose a Knowledge Expert answer to rate.");
  }
  const store = await loadKnowledgeExpertStore();
  const turnIndex = store.turns.findIndex((turn) => turn.id === traceId);
  if (turnIndex === -1) {
    throw new Error("Knowledge Expert answer not found.");
  }
  if (store.turns[turnIndex].userName && userName && store.turns[turnIndex].userName !== userName) {
    throw new Error("You can only rate your own Knowledge Expert answers.");
  }
  store.turns[turnIndex] = {
    ...store.turns[turnIndex],
    feedbackRating: rating,
    feedbackAt: new Date().toISOString(),
  };
  await saveKnowledgeExpertStore(store);
  return { turn: store.turns[turnIndex] };
}

async function knowledgeExpertConversationsReport() {
  const store = await loadKnowledgeExpertStore();
  return {
    turns: store.turns.slice(0, 200),
    totals: {
      turns: store.turns.length,
      grounded: store.turns.filter((turn) => turn.grounded).length,
      declined: store.turns.filter((turn) => !turn.grounded && !turn.error).length,
      errors: store.turns.filter((turn) => turn.error).length,
    },
  };
}

async function knowledgeExpertErrorsReport() {
  const store = await loadKnowledgeExpertStore();
  return {
    turns: store.turns.filter((turn) => turn.error || (turn.traceEvents || []).some((event) => event.type === "error")).slice(0, 200),
  };
}

async function knowledgeExpertDeadEntriesReport() {
  const store = await loadKnowledgeExpertStore();
  const retrieved = new Set(store.turns.flatMap((turn) => turn.retrievedEntryIds || []));
  const cited = new Set(store.turns.flatMap((turn) => (turn.citations || []).map((citation) => citation.id)));
  return {
    entries: store.entries
      .map(({ embedding, answer, ...entry }) => ({
        ...entry,
        answerPreview: answer.slice(0, 280),
        retrieved: retrieved.has(entry.id),
        cited: cited.has(entry.id),
      }))
      .filter((entry) => !entry.retrieved || !entry.cited),
  };
}

async function knowledgeExpertGapsReport() {
  const store = await loadKnowledgeExpertStore();
  const declinedTurns = store.turns.filter((turn) => !turn.grounded && !turn.error && turn.userMessage).slice(0, 300);
  const clusters = [];
  for (const turn of declinedTurns) {
    const tokens = new Set(meaningfulTokens(turn.userMessage));
    let bestCluster = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = jaccardSimilarity(tokens, cluster.tokens);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }
    if (bestCluster && bestScore >= 0.35) {
      bestCluster.turns.push(turn);
      for (const token of tokens) {
        bestCluster.tokens.add(token);
      }
    } else {
      clusters.push({ id: crypto.randomUUID(), tokens, turns: [turn] });
    }
  }
  return {
    clusters: clusters
      .map((cluster) => ({
        id: cluster.id,
        memberCount: cluster.turns.length,
        centroidQuestion: cluster.turns[0].userMessage,
        examples: cluster.turns.slice(0, 5),
      }))
      .sort((left, right) => right.memberCount - left.memberCount),
  };
}

function jaccardSimilarity(left, right) {
  if (!left.size || !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizePerformanceInsight(rawInsight = {}) {
  const toolId = cleanText(rawInsight.toolId || rawInsight.tool || "", "", 24);
  if (!["padelog", "betlog"].includes(toolId)) {
    throw new Error("Performance insight tool must be padelog or betlog");
  }

  const insight = cleanText(rawInsight.insight, "", 20000);
  if (!insight) {
    throw new Error("Performance insight is empty.");
  }
  if (isModelOnlyInsight(insight)) {
    throw new Error("Performance insight only contains model metadata.");
  }

  return {
    id: cleanText(rawInsight.id, crypto.randomUUID(), 80),
    toolId,
    model: cleanText(rawInsight.model, ANTHROPIC_ANALYSIS_MODEL, 120),
    generatedAt: cleanText(rawInsight.generatedAt, new Date().toISOString(), 40),
    sourceRecordCount: cleanUsageNumber(rawInsight.sourceRecordCount),
    insight,
  };
}

function isModelOnlyInsight(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return /^model\s*:\s*claude[\w.-]*\s*$/.test(normalized);
}

async function loadPerformanceInsights() {
  const parsed = await loadJsonStore(DATA_STORES.performanceInsights, PERFORMANCE_INSIGHTS_PATH, { insights: [] });
  const insights = Array.isArray(parsed?.insights) ? parsed.insights : Array.isArray(parsed) ? parsed : [];
  return sortPerformanceInsights(insights.map(normalizePerformanceInsight));
}

async function savePerformanceInsights(insights) {
  await saveJsonStore(DATA_STORES.performanceInsights, { insights: sortPerformanceInsights(insights) });
}

function sortPerformanceInsights(insights) {
  return [...insights].sort((left, right) => String(right.generatedAt || "").localeCompare(String(left.generatedAt || "")));
}

async function performanceInsightsForTool(toolId) {
  const normalizedToolId = String(toolId || "").trim();
  if (!["padelog", "betlog"].includes(normalizedToolId)) {
    throw new Error("Choose Padelog or Betlog");
  }

  const insights = await loadPerformanceInsights();
  return insights.filter((insight) => insight.toolId === normalizedToolId);
}

async function savePerformanceInsight(insight) {
  const normalizedInsight = normalizePerformanceInsight(insight);
  const insights = await loadPerformanceInsights();
  await savePerformanceInsights([normalizedInsight, ...insights]);
  return normalizedInsight;
}

const DEFAULT_OLYMPIACOS_NEWS_SITES = [
  "https://www.sport-fm.gr/",
  "https://www.gazzetta.gr/",
  "https://www.sport24.gr/",
  "https://www.thrylos24.gr/",
];
const OLYMPIACOS_NEWS_TEAMS = [
  {
    id: "football",
    label: "Olympiacos FC",
    greekLabel: "Ολυμπιακός Ποδόσφαιρο",
  },
  {
    id: "basketball",
    label: "Olympiacos BC",
    greekLabel: "Ολυμπιακός Μπάσκετ",
  },
];
const OLYMPIACOS_NEWS_WINDOW_HOURS = 24;

function defaultOlympiacosNewsStore() {
  return {
    sites: DEFAULT_OLYMPIACOS_NEWS_SITES.map(normalizeOlympiacosNewsSite),
    runs: [],
  };
}

async function loadOlympiacosNewsStore() {
  const parsed = await loadJsonStore(DATA_STORES.olympiacosNews, OLYMPIACOS_NEWS_PATH, defaultOlympiacosNewsStore());
  return normalizeOlympiacosNewsStore(parsed);
}

async function saveOlympiacosNewsStore(store) {
  const normalizedStore = normalizeOlympiacosNewsStore(store);
  await saveJsonStore(DATA_STORES.olympiacosNews, normalizedStore);
  return normalizedStore;
}

function normalizeOlympiacosNewsStore(store = {}) {
  const defaultStore = defaultOlympiacosNewsStore();
  const rawSites = Array.isArray(store.sites) && store.sites.length ? store.sites : defaultStore.sites;
  const sites = uniqueOlympiacosNewsSites(rawSites.map(normalizeOlympiacosNewsSite));
  const rawRuns = Array.isArray(store.runs) ? store.runs : [];

  return {
    sites,
    runs: rawRuns.map(normalizeOlympiacosNewsRun).sort(sortOlympiacosNewsRuns).slice(0, 120),
  };
}

function uniqueOlympiacosNewsSites(sites) {
  const seen = new Set();
  return sites.filter((site) => {
    const key = site.hostname;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeOlympiacosNewsSite(rawSite) {
  const input = typeof rawSite === "string" ? { url: rawSite } : rawSite || {};
  const url = normalizeOlympiacosNewsUrl(input.url || input.href || input.hostname);
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return {
    id: cleanText(input.id, hostname, 80),
    name: cleanText(input.name, titleFromHostname(hostname), 80),
    url,
    hostname,
    enabled: input.enabled !== false,
  };
}

function normalizeOlympiacosNewsUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Website URL is required");
  }
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Website URL is not valid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Website URL must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname || "/";
  return parsed.toString();
}

function titleFromHostname(hostname) {
  return String(hostname || "News site")
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeOlympiacosNewsRun(rawRun = {}) {
  const generatedAt = cleanText(rawRun.generatedAt, new Date().toISOString(), 40);
  const window = rawRun.window || {};
  return {
    id: cleanText(rawRun.id, crypto.randomUUID(), 80),
    generatedAt,
    window: {
      hours: cleanPositiveInteger(window.hours, OLYMPIACOS_NEWS_WINDOW_HOURS),
      from: cleanText(window.from, new Date(Date.now() - OLYMPIACOS_NEWS_WINDOW_HOURS * 60 * 60 * 1000).toISOString(), 40),
      to: cleanText(window.to, generatedAt, 40),
    },
    sites: Array.isArray(rawRun.sites) ? rawRun.sites.map(normalizeOlympiacosNewsRunSite) : [],
  };
}

function normalizeOlympiacosNewsRunSite(site = {}) {
  return {
    siteId: cleanText(site.siteId, "", 80),
    name: cleanText(site.name, "News site", 80),
    url: cleanText(site.url, "", 240),
    hostname: cleanText(site.hostname, "", 120),
    teams: Object.fromEntries(
      OLYMPIACOS_NEWS_TEAMS.map((team) => {
        const rawTeam = site.teams?.[team.id] || {};
        return [
          team.id,
          {
            summary: cleanText(rawTeam.summary, "Δεν βρέθηκαν επιβεβαιωμένες ειδήσεις στο τελευταίο 24ωρο.", 1000),
            articles: Array.isArray(rawTeam.articles)
              ? rawTeam.articles.map(normalizeOlympiacosNewsArticle).slice(0, 6)
              : [],
          },
        ];
      }),
    ),
    errors: Array.isArray(site.errors) ? site.errors.map((error) => cleanText(error, "", 240)).filter(Boolean) : [],
  };
}

function normalizeOlympiacosNewsArticle(article = {}) {
  return {
    title: cleanText(article.title, "Untitled article", 240),
    url: cleanText(article.url, "", 600),
    publishedAt: cleanText(article.publishedAt, "", 40),
    snippet: cleanText(article.snippet, "", 500),
  };
}

function sortOlympiacosNewsRuns(left, right) {
  return String(right.generatedAt || "").localeCompare(String(left.generatedAt || ""));
}

async function updateOlympiacosNewsSites(payload = {}) {
  const incomingSites = Array.isArray(payload.sites) ? payload.sites : [];
  if (!incomingSites.length) {
    throw new Error("Add at least one website.");
  }
  const store = await loadOlympiacosNewsStore();
  const nextStore = {
    ...store,
    sites: uniqueOlympiacosNewsSites(incomingSites.map(normalizeOlympiacosNewsSite)),
  };
  return saveOlympiacosNewsStore(nextStore);
}

async function runOlympiacosNewsSearch() {
  const store = await loadOlympiacosNewsStore();
  const enabledSites = store.sites.filter((site) => site.enabled);
  if (!enabledSites.length) {
    throw new Error("Enable at least one website before running the search.");
  }

  const now = new Date();
  const from = new Date(now.getTime() - OLYMPIACOS_NEWS_WINDOW_HOURS * 60 * 60 * 1000);
  const sites = await openAiOlympiacosNewsForSites(enabledSites, { from, to: now });
  const run = normalizeOlympiacosNewsRun({
    id: crypto.randomUUID(),
    generatedAt: now.toISOString(),
    window: {
      hours: OLYMPIACOS_NEWS_WINDOW_HOURS,
      from: from.toISOString(),
      to: now.toISOString(),
    },
    sites,
  });
  const nextStore = await saveOlympiacosNewsStore({
    ...store,
    runs: [run, ...store.runs],
  });

  return {
    run,
    runs: nextStore.runs,
    sites: nextStore.sites,
  };
}

function openAiModelKey() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY in .env");
  }
  return apiKey;
}

async function openAiOlympiacosNewsForSites(sites, window) {
  const payload = await fetchJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiModelKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_OLYMPIACOS_NEWS_MODEL,
      reasoning: { effort: "low" },
      tools: [
        {
          type: "web_search",
          user_location: {
            type: "approximate",
            country: "GR",
            city: "Athens",
            region: "Attica",
            timezone: "Europe/Athens",
          },
        },
      ],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: olympiacosNewsOpenAiPrompt(sites, window),
    }),
  });
  const parsed = parseOpenAiOlympiacosNewsResponse(extractOpenAiResponseText(payload));
  return [
    normalizeOpenAiOlympiacosSiteResult(
      {
        id: "general-web",
        name: "General web",
        url: "https://www.google.com/search?q=Olympiacos+news",
        hostname: "general-web",
      },
      parsed.sites?.["general-web"],
    ),
    ...sites.map((site) => normalizeOpenAiOlympiacosSiteResult(site, parsed.sites?.[site.hostname])),
  ];
}

function olympiacosNewsOpenAiPrompt(sites, window) {
  return [
    "Search the web for the most recent and important Greek and international headlines about Olympiacos FC football and Olympiacos BC basketball.",
    "Start from the configured priority websites, then broaden to reliable web sources when they have more recent or important coverage.",
    `Time window: only include articles first published from ${window.from.toISOString()} through ${window.to.toISOString()}.`,
    "Create a general-web entry that synthesizes the most important headlines for each team across all reliable sources.",
    "For each configured priority website, also synthesize all relevant articles from that site for each team when available.",
    "The summary field must be a combined digest, not a per-article summary or a list of article headlines.",
    "Use the articles array for supporting source links and metadata, ordered by importance and recency.",
    "If a configured priority site has no relevant article for a team in the time window, say so in Greek.",
    "Do not include rumors unless the source page presents them as news.",
    "Return ONLY valid JSON with this exact shape:",
    '{"sites":{"general-web":{"football":{"summary":"...","articles":[{"title":"...","url":"...","publishedAt":"ISO date or empty","snippet":"..."}]},"basketball":{"summary":"...","articles":[{"title":"...","url":"...","publishedAt":"ISO date or empty","snippet":"..."}]},"errors":[]},"example.gr":{"football":{"summary":"...","articles":[{"title":"...","url":"...","publishedAt":"ISO date or empty","snippet":"..."}]},"basketball":{"summary":"...","articles":[{"title":"...","url":"...","publishedAt":"ISO date or empty","snippet":"..."}]},"errors":[]}}}',
    "Configured priority websites:",
    ...sites.map((site) => `- ${site.hostname} (${site.name})`),
  ].join("\n");
}

function extractOpenAiResponseText(payload = {}) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return "";
  }

  return payload.output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((content) => content.text || content.output_text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseOpenAiOlympiacosNewsResponse(text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("OpenAI returned no news summary text.");
  }

  try {
    return JSON.parse(cleanText);
  } catch {
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("OpenAI returned a news summary that was not valid JSON.");
  }
}

function normalizeOpenAiOlympiacosSiteResult(site, rawSite = {}) {
  return normalizeOlympiacosNewsRunSite({
    siteId: site.id,
    name: site.name,
    url: site.url,
    hostname: site.hostname,
    teams: {
      football: normalizeOpenAiOlympiacosTeam(rawSite.football),
      basketball: normalizeOpenAiOlympiacosTeam(rawSite.basketball),
    },
    errors: Array.isArray(rawSite.errors) ? rawSite.errors : [],
  });
}

function normalizeOpenAiOlympiacosTeam(rawTeam = {}) {
  return {
    summary: cleanText(rawTeam.summary, "Δεν βρέθηκαν επιβεβαιωμένες ειδήσεις στο τελευταίο 24ωρο.", 1000),
    articles: Array.isArray(rawTeam.articles)
      ? rawTeam.articles.map(normalizeOlympiacosNewsArticle).slice(0, 6)
      : [],
  };
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
  const parsed = await loadJsonStore(DATA_STORES.padelogMatches, PADELOG_MATCHES_PATH, { matches: [] });
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : Array.isArray(parsed) ? parsed : [];
  return sortPadelogMatches(matches.map(normalizePadelogMatch));
}

async function savePadelogMatches(matches) {
  await saveJsonStore(DATA_STORES.padelogMatches, { matches: sortPadelogMatches(matches) });
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
    created: normalizedMatches,
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

async function analyzePadelogPerformance() {
  const matches = await loadPadelogMatches();
  if (!matches.length) {
    throw new Error("Add at least one Padelog match before asking for AI insights.");
  }

  const system = [
    "You are a concise padel performance analyst.",
    "Use only the provided JSON data and computed summary.",
    "Look for patterns across the full record: form over time, teammates, clubs, opponents, set scores, win/loss/draw mix, and data quality.",
    "Return exactly 5 bullets and no headings.",
    "Keep each bullet under 24 words.",
    "Do not include an introduction or closing sentence.",
    "Avoid generic sports advice; tie every point to the data.",
  ].join(" ");
  const user = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: summarizePadelogPerformance(matches),
      matches,
    },
    null,
    2,
  );

  const insight = {
    id: crypto.randomUUID(),
    toolId: "padelog",
    model: ANTHROPIC_ANALYSIS_MODEL,
    generatedAt: new Date().toISOString(),
    sourceRecordCount: matches.length,
    insight: await fetchAnthropicMessage({ system, user, maxTokens: 360 }),
  };
  await savePerformanceInsight(insight);
  return insight;
}

function summarizePadelogPerformance(matches) {
  const byMonth = groupBy(matches, (match) => String(match.date || "").slice(0, 7));
  const byClub = groupBy(matches, (match) => match.club || "Unknown club");
  const byTeammate = groupBy(matches, (match) => match.teammate || "Unknown teammate");

  return {
    matches: matches.length,
    firstDate: matches[matches.length - 1]?.date || "",
    lastDate: matches[0]?.date || "",
    resultBreakdown: countBy(matches, (match) => match.result || "Unknown"),
    setScoreBreakdown: countBy(matches, (match) => match.sets || "Unknown"),
    monthly: summarizePadelogGroups(byMonth),
    clubs: summarizePadelogGroups(byClub),
    teammates: summarizePadelogGroups(byTeammate),
  };
}

function summarizePadelogGroups(groups) {
  return Array.from(groups.entries())
    .map(([label, rows]) => ({
      label,
      matches: rows.length,
      wins: rows.filter((row) => row.result === "Won").length,
      losses: rows.filter((row) => row.result === "Lost").length,
      draws: rows.filter((row) => row.result === "Draw").length,
      winRate: rows.length ? Math.round((rows.filter((row) => row.result === "Won").length / rows.length) * 100) : 0,
    }))
    .sort((left, right) => right.matches - left.matches || String(left.label).localeCompare(String(right.label)));
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
  const parsed = await loadJsonStore(DATA_STORES.betlogBets, BETLOG_BETS_PATH, { bets: [] });
  const bets = Array.isArray(parsed?.bets) ? parsed.bets : Array.isArray(parsed) ? parsed : [];
  return sortBetlogBets(bets.map(normalizeBetlogBet));
}

async function saveBetlogBets(bets) {
  await saveJsonStore(DATA_STORES.betlogBets, { bets: sortBetlogBets(bets) });
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
    created: normalizedBets,
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

async function analyzeBetlogPerformance() {
  const bets = await loadBetlogBets();
  if (!bets.length) {
    throw new Error("Add at least one Betlog row before asking for AI insights.");
  }

  const system = [
    "You are a concise betting performance analyst focused on risk discipline.",
    "Use only the provided JSON data and computed summary.",
    "Analyze the full record: ROI, stake allocation, hit rate, bet types, odds bands, markets, selections, open bets, and repeated weaknesses.",
    "Return exactly 5 bullets and no headings.",
    "Keep each bullet under 24 words.",
    "Do not include an introduction or closing sentence.",
    "Do not encourage more betting. Focus on performance, bankroll protection, and measurable process improvements.",
  ].join(" ");
  const user = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: summarizeBetlogPerformance(bets),
      bets,
    },
    null,
    2,
  );

  const insight = {
    id: crypto.randomUUID(),
    toolId: "betlog",
    model: ANTHROPIC_ANALYSIS_MODEL,
    generatedAt: new Date().toISOString(),
    sourceRecordCount: bets.length,
    insight: await fetchAnthropicMessage({ system, user, maxTokens: 360 }),
  };
  await savePerformanceInsight(insight);
  return insight;
}

function summarizeBetlogPerformance(bets) {
  const uniqueBets = Array.from(groupBetsByBetId(bets).values()).map((rows) => rows[0]);
  const settledBets = uniqueBets.filter((bet) => !isOpenBetStatus(bet.status));
  const wins = settledBets.filter((bet) => Number(bet.returnAmount) > 0 || isWinningBetStatus(bet.status)).length;
  const stake = sumNumbers(uniqueBets.map((bet) => (bet.freeBet ? 0 : bet.stake)));
  const returns = sumNumbers(uniqueBets.map((bet) => bet.returnAmount));
  const profit = Math.round((returns - stake) * 100) / 100;
  const byMonth = groupBy(uniqueBets, (bet) => String(bet.date || "").slice(0, 7));
  const byBetType = groupBy(uniqueBets, (bet) => bet.betType || "Unknown bet type");
  const byStatus = groupBy(uniqueBets, (bet) => bet.status || "Unknown status");
  const oddsBands = groupBy(uniqueBets, betlogOddsBand);

  return {
    rows: bets.length,
    uniqueBets: uniqueBets.length,
    firstDate: uniqueBets[uniqueBets.length - 1]?.date || "",
    lastDate: uniqueBets[0]?.date || "",
    stake,
    returns,
    profit,
    roi: stake ? Math.round((profit / stake) * 1000) / 10 : 0,
    winRate: settledBets.length ? Math.round((wins / settledBets.length) * 100) : 0,
    openBets: uniqueBets.filter((bet) => isOpenBetStatus(bet.status)).length,
    avgOdds: uniqueBets.length ? Math.round((sumNumbers(uniqueBets.map((bet) => bet.odds)) / uniqueBets.length) * 100) / 100 : 0,
    statusBreakdown: countBy(uniqueBets, (bet) => bet.status || "Unknown"),
    monthly: summarizeBetlogGroups(byMonth),
    betTypes: summarizeBetlogGroups(byBetType),
    statuses: summarizeBetlogGroups(byStatus),
    oddsBands: summarizeBetlogGroups(oddsBands),
  };
}

function summarizeBetlogGroups(groups) {
  return Array.from(groups.entries())
    .map(([label, rows]) => {
      const stake = sumNumbers(rows.map((row) => (row.freeBet ? 0 : row.stake)));
      const returns = sumNumbers(rows.map((row) => row.returnAmount));
      const profit = Math.round((returns - stake) * 100) / 100;
      return {
        label,
        bets: rows.length,
        stake,
        returns,
        profit,
        roi: stake ? Math.round((profit / stake) * 1000) / 10 : 0,
      };
    })
    .sort((left, right) => right.bets - left.bets || String(left.label).localeCompare(String(right.label)));
}

function groupBetsByBetId(bets) {
  const groups = new Map();
  bets.forEach((bet) => {
    const key = bet.betId || bet.id;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(bet);
  });
  return groups;
}

function isOpenBetStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return ["open", "pending", "active", "ανοιχτό", "εκκρεμεί"].includes(normalized);
}

function isWinningBetStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return ["won", "win", "κερδισμένο", "cash out"].includes(normalized);
}

function betlogOddsBand(bet) {
  const odds = Number(bet.odds) || 0;
  if (odds < 1.5) {
    return "Under 1.50";
  }
  if (odds < 2) {
    return "1.50-1.99";
  }
  if (odds < 3) {
    return "2.00-2.99";
  }
  return "3.00+";
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row) || "Unknown";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  });
  return groups;
}

function countBy(rows, keyFn) {
  return Object.fromEntries(
    Array.from(groupBy(rows, keyFn).entries())
      .map(([label, groupRows]) => [label, groupRows.length])
      .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))),
  );
}

function sumNumbers(numbers) {
  return numbers.reduce((total, value) => total + (Number(value) || 0), 0);
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
  const parsed = await loadJsonStore(DATA_STORES.notelogNotes, NOTELOG_NOTES_PATH, { notes: [] });
  const notes = Array.isArray(parsed?.notes) ? parsed.notes : Array.isArray(parsed) ? parsed : [];
  return sortNotelogNotes(notes.map(normalizeNotelogNote));
}

async function saveNotelogNotes(notes) {
  await saveJsonStore(DATA_STORES.notelogNotes, { notes: sortNotelogNotes(notes) });
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
  if (!hasPdfHeader(pdfBuffer)) {
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

async function combinePdfDocuments({ fileName, files }) {
  if (!Array.isArray(files) || files.length < COMBINE_PDF_MIN_DOCUMENTS) {
    throw new Error("Choose at least two PDF files to combine");
  }

  if (files.length > COMBINE_PDF_MAX_DOCUMENTS) {
    throw new Error("Combine PDFs supports up to five documents at a time");
  }

  const combinedPdf = await PDFDocument.create();
  let pageCount = 0;

  for (const [index, file] of files.entries()) {
    const sourceName = String(file?.fileName || `Document ${index + 1}`).trim();
    const compactBase64 = String(file?.base64 || "").trim();

    if (!compactBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
      throw new Error(`${sourceName} must be a Base64 PDF`);
    }

    const pdfBuffer = Buffer.from(compactBase64, "base64");
    if (!hasPdfHeader(pdfBuffer)) {
      throw new Error(`${sourceName} is not a valid PDF file`);
    }

    let sourcePdf;
    try {
      sourcePdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    } catch {
      throw new Error(`${sourceName} could not be read as a PDF`);
    }

    const copiedPages = await combinedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    copiedPages.forEach((page) => {
      combinedPdf.addPage(page);
      pageCount += 1;
    });
  }

  if (pageCount === 0) {
    throw new Error("The selected PDFs do not contain any pages");
  }

  const savedFileName = outputCombinedPdfFileName(fileName);
  const outputPath = path.join(OUTPUTS_DIR, savedFileName);
  const pdfBytes = await combinedPdf.save();
  const base64 = Buffer.from(pdfBytes).toString("base64");

  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.writeFile(outputPath, pdfBytes);

  return {
    fileName: savedFileName,
    outputPath,
    pageCount,
    pdfSource: `data:application/pdf;base64,${base64}`,
  };
}

async function saveCsvJsonRows({ fileName, csv }) {
  if (!fileName || typeof csv !== "string") {
    throw new Error("A CSV file is required");
  }

  if (path.extname(fileName).toLowerCase() !== ".csv") {
    throw new Error("Choose a CSV file");
  }

  const baseName = outputCsvJsonBaseName(fileName);
  const parsedRows = parseCsvRows(csv.replace(/^\uFEFF/, ""));
  const dataset = normalizeCsvDataset(parsedRows);
  const outputDir = path.join(OUTPUTS_DIR, baseName);
  const tempOutputDir = path.join(OUTPUTS_DIR, `.csv-json-rows-${baseName}-${crypto.randomUUID()}`);

  const files = [];
  try {
    await fs.mkdir(tempOutputDir, { recursive: true });

    for (const [index, row] of dataset.rows.entries()) {
      const record = {};
      for (const [columnIndex, header] of dataset.headers.entries()) {
        record[header] = row.values[columnIndex] ?? "";
      }

      const savedFileName = `${baseName}${index + 1}.json`;
      await fs.writeFile(path.join(tempOutputDir, savedFileName), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      files.push(savedFileName);
    }

    await replaceOutputDirectory(tempOutputDir, outputDir);
  } catch (error) {
    await fs.rm(tempOutputDir, { recursive: true, force: true });
    throw error;
  }

  return {
    fileName: baseName,
    outputPath: outputDir,
    rowCount: files.length,
    columnCount: dataset.headers.length,
    skippedBlankRows: dataset.skippedBlankRows,
    warnings: dataset.warnings,
    files,
  };
}

async function replaceOutputDirectory(tempOutputDir, outputDir) {
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  const backupOutputDir = path.join(OUTPUTS_DIR, `.csv-json-rows-backup-${path.basename(outputDir)}-${crypto.randomUUID()}`);
  let movedExisting = false;

  try {
    await fs.rename(outputDir, backupOutputDir);
    movedExisting = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.rename(tempOutputDir, outputDir);
  } catch (error) {
    if (movedExisting) {
      await fs.rename(backupOutputDir, outputDir).catch(() => {});
    }
    throw error;
  }

  if (movedExisting) {
    await fs.rm(backupOutputDir, { recursive: true, force: true });
  }
}

function normalizeCsvDataset(parsedRows) {
  if (!parsedRows.length) {
    throw new Error("The CSV file is empty");
  }

  const headerRow = parsedRows[0];
  if (!headerRow.length || headerRow.every((value) => String(value || "").trim() === "")) {
    throw new Error("The CSV file needs a header row");
  }

  const rows = [];
  let skippedBlankRows = 0;
  let maxColumnCount = headerRow.length;
  let firstShortRow = null;
  let firstLongRow = null;
  let replacementCharacterCount = countReplacementCharacters(headerRow);

  for (const [index, row] of parsedRows.slice(1).entries()) {
    const csvRowNumber = index + 2;
    if (row.every((value) => String(value || "").trim() === "")) {
      skippedBlankRows += 1;
      continue;
    }

    if (row.length < headerRow.length && !firstShortRow) {
      firstShortRow = { rowNumber: csvRowNumber, columns: row.length };
    }
    if (row.length > headerRow.length && !firstLongRow) {
      firstLongRow = { rowNumber: csvRowNumber, columns: row.length };
    }

    replacementCharacterCount += countReplacementCharacters(row);
    maxColumnCount = Math.max(maxColumnCount, row.length);
    rows.push({ csvRowNumber, values: row });
  }

  if (!rows.length) {
    throw new Error("The CSV file does not contain any data rows");
  }

  const warnings = [];
  if (firstShortRow) {
    warnings.push(
      `Row ${firstShortRow.rowNumber} has ${firstShortRow.columns} columns; missing values were exported as empty strings.`,
    );
  }
  if (firstLongRow) {
    warnings.push(
      `Row ${firstLongRow.rowNumber} has ${firstLongRow.columns} columns; extra columns were kept as generated Column fields.`,
    );
  }
  if (replacementCharacterCount > 0) {
    warnings.push(
      `${replacementCharacterCount} replacement characters were found. The CSV may not be UTF-8 encoded.`,
    );
  }
  if (skippedBlankRows > 0) {
    warnings.push(`${skippedBlankRows} blank rows were skipped.`);
  }

  return {
    headers: normalizeCsvHeaders(headerRow, maxColumnCount),
    rows,
    skippedBlankRows,
    warnings,
  };
}

function countReplacementCharacters(values) {
  return values.reduce((total, value) => total + (String(value || "").match(/\uFFFD/g) || []).length, 0);
}

function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const nextCharacter = csv[index + 1];

    if (inQuotes) {
      if (character === '"' && nextCharacter === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error("The CSV file has an unclosed quoted field");
  }

  if (field || row.length || csv.endsWith(",")) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeCsvHeaders(headers, columnCount = headers.length) {
  const seen = new Map();
  return Array.from({ length: columnCount }, (_, index) => {
    const header = headers[index];
    const cleaned = String(header || "").trim() || `Column ${index + 1}`;
    const count = seen.get(cleaned) || 0;
    seen.set(cleaned, count + 1);
    return count ? `${cleaned} (${count + 1})` : cleaned;
  });
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

async function publicApiDocsPage() {
  const version = await appVersion();
  const openApiJson = JSON.stringify(optimusOpenApiSpec(version), null, 2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Optimus Public API Docs</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 56px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 4vw, 3rem); letter-spacing: 0; }
    h2 { margin-top: 36px; font-size: 1.25rem; }
    p { max-width: 760px; }
    code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.92rem; }
    code { padding: 2px 5px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 5px; }
    pre { overflow: auto; padding: 16px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
    .endpoint { display: grid; gap: 10px; margin-top: 16px; padding-top: 18px; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
    .method { display: inline-flex; width: fit-content; padding: 2px 8px; border-radius: 5px; background: #166534; color: white; font-weight: 700; font-size: 0.78rem; letter-spacing: 0; }
    a { color: LinkText; }
  </style>
</head>
<body>
  <main>
    <h1>Optimus Public API</h1>
    <p>Use these endpoints to log Padelog matches and Betlog rows from scripts, Shortcuts, forms, or other tools. Authenticate with <code>Authorization: Bearer $OPTIMUS_PUBLIC_API_KEY</code> or <code>X-API-Key</code>.</p>
    <p>The OpenAPI JSON is available at <a href="/api/openapi.json"><code>/api/openapi.json</code></a>.</p>

    <section class="endpoint">
      <span class="method">POST</span>
      <h2><code>/api/public/padelog/matches</code></h2>
      <p>Logs one padel match with the same validation used by the Padelog UI.</p>
      <pre><code>curl -X POST http://localhost:${PORT}/api/public/padelog/matches \\
  -H "Authorization: Bearer $OPTIMUS_PUBLIC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "club": "Padel Club",
    "date": "2026-05-29",
    "teammate": "Alex",
    "opponents": "Nikos / Maria",
    "result": "Won",
    "sets": "2-1"
  }'</code></pre>
    </section>

    <section class="endpoint">
      <span class="method">POST</span>
      <h2><code>/api/public/betlog/bets</code></h2>
      <p>Logs one Betlog row. Combo bets can send multiple rows using the <code>bets</code> array and the same <code>betId</code>.</p>
      <pre><code>curl -X POST http://localhost:${PORT}/api/public/betlog/bets \\
  -H "Authorization: Bearer $OPTIMUS_PUBLIC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "date": "2026-05-29",
    "time": "21:00",
    "betId": "BET-1001",
    "betType": "Single",
    "stake": 10,
    "freeBet": false,
    "status": "Open",
    "returnAmount": 0,
    "selection": "Team A win",
    "odds": 1.85,
    "market": "Match winner",
    "match": "Team A vs Team B",
    "score": "",
    "outcomeType": "single",
    "legs": 1
  }'</code></pre>
    </section>

    <h2>OpenAPI</h2>
    <pre><code>${escapeHtmlText(openApiJson)}</code></pre>
  </main>
</body>
</html>`;
}

function escapeHtmlText(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character],
  );
}

function optimusOpenApiSpec(version = "unknown") {
  return {
    openapi: "3.0.3",
    info: {
      title: "Optimus Public API",
      version,
      description: "Public endpoints for logging Padelog matches and Betlog bet rows.",
    },
    servers: [{ url: `http://${HOST}:${PORT}` }],
    tags: [
      { name: "Padelog", description: "Padel match logging" },
      { name: "Betlog", description: "Bet row logging" },
    ],
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Use OPTIMUS_PUBLIC_API_KEY, OPTIMUS_API_KEY, or the Optimus access key fallback.",
        },
        headerApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
        PadelogMatchInput: {
          type: "object",
          properties: {
            id: { type: "string", description: "Optional client-provided id. A UUID is generated when omitted." },
            club: { type: "string", example: "Padel Club" },
            date: { type: "string", example: "2026-05-29", description: "YYYY-MM-DD or day/month format." },
            teammate: { type: "string", example: "Alex" },
            opponents: { type: "string", example: "Nikos / Maria" },
            result: { type: "string", enum: ["Won", "Lost", "Draw"] },
            sets: { type: "string", example: "2-1" },
          },
          required: ["date", "result", "sets"],
        },
        PadelogLogRequest: {
          oneOf: [
            { $ref: "#/components/schemas/PadelogMatchInput" },
            {
              type: "object",
              properties: { match: { $ref: "#/components/schemas/PadelogMatchInput" } },
              required: ["match"],
            },
            {
              type: "object",
              properties: {
                matches: { type: "array", items: { $ref: "#/components/schemas/PadelogMatchInput" } },
              },
              required: ["matches"],
            },
          ],
        },
        PadelogMatch: {
          allOf: [
            { $ref: "#/components/schemas/PadelogMatchInput" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
              },
              required: ["id", "club", "date", "teammate", "opponents", "result", "sets", "createdAt"],
            },
          ],
        },
        PadelogLogResponse: {
          type: "object",
          properties: {
            imported: { type: "integer" },
            total: { type: "integer", description: "Total saved Padelog matches after this request." },
            created: { type: "array", items: { $ref: "#/components/schemas/PadelogMatch" } },
          },
          required: ["imported", "total", "created"],
        },
        BetlogBetInput: {
          type: "object",
          properties: {
            id: { type: "string", description: "Optional client-provided row id. A UUID is generated when omitted." },
            date: { type: "string", example: "2026-05-29", description: "YYYY-MM-DD or day/month format." },
            time: { type: "string", example: "21:00", description: "HH:MM." },
            betId: { type: "string", example: "BET-1001" },
            betType: { type: "string", example: "Single" },
            stake: { type: "number", minimum: 0, example: 10 },
            freeBet: { type: "boolean", example: false },
            status: { type: "string", example: "Open" },
            returnAmount: { type: "number", minimum: 0, example: 0 },
            selection: { type: "string", example: "Team A win" },
            odds: { type: "number", exclusiveMinimum: 0, example: 1.85 },
            market: { type: "string", example: "Match winner" },
            match: { type: "string", example: "Team A vs Team B" },
            score: { type: "string", example: "" },
            outcomeType: { type: "string", example: "single" },
            legs: { type: "integer", minimum: 1, example: 1 },
          },
          required: ["date", "time", "stake", "odds"],
        },
        BetlogLogRequest: {
          oneOf: [
            { $ref: "#/components/schemas/BetlogBetInput" },
            {
              type: "object",
              properties: { bet: { $ref: "#/components/schemas/BetlogBetInput" } },
              required: ["bet"],
            },
            {
              type: "object",
              properties: {
                bets: { type: "array", items: { $ref: "#/components/schemas/BetlogBetInput" } },
              },
              required: ["bets"],
            },
          ],
        },
        BetlogBet: {
          allOf: [
            { $ref: "#/components/schemas/BetlogBetInput" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
              },
              required: [
                "id",
                "date",
                "time",
                "betId",
                "betType",
                "stake",
                "freeBet",
                "status",
                "returnAmount",
                "selection",
                "odds",
                "market",
                "match",
                "score",
                "outcomeType",
                "legs",
                "createdAt",
              ],
            },
          ],
        },
        BetlogLogResponse: {
          type: "object",
          properties: {
            imported: { type: "integer" },
            total: { type: "integer", description: "Total saved Betlog rows after this request." },
            created: { type: "array", items: { $ref: "#/components/schemas/BetlogBet" } },
          },
          required: ["imported", "total", "created"],
        },
      },
    },
    security: [{ bearerApiKey: [] }, { headerApiKey: [] }],
    paths: {
      "/api/public/padelog/matches": {
        post: {
          tags: ["Padelog"],
          summary: "Log Padelog matches",
          description: "Create one or more Padelog matches using the same validation as the UI.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/PadelogLogRequest" } } },
          },
          responses: publicApiResponses("#/components/schemas/PadelogLogResponse", "Match rows were logged."),
        },
      },
      "/api/public/betlog/bets": {
        post: {
          tags: ["Betlog"],
          summary: "Log Betlog bet rows",
          description: "Create one or more Betlog rows using the same validation as the UI.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/BetlogLogRequest" } } },
          },
          responses: publicApiResponses("#/components/schemas/BetlogLogResponse", "Bet rows were logged."),
        },
      },
    },
  };
}

function publicApiResponses(schemaRef, createdDescription) {
  return {
    201: {
      description: createdDescription,
      content: { "application/json": { schema: { $ref: schemaRef } } },
    },
    400: {
      description: "Validation error.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
    401: {
      description: "Missing or invalid API key.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
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

  if (request.method === "GET" && url.pathname === "/api/openapi.json") {
    sendJson(response, 200, optimusOpenApiSpec(await appVersion()));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/docs") {
    const html = await publicApiDocsPage();
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      ...corsHeaders(),
    });
    response.end(html);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/padelog/matches") {
    if (!requirePublicApiKey(request, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const result = await addPadelogMatches(payload);
      sendJson(response, 201, {
        imported: result.imported,
        total: result.matches.length,
        created: result.created,
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Padelog matches" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/betlog/bets") {
    if (!requirePublicApiKey(request, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const result = await addBetlogBets(payload);
      sendJson(response, 201, {
        imported: result.imported,
        total: result.bets.length,
        created: result.created,
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Betlog bets" });
    }
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

  if (request.method === "GET" && url.pathname === "/api/admin/backup") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await createBackupArchive());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not create backup" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/restore") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await restoreBackupArchive(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not restore backup" });
    }
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

  if (request.method === "GET" && url.pathname === "/api/tools/olympiacos-news") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await loadOlympiacosNewsStore());
    } catch (error) {
      console.error("Could not load Olympiacos news store", error);
      sendJson(response, 500, { error: error.message || "Could not load Olympiacos news" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/olympiacos-news/sites") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await updateOlympiacosNewsSites(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Olympiacos news sites" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/olympiacos-news/run") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await runOlympiacosNewsSearch());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not run Olympiacos news search" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/knowledge-expert") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await knowledgeExpertSnapshot(url.searchParams.get("conversationId") || ""));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not load Knowledge Expert" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/conversations") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await createKnowledgeConversation(payload, session.name));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not create conversation" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/conversations/update") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await updateKnowledgeConversation(payload, session.name));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not update conversation" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/conversations/clear") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await clearKnowledgeConversation(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not clear conversation" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/conversations/delete") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await deleteKnowledgeConversation(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not delete conversation" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/upload") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await replaceKnowledgeExpertDataset(payload, session.name));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not upload Knowledge Expert dataset" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/chat") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await chatWithKnowledgeExpert(payload, session.name));
    } catch (error) {
      const payloadMessage = "";
      await persistKnowledgeErrorTurn(payloadMessage, session.name, error).catch(() => {});
      sendJson(response, 400, { error: error.message || "Could not answer with Knowledge Expert" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/chat/stream") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    let payload = {};
    let streamedText = "";
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...corsHeaders(),
    });

    try {
      payload = await readJson(request);
      const turn = await chatWithKnowledgeExpert(payload, session.name, {
        onTrace: (event) => sendSse(response, "trace", event),
        onTextDelta: (delta) => {
          streamedText += delta;
          sendSse(response, "text_delta", { delta });
        },
      });
      if (!streamedText && turn.assistantResponse) {
        sendSse(response, "text_delta", { delta: turn.assistantResponse });
      }
      sendSse(response, "meta", {
        traceId: turn.id,
        citations: turn.citations,
        grounded: turn.grounded,
        durationMs: turn.durationMs,
        turn,
      });
      sendSse(response, "done", {});
      response.end();
    } catch (error) {
      await persistKnowledgeErrorTurn(payload.message || "", session.name, error, payload.conversationId || "").catch(() => {});
      sendSse(response, "error", { message: error.message || "Could not answer with Knowledge Expert" });
      sendSse(response, "done", {});
      response.end();
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/knowledge-expert/feedback") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await rateKnowledgeExpertTurn(payload, session.name));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not save Knowledge Expert feedback" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/knowledge-expert/admin/conversations") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, await knowledgeExpertConversationsReport());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/knowledge-expert/admin/reports/errors") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, await knowledgeExpertErrorsReport());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/knowledge-expert/admin/reports/dead-entries") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, await knowledgeExpertDeadEntriesReport());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/knowledge-expert/admin/reports/knowledge-gaps") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, await knowledgeExpertGapsReport());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/padelog/matches") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, { matches: await loadPadelogMatches() });
    } catch (error) {
      console.error("Could not load Padelog matches", error);
      sendJson(response, 500, { error: error.message || "Could not load Padelog matches" });
    }
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

  if (request.method === "GET" && url.pathname === "/api/tools/padelog/analysis") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, { insights: await performanceInsightsForTool("padelog") });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not load Padelog insights" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/padelog/analysis") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await analyzePadelogPerformance());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not analyze Padelog performance" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/betlog/bets") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, { bets: await loadBetlogBets() });
    } catch (error) {
      console.error("Could not load Betlog bets", error);
      sendJson(response, 500, { error: error.message || "Could not load Betlog bets" });
    }
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

  if (request.method === "GET" && url.pathname === "/api/tools/betlog/analysis") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, { insights: await performanceInsightsForTool("betlog") });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not load Betlog insights" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/betlog/analysis") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      sendJson(response, 200, await analyzeBetlogPerformance());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not analyze Betlog performance" });
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

  if (request.method === "POST" && url.pathname === "/api/tools/combine-pdfs") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await combinePdfDocuments(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not combine PDFs" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/csv-json-rows") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    try {
      const payload = await readJson(request);
      sendJson(response, 200, await saveCsvJsonRows(payload));
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Could not convert CSV" });
    }
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
  handleRequest(request, response).catch((error) => {
    console.error("Unhandled Optimus API error", error);
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
