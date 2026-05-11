const API_BASE = "http://localhost:8787/api";
const app = document.querySelector("#app");
let activeUser = null;
let activeExpiresAt = null;
let suiteSourceFiles = [];

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
  activeUser = user;
  activeExpiresAt = expiresAt;

  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>Index</h1>
          <p>Signed in as ${escapeHtml(user.name)}. Session expires in ${hoursLeft(expiresAt)}h.</p>
        </div>
      </div>

      <div class="tool-list" aria-label="Available tools">
        <article class="tool-row">
          <div>
            <h2>HTML to iframe Base64</h2>
            <p>Convert an HTML file into an iframe-ready Base64 data string and save it to Outputs.</p>
          </div>
          <button class="button button-secondary" id="open-html-tool" type="button">Open</button>
        </article>
        <article class="tool-row">
          <div>
            <h2>Presentation Suite Builder</h2>
            <p>Create a tabbed presentation suite HTML file with a deck tab and demo tabs.</p>
          </div>
          <button class="button button-secondary" id="open-presentation-suite-tool" type="button">Open</button>
        </article>
        <article class="tool-row">
          <div>
            <h2>Demo Builder</h2>
            <p>Create a branded, configurable agent demo template with scenarios, messages, docs, and logs.</p>
          </div>
          <button class="button button-secondary" id="open-demo-builder-tool" type="button">Open</button>
        </article>
      </div>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#open-html-tool").addEventListener("click", renderHtmlBase64Tool);
  document
    .querySelector("#open-presentation-suite-tool")
    .addEventListener("click", renderPresentationSuiteTool);
  document.querySelector("#open-demo-builder-tool").addEventListener("click", renderDemoBuilderTool);
}

function renderHtmlBase64Tool() {
  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>HTML to iframe Base64</h1>
          <p>Select an HTML file and save the generated string to Outputs.</p>
        </div>
        <button class="button button-secondary" id="back-button" type="button">Back</button>
      </div>

      <form class="tool-panel" id="html-base64-form">
        <div class="field">
          <label for="html-file">HTML file</label>
          <input id="html-file" name="htmlFile" type="file" accept=".html,.htm,text/html" required />
        </div>
        <p class="error" id="tool-error"></p>
        <button class="button button-primary" type="submit">Create TXT output</button>
      </form>

      <section class="result-panel" id="result-panel" hidden>
        <div class="result-head">
          <div>
            <h2>Output</h2>
            <p id="saved-path"></p>
          </div>
          <button class="button button-secondary" id="copy-output" type="button">Copy</button>
        </div>
        <textarea id="base64-output" readonly spellcheck="false"></textarea>
        <iframe id="iframe-preview" title="HTML preview"></iframe>
      </section>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#back-button").addEventListener("click", () => {
    renderIndex({ user: activeUser, expiresAt: activeExpiresAt });
  });
  document.querySelector("#html-base64-form").addEventListener("submit", handleHtmlBase64Submit);
}

async function renderPresentationSuiteTool() {
  suiteSourceFiles = [];
  try {
    const payload = await request("/outputs/iframe-sources");
    suiteSourceFiles = payload.files || [];
  } catch {
    suiteSourceFiles = [];
  }

  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>Presentation Suite Builder</h1>
          <p>Generate a tabbed HTML template with the first tab as the deck and the remaining tabs as demos.</p>
        </div>
        <button class="button button-secondary" id="back-button" type="button">Back</button>
      </div>

      <form class="tool-panel" id="presentation-suite-form">
        <div class="form-grid">
          <div class="field">
            <label for="suite-file-name">Output file name</label>
            <input id="suite-file-name" name="fileName" placeholder="presentation-suite.html" required />
          </div>
          <div class="field">
            <label for="suite-tab-count">Number of tabs</label>
            <input id="suite-tab-count" name="tabCount" type="number" min="1" max="12" value="3" required />
          </div>
        </div>
        <div class="field">
          <label>Tabs</label>
          <div class="label-list" id="suite-label-list"></div>
        </div>
        <p class="error" id="tool-error"></p>
        <button class="button button-primary" type="submit">Create HTML output</button>
      </form>

      <section class="result-panel" id="result-panel" hidden>
        <div class="result-head">
          <div>
            <h2>Output</h2>
            <p id="saved-path"></p>
          </div>
          <button class="button button-secondary" id="copy-output" type="button">Copy HTML</button>
        </div>
        <textarea id="suite-output" readonly spellcheck="false"></textarea>
        <iframe id="iframe-preview" title="Presentation suite preview"></iframe>
      </section>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#back-button").addEventListener("click", () => {
    renderIndex({ user: activeUser, expiresAt: activeExpiresAt });
  });

  const tabCount = document.querySelector("#suite-tab-count");
  tabCount.addEventListener("input", renderSuiteLabelInputs);
  renderSuiteLabelInputs();

  document
    .querySelector("#presentation-suite-form")
    .addEventListener("submit", handlePresentationSuiteSubmit);
}

function renderDemoBuilderTool() {
  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>Demo Builder</h1>
          <p>Generate a reusable demo HTML template with editable branding, scenarios, messages, documents, and logs.</p>
        </div>
        <button class="button button-secondary" id="back-button" type="button">Back</button>
      </div>

      <form class="tool-panel" id="demo-builder-form">
        <div class="form-grid">
          <div class="field">
            <label for="demo-file-name">Output file name</label>
            <input id="demo-file-name" name="fileName" value="demo-builder-template.html" required />
          </div>
          <div class="field">
            <label for="demo-scenario-count">Number of scenarios</label>
            <input id="demo-scenario-count" name="scenarioCount" type="number" min="1" max="8" value="2" required />
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="demo-logo-text">Logo text</label>
            <input id="demo-logo-text" name="logoText" value="LOGO" required />
          </div>
          <div class="field">
            <label for="demo-title">Demo title</label>
            <input id="demo-title" name="title" value="Funding Advisor Demo" required />
          </div>
        </div>

        <div class="field">
          <label for="demo-subtitle">Subtitle</label>
          <input id="demo-subtitle" name="subtitle" value="Configurable agent simulation template" />
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="demo-font-ui">UI font</label>
            <input id="demo-font-ui" name="fontUi" value="Inter, system-ui, sans-serif" />
          </div>
          <div class="field">
            <label for="demo-font-mono">Mono font</label>
            <input id="demo-font-mono" name="fontMono" value="JetBrains Mono, monospace" />
          </div>
        </div>

        <div class="color-grid">
          <div class="field">
            <label for="demo-brand-color">Brand</label>
            <input id="demo-brand-color" name="brandColor" type="color" value="#003a7d" />
          </div>
          <div class="field">
            <label for="demo-accent-color">Accent</label>
            <input id="demo-accent-color" name="accentColor" type="color" value="#c8a84b" />
          </div>
          <div class="field">
            <label for="demo-bg-color">Background</label>
            <input id="demo-bg-color" name="backgroundColor" type="color" value="#0e1117" />
          </div>
          <div class="field">
            <label for="demo-font-color">Font</label>
            <input id="demo-font-color" name="fontColor" type="color" value="#e8eaf0" />
          </div>
        </div>

        <p class="error" id="tool-error"></p>
        <button class="button button-primary" type="submit">Create demo template</button>
      </form>

      <section class="result-panel" id="result-panel" hidden>
        <div class="result-head">
          <div>
            <h2>Output</h2>
            <p id="saved-path"></p>
          </div>
          <button class="button button-secondary" id="copy-output" type="button">Copy HTML</button>
        </div>
        <textarea id="demo-output" readonly spellcheck="false"></textarea>
        <iframe id="iframe-preview" title="Demo Builder preview"></iframe>
      </section>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#back-button").addEventListener("click", () => {
    renderIndex({ user: activeUser, expiresAt: activeExpiresAt });
  });
  document.querySelector("#demo-builder-form").addEventListener("submit", handleDemoBuilderSubmit);
}

function renderTopbar() {
  return `
    <header class="topbar">
      <div class="brand">
        <img class="brand-logo" src="./assets/optimus-horizontal.svg" alt="Optimus" />
      </div>
      <button class="button button-secondary" id="logout-button" type="button">Log out</button>
    </header>
  `;
}

function renderSuiteLabelInputs() {
  const labelList = document.querySelector("#suite-label-list");
  const tabCount = document.querySelector("#suite-tab-count");
  const existingLabels = Array.from(labelList.querySelectorAll('input[name="tabLabel"]')).map(
    (input) => input.value,
  );
  const existingSourceFiles = Array.from(labelList.querySelectorAll('select[name="tabSourceFile"]')).map(
    (select) => select.value,
  );
  const count = Math.min(12, Math.max(1, Number(tabCount.value) || 1));
  tabCount.value = count;

  labelList.innerHTML = Array.from({ length: count }, (_, index) => {
    const role = index === 0 ? "Deck" : index === 1 ? "Demo" : `Demo ${index}`;
    const value = existingLabels[index] || (index === 0 ? "Deck" : `Demo ${index}`);
    const selectedSourceFile = existingSourceFiles[index] || "";
    return `
      <div class="label-row">
        <span class="badge">${role}</span>
        <input name="tabLabel" value="${escapeAttribute(value)}" aria-label="${role} label" required />
        <select name="tabSourceFile" aria-label="${role} iframe source">
          <option value="">No iframe</option>
          ${renderSourceFileOptions(selectedSourceFile)}
        </select>
      </div>
    `;
  }).join("");
}

function renderSourceFileOptions(selectedSourceFile) {
  if (!suiteSourceFiles.length) {
    return '<option value="" disabled>No TXT outputs found</option>';
  }

  return suiteSourceFiles
    .map((fileName) => {
      const selected = fileName === selectedSourceFile ? " selected" : "";
      return `<option value="${escapeAttribute(fileName)}"${selected}>${escapeHtml(fileName)}</option>`;
    })
    .join("");
}

async function handleHtmlBase64Submit(event) {
  event.preventDefault();

  const fileInput = document.querySelector("#html-file");
  const [file] = fileInput.files;
  if (!file) {
    showToolError("Choose an HTML file first.");
    return;
  }

  try {
    const html = await file.text();
    const result = await request("/tools/html-base64", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        html,
      }),
    });

    showToolResult(result);
  } catch (error) {
    showToolError(error.message);
  }
}

async function handlePresentationSuiteSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const data = new FormData(form);
  const labels = data.getAll("tabLabel").map((label) => String(label).trim());
  const sourceFiles = data.getAll("tabSourceFile").map((fileName) => String(fileName).trim());

  try {
    const result = await request("/tools/presentation-suite", {
      method: "POST",
      body: JSON.stringify({
        fileName: String(data.get("fileName")).trim(),
        tabCount: Number(data.get("tabCount")),
        labels,
        sourceFiles,
      }),
    });

    showPresentationSuiteResult(result);
  } catch (error) {
    showToolError(error.message);
  }
}

async function handleDemoBuilderSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const data = new FormData(form);

  try {
    const result = await request("/tools/demo-builder", {
      method: "POST",
      body: JSON.stringify({
        fileName: String(data.get("fileName")).trim(),
        scenarioCount: Number(data.get("scenarioCount")),
        logoText: String(data.get("logoText")).trim(),
        title: String(data.get("title")).trim(),
        subtitle: String(data.get("subtitle")).trim(),
        fontUi: String(data.get("fontUi")).trim(),
        fontMono: String(data.get("fontMono")).trim(),
        brandColor: String(data.get("brandColor")).trim(),
        accentColor: String(data.get("accentColor")).trim(),
        backgroundColor: String(data.get("backgroundColor")).trim(),
        fontColor: String(data.get("fontColor")).trim(),
      }),
    });

    showDemoBuilderResult(result);
  } catch (error) {
    showToolError(error.message);
  }
}

function showToolResult(result) {
  const panel = document.querySelector("#result-panel");
  const savedPath = document.querySelector("#saved-path");
  const output = document.querySelector("#base64-output");
  const preview = document.querySelector("#iframe-preview");
  const copyButton = document.querySelector("#copy-output");

  savedPath.textContent = `Saved as ${result.fileName}`;
  output.value = result.iframeSource;
  preview.src = result.iframeSource;
  panel.hidden = false;

  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.iframeSource);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy";
    }, 1200);
  });
}

function showPresentationSuiteResult(result) {
  const panel = document.querySelector("#result-panel");
  const savedPath = document.querySelector("#saved-path");
  const output = document.querySelector("#suite-output");
  const preview = document.querySelector("#iframe-preview");
  const copyButton = document.querySelector("#copy-output");

  savedPath.textContent = `Saved as ${result.fileName}`;
  output.value = result.html;
  preview.srcdoc = result.html;
  panel.hidden = false;

  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.html);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy HTML";
    }, 1200);
  });
}

function showDemoBuilderResult(result) {
  const panel = document.querySelector("#result-panel");
  const savedPath = document.querySelector("#saved-path");
  const output = document.querySelector("#demo-output");
  const preview = document.querySelector("#iframe-preview");
  const copyButton = document.querySelector("#copy-output");

  savedPath.textContent = `Saved as ${result.fileName}`;
  output.value = result.html;
  preview.srcdoc = result.html;
  panel.hidden = false;

  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.html);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy HTML";
    }, 1200);
  });
}

function showToolError(message) {
  const error = document.querySelector("#tool-error");
  error.textContent = message;
  error.classList.add("is-visible");
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

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

loadSession();
