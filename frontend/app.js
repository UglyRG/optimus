const API_BASE = "http://localhost:8787/api";
const app = document.querySelector("#app");
let activeUser = null;
let activeExpiresAt = null;
let suiteSourceFiles = [];
let demoContentJsonDirty = false;
let demoSizingJsonDirty = false;
let demoGlossaryJsonDirty = false;
const TOOL_RENDERERS = {
  "demo-builder": renderDemoBuilderTool,
  "presentation-suite": renderPresentationSuiteTool,
  "html-base64": renderHtmlBase64Tool,
  "pdf-base64": renderPdfBase64Tool,
};

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

async function renderIndex({ user, expiresAt }) {
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
        <button class="button button-secondary" id="manage-tools-button" type="button">Manage tools</button>
      </div>

      <div class="tool-groups" id="tool-groups" aria-label="Available tools">
        <div class="tool-list-state">Loading tools...</div>
      </div>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#manage-tools-button").addEventListener("click", renderToolAdminDashboard);

  try {
    const payload = await request("/tools");
    renderToolCatalog(payload.tools || []);
  } catch (error) {
    const toolGroups = document.querySelector("#tool-groups");
    if (toolGroups) {
      toolGroups.innerHTML = `<p class="error is-visible">Could not load tools: ${escapeHtml(error.message)}</p>`;
    }
  }
}

function renderToolCatalog(tools) {
  const toolGroups = document.querySelector("#tool-groups");
  if (!toolGroups) {
    return;
  }

  const visibleTools = tools
    .filter((tool) => TOOL_RENDERERS[tool.id])
    .sort(compareCatalogTools);
  const groups = groupCatalogTools(visibleTools);

  if (!groups.length) {
    toolGroups.innerHTML = '<div class="tool-list-state">No tools are available.</div>';
    return;
  }

  toolGroups.innerHTML = groups.map(renderToolGroup).join("");
  toolGroups.querySelectorAll("[data-tool-id]").forEach((button) => {
    button.addEventListener("click", () => {
      TOOL_RENDERERS[button.dataset.toolId]();
    });
  });
}

function groupCatalogTools(tools) {
  const groups = new Map();

  for (const tool of tools) {
    const groupName = String(tool.group || "Tools").trim() || "Tools";
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        order: Number.isFinite(tool.groupOrder) ? tool.groupOrder : Number.MAX_SAFE_INTEGER,
        tools: [],
      });
    }

    groups.get(groupName).tools.push(tool);
  }

  return Array.from(groups.values()).sort(
    (left, right) => left.order - right.order || left.name.localeCompare(right.name),
  );
}

function renderToolGroup(group) {
  return `
    <section class="tool-group">
      <div class="tool-group-head">
        <h2>${escapeHtml(group.name)}</h2>
      </div>
      <div class="tool-list">
        ${group.tools.map(renderToolRow).join("")}
      </div>
    </section>
  `;
}

function renderToolRow(tool) {
  return `
    <article class="tool-row">
      <div>
        <h3>${escapeHtml(tool.title)}</h3>
        <p>${escapeHtml(tool.description)}</p>
      </div>
      <button class="button button-secondary" data-tool-id="${escapeAttribute(tool.id)}" type="button">Open</button>
    </article>
  `;
}

function compareCatalogTools(left, right) {
  const leftGroupOrder = Number.isFinite(left.groupOrder) ? left.groupOrder : Number.MAX_SAFE_INTEGER;
  const rightGroupOrder = Number.isFinite(right.groupOrder) ? right.groupOrder : Number.MAX_SAFE_INTEGER;
  const leftDisplayOrder = Number.isFinite(left.displayOrder) ? left.displayOrder : Number.MAX_SAFE_INTEGER;
  const rightDisplayOrder = Number.isFinite(right.displayOrder) ? right.displayOrder : Number.MAX_SAFE_INTEGER;

  return (
    leftGroupOrder - rightGroupOrder ||
    String(left.group || "").localeCompare(String(right.group || "")) ||
    leftDisplayOrder - rightDisplayOrder ||
    String(left.title || "").localeCompare(String(right.title || ""))
  );
}

async function renderToolAdminDashboard() {
  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>Manage tools</h1>
          <p>Create groups, place hosted tools, and control their display order.</p>
        </div>
        <button class="button button-secondary" id="back-button" type="button">Back</button>
      </div>

      <div class="tool-list-state">Loading tool settings...</div>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#back-button").addEventListener("click", () => {
    renderIndex({ user: activeUser, expiresAt: activeExpiresAt });
  });

  try {
    renderToolAdminForm(await request("/admin/tool-catalog"));
  } catch (error) {
    const page = document.querySelector(".index-page");
    page.insertAdjacentHTML(
      "beforeend",
      `<p class="error is-visible">Could not load tool settings: ${escapeHtml(error.message)}</p>`,
    );
  }
}

function renderToolAdminForm(catalog) {
  const groups = [...(catalog.groups || [])].sort(
    (left, right) => left.displayOrder - right.displayOrder || left.name.localeCompare(right.name),
  );
  const tools = [...(catalog.tools || [])].sort((left, right) => {
    const leftGroup = groups.find((group) => group.id === left.groupId);
    const rightGroup = groups.find((group) => group.id === right.groupId);
    return (
      (leftGroup?.displayOrder || Number.MAX_SAFE_INTEGER) -
        (rightGroup?.displayOrder || Number.MAX_SAFE_INTEGER) ||
      left.displayOrder - right.displayOrder ||
      left.title.localeCompare(right.title)
    );
  });
  const page = document.querySelector(".index-page");

  page.querySelector(".tool-list-state")?.remove();
  page.querySelector("#tool-admin-form")?.remove();
  page.insertAdjacentHTML(
    "beforeend",
    `
      <form class="tool-panel admin-panel" id="tool-admin-form">
        <section class="admin-section">
          <div class="admin-section-head">
            <div>
              <h2>Groups</h2>
              <p>Lower numbers appear first.</p>
            </div>
            <button class="button button-secondary" id="add-tool-group" type="button">Add group</button>
          </div>
          <div class="admin-group-list" id="admin-group-list">
            ${groups.map(renderAdminGroupRow).join("")}
          </div>
        </section>

        <section class="admin-section">
          <div class="admin-section-head">
            <div>
              <h2>Hosted tools</h2>
              <p>Disable a tool to remove it from the index.</p>
            </div>
          </div>
          <div class="admin-tool-list" id="admin-tool-list">
            ${tools.map((tool) => renderAdminToolRow(tool, groups)).join("")}
          </div>
        </section>

        <p class="success" id="admin-success"></p>
        <p class="error" id="admin-error"></p>
        <button class="button button-primary" type="submit">Save tool layout</button>
      </form>
    `,
  );

  document.querySelector("#add-tool-group").addEventListener("click", handleAddToolGroup);
  document.querySelector("#admin-group-list").addEventListener("click", handleAdminGroupListClick);
  document.querySelector("#tool-admin-form").addEventListener("submit", handleToolAdminSubmit);
}

function renderAdminGroupRow(group) {
  return `
    <div class="admin-group-row" data-group-id="${escapeAttribute(group.id)}">
      <input name="groupId" type="hidden" value="${escapeAttribute(group.id)}" />
      <div class="field">
        <label for="group-name-${escapeAttribute(group.id)}">Group name</label>
        <input id="group-name-${escapeAttribute(group.id)}" name="groupName" value="${escapeAttribute(group.name)}" required />
      </div>
      <div class="field">
        <label for="group-order-${escapeAttribute(group.id)}">Order</label>
        <input id="group-order-${escapeAttribute(group.id)}" name="groupOrder" type="number" min="1" value="${escapeAttribute(group.displayOrder)}" required />
      </div>
      <button class="button button-secondary" data-remove-group="${escapeAttribute(group.id)}" type="button">Remove</button>
    </div>
  `;
}

function renderAdminToolRow(tool, groups) {
  return `
    <article class="admin-tool-row">
      <div class="admin-tool-copy">
        <h3>${escapeHtml(tool.title)}</h3>
        <p>${escapeHtml(tool.description)}</p>
        <input name="toolId" type="hidden" value="${escapeAttribute(tool.id)}" />
      </div>
      <label class="toggle-field">
        <input class="admin-tool-enabled" name="toolEnabled-${escapeAttribute(tool.id)}" type="checkbox"${tool.enabled ? " checked" : ""} />
        <span>Visible</span>
      </label>
      <div class="field">
        <label for="tool-group-${escapeAttribute(tool.id)}">Group</label>
        <select class="admin-tool-group" id="tool-group-${escapeAttribute(tool.id)}" name="toolGroup-${escapeAttribute(tool.id)}">
          ${groups
            .map((group) => {
              const selected = group.id === tool.groupId ? " selected" : "";
              return `<option value="${escapeAttribute(group.id)}"${selected}>${escapeHtml(group.name)}</option>`;
            })
            .join("")}
        </select>
      </div>
      <div class="field">
        <label for="tool-order-${escapeAttribute(tool.id)}">Order</label>
        <input class="admin-tool-order" id="tool-order-${escapeAttribute(tool.id)}" name="toolOrder-${escapeAttribute(tool.id)}" type="number" min="1" value="${escapeAttribute(tool.displayOrder)}" required />
      </div>
    </article>
  `;
}

function handleAddToolGroup() {
  const catalog = readToolAdminFormValues();
  const nextOrder = catalog.groups.reduce((max, group) => Math.max(max, group.displayOrder), 0) + 1;
  const id = uniqueFrontendGroupId("new-group", catalog.groups);
  catalog.groups.push({ id, name: "New group", displayOrder: nextOrder });
  renderToolAdminForm(catalog);
}

function handleAdminGroupListClick(event) {
  const button = event.target.closest("[data-remove-group]");
  if (!button) {
    return;
  }

  const groupId = button.dataset.removeGroup;
  const catalog = readToolAdminFormValues();
  if (catalog.tools.some((tool) => tool.groupId === groupId && tool.enabled)) {
    showAdminError("Move or hide tools in this group before removing it.");
    return;
  }

  catalog.groups = catalog.groups.filter((group) => group.id !== groupId);
  if (!catalog.groups.length) {
    showAdminError("At least one group is required.");
    return;
  }

  renderToolAdminForm(catalog);
}

async function handleToolAdminSubmit(event) {
  event.preventDefault();

  try {
    const catalog = readToolAdminFormValues();
    const result = await request("/admin/tool-catalog", {
      method: "POST",
      body: JSON.stringify(catalog),
    });
    renderToolAdminForm(result);
    showAdminSuccess("Tool layout saved.");
  } catch (error) {
    showAdminError(error.message);
  }
}

function readToolAdminFormValues() {
  const form = document.querySelector("#tool-admin-form");
  const groupRows = Array.from(form.querySelectorAll(".admin-group-row"));
  const groups = groupRows.map((row, index) => ({
    id: row.querySelector('input[name="groupId"]').value,
    name: row.querySelector('input[name="groupName"]').value.trim(),
    displayOrder: Math.max(1, Number(row.querySelector('input[name="groupOrder"]').value) || index + 1),
  }));

  const toolRows = Array.from(form.querySelectorAll(".admin-tool-row"));
  const tools = toolRows.map((row, index) => {
    const id = row.querySelector('input[name="toolId"]').value;
    return {
      id,
      groupId: row.querySelector(".admin-tool-group").value,
      displayOrder: Math.max(1, Number(row.querySelector(".admin-tool-order").value) || index + 1),
      enabled: row.querySelector(".admin-tool-enabled").checked,
    };
  });

  return { groups, tools };
}

function uniqueFrontendGroupId(value, groups) {
  const existingIds = new Set(groups.map((group) => group.id));
  const baseId = String(value || "group")
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "group";
  let id = baseId;
  let suffix = 2;

  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function showAdminSuccess(message) {
  const success = document.querySelector("#admin-success");
  if (!success) return;
  success.textContent = message;
  success.classList.add("is-visible");
}

function showAdminError(message) {
  const error = document.querySelector("#admin-error");
  if (!error) return;
  error.textContent = message;
  error.classList.add("is-visible");
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

function renderPdfBase64Tool() {
  app.innerHTML = `
    ${renderTopbar()}

    <section class="index-page">
      <div class="page-head">
        <div class="page-title">
          <h1>PDF to iframe Base64</h1>
          <p>Select a PDF file and save the generated string to Outputs.</p>
        </div>
        <button class="button button-secondary" id="back-button" type="button">Back</button>
      </div>

      <form class="tool-panel" id="pdf-base64-form">
        <div class="field">
          <label for="pdf-file">PDF file</label>
          <input id="pdf-file" name="pdfFile" type="file" accept=".pdf,application/pdf" required />
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
        <iframe id="iframe-preview" title="PDF preview"></iframe>
      </section>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
  document.querySelector("#back-button").addEventListener("click", () => {
    renderIndex({ user: activeUser, expiresAt: activeExpiresAt });
  });
  document.querySelector("#pdf-base64-form").addEventListener("submit", handlePdfBase64Submit);
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
  demoContentJsonDirty = false;
  demoSizingJsonDirty = false;
  demoGlossaryJsonDirty = false;
  const defaultContent = createDefaultDemoContent(2);
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
            <input id="demo-title" name="title" value="Use-case Demo" required />
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

        <details class="json-section" open>
          <summary><span>Content JSON</span><small id="demo-content-summary"></small></summary>
          <div class="json-section-body">
            <input class="json-file-input" id="demo-content-file" type="file" accept=".json,application/json" data-target="demo-content-json" data-preview="demo-content-preview" />
            <textarea class="content-json-input" id="demo-content-json" name="contentJson" aria-label="Content JSON" spellcheck="false">${escapeHtml(
              JSON.stringify(defaultContent, null, 2),
            )}</textarea>
            <div class="json-preview" id="demo-content-preview" aria-live="polite"></div>
          </div>
        </details>

        <details class="json-section">
          <summary><span>Sizing JSON</span><small id="demo-sizing-summary"></small></summary>
          <div class="json-section-body">
            <input class="json-file-input" id="demo-sizing-file" type="file" accept=".json,application/json" data-target="demo-sizing-json" data-preview="demo-sizing-preview" />
            <textarea class="content-json-input" id="demo-sizing-json" name="sizingJson" aria-label="Sizing JSON" spellcheck="false">${escapeHtml(
              JSON.stringify(createDefaultSizingContent(defaultContent), null, 2),
            )}</textarea>
            <div class="json-preview" id="demo-sizing-preview" aria-live="polite"></div>
          </div>
        </details>

        <details class="json-section">
          <summary><span>Glossary JSON</span><small id="demo-glossary-summary"></small></summary>
          <div class="json-section-body">
            <input class="json-file-input" id="demo-glossary-file" type="file" accept=".json,application/json" data-target="demo-glossary-json" data-preview="demo-glossary-preview" />
            <textarea class="content-json-input" id="demo-glossary-json" name="glossaryJson" aria-label="Glossary JSON" spellcheck="false">${escapeHtml(
              JSON.stringify(createDefaultGlossaryContent(defaultContent), null, 2),
            )}</textarea>
            <div class="json-preview" id="demo-glossary-preview" aria-live="polite"></div>
          </div>
        </details>

        <section class="form-preview" aria-label="Template preview">
          <div class="result-head">
            <div>
              <h2>Template preview</h2>
              <p>Uses the predefined values above before creating the HTML output.</p>
            </div>
          </div>
          <iframe class="live-preview-frame" id="demo-builder-live-preview" title="Live Demo Builder template preview"></iframe>
        </section>

        <p class="error" id="tool-error"></p>
        <button class="button button-primary" type="submit">Create Demo</button>
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
  const form = document.querySelector("#demo-builder-form");
  form.addEventListener("input", handleDemoBuilderFormInput);
  form.addEventListener("change", handleDemoBuilderFormChange);
  form.addEventListener("submit", handleDemoBuilderSubmit);
  updateDemoJsonPreviews();
  updateDemoBuilderLivePreview();
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

async function handlePdfBase64Submit(event) {
  event.preventDefault();

  const fileInput = document.querySelector("#pdf-file");
  const [file] = fileInput.files;
  if (!file) {
    showToolError("Choose a PDF file first.");
    return;
  }

  try {
    const base64 = await fileToBase64(file);
    const result = await request("/tools/pdf-base64", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        base64,
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

  try {
    const result = await request("/tools/demo-builder", {
      method: "POST",
      body: JSON.stringify(readDemoBuilderFormValues(form)),
    });

    showDemoBuilderResult(result);
  } catch (error) {
    showToolError(error.message);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error || new Error("Could not read file"));
    });
    reader.readAsDataURL(file);
  });
}

function readDemoBuilderFormValues(form = document.querySelector("#demo-builder-form")) {
  const data = new FormData(form);
  return {
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
    contentJson: String(data.get("contentJson")).trim(),
    sizingJson: String(data.get("sizingJson")).trim(),
    glossaryJson: String(data.get("glossaryJson")).trim(),
  };
}

function handleDemoBuilderFormInput(event) {
  if (event.target.id === "demo-content-json") {
    demoContentJsonDirty = true;
    updateJsonPreviewForTextarea(event.target);
  }

  if (event.target.id === "demo-sizing-json") {
    demoSizingJsonDirty = true;
    updateJsonPreviewForTextarea(event.target);
  }

  if (event.target.id === "demo-glossary-json") {
    demoGlossaryJsonDirty = true;
    updateJsonPreviewForTextarea(event.target);
  }

  if (event.target.id === "demo-scenario-count" && !demoContentJsonDirty) {
    const count = Math.min(8, Math.max(1, Number(event.target.value) || 1));
    const content = createDefaultDemoContent(count);
    document.querySelector("#demo-content-json").value = JSON.stringify(content, null, 2);
    updateJsonPreviewForTextarea(document.querySelector("#demo-content-json"));
    if (!demoSizingJsonDirty) {
      document.querySelector("#demo-sizing-json").value = JSON.stringify(createDefaultSizingContent(content), null, 2);
      updateJsonPreviewForTextarea(document.querySelector("#demo-sizing-json"));
    }
    if (!demoGlossaryJsonDirty) {
      document.querySelector("#demo-glossary-json").value = JSON.stringify(createDefaultGlossaryContent(content), null, 2);
      updateJsonPreviewForTextarea(document.querySelector("#demo-glossary-json"));
    }
  }

  updateDemoBuilderLivePreview();
}

async function handleDemoBuilderFormChange(event) {
  const input = event.target.closest(".json-file-input");
  if (!input || !input.files?.length) {
    return;
  }

  const target = document.querySelector(`#${input.dataset.target}`);
  const preview = document.querySelector(`#${input.dataset.preview}`);
  try {
    const text = await input.files[0].text();
    const parsed = JSON.parse(text);
    target.value = JSON.stringify(parsed, null, 2);
    markDemoJsonDirty(target.id);
    if (target.id === "demo-content-json") {
      syncDemoContentUpload(parsed);
    }
    updateJsonPreview(target.value, preview, input.files[0].name);
    updateDemoBuilderLivePreview();
  } catch (error) {
    preview.innerHTML = `<div class="json-preview-error">Could not load JSON: ${escapeHtml(error.message)}</div>`;
  }
}

function syncDemoContentUpload(parsed) {
  const scenarios = Array.isArray(parsed) ? parsed : parsed?.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 1) {
    return;
  }
  const count = Math.min(8, scenarios.length);
  document.querySelector("#demo-scenario-count").value = String(count);
  if (!demoSizingJsonDirty) {
    const sizingField = document.querySelector("#demo-sizing-json");
    sizingField.value = JSON.stringify(createDefaultSizingContent(scenarios.slice(0, count)), null, 2);
    updateJsonPreviewForTextarea(sizingField);
  }
  if (!demoGlossaryJsonDirty) {
    const glossaryField = document.querySelector("#demo-glossary-json");
    glossaryField.value = JSON.stringify(createDefaultGlossaryContent(scenarios.slice(0, count)), null, 2);
    updateJsonPreviewForTextarea(glossaryField);
  }
}

function markDemoJsonDirty(textareaId) {
  if (textareaId === "demo-content-json") demoContentJsonDirty = true;
  if (textareaId === "demo-sizing-json") demoSizingJsonDirty = true;
  if (textareaId === "demo-glossary-json") demoGlossaryJsonDirty = true;
}

function updateDemoJsonPreviews() {
  ["demo-content-json", "demo-sizing-json", "demo-glossary-json"].forEach((id) => {
    updateJsonPreviewForTextarea(document.querySelector(`#${id}`));
  });
}

function updateJsonPreviewForTextarea(textarea) {
  if (!textarea) return;
  const previewId = textarea.id.replace("-json", "-preview");
  updateJsonPreview(textarea.value, document.querySelector(`#${previewId}`));
}

function updateJsonPreview(jsonText, preview, fileName = "") {
  if (!preview) return;
  try {
    const parsed = JSON.parse(jsonText || "null");
    const summary = summarizeDemoJsonPreview(preview.id, parsed);
    const summaryEl = document.querySelector(`#${preview.id.replace("-preview", "-summary")}`);
    if (summaryEl) {
      summaryEl.textContent = summary;
    }
    preview.innerHTML = `
      <div class="json-preview-head">
        <strong>${escapeHtml(fileName || "Loaded JSON")}</strong>
        <span>${escapeHtml(summary)}</span>
      </div>
      <pre>${escapeHtml(JSON.stringify(parsed, null, 2).slice(0, 1800))}${JSON.stringify(parsed, null, 2).length > 1800 ? "\n..." : ""}</pre>
    `;
  } catch (error) {
    const summaryEl = document.querySelector(`#${preview.id.replace("-preview", "-summary")}`);
    if (summaryEl) {
      summaryEl.textContent = "Invalid JSON";
    }
    preview.innerHTML = `<div class="json-preview-error">Invalid JSON: ${escapeHtml(error.message)}</div>`;
  }
}

function summarizeDemoJsonPreview(previewId, parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed?.scenarios || parsed?.sizing || parsed?.glossary || [];
  if (previewId === "demo-content-preview") {
    const scenarios = Array.isArray(parsed) ? parsed : parsed?.scenarios || [];
    const messages = scenarios.reduce((total, scenario) => total + (Array.isArray(scenario.messages) ? scenario.messages.length : 0), 0);
    const docs = scenarios.reduce((total, scenario) => total + (Array.isArray(scenario.docs) ? scenario.docs.length : 0), 0);
    const logs = scenarios.reduce((total, scenario) => total + (Array.isArray(scenario.logs) ? scenario.logs.length : 0), 0);
    return `${scenarios.length} scenarios · ${messages} messages · ${docs} docs · ${logs} logs`;
  }
  if (previewId === "demo-sizing-preview") {
    return `${items.length} sizing entries`;
  }
  if (previewId === "demo-glossary-preview") {
    const scenarioGlossaries = items.filter((item) => Array.isArray(item.categories));
    const categories = scenarioGlossaries.length
      ? scenarioGlossaries.reduce((total, item) => total + item.categories.length, 0)
      : items.length;
    return `${scenarioGlossaries.length || "global"} glossary set${scenarioGlossaries.length === 1 ? "" : "s"} · ${categories} categories`;
  }
  return Array.isArray(items) ? `${items.length} entries` : "JSON object";
}

function updateDemoBuilderLivePreview() {
  const preview = document.querySelector("#demo-builder-live-preview");
  if (!preview) {
    return;
  }

  preview.srcdoc = buildDemoBuilderLivePreviewHtml(readDemoBuilderFormValues());
}

function buildDemoBuilderLivePreviewHtml(values) {
  const content = parseDemoContentJson(values.contentJson);
  if (content.error) {
    return buildDemoBuilderPreviewErrorHtml(content.error);
  }

  const sizingContent = parseDemoSizingJson(values.sizingJson, content.scenarios);
  if (sizingContent.error) {
    return buildDemoBuilderPreviewErrorHtml(sizingContent.error);
  }

  const glossaryContent = parseDemoGlossaryJson(values.glossaryJson, content.scenarios);
  if (glossaryContent.error) {
    return buildDemoBuilderPreviewErrorHtml(glossaryContent.error);
  }

  const scenarios = content.scenarios;
  const scenario = scenarios[0];
  const messages = scenario.messages.length ? scenario.messages : createDefaultDemoContent(1)[0].messages;
  const logs = scenario.logs.length ? scenario.logs : createDefaultDemoContent(1)[0].logs;
  const sizing = sizingContent.sizing[0];
  const fontUi = safePreviewCssFont(values.fontUi, "Inter, system-ui, sans-serif");
  const fontMono = safePreviewCssFont(values.fontMono, "JetBrains Mono, monospace");
  const scenarioOptions = scenarios.map((item) => `<option>${escapeHtml(item.label)}</option>`).join("");
  const scenarioHeaderControl = scenarios.length > 1
    ? `<label class="scenario-picker"><span>Scenario</span><select>${scenarioOptions}</select></label>`
    : `<div class="scenario-title"><span>Scenario</span><strong>${escapeHtml(scenario.label)}</strong></div>`;
  const glossaryPreview = renderPreviewGlossary(glossaryContent.glossary, scenario.id);
  const previewMessages = messages.slice(0, 4).map(renderPreviewMessage).join("");
  const previewDoc = renderPreviewPrerequisitesDoc(sizing);
  const previewLogs = logs
    .slice(0, 5)
    .map((log) => {
      const type = normalizePreviewLogType(log.type);
      return `<div class="log-line"><span class="log-type ${escapeAttribute(type)}">${escapeHtml(type)}</span><span>${escapeHtml(groupedPreviewLogText(log, logs))}</span></div>`;
    })
    .join("");
  const sizingMeta = `${sizing.capabilityTier} · ${sizing.connectedDataSources} data sources · ${sizing.connectedEnterpriseSystems} enterprise systems • ${sizing.commercialTier}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body { margin: 0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: ${escapeAttribute(values.backgroundColor || "#0e1117")}; color: ${escapeAttribute(values.fontColor || "#e8eaf0")}; font: 13px ${fontUi}; }
  .header { height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: ${escapeAttribute(values.brandColor || "#003a7d")}; border-bottom: 2px solid ${escapeAttribute(values.accentColor || "#c8a84b")}; flex: 0 0 auto; }
  .logo { background: #fff; color: ${escapeAttribute(values.brandColor || "#003a7d")}; border-radius: 4px; padding: 5px 9px; font-weight: 900; letter-spacing: 1px; }
  h1 { margin: 0; font-size: 14px; line-height: 1.1; }
  p { margin: 3px 0 0; color: rgba(255,255,255,.68); font-size: 11px; }
  .scenario-picker { margin-left: auto; display: flex; align-items: center; gap: 7px; }
  .scenario-picker span { color: rgba(255,255,255,.62); font: 9px ${fontMono}; text-transform: uppercase; letter-spacing: 1px; }
  .scenario-title { margin-left: auto; display: flex; align-items: center; gap: 7px; color: #fff; font-size: 10px; font-weight: 800; }
  .scenario-title span { color: rgba(255,255,255,.62); font: 9px ${fontMono}; text-transform: uppercase; letter-spacing: 1px; }
  select { max-width: 190px; height: 30px; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; padding: 0 8px; background: rgba(255,255,255,.12); color: #fff; font: inherit; }
  .glossary-button { border: 1px solid rgba(255,255,255,.22); border-radius: 6px; padding: 7px 9px; background: rgba(255,255,255,.12); color: #fff; font: 700 10px ${fontUi}; }
  .glossary-popover { position: absolute; right: 16px; top: 58px; width: 260px; max-height: 190px; overflow: hidden; border: 1px solid #2a3550; border-radius: 8px; background: #1e2638; box-shadow: 0 14px 36px rgba(0,0,0,.35); }
  .glossary-popover h2 { margin: 0; padding: 9px 11px; border-bottom: 1px solid #2a3550; font-size: 12px; }
  .glossary-popover-body { padding: 8px 11px; color: #9aa5b8; font-size: 10px; line-height: 1.45; }
  .glossary-popover strong { color: ${escapeAttribute(values.accentColor || "#c8a84b")}; font-family: ${fontMono}; }
  .main { flex: 1; min-height: 0; overflow: hidden; display: grid; grid-template-columns: 42% 58%; }
  .chat { min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: #f8f9fb; color: #1a2030; border-right: 1px solid #2a3550; scrollbar-width: thin; }
  .preview-messages { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 9px; padding: 10px; }
  .preview-msg { display: grid; grid-template-columns: 24px minmax(0,1fr) 24px; align-items: start; gap: 7px; }
  .preview-avatar { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: ${escapeAttribute(values.brandColor || "#003a7d")}; color: #fff; font-size: 12px; }
  .preview-avatar.user { grid-column: 3; background: #475569; }
  .bubble { grid-column: 2; width: fit-content; max-width: 100%; padding: 8px 10px; border-radius: 12px; background: #fff; border: 1px solid #d8dde8; line-height: 1.4; }
  .preview-msg.user .bubble { justify-self: end; background: ${escapeAttribute(values.brandColor || "#003a7d")}; color: #fff; border-color: ${escapeAttribute(values.brandColor || "#003a7d")}; }
  .preview-input { flex: 0 0 auto; display: flex; gap: 6px; padding: 8px; border-top: 1px solid #d8dde8; background: #fff; }
  .preview-input input { flex: 1; min-width: 0; border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px; background: #f8fafc; font: 10px ${fontUi}; }
  .preview-input button { border: 0; border-radius: 6px; padding: 6px 9px; background: ${escapeAttribute(values.brandColor || "#003a7d")}; color: #fff; font: 700 10px ${fontUi}; }
  .right { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: #141820; }
  .right-tabs { height: 30px; display: flex; border-bottom: 1px solid #2a3550; background: #1e2638; }
  .right-tab { display: flex; align-items: center; padding: 0 10px; border-bottom: 2px solid transparent; color: #64748b; font-size: 9px; font-weight: 800; }
  .right-tab.active { color: #e8eaf0; border-bottom-color: ${escapeAttribute(values.brandColor || "#003a7d")}; background: #141820; }
  .split-preview { flex: 1; min-height: 0; display: grid; grid-template-rows: 1fr 126px; }
  .doc-tabs { display: flex; min-height: 28px; border-bottom: 1px solid #2a3550; background: #1e2638; }
  .doc-tab { padding: 7px 9px; border-right: 1px solid #2a3550; color: #64748b; font-size: 9px; }
  .doc-tab.active { color: #e8eaf0; border-bottom: 2px solid ${escapeAttribute(values.brandColor || "#003a7d")}; background: #141820; }
  .docs-preview { min-height: 0; overflow: auto; }
  .doc { margin: 12px; border: 1px solid #2a3550; border-radius: 8px; overflow: hidden; background: #1e2638; }
  .doc-head { padding: 10px 12px; border-bottom: 1px solid #2a3550; font-weight: 800; }
  .doc-body { padding: 10px 12px; color: #9aa5b8; line-height: 1.5; }
  .log-head { border-top: 2px solid ${escapeAttribute(values.accentColor || "#c8a84b")}; border-bottom: 1px solid #2a3550; padding: 5px 10px; background: #1e2638; color: #64748b; display: flex; align-items: center; gap: 7px; font: 9px ${fontMono}; text-transform: uppercase; letter-spacing: 1px; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: #34d399; }
  .logs { min-height: 0; overflow: auto; padding: 6px 10px; background: #0b0f16; color: #9aa5b8; font: 9.5px ${fontMono}; scrollbar-width: thin; }
  .log-line { flex: 0 0 auto; }
  .log-line { display: flex; gap: 7px; align-items: flex-start; padding: 2px 0; border-bottom: 1px solid rgba(42,53,80,.25); }
  .log-type { min-width: 46px; padding: 1px 4px; border-radius: 3px; text-align: center; color: ${escapeAttribute(values.accentColor || "#c8a84b")}; background: rgba(200,168,75,.14); font-size: 8px; font-weight: 900; text-transform: uppercase; }
  .log-type.info { background: rgba(91,124,250,.15); color: #5b7cfa; }
  .log-type.data { background: rgba(251,146,60,.15); color: #fb923c; }
  .log-type.api { background: rgba(34,211,238,.15); color: #22d3ee; }
  .log-type.decision { background: rgba(251,191,36,.15); color: #fbbf24; }
  .log-type.success { background: rgba(52,211,153,.15); color: #34d399; }
  .log-type.warn { background: rgba(251,191,36,.15); color: #fbbf24; }
  .demo-bar { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-top: 1px solid #2a3550; background: #1e2638; flex: 0 0 auto; }
  .simulation-controls, .speed-control { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
  .demo-label { color: #64748b; font: 9px ${fontMono}; text-transform: uppercase; letter-spacing: 1px; }
  .demo-bar button { border: 0; border-radius: 6px; padding: 6px 9px; background: ${escapeAttribute(values.brandColor || "#003a7d")}; color: #fff; font: 700 10px ${fontUi}; }
  .demo-bar button:disabled { opacity: .45; }
  .speed-control button { padding: 4px 6px; border: 1px solid #2a3550; background: #141820; color: #9aa5b8; font: 9px ${fontMono}; }
  .speed-control button.active { border-color: ${escapeAttribute(values.brandColor || "#003a7d")}; background: ${escapeAttribute(values.brandColor || "#003a7d")}; color: #fff; }
  .sizing-info { margin-left: auto; color: #9aa5b8; font: 9px ${fontMono}; white-space: nowrap; }
</style>
</head>
<body>
  <header class="header">
    <div class="logo">${escapeHtml(values.logoText || "LOGO")}</div>
    <div><h1>${escapeHtml(values.title || "Use-case Demo")}</h1><p>${escapeHtml(values.subtitle || "Configurable agent simulation template")}</p></div>
    ${scenarioHeaderControl}
    <button type="button" class="glossary-button">ⓘ Glossary</button>
    ${glossaryPreview}
  </header>
  <main class="main">
    <section class="chat">
      <div class="preview-messages">${previewMessages}</div>
      <div class="preview-input"><input readonly placeholder="Write your message here..." /><button type="button">Send</button></div>
    </section>
    <section class="right">
      <div class="right-tabs">
        <div class="right-tab active">Docs + Agent Log</div>
        <div class="right-tab">Docs only</div>
        <div class="right-tab">Agent Log only</div>
      </div>
      <div class="split-preview">
        <div class="docs-preview">
          <div class="doc-tabs">
            <div class="doc-tab active">Prerequisites</div>
          </div>
          ${previewDoc}
        </div>
        <div>
          <div class="log-head"><span class="live-dot"></span><span>Agent Log — Live Processing</span></div>
          <div class="logs">${previewLogs}</div>
        </div>
      </div>
    </section>
  </main>
  <footer class="demo-bar">
    <div class="simulation-controls">
      <span class="demo-label">SIMULATION</span>
      <button type="button">Start</button>
      <button type="button" disabled>Pause</button>
    </div>
    <div class="sizing-info">${escapeHtml(sizingMeta)}</div>
    <div class="speed-control">
      <span class="demo-label">Speed</span>
      <button type="button">0.5x</button>
      <button type="button" class="active">1x</button>
      <button type="button">2x</button>
      <button type="button">3x</button>
    </div>
  </footer>
</body>
</html>`;
}

function createDefaultDemoContent(count) {
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

function createDefaultSizingContent(scenarios) {
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

function createDefaultGlossaryCategories() {
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

function createDefaultGlossaryContent(scenarios) {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    title: `${scenario.label} Glossary`,
    categories: createDefaultGlossaryCategories(),
  }));
}

function parseDemoContentJson(contentJson) {
  try {
    const parsed = JSON.parse(contentJson || "[]");
    const scenarios = Array.isArray(parsed) ? parsed : parsed.scenarios;
    if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 8) {
      return { error: "Content JSON must contain between 1 and 8 scenarios." };
    }

    return {
      scenarios: scenarios.map((scenario, index) => ({
        id: String(scenario.id || `scenario-${index + 1}`),
        label: String(scenario.label || `Scenario ${index + 1}`),
        messages: Array.isArray(scenario.messages) ? scenario.messages : [],
        docs: Array.isArray(scenario.docs) ? scenario.docs : [],
        logs: Array.isArray(scenario.logs) ? scenario.logs : [],
      })),
    };
  } catch {
    return { error: "Content JSON is not valid JSON." };
  }
}

function parseDemoSizingJson(sizingJson, scenarios) {
  try {
    const parsed = JSON.parse(sizingJson || "[]");
    const entries = Array.isArray(parsed) ? parsed : parsed.sizing;
    if (!Array.isArray(entries)) {
      return { error: "Sizing JSON must be an array or an object with a sizing array." };
    }

    const defaults = createDefaultSizingContent(scenarios);
    const byScenario = new Map(entries.map((entry) => [String(entry.scenarioId || ""), entry]));
    return {
      sizing: scenarios.map((scenario, index) => {
        const entry = byScenario.get(scenario.id) || {};
        const fallback = defaults[index];
        return {
          scenarioId: scenario.id,
          title: String(entry.title || fallback.title),
          subtitle: String(entry.subtitle || fallback.subtitle),
          capabilityTier: String(entry.capabilityTier || fallback.capabilityTier),
          commercialTier: String(entry.commercialTier || fallback.commercialTier),
          connectedDataSources: Number(entry.connectedDataSources ?? fallback.connectedDataSources) || 0,
          connectedEnterpriseSystems: Number(entry.connectedEnterpriseSystems ?? fallback.connectedEnterpriseSystems) || 0,
          implementationSize: String(entry.implementationSize || fallback.implementationSize),
          knowledgeDataSources: Array.isArray(entry.knowledgeDataSources) ? entry.knowledgeDataSources : fallback.knowledgeDataSources,
          enterpriseSystemConnections: Array.isArray(entry.enterpriseSystemConnections) ? entry.enterpriseSystemConnections : fallback.enterpriseSystemConnections,
          regulatoryFrameworks: Array.isArray(entry.regulatoryFrameworks) ? entry.regulatoryFrameworks : fallback.regulatoryFrameworks,
          clientSidePrerequisites: Array.isArray(entry.clientSidePrerequisites) ? entry.clientSidePrerequisites : fallback.clientSidePrerequisites,
          keySizingDrivers: Array.isArray(entry.keySizingDrivers) ? entry.keySizingDrivers : fallback.keySizingDrivers,
        };
      }),
    };
  } catch {
    return { error: "Sizing JSON is not valid JSON." };
  }
}

function parseDemoGlossaryJson(glossaryJson, scenarios) {
  try {
    const parsed = JSON.parse(glossaryJson || "[]");
    const glossary = Array.isArray(parsed) ? parsed : parsed.glossary;
    if (!Array.isArray(glossary)) {
      return { error: "Glossary JSON must be an array or an object with a glossary array." };
    }

    if (glossary.some((item) => Array.isArray(item.categories))) {
      return {
        glossary: scenarios.map((scenario, index) => {
          const entry = glossary.find((item) => String(item.scenarioId || "") === scenario.id) || glossary[index] || {};
          return {
            scenarioId: scenario.id,
            title: String(entry.title || `${scenario.label} Glossary`),
            categories: normalizePreviewGlossaryCategories(entry.categories),
          };
        }),
      };
    }

    return {
      glossary: [
        {
          scenarioId: "*",
          title: "Glossary",
          categories: normalizePreviewGlossaryCategories(glossary),
        },
      ],
    };
  } catch {
    return { error: "Glossary JSON is not valid JSON." };
  }
}

function normalizePreviewGlossaryCategories(categories) {
  const source = Array.isArray(categories) && categories.length ? categories : createDefaultGlossaryCategories();
  return source.map((category) => ({
    category: String(category.category || "Glossary"),
    entries: Array.isArray(category.entries)
      ? category.entries.map((entry) => ({
          term: String(entry.term || "Term"),
          definition: String(entry.definition || "Definition"),
        }))
      : [],
  }));
}

function renderPreviewMessage(message) {
  const role = message.role === "user" ? "user" : "agent";
  const avatar = role === "user" ? "👤" : "🤖";
  return `<div class="preview-msg ${role}">${role === "agent" ? `<div class="preview-avatar agent">${avatar}</div>` : "<div></div>"}<div class="bubble">${sanitizePreviewHtml(message.text || "Placeholder message")}</div>${role === "user" ? `<div class="preview-avatar user">${avatar}</div>` : "<div></div>"}</div>`;
}

function renderPreviewDoc(doc) {
  const safeDoc = doc || createDefaultDemoContent(1)[0].docs[0];
  const rows = (safeDoc.sections || [])
    .flatMap((section) => section.rows || [])
    .slice(0, 4)
    .map((row) => `${escapeHtml(row.label || "Field")}: ${escapeHtml(row.value || "Placeholder value")}`)
    .join("<br>");

  return `<article class="doc"><div class="doc-head">${escapeHtml(safeDoc.title || "Document Template")}</div><div class="doc-body">${escapeHtml(safeDoc.subtitle || "Evidence view")}<br>${rows}</div></article>`;
}

function renderPreviewPrerequisitesDoc(sizing) {
  const sourceItems = (sizing.knowledgeDataSources || []).slice(0, 3);
  const driverItems = (sizing.keySizingDrivers || []).slice(0, 3);
  const items = [
    ...sourceItems.map((item) => `✓ ${escapeHtml(item)}`),
    `Scope: ${escapeHtml(sizing.implementationSize)}`,
    ...driverItems.map((item) => `✓ ${escapeHtml(item)}`),
  ].join("<br>");

  return `<article class="doc"><div class="doc-head">⚙️ ${escapeHtml(sizing.title || "Deployment Prerequisites")}</div><div class="doc-body">${escapeHtml(sizing.subtitle || "Scenario prerequisites")}<br>${items}</div></article>`;
}

function renderPreviewGlossary(glossary, scenarioId) {
  const scenarioGlossary = (glossary || []).find((entry) => entry.scenarioId === scenarioId) || (glossary || []).find((entry) => entry.scenarioId === "*") || (glossary || [])[0] || { categories: [] };
  const entries = (scenarioGlossary.categories || [])
    .flatMap((category) => category.entries || [])
    .slice(0, 3)
    .map((entry) => `<strong>${escapeHtml(entry.term)}</strong>: ${escapeHtml(entry.definition)}`)
    .join("<br>");

  return `<div class="glossary-popover"><h2>${escapeHtml(scenarioGlossary.title || "Glossary")}</h2><div class="glossary-popover-body">${entries}</div></div>`;
}

function buildDemoBuilderPreviewErrorHtml(message) {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:18px;font:14px system-ui;color:#9f3d34;background:#fff1ee;"><strong>Preview unavailable</strong><br>${escapeHtml(message)}</body></html>`;
}

function sanitizePreviewHtml(value) {
  return escapeHtml(value).replace(/&lt;(\/?strong)&gt;/g, "<$1>");
}

function safePreviewCssFont(value, fallback) {
  const font = String(value || "").trim();
  if (!font || /[<>{};]/.test(font)) {
    return fallback;
  }

  return font.slice(0, 120);
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

function normalizePreviewLogType(type) {
  return String(type || "info").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "info";
}

function groupedPreviewLogText(log, logs) {
  const text = String(log.text || "");
  if (/^(┌|│|└|━━━)/.test(text)) {
    return text;
  }
  const group = String(log.group || "").trim();
  if (!group) {
    return text;
  }
  const groupEntries = logs.filter((item) => String(item.group || "").trim() === group);
  const index = groupEntries.indexOf(log);
  if (index === 0) {
    return `┌─ ${group} · ${text}`;
  }
  if (index === groupEntries.length - 1) {
    return `└─ ${text}`;
  }
  return `│  ${text}`;
}

loadSession();
