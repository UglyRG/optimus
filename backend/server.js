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

function outputHtmlFileName(fileName) {
  const parsed = path.parse(fileName || "presentation-suite.html");
  const baseName = parsed.name || "presentation-suite";
  const safeBaseName = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `${safeBaseName || "presentation-suite"}.html`;
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

function buildPresentationSuiteHtml({ labels, dateLabel = formatSuiteDate() }) {
  const tabs = labels.map((label, index) => ({
    id: tabIdForIndex(index),
    label: escapeTemplateHtml(label),
    isActive: index === 0,
  }));

  const buttons = tabs
    .map(
      (tab) =>
        `    <button class="tab-btn${tab.isActive ? " active" : ""}" onclick="switchTab('${tab.id}',this)"><span class="tab-dot"></span>${tab.label}</button>`,
    )
    .join("\n");

  const panels = tabs
    .map(
      (tab) =>
        `  <div class="panel${tab.isActive ? " active" : ""}" id="panel-${tab.id}"></div>`,
    )
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

async function savePresentationSuite({ fileName, tabCount, labels }) {
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

  const savedFileName = outputHtmlFileName(fileName);
  const outputPath = path.join(OUTPUTS_DIR, savedFileName);
  const html = buildPresentationSuiteHtml({ labels: cleanLabels });

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
