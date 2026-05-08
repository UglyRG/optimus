const API_BASE = "http://localhost:8787/api";
const app = document.querySelector("#app");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

async function loadSession() {
  try {
    const payload = await request("/auth/me");
    renderIndex(payload);
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-page">
      <form class="login-tab" id="login-form">
        <h1>Optimus</h1>
        <p>Sign in to continue.</p>
        <div class="form-stack">
          <div class="field">
            <label for="name">Name</label>
            <input id="name" name="name" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="access-key">Access key</label>
            <input id="access-key" name="accessKey" type="password" autocomplete="current-password" required />
          </div>
          <p class="error" id="login-error"></p>
          <button class="button button-primary" type="submit">Log in</button>
        </div>
      </form>
    </section>
  `;

  document.querySelector("#login-form").addEventListener("submit", handleLogin);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);

  try {
    const payload = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        name: String(data.get("name")).trim(),
        accessKey: String(data.get("accessKey")),
      }),
    });
    renderIndex(payload);
  } catch (error) {
    showError(error.message);
  }
}

function renderIndex({ user, expiresAt }) {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">O</span>
        <span>Optimus</span>
      </div>
      <button class="button button-secondary" id="logout-button" type="button">Log out</button>
    </header>

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>Index</h1>
          <p>Signed in as ${escapeHtml(user.name)}. Session expires in ${hoursLeft(expiresAt)}h.</p>
        </div>
        <button class="button button-primary" type="button">Add tool</button>
      </div>

      <div class="tool-list" aria-label="Available tools">
        <article class="tool-row">
          <div>
            <h2>Tools</h2>
            <p>The first tool slot is ready for whatever we build next.</p>
          </div>
          <span class="badge">Empty</span>
        </article>
      </div>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
}

async function handleLogout() {
  await request("/auth/logout", { method: "POST" }).catch(() => {});
  renderLogin();
}

function showError(message) {
  const error = document.querySelector("#login-error");
  error.textContent = message;
  error.classList.add("is-visible");
}

function hoursLeft(expiresAt) {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60)));
}

function escapeHtml(value) {
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

loadSession();
