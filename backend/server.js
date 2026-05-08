const crypto = require("node:crypto");
const http = require("node:http");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "localhost";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:4173";
const ACCESS_KEY = process.env.OPTIMUS_ACCESS_KEY || "optimus";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

const sessions = new Map();

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

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
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
    const session = currentSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    sendJson(response, 200, {
      user: { name: session.name },
      expiresAt: session.expiresAt,
    });
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
