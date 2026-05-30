import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  DatabaseBackup,
  Download,
  Eye,
  EyeOff,
  Moon,
  Plus,
  RotateCcw,
  Save,
  Sun,
  Upload,
  Trash2,
  Pencil,
  X,
} from "lucide-react";
import "./styles.css";
import "./react.css";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";
const THEME_STORAGE_KEY = "optimus-theme";
const NOTELOG_CALIBRATION_STORAGE_KEY = "optimus-notelog-calibration";
const TOOL_VIEW_IDS = new Set([
  "padelog",
  "betlog",
  "notelog",
  "html-base64",
  "pdf-base64",
  "combine-pdfs",
  "csv-json-rows",
  "csv-qa-markdown",
  "token-usage",
  "presentation-suite",
  "demo-builder",
  "knowledge-expert",
]);
const NOTELOG_PAGE_WIDTH = 1414;
const NOTELOG_PAGE_HEIGHT = 1000;
const NOTELOG_CALIBRATION_STEPS = [
  { id: "topLeft", label: "top-left", x: 0, y: 0 },
  { id: "topRight", label: "top-right", x: NOTELOG_PAGE_WIDTH, y: 0 },
  { id: "bottomRight", label: "bottom-right", x: NOTELOG_PAGE_WIDTH, y: NOTELOG_PAGE_HEIGHT },
  { id: "bottomLeft", label: "bottom-left", x: 0, y: NOTELOG_PAGE_HEIGHT },
];
const TOKEN_USAGE_EXPLAINERS = {
  totalTokens: {
    title: "Total Tokens",
    body: "All counted usage tokens for the range. For OpenAI this includes text and audio input/output tokens. For Anthropic this includes input, cache, and output tokens.",
  },
  inputTokens: {
    title: "Input Tokens",
    body: "Tokens sent to the model, including prompts, context, retrieved content, and cache-related input tokens when the provider reports them.",
  },
  outputTokens: {
    title: "Output Tokens",
    body: "Tokens generated to responses.",
  },
  cachedInputTokens: {
    title: "Cached Input",
    body: "OpenAI input tokens served from prompt cache rather than processed as fresh input.",
  },
  cacheCreationInputTokens: {
    title: "Cache Creation",
    body: "Anthropic input tokens used to create prompt cache entries.",
  },
  cacheReadInputTokens: {
    title: "Cache Read",
    body: "Anthropic input tokens read from prompt cache.",
  },
  inputAudioTokens: {
    title: "Input Audio",
    body: "OpenAI audio tokens sent as input.",
  },
  outputAudioTokens: {
    title: "Output Audio",
    body: "OpenAI audio tokens generated as output.",
  },
};

function viewFromLocation() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin") return { name: "admin" };
  const toolMatch = path.match(/^\/tools\/([^/]+)$/);
  if (toolMatch && TOOL_VIEW_IDS.has(toolMatch[1])) return { name: toolMatch[1] };
  return { name: "dashboard" };
}

function pathForView(view) {
  if (view.name === "admin") return "/admin";
  if (TOOL_VIEW_IDS.has(view.name)) return `/tools/${view.name}`;
  return "/";
}

function outputDownloadUrl(fileName) {
  return `/api/outputs/download/${encodeURIComponent(fileName)}`;
}

function navigateToView(setView, view, options = {}) {
  const path = pathForView(view);
  if (window.location.pathname !== path) {
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
  }
  setView(view);
}

function App() {
  const [theme, setTheme] = useState(() => storedTheme());
  const [session, setSession] = useState(null);
  const [view, setView] = useState(() => viewFromLocation());
  const [status, setStatus] = useState({ loading: true, error: "" });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    function handlePopState() {
      setView(viewFromLocation());
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    let alive = true;
    request("/auth/session")
      .then((payload) => {
        if (!alive) return;
        setSession(payload.authenticated ? payload : null);
        setStatus({ loading: false, error: "" });
      })
      .catch(() => {
        if (!alive) return;
        setSession(null);
        setStatus({ loading: false, error: "" });
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleLogin(credentials) {
    const payload = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    setSession(payload);
  }

  async function handleLogout() {
    await request("/auth/logout", { method: "POST" }).catch(() => {});
    setSession(null);
    navigateToView(setView, { name: "dashboard" }, { replace: true });
  }

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  }

  if (status.loading) {
    return <div className="tool-list-state react-boot-state">Loading Optimus...</div>;
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <>
      <Topbar
        showManageTools={view.name === "dashboard"}
        theme={theme}
        onHome={() => navigateToView(setView, { name: "dashboard" })}
        onManageTools={() => navigateToView(setView, { name: "admin" })}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
      />
      {view.name === "admin" ? (
        <ToolAdminPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "padelog" ? (
        <PadelogPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "betlog" ? (
        <BetlogPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "notelog" ? (
        <NotelogPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "html-base64" ? (
        <Base64ToolPage
          type="html"
          title="HTML to iframe Base64"
          description="Select an HTML file and save the generated string to Outputs."
          accept=".html,.htm,text/html"
          endpoint="/tools/html-base64"
          onBack={() => navigateToView(setView, { name: "dashboard" })}
        />
      ) : view.name === "pdf-base64" ? (
        <Base64ToolPage
          type="pdf"
          title="PDF to iframe Base64"
          description="Select a PDF file and save the generated string to Outputs."
          accept=".pdf,application/pdf"
          endpoint="/tools/pdf-base64"
          onBack={() => navigateToView(setView, { name: "dashboard" })}
        />
      ) : view.name === "combine-pdfs" ? (
        <CombinePdfsPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "csv-json-rows" ? (
        <CsvJsonRowsPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "csv-qa-markdown" ? (
        <CsvQaMarkdownPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "token-usage" ? (
        <TokenUsagePage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "presentation-suite" ? (
        <PresentationSuitePage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "demo-builder" ? (
        <DemoBuilderPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : view.name === "knowledge-expert" ? (
        <KnowledgeExpertPage onBack={() => navigateToView(setView, { name: "dashboard" })} />
      ) : (
        <DashboardPage onOpenTool={(toolId) => navigateToView(setView, { name: toolId })} />
      )}
    </>
  );
}

function LoginPage({ onLogin }) {
  const [name, setName] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onLogin({ name: name.trim(), accessKey });
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="login-page">
      <form className="login-tab" onSubmit={submit}>
        <h1>Optimus</h1>
        <p>Sign in to continue.</p>
        <div className="form-stack">
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="access-key">Access key</label>
            <input
              id="access-key"
              name="accessKey"
              type="password"
              autoComplete="current-password"
              required
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
            />
          </div>
          <p className={`error ${error ? "is-visible" : ""}`}>{error}</p>
          <button className="button button-primary" type="submit" disabled={submitting}>
            {submitting ? "Logging in..." : "Log in"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Topbar({ showManageTools, theme, onHome, onManageTools, onToggleTheme, onLogout }) {
  const [version, setVersion] = useState("v6");

  useEffect(() => {
    request("/version")
      .then((payload) => setVersion(formatAppVersion(payload.version)))
      .catch(() => setVersion("Version unavailable"));
  }, []);

  const isDark = theme === "dark";

  return (
    <header className="topbar">
      <a
        className="brand"
        href="/"
        aria-label="Go to Optimus home"
        onClick={(event) => {
          event.preventDefault();
          onHome();
        }}
      >
        <img className="brand-logo" src="/assets/optimus-vertical.svg" alt="Optimus" />
      </a>
      <div className="topbar-actions">
        {showManageTools ? (
          <button className="button button-secondary" type="button" onClick={onManageTools}>
            Manage tools
          </button>
        ) : null}
        <button
          className="theme-toggle"
          type="button"
          aria-pressed={isDark}
          aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
          title={`Switch to ${isDark ? "light" : "dark"} theme`}
          onClick={onToggleTheme}
        >
          {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          <span>{isDark ? "Light" : "Dark"}</span>
        </button>
        <button className="button button-secondary" type="button" onClick={onLogout}>
          Log out
        </button>
      </div>
      <div className="topbar-version">{version}</div>
    </header>
  );
}

function DashboardPage({ onOpenTool }) {
  const [tools, setTools] = useState({ loading: true, error: "", items: [] });
  const [summary, setSummary] = useState({ loading: true, error: "", groups: [] });
  const [insightsModal, setInsightsModal] = useState(null);

  useEffect(() => {
    request("/tools")
      .then((payload) => setTools({ loading: false, error: "", items: payload.tools || [] }))
      .catch((error) => setTools({ loading: false, error: error.message, items: [] }));

    loadMonthlySummary().then(setSummary);
  }, []);

  const groupedTools = useMemo(() => groupCatalogTools(tools.items), [tools.items]);

  return (
    <section className="index-page dashboard-page">
      <section className="dashboard-layout">
        <main className="dashboard-main">
          <section className="month-summary" aria-label="Monthly performance summary">
            <div className="month-summary-grid">
              {summary.loading ? <div className="tool-list-state">Loading monthly performance...</div> : null}
              {summary.error ? <p className="error is-visible">{summary.error}</p> : null}
              {!summary.loading && !summary.error ? summary.groups.map((group) => <MonthSummaryGroup key={group.title} group={group} onOpenInsights={openInsightsModal} />) : null}
            </div>
          </section>

          <div className="tool-groups" aria-label="Available tools">
            {tools.loading ? <div className="tool-list-state">Loading tools...</div> : null}
            {tools.error ? <p className="error is-visible">Could not load tools: {tools.error}</p> : null}
            {!tools.loading && !tools.error && !groupedTools.length ? <div className="tool-list-state">No tools are available.</div> : null}
            {groupedTools.map((group) => (
              <ToolGroup key={group.name} group={group} onOpenTool={onOpenTool} />
            ))}
          </div>
        </main>

      </section>
      {insightsModal ? <PerformanceInsightsModal state={insightsModal} setState={setInsightsModal} onClose={() => setInsightsModal(null)} /> : null}
    </section>
  );

  async function openInsightsModal(toolId) {
    openPerformanceInsightsModal(toolId, setInsightsModal);
  }
}

function MonthSummaryGroup({ group, onOpenInsights }) {
  return (
    <article className={`month-summary-group is-${group.variant}`}>
      <div className="month-summary-group-head">
        <h3>{group.title}</h3>
        <button className="button button-primary month-summary-ai-button" type="button" onClick={() => onOpenInsights(group.toolId)}>
          AI insights
        </button>
      </div>
      <div className="month-summary-metrics">
        {group.metrics.map((metric) => (
          <div className="month-summary-metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small className={metric.tone}>{metric.deltaLabel}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function PerformanceInsightsModal({ state, setState, onClose }) {
  const { toolId, insights, index, loading, generating, error } = state;
  const toolName = toolId === "betlog" ? "Betlog" : "Padelog";
  const insight = insights[index] || null;
  const subtitle = insights.length
    ? `${toolName}: showing saved runs. Generate a new one when you want a fresh read.`
    : `${toolName}: no saved insight yet. Generate one from the full JSON history.`;

  async function generateInsight() {
    if (generating) return;
    setState((current) => ({ ...current, loading: true, generating: true, error: "" }));
    try {
      const nextInsight = await request(`/tools/${toolId}/analysis`, { method: "POST" });
      setState((current) => ({
        ...current,
        insights: [nextInsight, ...current.insights],
        index: 0,
        loading: false,
        generating: false,
        error: "",
      }));
    } catch (generateError) {
      setState((current) => ({ ...current, loading: false, generating: false, error: generateError.message }));
    }
  }

  function step(delta) {
    setState((current) => ({
      ...current,
      index: Math.min(Math.max(current.index + delta, 0), current.insights.length - 1),
    }));
  }

  return (
    <div className="ai-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-insights-title">
        <div className="ai-modal-head">
          <div>
            <h2 id="ai-insights-title">AI insights</h2>
            <p>{subtitle}</p>
          </div>
          <button className="button button-secondary ai-modal-close" type="button" aria-label="Close AI insights" onClick={onClose}>Close</button>
        </div>
        <div className="ai-modal-body">
          {loading ? <div className="ai-insights-loading">{generating ? "Generating a fresh insight..." : "Loading saved insights..."}</div> : null}
          {!loading && error ? <div className="ai-insights-error">{error}</div> : null}
          {!loading && !error && !insights.length ? <div className="ai-insights-empty">No saved runs yet.</div> : null}
          {!loading && !error && insight ? <InsightBody insight={insight} /> : null}
        </div>
        <div className="ai-modal-actions">
          <button className="button button-secondary" type="button" disabled={!insights.length || index >= insights.length - 1 || generating} onClick={() => step(1)}>{"<"}</button>
          <span className="ai-modal-counter">{insights.length ? `${index + 1} / ${insights.length}` : "0 / 0"}</span>
          <button className="button button-secondary" type="button" disabled={!insights.length || index <= 0 || generating} onClick={() => step(-1)}>{">"}</button>
          <button className="button button-primary" type="button" disabled={generating} onClick={generateInsight}>{generating ? "Generating..." : "Generate new"}</button>
        </div>
      </div>
    </div>
  );
}

async function openPerformanceInsightsModal(toolId, setState) {
  setState({ toolId, insights: [], index: 0, loading: true, generating: false, error: "" });
  try {
    const payload = await request(`/tools/${toolId}/analysis`);
    setState({ toolId, insights: payload.insights || [], index: 0, loading: false, generating: false, error: "" });
  } catch (error) {
    setState({ toolId, insights: [], index: 0, loading: false, generating: false, error: error.message });
  }
}

function InsightBody({ insight }) {
  const text = String(insight?.insight || "").trim();
  if (!text || isModelOnlyInsightText(text)) {
    return <div className="ai-insights-error">No insight text was returned. Please try generating it again.</div>;
  }
  return (
    <>
      <div className="ai-insights-run-meta">{formatPerformanceInsightRunMeta(insight)}</div>
      <div className="ai-insights-text">{formatInsightTextNodes(text)}</div>
    </>
  );
}

function ToolGroup({ group, onOpenTool }) {
  return (
    <section className="tool-group">
      <div className="tool-group-head">
        <h2>{group.name}</h2>
      </div>
      <div className="tool-list">
        {group.tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} onOpenTool={onOpenTool} />
        ))}
      </div>
    </section>
  );
}

function ToolRow({ tool, onOpenTool }) {
  const href = pathForView({ name: tool.id });
  return (
    <article className="tool-row">
      <div>
        <h3>{tool.title}</h3>
        <p>{tool.description}</p>
      </div>
      <a
        className="button button-secondary react-open-link"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onOpenTool(tool.id);
        }}
      >
        <span>Open</span>
      </a>
    </article>
  );
}

function ToolAdminPage({ onBack }) {
  const [catalog, setCatalog] = useState(null);
  const [status, setStatus] = useState({ loading: true, saving: false, success: "", error: "" });

  useEffect(() => {
    request("/admin/tool-catalog")
      .then((payload) => {
        setCatalog(sortAdminCatalog(payload));
        setStatus({ loading: false, saving: false, success: "", error: "" });
      })
      .catch((error) => setStatus({ loading: false, saving: false, success: "", error: `Could not load tool settings: ${error.message}` }));
  }, []);

  function updateCatalog(nextCatalog) {
    setCatalog(sortAdminCatalog(nextCatalog));
    setStatus((current) => ({ ...current, success: "", error: "" }));
  }

  function addGroup() {
    const nextOrder = Math.max(0, ...catalog.groups.map((group) => Number(group.displayOrder) || 0)) + 1;
    updateCatalog({
      ...catalog,
      groups: [...catalog.groups, { id: uniqueGroupId("new-group", catalog.groups), name: "New group", displayOrder: nextOrder }],
    });
  }

  function removeGroup(groupId) {
    if (catalog.tools.some((tool) => tool.groupId === groupId && tool.enabled)) {
      setStatus((current) => ({ ...current, error: "Move or hide tools in this group before removing it.", success: "" }));
      return;
    }
    const groups = catalog.groups.filter((group) => group.id !== groupId);
    if (!groups.length) {
      setStatus((current) => ({ ...current, error: "At least one group is required.", success: "" }));
      return;
    }
    updateCatalog({ ...catalog, groups });
  }

  function updateGroup(groupId, patch) {
    updateCatalog({
      ...catalog,
      groups: catalog.groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
    });
  }

  function updateTool(toolId, patch) {
    updateCatalog({
      ...catalog,
      tools: catalog.tools.map((tool) => (tool.id === toolId ? { ...tool, ...patch } : tool)),
    });
  }

  async function save(event) {
    event.preventDefault();
    setStatus({ loading: false, saving: true, success: "", error: "" });
    try {
      const result = await request("/admin/tool-catalog", {
        method: "POST",
        body: JSON.stringify(catalog),
      });
      setCatalog(sortAdminCatalog(result));
      setStatus({ loading: false, saving: false, success: "Tool layout saved.", error: "" });
    } catch (error) {
      setStatus({ loading: false, saving: false, success: "", error: error.message });
    }
  }

  async function backup() {
    setStatus((current) => ({ ...current, success: "", error: "" }));
    try {
      const result = await request("/admin/backup");
      downloadBase64File(result.base64, result.fileName || "optimus-backup.zip", result.mimeType || "application/zip");
      setStatus((current) => ({ ...current, success: "Backup downloaded." }));
    } catch (error) {
      setStatus((current) => ({ ...current, error: error.message }));
    }
  }

  async function restore(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const confirmed = window.confirm("Restore this backup? Current tool layout, Padelog, Betlog, and Notelog data will be replaced.");
    if (!confirmed) {
      event.target.value = "";
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const result = await request("/admin/restore", {
        method: "POST",
        body: JSON.stringify({ base64 }),
      });
      setCatalog(sortAdminCatalog(result.catalog));
      const restored = result.restored || {};
      setStatus({
        loading: false,
        saving: false,
        success: `Backup restored. ${restored.matches || 0} matches, ${restored.bets || 0} bets, and ${restored.notes || 0} notes restored.`,
        error: "",
      });
    } catch (error) {
      setStatus((current) => ({ ...current, error: error.message, success: "" }));
    } finally {
      event.target.value = "";
    }
  }

  return (
    <section className="index-page">
      <div className="page-head">
        <div className="page-title">
          <h1>Manage tools</h1>
          <p>Create groups, place hosted tools, and control their display order.</p>
        </div>
        <button className="button button-secondary react-icon-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Back</span>
        </button>
      </div>

      {status.loading ? <div className="tool-list-state">Loading tool settings...</div> : null}
      {status.error ? <p className="error is-visible">{status.error}</p> : null}

      {catalog ? (
        <form className="tool-panel admin-panel" onSubmit={save}>
          <section className="admin-section">
            <div className="admin-section-head">
              <div>
                <h2>Backup and restore</h2>
                <p>Download or restore the local data files for tools, Padelog, Betlog, and Notelog.</p>
              </div>
              <div className="admin-actions">
                <button className="button button-secondary react-icon-button" type="button" onClick={backup}>
                  <DatabaseBackup size={16} aria-hidden="true" />
                  <span>Backup</span>
                </button>
                <label className="button button-secondary react-icon-button react-file-button">
                  <Upload size={16} aria-hidden="true" />
                  <span>Restore</span>
                  <input type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange={restore} />
                </label>
              </div>
            </div>
          </section>

          <section className="admin-section">
            <div className="admin-section-head">
              <div>
                <h2>Groups</h2>
                <p>Lower numbers appear first.</p>
              </div>
              <button className="button button-secondary react-icon-button" type="button" onClick={addGroup}>
                <Plus size={16} aria-hidden="true" />
                <span>Add group</span>
              </button>
            </div>
            <div className="admin-group-list">
              {catalog.groups.map((group) => (
                <div className="admin-group-row" key={group.id}>
                  <div className="field">
                    <label htmlFor={`group-name-${group.id}`}>Group name</label>
                    <input id={`group-name-${group.id}`} value={group.name} required onChange={(event) => updateGroup(group.id, { name: event.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor={`group-order-${group.id}`}>Order</label>
                    <input
                      id={`group-order-${group.id}`}
                      type="number"
                      min="1"
                      value={group.displayOrder}
                      required
                      onChange={(event) => updateGroup(group.id, { displayOrder: Number(event.target.value) || 1 })}
                    />
                  </div>
                  <button className="button button-secondary react-icon-button" type="button" onClick={() => removeGroup(group.id)}>
                    <RotateCcw size={16} aria-hidden="true" />
                    <span>Remove</span>
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="admin-section">
            <div className="admin-section-head">
              <div>
                <h2>Hosted tools</h2>
                <p>Disable a tool to remove it from the index.</p>
              </div>
            </div>
            <div className="admin-tool-list">
              {catalog.tools.map((tool) => (
                <article className="admin-tool-row" key={tool.id}>
                  <div className="admin-tool-copy">
                    <h3>{tool.title}</h3>
                    <p>{tool.description}</p>
                  </div>
                  <label className="toggle-field">
                    <input type="checkbox" checked={tool.enabled} onChange={(event) => updateTool(tool.id, { enabled: event.target.checked })} />
                    {tool.enabled ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
                    <span>Visible</span>
                  </label>
                  <div className="field">
                    <label htmlFor={`tool-group-${tool.id}`}>Group</label>
                    <select id={`tool-group-${tool.id}`} value={tool.groupId} onChange={(event) => updateTool(tool.id, { groupId: event.target.value })}>
                      {catalog.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`tool-order-${tool.id}`}>Order</label>
                    <input
                      id={`tool-order-${tool.id}`}
                      type="number"
                      min="1"
                      value={tool.displayOrder}
                      required
                      onChange={(event) => updateTool(tool.id, { displayOrder: Number(event.target.value) || 1 })}
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>

          <p className={`success ${status.success ? "is-visible" : ""}`}>{status.success}</p>
          <p className={`error ${status.error ? "is-visible" : ""}`}>{status.error}</p>
          <button className="button button-primary react-icon-button" type="submit" disabled={status.saving}>
            <Save size={16} aria-hidden="true" />
            <span>{status.saving ? "Saving..." : "Save tool layout"}</span>
          </button>
        </form>
      ) : null}
    </section>
  );
}

function PadelogPage({ onBack }) {
  const emptyMatch = { club: "", date: localDateInputValue(), teammate: "", opponents: "", result: "Won", sets: "" };
  const [matches, setMatches] = useState([]);
  const [form, setForm] = useState(emptyMatch);
  const [range, setRange] = useState("month");
  const [customRange, setCustomRange] = useState({ from: `${new Date().getFullYear()}-01-01`, to: localDateInputValue() });
  const [groupBy, setGroupBy] = useState("month");
  const [pageSize, setPageSize] = useState("25");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [csvPreview, setCsvPreview] = useState("");
  const [insightsModal, setInsightsModal] = useState(null);

  useEffect(() => {
    request("/tools/padelog/matches")
      .then((payload) => setMatches(payload.matches || []))
      .catch((error) => setMessage({ type: "error", text: `Could not load matches: ${error.message}` }));
  }, []);

  const activeRange = activeDateRange(range, customRange);
  const stats = summarizePadelogMatches(matches.filter((match) => isDateInRange(match.date, activeRange)));
  const displayMatches = useMemo(() => sortPadelogDisplay(matches, groupBy), [matches, groupBy]);
  const paged = paginate(displayMatches, page, pageSize);

  async function saveMatch(event) {
    event.preventDefault();
    try {
      const payload = await request("/tools/padelog/matches", { method: "POST", body: JSON.stringify({ match: form }) });
      setMatches(payload.matches || []);
      setForm(emptyMatch);
      setPage(1);
      setMessage({ type: "success", text: "Match saved." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function importCsv(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = parsePadelogCsv(await file.text());
      setCsvPreview(`${rows.length} row${rows.length === 1 ? "" : "s"} ready`);
      const payload = await request("/tools/padelog/matches", { method: "POST", body: JSON.stringify({ matches: rows }) });
      setMatches(payload.matches || []);
      setPage(1);
      setMessage({ type: "success", text: `Imported ${payload.imported || rows.length} matches.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
      setCsvPreview("");
    } finally {
      event.target.value = "";
    }
  }

  async function updateMatch() {
    try {
      const payload = await request("/tools/padelog/update", { method: "POST", body: JSON.stringify({ id: editingId, match: draft }) });
      setMatches(payload.matches || []);
      setEditingId("");
      setDraft(null);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function deleteMatch(id) {
    try {
      const payload = await request("/tools/padelog/delete", { method: "POST", body: JSON.stringify({ id }) });
      setMatches(payload.matches || []);
      if (editingId === id) setEditingId("");
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  return (
    <ToolPageShell
      title="Padelog"
      description="Store padel match results and track performance across month-to-date, year-to-date, or custom periods."
      onBack={onBack}
    >
      <StatsPanel
        caption={`${activeRange.label}: ${stats.matches} match${stats.matches === 1 ? "" : "es"}.`}
        range={range}
        onRange={setRange}
        customRange={customRange}
        onCustomRange={setCustomRange}
        onInsights={() => openPerformanceInsightsModal("padelog", setInsightsModal)}
        metrics={[
          ["Matches", stats.matches],
          ["Wins", stats.wins],
          ["Losses", stats.losses],
          ["Draws", stats.draws],
          ["Win rate", `${stats.winRate}%`],
          ["Unique clubs", stats.clubs],
          ["Teammates", stats.teammates],
          ["Set scores", stats.setsLogged],
        ]}
      />
      {insightsModal ? <PerformanceInsightsModal state={insightsModal} setState={setInsightsModal} onClose={() => setInsightsModal(null)} /> : null}

      <section className="padelog-layout">
        <form className="tool-panel" onSubmit={saveMatch}>
          <PanelTitle title="Manual entry" body="Add one match at a time." />
          <div className="form-grid padelog-form-grid">
            <Field label="Padel Club"><input required value={form.club} onChange={(event) => setForm({ ...form, club: event.target.value })} /></Field>
            <Field label="Date"><input type="date" required value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></Field>
          </div>
          <div className="form-grid padelog-form-grid">
            <Field label="Teammate"><input required value={form.teammate} onChange={(event) => setForm({ ...form, teammate: event.target.value })} /></Field>
            <Field label="Result">
              <select value={form.result} onChange={(event) => setForm({ ...form, result: event.target.value })}>
                <option>Won</option><option>Lost</option><option>Draw</option>
              </select>
            </Field>
          </div>
          <Field label="Opponents"><input required placeholder="Player A / Player B" value={form.opponents} onChange={(event) => setForm({ ...form, opponents: event.target.value })} /></Field>
          <Field label="Sets"><input required pattern="\d+-\d+" placeholder="2-1" value={form.sets} onChange={(event) => setForm({ ...form, sets: event.target.value })} /></Field>
          <ScopedMessage message={message} />
          <button className="button button-primary" type="submit">Save match</button>
        </form>

        <section className="tool-panel">
          <PanelTitle title="CSV import" body="Columns: Padel Club, Date, Teamate, Opponents, Result, Sets." />
          <Field label="CSV file"><input type="file" accept=".csv,text/csv" onChange={importCsv} /></Field>
          <div className="padelog-import-actions">
            <button className="button button-secondary" type="button" onClick={() => downloadTextFile(padelogTemplate(), "padelog-template.csv", "text/csv")}>Download template</button>
          </div>
          {csvPreview ? <div className="padelog-csv-preview"><strong>{csvPreview}</strong></div> : null}
        </section>
      </section>

      <HistoryPanel
        title="Match history"
        count={`${matches.length} saved match${matches.length === 1 ? "" : "es"}${matches.length ? ` · showing ${paged.start + 1}-${paged.end}.` : "."}`}
        groupOptions={[["month", "Month"], ["club", "Padel Club"], ["none", "None"]]}
        groupBy={groupBy}
        onGroupBy={(value) => { setGroupBy(value); setPage(1); }}
        pageSize={pageSize}
        onPageSize={(value) => { setPageSize(value); setPage(1); }}
        page={page}
        totalPages={paged.totalPages}
        onPage={setPage}
      >
        <table className="padelog-table">
          <thead><tr><th>Date</th><th>Padel Club</th><th>Teammate</th><th>Opponents</th><th>Result</th><th>Sets</th><th></th></tr></thead>
          <tbody>
            {!matches.length ? <tr><td colSpan="7">No matches yet.</td></tr> : null}
            {withGroups(paged.rows, groupBy, padelogGroupLabel).map((item) =>
              item.type === "group" ? (
                <tr className="padelog-group-row" key={item.key}><td colSpan="7">{item.label}</td></tr>
              ) : editingId === item.row.id ? (
                <PadelogEditRow key={item.row.id} draft={draft} setDraft={setDraft} onSave={updateMatch} onCancel={() => setEditingId("")} />
              ) : (
                <tr key={item.row.id}>
                  <td>{formatDisplayDate(item.row.date)}</td><td>{item.row.club}</td><td>{item.row.teammate}</td><td>{item.row.opponents}</td>
                  <td><span className={`padelog-result ${item.row.result.toLowerCase()}`}>{item.row.result}</span></td><td>{item.row.sets}</td>
                  <td><RowActions onEdit={() => { setEditingId(item.row.id); setDraft(item.row); }} onDelete={() => deleteMatch(item.row.id)} /></td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </HistoryPanel>
    </ToolPageShell>
  );
}

function BetlogPage({ onBack }) {
  const emptyBet = {
    date: localDateInputValue(), time: localTimeInputValue(), betId: "", betType: "", stake: "", freeBet: false, status: "",
    returnAmount: "0", selection: "", odds: "", market: "", match: "", score: "", outcomeType: "single", legs: "1",
  };
  const [bets, setBets] = useState([]);
  const [form, setForm] = useState(emptyBet);
  const [showManual, setShowManual] = useState(false);
  const [range, setRange] = useState("month");
  const [customRange, setCustomRange] = useState({ from: `${new Date().getFullYear()}-01-01`, to: localDateInputValue() });
  const [groupBy, setGroupBy] = useState("month");
  const [pageSize, setPageSize] = useState("25");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [csvPreview, setCsvPreview] = useState("");
  const [insightsModal, setInsightsModal] = useState(null);

  useEffect(() => {
    request("/tools/betlog/bets")
      .then((payload) => setBets(payload.bets || []))
      .catch((error) => setMessage({ type: "error", text: `Could not load bets: ${error.message}` }));
  }, []);

  const activeRange = activeDateRange(range, customRange);
  const stats = summarizeBetlogBets(bets.filter((bet) => isDateInRange(bet.date, activeRange)));
  const displayBets = useMemo(() => sortBetlogDisplay(bets, groupBy), [bets, groupBy]);
  const paged = paginate(displayBets, page, pageSize);

  async function saveBet(event) {
    event.preventDefault();
    try {
      const payload = await request("/tools/betlog/bets", { method: "POST", body: JSON.stringify({ bet: form }) });
      setBets(payload.bets || []);
      setForm(emptyBet);
      setPage(1);
      setMessage({ type: "success", text: "Bet saved." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function importCsv(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = parseBetlogCsv(await file.text());
      setCsvPreview(`${rows.length} row${rows.length === 1 ? "" : "s"} ready`);
      const payload = await request("/tools/betlog/bets", { method: "POST", body: JSON.stringify({ bets: rows }) });
      setBets(payload.bets || []);
      setPage(1);
      setMessage({ type: "success", text: `Imported ${payload.imported || rows.length} bet rows.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
      setCsvPreview("");
    } finally {
      event.target.value = "";
    }
  }

  async function updateBet() {
    try {
      const payload = await request("/tools/betlog/update", { method: "POST", body: JSON.stringify({ id: editingId, bet: draft }) });
      setBets(payload.bets || []);
      setEditingId("");
      setDraft(null);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function deleteBet(id) {
    try {
      const payload = await request("/tools/betlog/delete", { method: "POST", body: JSON.stringify({ id }) });
      setBets(payload.bets || []);
      if (editingId === id) setEditingId("");
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  return (
    <ToolPageShell title="Betlog" description="Log placed bets and track stake, returns, profit, and hit rate across month-to-date, year-to-date, or custom periods." onBack={onBack}>
      <StatsPanel
        caption={`${activeRange.label}: ${stats.uniqueBets} bet${stats.uniqueBets === 1 ? "" : "s"} across ${bets.length} row${bets.length === 1 ? "" : "s"}.`}
        range={range}
        onRange={setRange}
        customRange={customRange}
        onCustomRange={setCustomRange}
        onInsights={() => openPerformanceInsightsModal("betlog", setInsightsModal)}
        metrics={[
          ["Bets", stats.uniqueBets], ["Stake", formatMoney(stats.stake)], ["Returns", formatMoney(stats.returns)], ["Profit", formatMoney(stats.profit)],
          ["ROI", `${stats.roi}%`], ["Win rate", `${stats.winRate}%`], ["Open bets", stats.open], ["Avg odds", formatOdds(stats.avgOdds)],
        ]}
      />
      {insightsModal ? <PerformanceInsightsModal state={insightsModal} setState={setInsightsModal} onClose={() => setInsightsModal(null)} /> : null}

      <section className="betlog-entry-layout">
        <section className="tool-panel betlog-import-panel">
          <div className="betlog-import-head">
            <PanelTitle title="CSV import" body="Columns: date, time, bet_id, bet_type, stake, free_bet, status, return_amount, selection, odds, market, match, score, outcome_type, legs." />
            <button className="button button-secondary" type="button" onClick={() => setShowManual(true)}>Manual entry</button>
          </div>
          <Field label="CSV file"><input type="file" accept=".csv,text/csv" onChange={importCsv} /></Field>
          <div className="padelog-import-actions">
            <button className="button button-secondary" type="button" onClick={() => downloadTextFile(betlogTemplate(), "betlog-template.csv", "text/csv")}>Download template</button>
          </div>
          <ScopedMessage message={message} />
          {csvPreview ? <div className="padelog-csv-preview"><strong>{csvPreview}</strong></div> : null}
        </section>

        {showManual ? (
          <form className="tool-panel betlog-manual-panel" onSubmit={saveBet}>
            <PanelTitle title="Manual entry" body="Add one selection row at a time. For combos, repeat the bet ID and shared stake/return fields per selection." />
            <BetlogFields form={form} setForm={setForm} />
            <ScopedMessage message={message} />
            <div className="padelog-import-actions">
              <button className="button button-primary" type="submit">Save bet</button>
              <button className="button button-secondary" type="button" onClick={() => setShowManual(false)}>Hide manual entry</button>
            </div>
          </form>
        ) : null}
      </section>

      <HistoryPanel
        title="Bet history"
        count={`${bets.length} saved bet row${bets.length === 1 ? "" : "s"}${bets.length ? ` · showing ${paged.start + 1}-${paged.end}.` : "."}`}
        groupOptions={[["month", "Month"], ["status", "Status"], ["betType", "Bet type"], ["none", "None"]]}
        groupBy={groupBy}
        onGroupBy={(value) => { setGroupBy(value); setPage(1); }}
        pageSize={pageSize}
        onPageSize={(value) => { setPageSize(value); setPage(1); }}
        page={page}
        totalPages={paged.totalPages}
        onPage={setPage}
      >
        <table className="padelog-table betlog-table">
          <thead><tr><th>Date</th><th>Bet</th><th>Money</th><th>Pick</th><th>Odds</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {!bets.length ? <tr><td colSpan="7">No bets yet.</td></tr> : null}
            {withGroups(paged.rows, groupBy, betlogGroupLabel).map((item) =>
              item.type === "group" ? <tr className="padelog-group-row" key={item.key}><td colSpan="7">{item.label}</td></tr>
              : editingId === item.row.id ? <BetlogEditRow key={item.row.id} draft={draft} setDraft={setDraft} onSave={updateBet} onCancel={() => setEditingId("")} />
              : <BetlogDisplayRow key={item.row.id} bet={item.row} onEdit={() => { setEditingId(item.row.id); setDraft(item.row); }} onDelete={() => deleteBet(item.row.id)} />
            )}
          </tbody>
        </table>
      </HistoryPanel>
    </ToolPageShell>
  );
}

function NotelogPage({ onBack }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(null);
  const autosaveRef = useRef(null);
  const saveNoteRef = useRef(null);
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [sidebarTab, setSidebarTab] = useState("notes");
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#111827");
  const [size, setSize] = useState(4);
  const [redoStack, setRedoStack] = useState([]);
  const [calibration, setCalibration] = useState(loadNotelogCalibration);
  const [calibrationDraft, setCalibrationDraft] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [saveStatus, setSaveStatus] = useState("Save ready");
  const [renderTick, setRenderTick] = useState(0);

  const activeNote = notes.find((note) => note.id === activeId) || notes[0] || null;
  const activePage = activeNote?.pages?.[pageIndex] || null;

  useEffect(() => {
    request("/tools/notelog/notes")
      .then((payload) => {
        const loaded = payload.notes?.length ? payload.notes.map(normalizeNote) : [newNote()];
        setNotes(loaded);
        setActiveId(loaded[0].id);
        setPageIndex(0);
      })
      .catch((error) => {
        const note = newNote();
        setNotes([note]);
        setActiveId(note.id);
        setMessage({ type: "error", text: `Could not load notes: ${error.message}` });
      });
  }, []);

  useEffect(() => {
    if (activePage) drawNotelogCanvas(canvasRef.current, activePage);
  }, [activePage, renderTick]);

  useEffect(() => {
    saveNoteRef.current = saveNote;
  });

  useEffect(() => () => window.clearTimeout(autosaveRef.current), []);

  function updateActiveNote(updater) {
    setNotes((current) =>
      current.map((note) => {
        if (note.id !== activeId) return note;
        const updated = updater(structuredCloneSafe(note));
        return { ...updated, updatedAt: new Date().toISOString() };
      }),
    );
    scheduleAutosave();
  }

  function scheduleAutosave() {
    window.clearTimeout(autosaveRef.current);
    setSaveStatus("Autosave pending");
    autosaveRef.current = window.setTimeout(() => {
      saveNoteRef.current?.({ silent: true });
    }, 900);
  }

  function createNote() {
    const note = newNote();
    setNotes((current) => [note, ...current]);
    setActiveId(note.id);
    setPageIndex(0);
    setRedoStack([]);
    setSidebarTab("tools");
  }

  async function saveNote(options = {}) {
    const note = notes.find((item) => item.id === activeId);
    if (!note) return;
    window.clearTimeout(autosaveRef.current);
    setSaveStatus("Saving...");
    try {
      const payload = await request("/tools/notelog/notes", { method: "POST", body: JSON.stringify({ note }) });
      setNotes((payload.notes || [payload.note]).map(normalizeNote));
      setActiveId(payload.note.id);
      setSaveStatus(`Saved ${localTimeInputValue()}`);
      if (!options.silent) setMessage({ type: "success", text: "Note saved." });
    } catch (error) {
      setSaveStatus("Save failed");
      setMessage({ type: "error", text: error.message });
    }
  }

  async function exportNote() {
    const note = notes.find((item) => item.id === activeId);
    if (!note) return;
    await saveNote({ silent: true });
    try {
      const payload = await request("/tools/notelog/export", { method: "POST", body: JSON.stringify({ id: note.id }) });
      setNotes((payload.notes || notes).map(normalizeNote));
      setMessage({ type: "success", text: `Exported ${payload.fileName}.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function deleteNote(noteId) {
    try {
      const payload = await request("/tools/notelog/delete", { method: "POST", body: JSON.stringify({ id: noteId }) });
      const nextNotes = payload.notes?.length ? payload.notes.map(normalizeNote) : [newNote()];
      setNotes(nextNotes);
      setActiveId(nextNotes[0].id);
      setPageIndex(0);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  function addPage() {
    updateActiveNote((note) => {
      note.pages.push(newPage());
      setPageIndex(note.pages.length - 1);
      return note;
    });
    setRedoStack([]);
  }

  function deletePage() {
    if (!activeNote || activeNote.pages.length <= 1) {
      setMessage({ type: "error", text: "A note needs at least one page." });
      return;
    }
    updateActiveNote((note) => {
      note.pages.splice(pageIndex, 1);
      return note;
    });
    setPageIndex(Math.max(0, pageIndex - 1));
    setRedoStack([]);
  }

  function undoStroke() {
    if (!activePage?.strokes?.length) return;
    const removed = activePage.strokes[activePage.strokes.length - 1];
    updateActiveNote((note) => {
      note.pages[pageIndex].strokes.pop();
      return note;
    });
    setRedoStack((current) => [removed, ...current]);
  }

  function redoStroke() {
    const [stroke, ...rest] = redoStack;
    if (!stroke) return;
    updateActiveNote((note) => {
      note.pages[pageIndex].strokes.push(stroke);
      return note;
    });
    setRedoStack(rest);
  }

  function startStroke(event) {
    if (!activePage) return;
    if (calibrationDraft) {
      captureCalibrationPoint(event);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = {
      tool,
      color,
      size: tool === "eraser" ? Math.max(8, size * 2.5) : size,
      points: [calibratedCanvasPoint(event, canvasRef.current, calibration)],
    };
    drawingRef.current = stroke;
    setRedoStack([]);
    updateActiveNote((note) => {
      note.pages[pageIndex].strokes.push(stroke);
      return note;
    });
  }

  function moveStroke(event) {
    const stroke = drawingRef.current;
    if (!stroke) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    for (const pointerEvent of events) {
      const point = calibratedCanvasPoint(pointerEvent, canvasRef.current, calibration);
      const previous = stroke.points[stroke.points.length - 1];
      if (!previous || pointDistance(previous, point) >= 1.2) stroke.points.push(point);
    }
    setRenderTick((tick) => tick + 1);
  }

  function endStroke(event) {
    const stroke = drawingRef.current;
    if (!stroke) return;
    event.preventDefault();
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      stroke.points.push({ ...point, x: point.x + 0.01, y: point.y + 0.01 });
    }
    stroke.points = smoothPoints(stroke.points);
    drawingRef.current = null;
    updateActiveNote((note) => note);
  }

  function startCalibration() {
    setCalibrationDraft({ points: [] });
    setSidebarTab("tools");
    setMessage({ type: "success", text: "Tap the highlighted page corners with your pen." });
    canvasRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resetCalibration() {
    setCalibration(null);
    setCalibrationDraft(null);
    localStorage.removeItem(NOTELOG_CALIBRATION_STORAGE_KEY);
    setMessage({ type: "success", text: "Tablet calibration reset." });
  }

  function captureCalibrationPoint(event) {
    event.preventDefault();
    const step = NOTELOG_CALIBRATION_STEPS[calibrationDraft.points.length];
    if (!step) return;
    const nextPoints = [...calibrationDraft.points, { id: step.id, ...canvasPoint(event, canvasRef.current) }];
    if (nextPoints.length >= NOTELOG_CALIBRATION_STEPS.length) {
      const nextCalibration = Object.fromEntries(nextPoints.map((point) => [point.id, { x: point.x, y: point.y }]));
      localStorage.setItem(NOTELOG_CALIBRATION_STORAGE_KEY, JSON.stringify(nextCalibration));
      setCalibration(nextCalibration);
      setCalibrationDraft(null);
      setMessage({ type: "success", text: "Tablet calibration saved." });
      return;
    }
    setCalibrationDraft({ points: nextPoints });
  }

  if (!activeNote) {
    return <ToolPageShell title="Notelog" description="Loading notes..." onBack={onBack}><div className="tool-list-state">Loading notes...</div></ToolPageShell>;
  }

  return (
    <section className="index-page notelog-page">
      <section className="notelog-shell">
        <aside className="notelog-sidebar">
          <div className="notelog-sidebar-title">
            <div><h1>Notelog</h1><p>Write handwritten notes, keep editable pages locally, and export vector PDFs.</p></div>
            <button className="button button-secondary" type="button" onClick={onBack}>Back</button>
          </div>
          <div className="notelog-sidebar-tabs" role="tablist" aria-label="Notelog sections">
            <button className={`button button-secondary ${sidebarTab === "notes" ? "is-active" : ""}`} type="button" onClick={() => setSidebarTab("notes")}>Notes</button>
            <button className={`button button-secondary ${sidebarTab === "tools" ? "is-active" : ""}`} type="button" onClick={() => setSidebarTab("tools")}>Tools</button>
          </div>

          <section className={`notelog-sidebar-panel ${sidebarTab === "notes" ? "is-active" : ""}`}>
            <div className="notelog-sidebar-head"><div><h2>Notes</h2><p>{notes.length} note{notes.length === 1 ? "" : "s"}</p></div><button className="button button-primary" type="button" onClick={createNote}>New</button></div>
            <div className="notelog-list">
              {notes.map((note) => (
                <article className={`notelog-note-row ${note.id === activeId ? "is-active" : ""}`} key={note.id}>
                  <button type="button" onClick={() => { setActiveId(note.id); setPageIndex(0); setRedoStack([]); }}>
                    <strong>{note.title || "Untitled note"}</strong>
                    <span>{note.pages.length} page{note.pages.length === 1 ? "" : "s"} · {formatDisplayDate(note.updatedAt.slice(0, 10))}</span>
                    {note.exportedFileName ? <span>{note.exportedFileName}</span> : null}
                  </button>
                  <button className="notelog-delete-note" type="button" onClick={() => deleteNote(note.id)}>Delete</button>
                </article>
              ))}
            </div>
          </section>

          <section className={`notelog-sidebar-panel ${sidebarTab === "tools" ? "is-active" : ""}`}>
            <div className="notelog-tools-panel">
              <Field label="Title"><input value={activeNote.title} onChange={(event) => updateActiveNote((note) => ({ ...note, title: event.target.value || "Untitled note" }))} /></Field>
              <div className="notelog-tool-group">
                <button className={`button button-secondary ${tool === "pen" ? "is-active" : ""}`} type="button" onClick={() => setTool("pen")}>Pen</button>
                <button className={`button button-secondary ${tool === "eraser" ? "is-active" : ""}`} type="button" onClick={() => setTool("eraser")}>Eraser</button>
              </div>
              <div className="form-grid notelog-tool-grid">
                <Field label="Color"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></Field>
                <Field label="Paper">
                  <select value={activePage?.background || "grid"} onChange={(event) => updateActiveNote((note) => { note.pages[pageIndex].background = event.target.value; return note; })}>
                    <option value="grid">Grid</option><option value="ruled">Ruled</option><option value="dots">Dots</option><option value="blank">Blank</option><option value="meeting">Meeting</option><option value="cornell">Cornell</option>
                  </select>
                </Field>
              </div>
              <Field label="Size"><input type="range" min="1" max="24" step="1" value={size} onChange={(event) => setSize(Number(event.target.value) || 4)} /></Field>
              <div className="notelog-tool-group"><button className="button button-secondary" type="button" disabled={!activePage?.strokes?.length} onClick={undoStroke}>Undo</button><button className="button button-secondary" type="button" disabled={!redoStack.length} onClick={redoStroke}>Redo</button></div>
              <div className="notelog-tool-group"><button className="button button-secondary" type="button" onClick={addPage}>Add page</button><button className="button button-secondary" type="button" disabled={activeNote.pages.length <= 1} onClick={deletePage}>Delete page</button></div>
              <div className="notelog-tool-group"><button className="button button-primary" type="button" onClick={() => saveNote()}>Save</button><button className="button button-secondary" type="button" onClick={exportNote}>Export PDF</button></div>
              <div className="notelog-export-preview"><span>{saveStatus}</span>{activeNote.exportedFileName ? <a href={`/api/outputs/notes/${encodeURIComponent(activeNote.exportedFileName)}`} target="_blank" rel="noopener">Open PDF</a> : null}</div>
              <div className="notelog-calibration-tools">
                <div><h3>Tablet calibration</h3><p>{calibrationDraft ? `Tap ${NOTELOG_CALIBRATION_STEPS[calibrationDraft.points.length]?.label} corner` : calibration ? "Calibration active" : "Not calibrated"}</p></div>
                <div className="notelog-tool-group">
                  <button className="button button-secondary" type="button" onClick={startCalibration}>Calibrate</button>
                  <button className="button button-secondary" type="button" disabled={!calibration && !calibrationDraft} onClick={resetCalibration}>Reset</button>
                </div>
              </div>
            </div>
          </section>
        </aside>

        <section className="notelog-workspace">
          <div className="notelog-page-tabs">
            {activeNote.pages.map((page, index) => <button key={page.id} className={`button button-secondary ${index === pageIndex ? "is-active" : ""}`} type="button" onClick={() => { setPageIndex(index); setRedoStack([]); }}>Page {index + 1}</button>)}
          </div>
          <div className="notelog-canvas-wrap">
            <canvas
              id="notelog-canvas"
              ref={canvasRef}
              width={NOTELOG_PAGE_WIDTH}
              height={NOTELOG_PAGE_HEIGHT}
              className={calibrationDraft ? "is-calibrating" : ""}
              aria-label="Handwriting canvas"
              onPointerDown={startStroke}
              onPointerMove={moveStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
            />
            {calibrationDraft ? (
              <div className="notelog-calibration-overlay">
                <div className="notelog-calibration-target" style={calibrationTargetStyle(calibrationDraft)} />
                <div className="notelog-calibration-card">
                  <strong>Tap {NOTELOG_CALIBRATION_STEPS[calibrationDraft.points.length]?.label}</strong>
                  <span>Point {calibrationDraft.points.length + 1} of {NOTELOG_CALIBRATION_STEPS.length}</span>
                </div>
              </div>
            ) : null}
          </div>
          <ScopedMessage message={message} />
        </section>
      </section>
    </section>
  );
}

function Base64ToolPage({ type, title, description, accept, endpoint, onBack }) {
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const file = event.currentTarget.elements.sourceFile.files?.[0];
    if (!file) {
      setMessage({ type: "error", text: `Choose a ${type === "pdf" ? "PDF" : "HTML"} file first.` });
      return;
    }
    setBusy(true);
    setMessage({ type: "", text: "" });
    setResult(null);
    try {
      const body = type === "pdf"
        ? { fileName: file.name, base64: await fileToBase64(file) }
        : { fileName: file.name, html: await file.text() };
      setResult(await request(endpoint, { method: "POST", body: JSON.stringify(body) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function copyOutput() {
    if (!result?.iframeSource) return;
    await navigator.clipboard.writeText(result.iframeSource);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <ToolPageShell title={title} description={description} onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <Field label={`${type === "pdf" ? "PDF" : "HTML"} file`}><input name="sourceFile" type="file" accept={accept} required onChange={() => setResult(null)} /></Field>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create TXT output"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved as {result.fileName}</p></div>
            <div className="result-actions">
              <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={result.fileName}>
                <Download size={16} aria-hidden="true" /> Download
              </a>
              <button className="button button-secondary" type="button" onClick={copyOutput}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
          <textarea value={result.iframeSource || ""} readOnly spellCheck="false" />
          <iframe src={result.iframeSource} title={`${title} preview`} />
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function CombinePdfsPage({ onBack }) {
  const [files, setFiles] = useState([]);
  const [fileName, setFileName] = useState("combined.pdf");
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);

  function addFiles(event) {
    const selected = Array.from(event.target.files || []);
    setResult(null);
    setMessage({ type: "", text: "" });
    setFiles((current) => {
      const seen = new Set(current.map(fileKey));
      const next = [...current];
      for (const file of selected) {
        const key = fileKey(file);
        if (!seen.has(key)) {
          seen.add(key);
          next.push(file);
        }
      }
      if (next.length > 5) {
        setMessage({ type: "error", text: "Only the first five PDF files will be combined." });
        return next.slice(0, 5);
      }
      return next;
    });
    event.target.value = "";
  }

  function moveFile(index, delta) {
    setFiles((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setResult(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (files.length < 2) {
      setMessage({ type: "error", text: "Choose at least two PDF files first." });
      return;
    }
    setBusy(true);
    setMessage({ type: "", text: "" });
    try {
      const encodedFiles = await Promise.all(files.map(async (file) => ({ fileName: file.name, base64: await fileToBase64(file) })));
      setResult(await request("/tools/combine-pdfs", { method: "POST", body: JSON.stringify({ fileName, files: encodedFiles }) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolPageShell title="Combine PDFs" description="Select two to five PDF files, set their order, and save one combined PDF to Outputs." onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="PDF files"><input type="file" accept=".pdf,application/pdf" multiple onChange={addFiles} /></Field>
          <Field label="New PDF name"><input value={fileName} required onChange={(event) => { setFileName(event.target.value); setResult(null); }} /></Field>
        </div>
        <div className="field">
          <label>Insert order</label>
          <div className="combine-pdf-list">
            {!files.length ? <div className="tool-list-state">No PDFs selected.</div> : null}
            {files.map((file, index) => (
              <div className="combine-pdf-row" key={fileKey(file)}>
                <span className="badge">{index + 1}</span>
                <span className="combine-pdf-name" title={file.name}>{file.name}</span>
                <div className="combine-pdf-actions">
                  <button className="button button-secondary" type="button" disabled={index === 0} onClick={() => moveFile(index, -1)}>Up</button>
                  <button className="button button-secondary" type="button" disabled={index === files.length - 1} onClick={() => moveFile(index, 1)}>Down</button>
                  <button className="button button-secondary" type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Combining..." : "Create combined PDF"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved as {result.fileName} ({result.pageCount} pages)</p></div>
            <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={result.fileName}>
              <Download size={16} aria-hidden="true" /> Download
            </a>
          </div>
          <iframe src={result.pdfSource} title="Combined PDF preview" />
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function CsvJsonRowsPage({ onBack }) {
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const file = event.currentTarget.elements.csvFile.files?.[0];
    if (!file) {
      setMessage({ type: "error", text: "Choose a CSV file first." });
      return;
    }
    setBusy(true);
    setMessage({ type: "", text: "" });
    setResult(null);
    try {
      setResult(await request("/tools/csv-json-rows", { method: "POST", body: JSON.stringify({ fileName: file.name, csv: await file.text() }) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const files = Array.isArray(result?.files) ? result.files : [];
  return (
    <ToolPageShell title="CSV to JSON Rows" description="Select a CSV file and save one JSON file per data row inside Outputs." onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <Field label="CSV file"><input name="csvFile" type="file" accept=".csv,text/csv" required onChange={() => setResult(null)} /></Field>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create JSON files"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved {result.rowCount} JSON files with {result.columnCount} columns in Outputs/{result.fileName}.</p></div>
            <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={`${result.fileName}.zip`}>
              <Download size={16} aria-hidden="true" /> Download ZIP
            </a>
          </div>
          <div className="json-preview">
            {warnings.map((warning) => <div className="json-preview-row json-preview-warning" key={warning}>{warning}</div>)}
            {files.slice(0, 200).map((name) => <div className="json-preview-row" key={name}>{name}</div>)}
            {files.length > 200 ? <div className="json-preview-row">...and {files.length - 200} more files</div> : null}
          </div>
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function CsvQaMarkdownPage({ onBack }) {
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const file = event.currentTarget.elements.qaCsvFile.files?.[0];
    if (!file) {
      setMessage({ type: "error", text: "Choose a Q&A CSV file first." });
      return;
    }
    setBusy(true);
    setMessage({ type: "", text: "" });
    setResult(null);
    try {
      setResult(await request("/tools/csv-qa-markdown", { method: "POST", body: JSON.stringify({ fileName: file.name, csv: await file.text() }) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolPageShell title="CSV Q&A to Markdown" description="Convert a Q&A CSV into a Markdown knowledge-base file saved to Outputs." onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <Field label="Q&A CSV file"><input name="qaCsvFile" type="file" accept=".csv,text/csv" required onChange={() => setResult(null)} /></Field>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create Markdown"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved {result.entryCount} Q&A entries as {result.fileName}{result.skippedRows ? `; skipped ${result.skippedRows} incomplete rows` : ""}.</p></div>
            <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={result.fileName}>
              <Download size={16} aria-hidden="true" /> Download
            </a>
          </div>
          <textarea value={result.markdown || ""} readOnly spellCheck="false" />
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function TokenUsagePage({ onBack }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(true);
  const [infoKey, setInfoKey] = useState("");

  useEffect(() => {
    fetchUsage({});
  }, []);

  async function fetchUsage(payload) {
    setBusy(true);
    setMessage({ type: "", text: "" });
    try {
      setResult(await request("/tools/token-usage", { method: "POST", body: JSON.stringify(payload) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    fetchUsage(range);
  }

  return (
    <ToolPageShell title="Check My Token Usage" description="Review OpenAI and Anthropic usage for month-to-date, year-to-date, and a custom range." onBack={onBack}>
      <section className="result-panel token-usage-results">
        <div className="result-head">
          <div><h2>Usage</h2><p>{busy && !result ? "Checking month-to-date and year-to-date usage..." : result?.generatedAt ? `Checked ${formatDateTime(result.generatedAt)}` : ""}</p></div>
        </div>
        <div className="token-usage-grid">
          {busy && !result ? <div className="tool-list-state">Loading usage...</div> : null}
          {result?.providers?.map((provider) => <TokenUsageProvider provider={provider} onInfo={setInfoKey} key={provider.name} />)}
        </div>
      </section>
      <form className="tool-panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Custom range start"><input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></Field>
          <Field label="Custom range end"><input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></Field>
        </div>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Checking..." : "Check custom range"}</button>
      </form>
      {infoKey ? <TokenInfoModal infoKey={infoKey} onClose={() => setInfoKey("")} /> : null}
    </ToolPageShell>
  );
}

function TokenUsageProvider({ provider, onInfo }) {
  if (!provider.ok) {
    return <article className="token-provider-card token-provider-error"><h3>{provider.name}</h3><p>{provider.error || "Usage unavailable"}</p></article>;
  }
  return (
    <article className="token-provider-card">
      <h3>{provider.name}</h3>
      <div className="token-range-list">
        {(provider.ranges || []).map((range) => <TokenUsageRange range={range} onInfo={onInfo} key={range.label} />)}
      </div>
    </article>
  );
}

function TokenUsageRange({ range, onInfo }) {
  const totals = range.totals || {};
  const breakdown = [
    ["Cached input", totals.cachedInputTokens, "cachedInputTokens"],
    ["Cache creation", totals.cacheCreationInputTokens, "cacheCreationInputTokens"],
    ["Cache read", totals.cacheReadInputTokens, "cacheReadInputTokens"],
    ["Input audio", totals.inputAudioTokens, "inputAudioTokens"],
    ["Output audio", totals.outputAudioTokens, "outputAudioTokens"],
  ].filter(([, value]) => Number(value) > 0);
  const visibleModels = (range.models || []).filter((model) => model.model && model.model !== "All models").slice(0, 6);
  return (
    <section className="token-range-card">
      <div className="token-range-head"><h4>{range.label}</h4><span>{formatRangeDates(range.startingAt, range.endingAt)}</span></div>
      <div className="token-metrics">
        <TokenMetric label="Total" value={totals.totalTokens} infoKey="totalTokens" onInfo={onInfo} />
        <TokenMetric label="Input" value={totals.inputTokens} infoKey="inputTokens" onInfo={onInfo} />
        <TokenMetric label="Output" value={totals.outputTokens} infoKey="outputTokens" onInfo={onInfo} />
      </div>
      {breakdown.length ? <dl className="token-breakdown">{breakdown.map(([label, value, key]) => <div key={key}><dt>{label}<InfoButton infoKey={key} onInfo={onInfo} /></dt><dd>{formatInteger(value)}</dd></div>)}</dl> : null}
      {visibleModels.length ? (
        <table className="token-model-table">
          <thead><tr><th>Model</th><th>Total</th><th>Input</th><th>Output</th></tr></thead>
          <tbody>{visibleModels.map((model) => <tr key={model.model}><td>{model.model}</td><td>{formatInteger(model.totalTokens)}</td><td>{formatInteger(model.inputTokens)}</td><td>{formatInteger(model.outputTokens)}</td></tr>)}</tbody>
        </table>
      ) : null}
    </section>
  );
}

function TokenMetric({ label, value, infoKey, onInfo }) {
  return <div className="token-metric"><span>{label}<InfoButton infoKey={infoKey} onInfo={onInfo} /></span><strong>{formatInteger(value)}</strong></div>;
}

function InfoButton({ infoKey, onInfo }) {
  if (!TOKEN_USAGE_EXPLAINERS[infoKey]) return null;
  return <button className="info-button" type="button" aria-label={`Explain ${TOKEN_USAGE_EXPLAINERS[infoKey].title}`} onClick={() => onInfo(infoKey)}>i</button>;
}

function TokenInfoModal({ infoKey, onClose }) {
  const explainer = TOKEN_USAGE_EXPLAINERS[infoKey];
  if (!explainer) return null;
  return (
    <div className="info-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="info-dialog" role="dialog" aria-modal="true" aria-labelledby="token-info-title">
        <button className="info-close" type="button" aria-label="Close explanation" onClick={onClose}>x</button>
        <h2 id="token-info-title">{explainer.title}</h2>
        <p>{explainer.body}</p>
      </div>
    </div>
  );
}

function PresentationSuitePage({ onBack }) {
  const [sourceFiles, setSourceFiles] = useState([]);
  const [fileName, setFileName] = useState("");
  const [tabCount, setTabCount] = useState(3);
  const [labels, setLabels] = useState(["Deck", "Demo 1", "Demo 2"]);
  const [selectedSources, setSelectedSources] = useState(["", "", ""]);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    request("/outputs/iframe-sources")
      .then((payload) => setSourceFiles(payload.files || []))
      .catch(() => setSourceFiles([]));
  }, []);

  function setCount(value) {
    setResult(null);
    const count = Math.min(12, Math.max(1, Number(value) || 1));
    setTabCount(count);
    setLabels((current) => Array.from({ length: count }, (_, index) => current[index] || (index === 0 ? "Deck" : `Demo ${index}`)));
    setSelectedSources((current) => Array.from({ length: count }, (_, index) => current[index] || ""));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage({ type: "", text: "" });
    setResult(null);
    try {
      setResult(await request("/tools/presentation-suite", {
        method: "POST",
        body: JSON.stringify({ fileName: fileName.trim(), tabCount, labels, sourceFiles: selectedSources }),
      }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function copyHtml() {
    if (!result?.html) return;
    await navigator.clipboard.writeText(result.html);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <ToolPageShell title="Presentation Suite Builder" description="Generate a tabbed HTML template with the first tab as the deck and the remaining tabs as demos." onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Output file name"><input value={fileName} placeholder="presentation-suite.html" required onChange={(event) => { setFileName(event.target.value); setResult(null); }} /></Field>
          <Field label="Number of tabs"><input type="number" min="1" max="12" value={tabCount} required onChange={(event) => setCount(event.target.value)} /></Field>
        </div>
        <div className="field">
          <label>Tabs</label>
          <div className="label-list">
            {Array.from({ length: tabCount }, (_, index) => (
              <div className="label-row" key={index}>
                <span className="badge">{index === 0 ? "Deck" : index === 1 ? "Demo" : `Demo ${index}`}</span>
                <input value={labels[index] || ""} aria-label={`Tab ${index + 1} label`} required onChange={(event) => { setLabels((current) => current.map((label, labelIndex) => labelIndex === index ? event.target.value : label)); setResult(null); }} />
                <select value={selectedSources[index] || ""} aria-label={`Tab ${index + 1} iframe source`} onChange={(event) => { setSelectedSources((current) => current.map((source, sourceIndex) => sourceIndex === index ? event.target.value : source)); setResult(null); }}>
                  <option value="">No iframe</option>
                  {!sourceFiles.length ? <option value="" disabled>No TXT outputs found</option> : null}
                  {sourceFiles.map((source) => <option key={source} value={source}>{source}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create HTML output"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved as {result.fileName}</p></div>
            <div className="result-actions">
              <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={result.fileName}>
                <Download size={16} aria-hidden="true" /> Download
              </a>
              <button className="button button-secondary" type="button" onClick={copyHtml}>{copied ? "Copied" : "Copy HTML"}</button>
            </div>
          </div>
          <textarea value={result.html || ""} readOnly spellCheck="false" />
          <iframe srcDoc={result.html} title="Presentation suite preview" />
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function DemoBuilderPage({ onBack }) {
  const [values, setValues] = useState(() => defaultDemoBuilderValues(2));
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewHtml = useMemo(() => buildDemoBuilderLivePreviewHtml(values), [values]);

  function update(field, value) {
    setResult(null);
    setValues((current) => {
      if (field === "scenarioCount") {
        const count = Math.min(8, Math.max(1, Number(value) || 1));
        return defaultDemoBuilderValues(count, { ...current, scenarioCount: count });
      }
      return { ...current, [field]: value };
    });
  }

  async function loadJsonFile(event, field) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      update(field, JSON.stringify(parsed, null, 2));
    } catch (error) {
      setMessage({ type: "error", text: `Could not load JSON: ${error.message}` });
    } finally {
      event.target.value = "";
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage({ type: "", text: "" });
    setResult(null);
    try {
      setResult(await request("/tools/demo-builder", { method: "POST", body: JSON.stringify(values) }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function copyHtml() {
    if (!result?.html) return;
    await navigator.clipboard.writeText(result.html);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <ToolPageShell title="Demo Builder" description="Generate a reusable demo HTML template with editable branding, scenarios, messages, documents, and logs." onBack={onBack}>
      <form className="tool-panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Output file name"><input value={values.fileName} required onChange={(event) => update("fileName", event.target.value)} /></Field>
          <Field label="Number of scenarios"><input type="number" min="1" max="8" value={values.scenarioCount} required onChange={(event) => update("scenarioCount", event.target.value)} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Logo text"><input value={values.logoText} required onChange={(event) => update("logoText", event.target.value)} /></Field>
          <Field label="Demo title"><input value={values.title} required onChange={(event) => update("title", event.target.value)} /></Field>
        </div>
        <Field label="Subtitle"><input value={values.subtitle} onChange={(event) => update("subtitle", event.target.value)} /></Field>
        <div className="form-grid">
          <Field label="UI font"><input value={values.fontUi} onChange={(event) => update("fontUi", event.target.value)} /></Field>
          <Field label="Mono font"><input value={values.fontMono} onChange={(event) => update("fontMono", event.target.value)} /></Field>
        </div>
        <div className="color-grid">
          {[
            ["brandColor", "Brand"],
            ["accentColor", "Accent"],
            ["backgroundColor", "Background"],
            ["fontColor", "Font"],
          ].map(([field, label]) => <Field label={label} key={field}><input type="color" value={values[field]} onChange={(event) => update(field, event.target.value)} /></Field>)}
        </div>
        <DemoJsonSection title="Content JSON" value={values.contentJson} onChange={(value) => update("contentJson", value)} onFile={(event) => loadJsonFile(event, "contentJson")} />
        <DemoJsonSection title="Sizing JSON" value={values.sizingJson} onChange={(value) => update("sizingJson", value)} onFile={(event) => loadJsonFile(event, "sizingJson")} />
        <DemoJsonSection title="Glossary JSON" value={values.glossaryJson} onChange={(value) => update("glossaryJson", value)} onFile={(event) => loadJsonFile(event, "glossaryJson")} />
        <section className="form-preview" aria-label="Template preview">
          <div className="result-head">
            <div><h2>Template preview</h2><p>Uses the current values above before creating the HTML output.</p></div>
          </div>
          <iframe className="live-preview-frame" srcDoc={previewHtml} title="Live Demo Builder template preview" />
        </section>
        <ScopedMessage message={message} />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create Demo"}</button>
      </form>
      {result ? (
        <section className="result-panel">
          <div className="result-head">
            <div><h2>Output</h2><p>Saved as {result.fileName}</p></div>
            <div className="result-actions">
              <a className="button button-secondary" href={outputDownloadUrl(result.fileName)} download={result.fileName}>
                <Download size={16} aria-hidden="true" /> Download
              </a>
              <button className="button button-secondary" type="button" onClick={copyHtml}>{copied ? "Copied" : "Copy HTML"}</button>
            </div>
          </div>
          <textarea value={result.html || ""} readOnly spellCheck="false" />
          <iframe srcDoc={result.html} title="Demo Builder preview" />
        </section>
      ) : null}
    </ToolPageShell>
  );
}

function DemoJsonSection({ title, value, onChange, onFile }) {
  const summary = summarizeJson(value);
  return (
    <details className="json-section" open={title === "Content JSON"}>
      <summary><span>{title}</span><small>{summary.label}</small></summary>
      <div className="json-section-body">
        <input className="json-file-input" type="file" accept=".json,application/json" onChange={onFile} />
        <textarea className="content-json-input" value={value} aria-label={title} spellCheck="false" onChange={(event) => onChange(event.target.value)} />
        <div className="json-preview" aria-live="polite">
          {summary.error ? <div className="json-preview-error">{summary.error}</div> : <><div className="json-preview-head"><strong>Loaded JSON</strong><span>{summary.label}</span></div><pre>{summary.preview}</pre></>}
        </div>
      </div>
    </details>
  );
}

function KnowledgeExpertPage({ onBack }) {
  const [entries, setEntries] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [turns, setTurns] = useState([]);
  const [models, setModels] = useState({});
  const [uploadMode, setUploadMode] = useState("append");
  const [message, setMessage] = useState({ type: "", text: "" });
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState({ loading: true, uploading: false, chatting: false });
  const [showHow, setShowHow] = useState(false);
  const [reportModal, setReportModal] = useState(null);
  const [entriesModalFile, setEntriesModalFile] = useState("");
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const knowledgeFiles = useMemo(() => buildKnowledgeFiles(uploads, entries), [uploads, entries]);

  useEffect(() => {
    loadSnapshot();
  }, []);

  async function loadSnapshot(conversationId = activeConversationId) {
    setBusy((current) => ({ ...current, loading: true }));
    try {
      const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
      const payload = await request(`/tools/knowledge-expert${query}`);
      setEntries(payload.entries || []);
      setUploads(payload.uploads || []);
      setConversations(payload.conversations || []);
      setActiveConversationId(payload.activeConversationId || payload.conversations?.[0]?.id || "");
      setTurns((payload.turns || []).slice().reverse());
      setModels(payload.models || {});
      setMessage({ type: "", text: "" });
    } catch (error) {
      setMessage({ type: "error", text: `Could not load Knowledge Expert: ${error.message}` });
    } finally {
      setBusy((current) => ({ ...current, loading: false }));
    }
  }

  async function uploadFiles(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const files = Array.from(form.elements.knowledgeFiles.files || []);
    if (!files.length) {
      setMessage({ type: "error", text: "Choose at least one file first." });
      return;
    }
    setBusy((current) => ({ ...current, uploading: true }));
    setMessage({ type: "success", text: `${uploadMode === "append" ? "Appending" : "Replacing"} and embedding...` });
    try {
      const uploadedFiles = await Promise.all(files.map(async (file) => ({ fileName: file.name, base64: await fileToBase64(file) })));
      const result = await request("/tools/knowledge-expert/upload", { method: "POST", body: JSON.stringify({ mode: uploadMode, files: uploadedFiles }) });
      form.reset();
      await loadSnapshot(activeConversationId);
      setMessage({ type: "success", text: `${uploadMode === "append" ? "Added" : "Loaded"} ${result.addedEntryCount} entries from ${result.fileCount} file(s). Dataset now has ${result.entryCount}.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy((current) => ({ ...current, uploading: false }));
    }
  }

  async function createConversation() {
    try {
      const payload = await request("/tools/knowledge-expert/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
      await loadSnapshot(payload.conversation?.id || "");
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function clearConversation() {
    if (!activeConversationId) return;
    try {
      await request("/tools/knowledge-expert/conversations/clear", { method: "POST", body: JSON.stringify({ conversationId: activeConversationId }) });
      await loadSnapshot(activeConversationId);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function renameConversation(conversation) {
    const title = window.prompt("Rename chat", conversation.title || "New chat");
    if (!title?.trim()) return;
    try {
      await request("/tools/knowledge-expert/conversations/update", { method: "POST", body: JSON.stringify({ conversationId: conversation.id, title: title.trim() }) });
      await loadSnapshot(activeConversationId);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function deleteConversation(conversationId) {
    try {
      const payload = await request("/tools/knowledge-expert/conversations/delete", { method: "POST", body: JSON.stringify({ conversationId }) });
      await loadSnapshot(conversationId === activeConversationId ? payload.activeConversationId || "" : activeConversationId);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function sendQuestion(event) {
    event.preventDefault();
    const userMessage = question.trim();
    if (!userMessage || busy.chatting) return;
    const pendingId = `pending-${Date.now()}`;
    setQuestion("");
    setBusy((current) => ({ ...current, chatting: true }));
    setTurns((current) => [...current, {
      id: pendingId,
      conversationId: activeConversationId,
      userMessage,
      assistantResponse: "Thinking...",
      citations: [],
      traceEvents: [],
      grounded: false,
      createdAt: new Date().toISOString(),
    }]);
    try {
      const turn = await streamKnowledgeExpertChat({ conversationId: activeConversationId, message: userMessage, history: turns.slice(-8) }, (deltaText) => {
        setTurns((current) => current.map((turnItem) => turnItem.id === pendingId ? { ...turnItem, assistantResponse: deltaText || "Thinking..." } : turnItem));
      });
      setTurns((current) => [...current.filter((turnItem) => turnItem.id !== pendingId), turn]);
      await loadSnapshot(activeConversationId);
    } catch (error) {
      setTurns((current) => current.filter((turnItem) => turnItem.id !== pendingId));
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy((current) => ({ ...current, chatting: false }));
    }
  }

  async function rateTurn(turnId, rating) {
    try {
      const result = await request("/tools/knowledge-expert/feedback", { method: "POST", body: JSON.stringify({ traceId: turnId, rating }) });
      setTurns((current) => current.map((turn) => (turn.id === turnId ? result.turn : turn)));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  }

  async function openReport(report) {
    const labels = {
      conversations: ["Conversations", "Recent chat turns, grounded status, and response text."],
      errors: ["Errors", "Persisted Knowledge Expert errors and failed turns."],
      dead: ["Dead entries", "Knowledge entries that were never retrieved or never cited."],
      gaps: ["Knowledge gaps", "Similar declined questions grouped together."],
    };
    const paths = {
      conversations: "/tools/knowledge-expert/admin/conversations",
      errors: "/tools/knowledge-expert/admin/reports/errors",
      dead: "/tools/knowledge-expert/admin/reports/dead-entries",
      gaps: "/tools/knowledge-expert/admin/reports/knowledge-gaps",
    };
    setReportModal({ report, title: labels[report]?.[0] || "Report", subtitle: labels[report]?.[1] || "Knowledge Expert admin report.", loading: true, error: "", payload: null });
    try {
      const payload = await request(paths[report]);
      setReportModal({ report, title: labels[report]?.[0] || "Report", subtitle: labels[report]?.[1] || "Knowledge Expert admin report.", loading: false, error: "", payload });
    } catch (error) {
      setReportModal((current) => current ? { ...current, loading: false, error: error.message } : null);
    }
  }

  const latestUpload = uploads[0];
  return (
    <section className="index-page knowledge-expert-page">
      <div className="page-head">
        <div className="page-title">
          <h1>Knowledge Expert</h1>
          <p>Upload a small knowledge base and ask grounded questions with source citations.</p>
        </div>
        <div className="knowledge-page-actions">
          <button className="button button-secondary knowledge-header-button" type="button" onClick={() => setShowHow(true)}>How it works</button>
          <button className="button button-secondary react-icon-button knowledge-header-button" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /><span>Back</span></button>
        </div>
      </div>

      <section className="knowledge-expert-layout">
        <aside className="tool-panel knowledge-expert-sidebar">
          <PanelTitle title="Dataset" body={latestUpload ? `${entries.length} entries from ${latestUpload.fileName}, uploaded ${formatDateTime(latestUpload.uploadedAt)}` : busy.loading ? "Loading entries..." : "No dataset uploaded yet."} />
          <form className="form-stack" onSubmit={uploadFiles}>
            <Field label="Knowledge files"><input name="knowledgeFiles" type="file" accept=".csv,.html,.htm,.txt,.md,.markdown,.json,.pdf,.docx,text/*,text/html,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple required /></Field>
            <fieldset className="knowledge-upload-mode">
              <legend>Upload mode</legend>
              <label><input type="radio" name="knowledgeUploadMode" value="append" checked={uploadMode === "append"} onChange={() => setUploadMode("append")} /><span>Append to current dataset</span></label>
              <label><input type="radio" name="knowledgeUploadMode" value="replace" checked={uploadMode === "replace"} onChange={() => setUploadMode("replace")} /><span>Replace whole dataset</span></label>
            </fieldset>
            <button className="button button-primary" type="submit" disabled={busy.uploading}>{busy.uploading ? "Uploading..." : "Upload files"}</button>
          </form>
          <details className="knowledge-template-box" open>
            <summary>Upload templates</summary>
            <div className="knowledge-template-body">
              <p>Best results come from one row per question the assistant should be able to answer. You can upload one file or many mixed files, including PDF and DOCX.</p>
              <div className="knowledge-template-actions">
                <button className="button button-secondary" type="button" onClick={() => downloadKnowledgeTemplate("csv")}>Download CSV</button>
                <button className="button button-secondary" type="button" onClick={() => downloadKnowledgeTemplate("json")}>Download JSON</button>
              </div>
              <div className="knowledge-template-example"><strong>CSV columns</strong><code>category,question,answer,link</code></div>
              <div className="knowledge-template-example"><strong>JSON shape</strong><code>{'{ "entries": [{ "category": "...", "question": "...", "answer": "...", "link": "..." }] }'}</code></div>
            </div>
          </details>
          <ScopedMessage message={message} />
          <details className="knowledge-template-box" open>
            <summary>Chats</summary>
            <div className="knowledge-template-body">
              <div className="knowledge-template-actions">
                <button className="button button-primary" type="button" onClick={createConversation}>New chat</button>
                <button className="button button-secondary" type="button" disabled={!activeConversationId} onClick={clearConversation}>Clear current</button>
              </div>
              <div className="knowledge-conversation-list">
                {!conversations.length ? <div className="tool-list-state">No chats yet.</div> : null}
                {conversations.map((conversation) => (
                  <article className={`knowledge-conversation-row ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id}>
                    <button className="knowledge-conversation-main" type="button" onClick={() => loadSnapshot(conversation.id)}>
                      <strong>{conversation.title || "New chat"}</strong>
                      <span>{formatDateTime(conversation.updatedAt)}</span>
                    </button>
                    <div className="knowledge-conversation-actions">
                      <button type="button" onClick={() => renameConversation(conversation)}>Rename</button>
                      <button type="button" onClick={() => deleteConversation(conversation.id)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </details>
          <details className="knowledge-template-box">
            <summary>Admin reports</summary>
            <div className="knowledge-template-body">
              <div className="knowledge-template-actions">
                <button className="button button-secondary" type="button" onClick={() => openReport("conversations")}>Conversations</button>
                <button className="button button-secondary" type="button" onClick={() => openReport("errors")}>Errors</button>
                <button className="button button-secondary" type="button" onClick={() => openReport("dead")}>Dead entries</button>
                <button className="button button-secondary" type="button" onClick={() => openReport("gaps")}>Knowledge gaps</button>
              </div>
            </div>
          </details>
          <details className="knowledge-template-box" open>
            <summary>Uploaded files</summary>
            <div className="knowledge-template-body">
              <div className="knowledge-file-list">
                {!entries.length ? <div className="tool-list-state">Upload files to begin.</div> : null}
                {knowledgeFiles.map((file) => (
                  <KnowledgeFileRow file={file} onOpen={() => setEntriesModalFile(file.fileName)} key={file.fileName} />
                ))}
              </div>
            </div>
          </details>
        </aside>

        <main className="tool-panel knowledge-expert-chat-panel">
          <div className="knowledge-chat-head">
            <div>
              <h2>{activeConversation?.title || "Chat"}</h2>
              <p>Uses this conversation to understand follow-ups. Answers still need knowledge base citations.</p>
            </div>
            <span>{models.chat || ""}</span>
          </div>
          <div className="knowledge-chat-log">
            {!turns.length ? <div className="tool-list-state">Ask a question after uploading a dataset.</div> : null}
            {turns.map((turn) => <KnowledgeTurn turn={turn} onRate={rateTurn} key={turn.id} />)}
          </div>
          <form className="knowledge-chat-form" onSubmit={sendQuestion}>
            <input value={question} disabled={busy.chatting} autoComplete="off" placeholder="Ask a question..." required onChange={(event) => setQuestion(event.target.value)} />
            <button className="button button-primary" type="submit" disabled={busy.chatting}>{busy.chatting ? "Sending..." : "Send"}</button>
          </form>
        </main>
      </section>

      {showHow ? <KnowledgeHowModal onClose={() => setShowHow(false)} /> : null}
      {reportModal ? <KnowledgeReportModal state={reportModal} onClose={() => setReportModal(null)} /> : null}
      {entriesModalFile ? (
        <KnowledgeEntriesModal
          files={knowledgeFiles}
          activeFileName={entriesModalFile}
          onSelectFile={setEntriesModalFile}
          onClose={() => setEntriesModalFile("")}
        />
      ) : null}
    </section>
  );
}

function KnowledgeFileRow({ file, onOpen }) {
  return (
    <article className="knowledge-file-row">
      <div>
        <strong>{file.fileName}</strong>
        <span>{formatInteger(file.entryCount)} entr{file.entryCount === 1 ? "y" : "ies"}{file.uploadedAt ? ` · ${formatDateTime(file.uploadedAt)}` : ""}</span>
        {file.fileType ? <p>{file.fileType.toUpperCase()}{file.uploadedBy ? ` · uploaded by ${file.uploadedBy}` : ""}</p> : null}
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen}>View Q&A</button>
    </article>
  );
}

function KnowledgeEntriesModal({ files, activeFileName, onSelectFile, onClose }) {
  const activeFile = files.find((file) => file.fileName === activeFileName) || files[0];
  if (!activeFile) return null;
  return (
    <div className="ai-modal knowledge-entries-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-entries-title">
        <div className="ai-modal-head">
          <div>
            <h2 id="knowledge-entries-title">Knowledge entries</h2>
            <p>{formatInteger(activeFile.entryCount)} entr{activeFile.entryCount === 1 ? "y" : "ies"} from {activeFile.fileName}</p>
          </div>
          <button className="button button-secondary" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="ai-modal-body">
          <div className="knowledge-file-tabs" role="tablist" aria-label="Knowledge files">
            {files.map((file) => (
              <button
                className={file.fileName === activeFile.fileName ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={file.fileName === activeFile.fileName}
                onClick={() => onSelectFile(file.fileName)}
                key={file.fileName}
              >
                <span>{file.fileName}</span>
                <small>{formatInteger(file.entryCount)}</small>
              </button>
            ))}
          </div>
          <div className="knowledge-entry-modal-list">
            {!activeFile.entries.length ? <div className="tool-list-state">No entries were found for this file.</div> : null}
            {activeFile.entries.map((entry) => <KnowledgeEntryRow entry={entry} key={entry.id} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function KnowledgeEntryRow({ entry }) {
  return (
    <article className="knowledge-entry-row">
      <div className="knowledge-entry-meta">
        <span>{entry.category || "General"}</span>
        <span>{entry.hasEmbedding ? "embedded" : "keyword only"}</span>
      </div>
      <h3>{entry.question}</h3>
      <p>{entry.answer || entry.answerPreview || ""}</p>
      {entry.link ? <a href={entry.link} target="_blank" rel="noreferrer">{entry.link}</a> : null}
    </article>
  );
}

function KnowledgeTurn({ turn, onRate }) {
  const [showTrace, setShowTrace] = useState(false);
  return (
    <article className="knowledge-turn">
      <div className="knowledge-message knowledge-message-user">{turn.userMessage}</div>
      <div className="knowledge-message knowledge-message-assistant">
        <div className="knowledge-answer">{formatMarkdownNodes(turn.assistantResponse || "")}</div>
        <KnowledgeCitations citations={turn.citations || []} />
        <div className="knowledge-turn-actions">
          <span>{turn.grounded ? "Grounded" : "Declined"} · {formatDateTime(turn.createdAt)}</span>
          {!String(turn.id).startsWith("pending-") ? (
            <>
              <button type="button" className={turn.feedbackRating === 1 ? "is-active" : ""} onClick={() => onRate(turn.id, 1)}>Good</button>
              <button type="button" className={turn.feedbackRating === -1 ? "is-active" : ""} onClick={() => onRate(turn.id, -1)}>Bad</button>
              <button type="button" onClick={() => setShowTrace((value) => !value)}>Trace</button>
            </>
          ) : null}
        </div>
        {showTrace ? <div className="knowledge-trace">{(turn.traceEvents || []).map((event, index) => <div className="knowledge-trace-row" key={`${event.type}-${index}`}><code>{event.type || "event"}</code><span>{event.summary || ""}</span><small>{formatInteger(event.tsMsOffset || 0)}ms</small></div>)}</div> : null}
      </div>
    </article>
  );
}

function buildKnowledgeFiles(uploads, entries) {
  const byFile = new Map();
  for (const entry of entries || []) {
    const fileName = entry.sourceDoc || "Unknown source";
    if (!byFile.has(fileName)) {
      byFile.set(fileName, {
        fileName,
        fileType: "",
        uploadedAt: "",
        uploadedBy: "",
        entryCount: 0,
        entries: [],
      });
    }
    const file = byFile.get(fileName);
    file.entries.push(entry);
    file.entryCount = file.entries.length;
  }

  for (const upload of uploads || []) {
    const fileName = upload.fileName || "Unknown source";
    if (!byFile.has(fileName) && /^\d+\s+files$/i.test(fileName)) {
      continue;
    }
    const file = byFile.get(fileName) || {
      fileName,
      entryCount: 0,
      entries: [],
    };
    byFile.set(fileName, {
      ...file,
      fileType: upload.fileType || file.fileType || "",
      uploadedAt: upload.uploadedAt || file.uploadedAt || "",
      uploadedBy: upload.uploadedBy || file.uploadedBy || "",
      entryCount: file.entries.length || upload.rowCount || 0,
    });
  }

  return Array.from(byFile.values()).sort((left, right) => {
    const leftTime = Date.parse(left.uploadedAt || "") || 0;
    const rightTime = Date.parse(right.uploadedAt || "") || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.fileName.localeCompare(right.fileName);
  });
}

function KnowledgeCitations({ citations }) {
  if (!citations.length) return null;
  return (
    <div className="knowledge-citations">
      {citations.map((citation) => citation.link ? (
        <a className="knowledge-citation-chip" href={citation.link} target="_blank" rel="noreferrer" key={citation.id || citation.label}>{citation.label || citation.id}</a>
      ) : (
        <span className="knowledge-citation-chip" key={citation.id || citation.label}>{citation.label || citation.id}</span>
      ))}
    </div>
  );
}

function KnowledgeHowModal({ onClose }) {
  return (
    <div className="ai-modal knowledge-how-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-how-title">
        <div className="ai-modal-head">
          <div><h2 id="knowledge-how-title">How Knowledge Expert works</h2><p>Grounded answers from a local, curated knowledge base.</p></div>
          <button className="button button-secondary" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="ai-modal-body knowledge-how-body">
          <section><h3>1. Upload trusted content</h3><p>Upload CSV, JSON, HTML, TXT, Markdown, PDF, or DOCX files. Append adds entries; Replace starts from a clean dataset.</p></section>
          <section><h3>2. Optimus prepares entries</h3><p>Files are parsed into knowledge entries. OpenAI embeddings enable semantic search; otherwise the tool uses keyword matching.</p></section>
          <section><h3>3. Questions retrieve matching entries</h3><p>Each chat turn uses the current conversation and recent turns to interpret follow-ups, then searches the active dataset.</p></section>
          <section><h3>4. Answers must cite sources</h3><p>Answers must come from retrieved knowledge entries, include citation IDs, and pass citation validation.</p></section>
          <section><h3>5. Chats stay separate</h3><p>New chat starts a separate conversation while keeping the knowledge base. Clear current removes only that chat's turns.</p></section>
        </div>
      </div>
    </div>
  );
}

function KnowledgeReportModal({ state, onClose }) {
  return (
    <div className="ai-modal knowledge-report-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-report-title">
        <div className="ai-modal-head">
          <div><h2 id="knowledge-report-title">{state.title}</h2><p>{state.subtitle}</p></div>
          <button className="button button-secondary" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="ai-modal-body">
          <div className="knowledge-report-output">
            {state.loading ? <div className="tool-list-state">Loading report...</div> : null}
            {!state.loading && state.error ? <p className="error is-visible">{state.error}</p> : null}
            {!state.loading && !state.error ? <KnowledgeReportBody report={state.report} payload={state.payload || {}} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function KnowledgeReportBody({ report, payload }) {
  if (report === "conversations") {
    const turns = payload.turns || [];
    return (
      <>
        <div className="knowledge-report-summary">
          <span>{formatInteger(payload.totals?.turns)} turns</span>
          <span>{formatInteger(payload.totals?.grounded)} grounded</span>
          <span>{formatInteger(payload.totals?.declined)} declined</span>
          <span>{formatInteger(payload.totals?.errors)} errors</span>
        </div>
        {!turns.length ? <div className="tool-list-state">No turns yet.</div> : null}
        {turns.slice(0, 12).map((turn) => <article key={turn.id}><strong>{turn.userMessage}</strong><p>{turn.assistantResponse}</p></article>)}
      </>
    );
  }
  if (report === "errors") {
    const turns = payload.turns || [];
    return turns.length ? turns.slice(0, 12).map((turn) => <article key={turn.id}><strong>{turn.userMessage}</strong><p>{turn.error || "Error"}</p></article>) : <div className="tool-list-state">No persisted errors.</div>;
  }
  if (report === "dead") {
    const entries = payload.entries || [];
    return entries.length ? entries.slice(0, 20).map((entry) => <article key={entry.id}><strong>{entry.question}</strong><p>{entry.retrieved ? "Retrieved" : "Never retrieved"} · {entry.cited ? "Cited" : "Never cited"}</p></article>) : <div className="tool-list-state">No dead entries yet.</div>;
  }
  const clusters = payload.clusters || [];
  return clusters.length ? clusters.slice(0, 12).map((cluster) => <article key={cluster.id}><strong>{cluster.centroidQuestion}</strong><p>{formatInteger(cluster.memberCount)} similar declined question(s)</p></article>) : <div className="tool-list-state">No knowledge gaps yet.</div>;
}

function ToolPageShell({ title, description, onBack, children }) {
  return (
    <section className="index-page">
      <div className="page-head">
        <div className="page-title">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button className="button button-secondary react-icon-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Back</span>
        </button>
      </div>
      {children}
    </section>
  );
}

function StatsPanel({ caption, range, onRange, customRange, onCustomRange, onInsights, metrics }) {
  return (
    <section className="tool-panel padelog-stats-panel">
      <div className="padelog-stats-head">
        <div className="panel-title">
          <h2>Statistics</h2>
          <p>{caption}</p>
        </div>
        <div className="padelog-range-controls" aria-label="Statistics range">
          {[["month", "Month to date"], ["year", "Year to date"], ["custom", "Custom"]].map(([value, label]) => (
            <button key={value} className={`button button-secondary ${range === value ? "is-active" : ""}`} type="button" onClick={() => onRange(value)}>
              {label}
            </button>
          ))}
          {onInsights ? <button className="button button-primary" type="button" onClick={onInsights}>AI insights</button> : null}
        </div>
      </div>
      {range === "custom" ? (
        <div className="padelog-custom-range">
          <Field label="From"><input type="date" value={customRange.from} onChange={(event) => onCustomRange({ ...customRange, from: event.target.value })} /></Field>
          <Field label="To"><input type="date" value={customRange.to} onChange={(event) => onCustomRange({ ...customRange, to: event.target.value })} /></Field>
        </div>
      ) : null}
      <div className="padelog-metrics">
        {metrics.map(([label, value]) => (
          <article className="padelog-metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function PanelTitle({ title, body }) {
  return <div className="panel-title"><h2>{title}</h2><p>{body}</p></div>;
}

function Field({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

function ScopedMessage({ message }) {
  if (!message.text) return null;
  return <p className={`${message.type === "success" ? "success" : "error"} is-visible`}>{message.text}</p>;
}

function HistoryPanel({ title, count, groupOptions, groupBy, onGroupBy, pageSize, onPageSize, page, totalPages, onPage, children }) {
  return (
    <section className="result-panel">
      <div className="result-head">
        <div><h2>{title}</h2><p>{count}</p></div>
        <div className="padelog-history-controls">
          <Field label="Group by">
            <select value={groupBy} onChange={(event) => onGroupBy(event.target.value)}>
              {groupOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Rows">
            <select value={pageSize} onChange={(event) => onPageSize(event.target.value)}>
              <option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="all">All</option>
            </select>
          </Field>
        </div>
      </div>
      <div className="padelog-table-wrap">{children}</div>
      <div className="padelog-pagination">
        {totalPages <= 1 ? <span className="padelog-page-summary">All rows shown</span> : (
          <>
            <button className="button button-secondary" type="button" disabled={page === 1} onClick={() => onPage(Math.max(1, page - 1))}>Previous</button>
            <span className="padelog-page-summary">Page {page} of {totalPages}</span>
            <button className="button button-secondary" type="button" disabled={page === totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Next</button>
          </>
        )}
      </div>
    </section>
  );
}

function RowActions({ onEdit, onDelete }) {
  return (
    <div className="padelog-row-actions">
      <button className="button button-secondary betlog-icon-button" type="button" onClick={onEdit} aria-label="Edit" title="Edit"><Pencil size={16} /></button>
      <button className="button button-secondary betlog-icon-button" type="button" onClick={onDelete} aria-label="Delete" title="Delete"><Trash2 size={16} /></button>
    </div>
  );
}

function PadelogEditRow({ draft, setDraft, onSave, onCancel }) {
  return (
    <tr className="padelog-edit-row">
      <td><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></td>
      <td><input value={draft.club} onChange={(event) => setDraft({ ...draft, club: event.target.value })} /></td>
      <td><input value={draft.teammate} onChange={(event) => setDraft({ ...draft, teammate: event.target.value })} /></td>
      <td><input value={draft.opponents} onChange={(event) => setDraft({ ...draft, opponents: event.target.value })} /></td>
      <td><select value={draft.result} onChange={(event) => setDraft({ ...draft, result: event.target.value })}><option>Won</option><option>Lost</option><option>Draw</option></select></td>
      <td><input pattern="\d+-\d+" value={draft.sets} onChange={(event) => setDraft({ ...draft, sets: event.target.value })} /></td>
      <td><div className="padelog-row-actions"><button className="button button-primary" type="button" onClick={onSave}>Save</button><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button></div></td>
    </tr>
  );
}

function BetlogFields({ form, setForm }) {
  const set = (patch) => setForm({ ...form, ...patch });
  return (
    <>
      <div className="form-grid padelog-form-grid"><Field label="Date"><input type="date" required value={form.date} onChange={(e) => set({ date: e.target.value })} /></Field><Field label="Time"><input type="time" required value={form.time} onChange={(e) => set({ time: e.target.value })} /></Field></div>
      <div className="form-grid padelog-form-grid"><Field label="Bet ID"><input required value={form.betId} onChange={(e) => set({ betId: e.target.value })} /></Field><Field label="Bet type"><input required value={form.betType} onChange={(e) => set({ betType: e.target.value })} /></Field></div>
      <div className="form-grid padelog-form-grid"><Field label="Stake"><input type="number" min="0" step="0.01" required value={form.stake} onChange={(e) => set({ stake: e.target.value })} /></Field><Field label="Return"><input type="number" min="0" step="0.01" required value={form.returnAmount} onChange={(e) => set({ returnAmount: e.target.value })} /></Field></div>
      <div className="form-grid padelog-form-grid"><Field label="Status"><input required value={form.status} onChange={(e) => set({ status: e.target.value })} /></Field><Field label="Odds"><input type="number" min="1.01" step="0.01" required value={form.odds} onChange={(e) => set({ odds: e.target.value })} /></Field></div>
      <Field label="Selection"><input required value={form.selection} onChange={(e) => set({ selection: e.target.value })} /></Field>
      <Field label="Market"><input required value={form.market} onChange={(e) => set({ market: e.target.value })} /></Field>
      <Field label="Match"><input required value={form.match} onChange={(e) => set({ match: e.target.value })} /></Field>
      <div className="form-grid padelog-form-grid"><Field label="Score"><input value={form.score} onChange={(e) => set({ score: e.target.value })} /></Field><Field label="Outcome type"><input required value={form.outcomeType} onChange={(e) => set({ outcomeType: e.target.value })} /></Field></div>
      <div className="form-grid padelog-form-grid"><label className="toggle-field"><input type="checkbox" checked={form.freeBet} onChange={(e) => set({ freeBet: e.target.checked })} /><span>Free bet</span></label><Field label="Legs"><input type="number" min="1" step="1" required value={form.legs} onChange={(e) => set({ legs: e.target.value })} /></Field></div>
    </>
  );
}

function BetlogDisplayRow({ bet, onEdit, onDelete }) {
  const profit = Number(bet.returnAmount || 0) - (bet.freeBet ? 0 : Number(bet.stake || 0));
  const tone = betlogStatusTone(bet.status);
  return (
    <tr>
      <td className="betlog-date-cell"><strong>{formatCompactDate(bet.date)}</strong><span>{bet.time}</span></td>
      <td><strong className="betlog-primary">{bet.betId}</strong><span className="betlog-muted-line">{bet.betType} · {bet.outcomeType} · {bet.legs} leg{Number(bet.legs) === 1 ? "" : "s"}{bet.freeBet ? " · Free" : ""}</span></td>
      <td className="betlog-money-cell"><span><b>S</b> {formatMoney(bet.stake)}</span><span><b>R</b> {formatMoney(bet.returnAmount)}</span><span className={profit >= 0 ? "is-positive" : "is-negative"}><b>P</b> {formatMoney(profit)}</span></td>
      <td><strong className="betlog-primary">{bet.selection}</strong><span className="betlog-muted-line">{bet.market}</span><span className="betlog-muted-line">{bet.match}{bet.score ? ` · ${bet.score}` : ""}</span></td>
      <td>{formatOdds(bet.odds)}</td>
      <td><span className={`betlog-status ${tone}`} title={bet.status}>{betlogStatusIcon(tone, bet.status)}</span></td>
      <td><RowActions onEdit={onEdit} onDelete={onDelete} /></td>
    </tr>
  );
}

function BetlogEditRow({ draft, setDraft, onSave, onCancel }) {
  const set = (patch) => setDraft({ ...draft, ...patch });
  return (
    <tr className="padelog-edit-row betlog-edit-row"><td colSpan="7">
      <div className="betlog-edit-grid">
        <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} /><input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
        <input value={draft.betId} onChange={(e) => set({ betId: e.target.value })} /><input value={draft.betType} onChange={(e) => set({ betType: e.target.value })} />
        <input type="number" min="0" step="0.01" value={draft.stake} onChange={(e) => set({ stake: e.target.value })} /><input type="number" min="0" step="0.01" value={draft.returnAmount} onChange={(e) => set({ returnAmount: e.target.value })} />
        <input value={draft.status} onChange={(e) => set({ status: e.target.value })} /><input type="number" min="1.01" step="0.01" value={draft.odds} onChange={(e) => set({ odds: e.target.value })} />
        <input className="betlog-edit-wide" value={draft.selection} onChange={(e) => set({ selection: e.target.value })} /><input className="betlog-edit-wide" value={draft.market} onChange={(e) => set({ market: e.target.value })} />
        <input className="betlog-edit-wide" value={draft.match} onChange={(e) => set({ match: e.target.value })} /><input value={draft.score} onChange={(e) => set({ score: e.target.value })} />
        <input value={draft.outcomeType} onChange={(e) => set({ outcomeType: e.target.value })} /><input type="number" min="1" step="1" value={draft.legs} onChange={(e) => set({ legs: e.target.value })} />
        <label className="betlog-edit-free"><input type="checkbox" checked={draft.freeBet} onChange={(e) => set({ freeBet: e.target.checked })} /> Free bet</label>
      </div>
      <div className="padelog-row-actions betlog-edit-actions"><button className="button button-primary" type="button" onClick={onSave}>Save</button><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button></div>
    </td></tr>
  );
}

async function loadMonthlySummary() {
  const [padelogResult, betlogResult] = await Promise.allSettled([request("/tools/padelog/matches"), request("/tools/betlog/bets")]);
  const currentRange = currentMonthDateRange();
  const previousRange = previousMonthDateRange();
  const groups = [];

  if (padelogResult.status === "fulfilled") {
    const matches = padelogResult.value.matches || [];
    const currentPadel = summarizePadelogMatches(matches.filter((match) => isDateInRange(match.date, currentRange)));
    const previousPadel = summarizePadelogMatches(matches.filter((match) => isDateInRange(match.date, previousRange)));
    groups.push({
      title: "Padel performance",
      variant: "padel",
      toolId: "padelog",
      metrics: [
        monthMetric("Matches", currentPadel.matches, previousPadel.matches, { higherIsGood: true }),
        monthMetric("Wins", currentPadel.wins, previousPadel.wins, { higherIsGood: true }),
        monthMetric("Win rate", currentPadel.winRate, previousPadel.winRate, { suffix: "%", higherIsGood: true }),
        monthMetric("Losses", currentPadel.losses, previousPadel.losses, { higherIsGood: false }),
      ],
    });
  }

  if (betlogResult.status === "fulfilled") {
    const bets = betlogResult.value.bets || [];
    const currentBetting = summarizeBetlogBets(bets.filter((bet) => isDateInRange(bet.date, currentRange)));
    const previousBetting = summarizeBetlogBets(bets.filter((bet) => isDateInRange(bet.date, previousRange)));
    groups.push({
      title: "Betting performance",
      variant: "betting",
      toolId: "betlog",
      metrics: [
        monthMetric("Profit", currentBetting.profit, previousBetting.profit, { formatter: formatMoney, higherIsGood: true }),
        monthMetric("ROI", currentBetting.roi, previousBetting.roi, { suffix: "%", higherIsGood: true }),
        monthMetric("Win rate", currentBetting.winRate, previousBetting.winRate, { suffix: "%", higherIsGood: true }),
        monthMetric("Bets", currentBetting.uniqueBets, previousBetting.uniqueBets, { higherIsGood: true }),
      ],
    });
  }

  const errors = [padelogResult, betlogResult].filter((result) => result.status === "rejected");
  return {
    loading: false,
    error: errors.length && !groups.length ? `Could not load monthly performance: ${errors[0].reason.message}` : "",
    groups,
  };
}

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

function storedTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function formatAppVersion(version) {
  const cleanVersion = String(version || "").replace(/-dirty$/, "").trim();
  const tagVersion = cleanVersion.match(/^v?\d+(?:\.\d+)*/)?.[0];
  if (tagVersion) return tagVersion.startsWith("v") ? tagVersion : `v${tagVersion}`;
  return cleanVersion || "Version unavailable";
}

function groupCatalogTools(tools) {
  const visibleTools = tools.filter((tool) => tool.enabled !== false).sort(compareCatalogTools);
  const groups = new Map();
  for (const tool of visibleTools) {
    const groupName = String(tool.groupName || tool.group || "Tools").trim() || "Tools";
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        order: Number.isFinite(tool.groupDisplayOrder) ? tool.groupDisplayOrder : Number.isFinite(tool.groupOrder) ? tool.groupOrder : Number.MAX_SAFE_INTEGER,
        tools: [],
      });
    }
    groups.get(groupName).tools.push(tool);
  }
  return Array.from(groups.values()).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

function compareCatalogTools(left, right) {
  const leftGroupOrder = finite(left.groupDisplayOrder, finite(left.groupOrder, Number.MAX_SAFE_INTEGER));
  const rightGroupOrder = finite(right.groupDisplayOrder, finite(right.groupOrder, Number.MAX_SAFE_INTEGER));
  const leftDisplayOrder = finite(left.displayOrder, Number.MAX_SAFE_INTEGER);
  const rightDisplayOrder = finite(right.displayOrder, Number.MAX_SAFE_INTEGER);
  return (
    leftGroupOrder - rightGroupOrder ||
    String(left.groupName || left.group || "").localeCompare(String(right.groupName || right.group || "")) ||
    leftDisplayOrder - rightDisplayOrder ||
    String(left.title || "").localeCompare(String(right.title || ""))
  );
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function sortAdminCatalog(catalog) {
  const groups = [...(catalog.groups || [])].sort((left, right) => left.displayOrder - right.displayOrder || left.name.localeCompare(right.name));
  const tools = [...(catalog.tools || [])].sort((left, right) => {
    const leftGroup = groups.find((group) => group.id === left.groupId);
    const rightGroup = groups.find((group) => group.id === right.groupId);
    return (
      (leftGroup?.displayOrder || Number.MAX_SAFE_INTEGER) - (rightGroup?.displayOrder || Number.MAX_SAFE_INTEGER) ||
      left.displayOrder - right.displayOrder ||
      left.title.localeCompare(right.title)
    );
  });
  return { groups, tools };
}

function uniqueGroupId(value, groups) {
  const seen = new Set(groups.map((group) => group.id));
  const baseId =
    String(value || "group")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "group";
  let id = baseId;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function formatPerformanceInsightRunMeta(insight) {
  const generatedAt = insight.generatedAt ? new Date(insight.generatedAt) : null;
  const dateText = generatedAt && !Number.isNaN(generatedAt.getTime()) ? generatedAt.toLocaleString() : "Saved run";
  const countText = insight.sourceRecordCount ? ` · ${insight.sourceRecordCount} records` : "";
  return `${dateText}${countText}`;
}

function isModelOnlyInsightText(text) {
  return /^model\s*:\s*claude[\w.-]*\s*$/i.test(String(text || "").trim());
}

function formatInsightTextNodes(text) {
  return String(text || "")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph, paragraphIndex) => (
      <p key={`${paragraphIndex}-${paragraph.slice(0, 16)}`}>
        {paragraph.split(/\n/).map((line, lineIndex) => (
          <React.Fragment key={`${lineIndex}-${line.slice(0, 16)}`}>
            {lineIndex ? <br /> : null}
            {formatBoldTextNodes(line)}
          </React.Fragment>
        ))}
      </p>
    ));
}

function formatBoldTextNodes(text) {
  return String(text || "")
    .split(/(\*\*.*?\*\*)/g)
    .filter(Boolean)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <React.Fragment key={index}>{part}</React.Fragment>,
    );
}

function formatMultilineNodes(text) {
  return String(text || "").split("\n").map((line, index) => (
    <React.Fragment key={`${index}-${line.slice(0, 16)}`}>
      {index ? <br /> : null}
      {line}
    </React.Fragment>
  ));
}

function formatMarkdownNodes(text) {
  const lines = String(text || "").trim().split(/\r?\n/);
  const nodes = [];
  let paragraph = [];
  let list = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    const content = paragraph.join("\n");
    nodes.push(
      <p key={`p-${nodes.length}`}>
        {content.split("\n").map((line, index) => (
          <React.Fragment key={`${index}-${line.slice(0, 16)}`}>
            {index ? <br /> : null}
            {formatMarkdownInlineNodes(line)}
          </React.Fragment>
        ))}
      </p>,
    );
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    const Tag = list.type;
    nodes.push(
      <Tag key={`list-${nodes.length}`}>
        {list.items.map((item, index) => <li key={`${index}-${item.slice(0, 16)}`}>{formatMarkdownInlineNodes(item)}</li>)}
      </Tag>,
    );
    list = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (unordered || ordered) {
      flushParagraph();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ordered || unordered)[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return nodes.length ? nodes : null;
}

function formatMarkdownInlineNodes(text) {
  const nodes = [];
  const pattern = /(\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={nodes.length}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else {
      const [, label, href] = match;
      nodes.push(<a key={nodes.length} href={href} target="_blank" rel="noreferrer">{label}</a>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < String(text || "").length) nodes.push(String(text || "").slice(cursor));
  return nodes;
}

async function streamKnowledgeExpertChat(payload, onText) {
  const response = await fetch(`${API_BASE}/tools/knowledge-expert/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.error || "Could not answer with Knowledge Expert");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let finalTurn = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const rawEvent of events) {
      const parsed = parseSseEvent(rawEvent);
      if (parsed.event === "text_delta") {
        streamedText += parsed.data.delta || "";
        onText(streamedText);
      } else if (parsed.event === "meta") {
        finalTurn = parsed.data.turn;
      } else if (parsed.event === "error") {
        throw new Error(parsed.data.message || "Could not answer with Knowledge Expert");
      }
    }
  }
  if (!finalTurn) throw new Error("Knowledge Expert stream ended without a final answer.");
  return finalTurn;
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  const event = (lines.find((line) => line.startsWith("event:")) || "event: message").slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return { event, data: data ? JSON.parse(data) : {} };
}

function downloadKnowledgeTemplate(type) {
  const templates = {
    csv: {
      fileName: "knowledge-expert-template.csv",
      mimeType: "text/csv;charset=utf-8",
      contents: [
        "category,question,answer,link",
        "Product,What is Optimus?,Optimus is a local personal tools dashboard.,https://example.com/optimus",
        "Policy,Who can use the tool?,Only signed-in Optimus users with the local access key can use it,",
      ].join("\n"),
    },
    json: {
      fileName: "knowledge-expert-template.json",
      mimeType: "application/json;charset=utf-8",
      contents: `${JSON.stringify({ entries: [
        { category: "Product", question: "What is Optimus?", answer: "Optimus is a local personal tools dashboard.", link: "https://example.com/optimus" },
        { category: "Policy", question: "Who can use the tool?", answer: "Only signed-in Optimus users with the local access key can use it.", link: "" },
      ] }, null, 2)}\n`,
    },
  };
  const template = templates[type];
  if (!template) return;
  const url = URL.createObjectURL(new Blob([template.contents], { type: template.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = template.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function fileKey(file) {
  return [file.name, file.size, file.lastModified].join(":");
}

function defaultDemoBuilderValues(count = 2, overrides = {}) {
  const scenarios = createDefaultDemoContent(count);
  return {
    fileName: "demo-builder-template.html",
    scenarioCount: count,
    logoText: "LOGO",
    title: "Use-case Demo",
    subtitle: "Configurable agent simulation template",
    fontUi: "Inter, system-ui, sans-serif",
    fontMono: "JetBrains Mono, monospace",
    brandColor: "#003a7d",
    accentColor: "#c8a84b",
    backgroundColor: "#0e1117",
    fontColor: "#e8eaf0",
    contentJson: JSON.stringify(scenarios, null, 2),
    sizingJson: JSON.stringify(createDefaultSizingContent(scenarios), null, 2),
    glossaryJson: JSON.stringify(createDefaultGlossaryContent(scenarios), null, 2),
    ...overrides,
  };
}

function createDefaultDemoContent(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `scenario-${index + 1}`,
    label: `Scenario ${index + 1} - Placeholder`,
    messages: [
      { role: "agent", text: `Welcome. This is the opening assistant message for scenario ${index + 1}.`, delayMs: 0 },
      { role: "user", text: "Replace this with the user's business question or prompt.", delayMs: 900 },
      { role: "agent", text: "Replace this with the agent response. Use <strong>HTML</strong> for emphasis when needed.", delayMs: 1200 },
    ],
    docs: [
      {
        title: "Document Template",
        subtitle: "Evidence, assumptions, outputs, or preview content",
        icon: "DOC",
        revealAfterMessageIndex: 2,
        delayMs: 250,
        sections: [{ heading: "Placeholder Section", rows: [{ label: "Field", value: "Placeholder value", tone: "neutral" }, { label: "Status", value: "Ready for editing", tone: "ok" }] }],
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
    knowledgeDataSources: ["Ingested (unstructured): Primary domain documentation (PDF)", "Ingested (structured): Program calendar or source table (JSON/CSV)", "Live structured: CRM or member profile API (read-only)"],
    enterpriseSystemConnections: ["CRM - Read access: profile, history, status, and metadata"],
    regulatoryFrameworks: ["Relevant policy / compliance framework", "Internal review and approval rules"],
    clientSidePrerequisites: ["API credentials for connected systems", "Validated source documents and current profile data", "Named human reviewer for edge cases"],
    keySizingDrivers: ["1 enterprise system connector", "5 knowledge sources - multi-framework", "Approval workflow requires human review", "Data mapping and normalization"],
  }));
}

function createDefaultGlossaryContent(scenarios) {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    title: `${scenario.label} Glossary`,
    categories: [
      { category: "Systems & Data", entries: [{ term: "CRM", definition: "Customer relationship management system containing profile, history, and account data." }, { term: "RAG", definition: "Retrieval-augmented generation: the agent searches trusted sources before composing an answer." }] },
      { category: "Delivery Terms", entries: [{ term: "Capability Tier", definition: "Operational complexity level for the use case, such as SOLO or AEON." }, { term: "Commercial Tier", definition: "Commercial packaging level used for sizing, pricing, or rollout planning." }] },
    ],
  }));
}

function summarizeJson(jsonText) {
  try {
    const parsed = JSON.parse(jsonText || "null");
    const scenarios = Array.isArray(parsed) ? parsed : parsed?.scenarios;
    const label = Array.isArray(scenarios) ? `${scenarios.length} scenarios` : Array.isArray(parsed) ? `${parsed.length} entries` : "JSON object";
    const formatted = JSON.stringify(parsed, null, 2);
    return { label, preview: `${formatted.slice(0, 1800)}${formatted.length > 1800 ? "\n..." : ""}` };
  } catch (error) {
    return { label: "Invalid JSON", error: `Invalid JSON: ${error.message}`, preview: "" };
  }
}

function buildDemoBuilderLivePreviewHtml(values) {
  const content = parseDemoContentJson(values.contentJson);
  if (content.error) return buildDemoBuilderPreviewErrorHtml(content.error);
  const sizingContent = parseDemoSizingJson(values.sizingJson, content.scenarios);
  if (sizingContent.error) return buildDemoBuilderPreviewErrorHtml(sizingContent.error);
  const glossaryContent = parseDemoGlossaryJson(values.glossaryJson, content.scenarios);
  if (glossaryContent.error) return buildDemoBuilderPreviewErrorHtml(glossaryContent.error);

  const scenario = content.scenarios[0];
  const messages = (scenario.messages.length ? scenario.messages : createDefaultDemoContent(1)[0].messages).slice(0, 4);
  const logs = (scenario.logs.length ? scenario.logs : createDefaultDemoContent(1)[0].logs).slice(0, 5);
  const sizing = sizingContent.sizing[0];
  const fontUi = safePreviewCssFont(values.fontUi, "Inter, system-ui, sans-serif");
  const fontMono = safePreviewCssFont(values.fontMono, "JetBrains Mono, monospace");
  const scenarioOptions = content.scenarios.map((item) => `<option>${escapeHtml(item.label)}</option>`).join("");
  const glossaryPreview = renderPreviewGlossary(glossaryContent.glossary, scenario.id);
  const sizingMeta = `${sizing.capabilityTier} · ${sizing.connectedDataSources} data sources · ${sizing.connectedEnterpriseSystems} enterprise systems · ${sizing.commercialTier}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%}body{margin:0;height:100vh;overflow:hidden;display:flex;flex-direction:column;background:${escapeAttribute(values.backgroundColor || "#0e1117")};color:${escapeAttribute(values.fontColor || "#e8eaf0")};font:13px ${fontUi};}
.header{height:52px;display:flex;align-items:center;gap:12px;padding:0 16px;background:${escapeAttribute(values.brandColor || "#003a7d")};border-bottom:2px solid ${escapeAttribute(values.accentColor || "#c8a84b")};flex:0 0 auto}
.logo{background:#fff;color:${escapeAttribute(values.brandColor || "#003a7d")};border-radius:4px;padding:5px 9px;font-weight:900;letter-spacing:1px}
h1{margin:0;font-size:14px;line-height:1.1}p{margin:3px 0 0;color:rgba(255,255,255,.68);font-size:11px}.scenario-picker{margin-left:auto;display:flex;align-items:center;gap:7px}.scenario-picker span,.demo-label{color:rgba(255,255,255,.62);font:9px ${fontMono};text-transform:uppercase;letter-spacing:1px}
select{max-width:190px;height:30px;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:0 8px;background:rgba(255,255,255,.12);color:#fff;font:inherit}.glossary-button{border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:7px 9px;background:rgba(255,255,255,.12);color:#fff;font:700 10px ${fontUi}}
.glossary-popover{position:absolute;right:16px;top:58px;width:260px;max-height:190px;overflow:hidden;border:1px solid #2a3550;border-radius:8px;background:#1e2638;box-shadow:0 14px 36px rgba(0,0,0,.35)}.glossary-popover h2{margin:0;padding:9px 11px;border-bottom:1px solid #2a3550;font-size:12px}.glossary-popover-body{padding:8px 11px;color:#9aa5b8;font-size:10px;line-height:1.45}.glossary-popover strong{color:${escapeAttribute(values.accentColor || "#c8a84b")};font-family:${fontMono}}
.main{flex:1;min-height:0;overflow:hidden;display:grid;grid-template-columns:42% 58%}.chat{min-height:0;overflow:hidden;display:flex;flex-direction:column;background:#f8f9fb;color:#1a2030;border-right:1px solid #2a3550}.preview-messages{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:9px;padding:10px}.preview-msg{display:grid;grid-template-columns:24px minmax(0,1fr) 24px;align-items:start;gap:7px}.preview-avatar{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:${escapeAttribute(values.brandColor || "#003a7d")};color:#fff;font-size:12px}.preview-avatar.user{grid-column:3;background:#475569}.bubble{grid-column:2;width:fit-content;max-width:100%;padding:8px 10px;border-radius:12px;background:#fff;border:1px solid #d8dde8;line-height:1.4}.preview-msg.user .bubble{justify-self:end;background:${escapeAttribute(values.brandColor || "#003a7d")};color:#fff;border-color:${escapeAttribute(values.brandColor || "#003a7d")}}
.preview-input{flex:0 0 auto;display:flex;gap:6px;padding:8px;border-top:1px solid #d8dde8;background:#fff}.preview-input input{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;background:#f8fafc;font:10px ${fontUi}}.preview-input button{border:0;border-radius:6px;padding:6px 9px;background:${escapeAttribute(values.brandColor || "#003a7d")};color:#fff;font:700 10px ${fontUi}}
.right{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#141820}.right-tabs{height:30px;display:flex;border-bottom:1px solid #2a3550;background:#1e2638}.right-tab{display:flex;align-items:center;padding:0 10px;border-bottom:2px solid transparent;color:#64748b;font-size:9px;font-weight:800}.right-tab.active{color:#e8eaf0;border-bottom-color:${escapeAttribute(values.brandColor || "#003a7d")};background:#141820}.split-preview{flex:1;min-height:0;display:grid;grid-template-rows:1fr 126px}.doc{margin:12px;border:1px solid #2a3550;border-radius:8px;overflow:hidden;background:#1e2638}.doc-head{padding:10px 12px;border-bottom:1px solid #2a3550;font-weight:800}.doc-body{padding:10px 12px;color:#9aa5b8;line-height:1.5}.log-head{border-top:2px solid ${escapeAttribute(values.accentColor || "#c8a84b")};border-bottom:1px solid #2a3550;padding:5px 10px;background:#1e2638;color:#64748b;display:flex;align-items:center;gap:7px;font:9px ${fontMono};text-transform:uppercase;letter-spacing:1px}.live-dot{width:6px;height:6px;border-radius:50%;background:#34d399}.logs{min-height:0;overflow:auto;padding:6px 10px;background:#0b0f16;color:#9aa5b8;font:9.5px ${fontMono}}.log-line{display:flex;gap:7px;align-items:flex-start;padding:2px 0;border-bottom:1px solid rgba(42,53,80,.25)}.log-type{min-width:46px;padding:1px 4px;border-radius:3px;text-align:center;color:${escapeAttribute(values.accentColor || "#c8a84b")};background:rgba(200,168,75,.14);font-size:8px;font-weight:900;text-transform:uppercase}
.demo-bar{min-height:44px;display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #2a3550;background:#1e2638;flex:0 0 auto}.demo-bar button{border:0;border-radius:6px;padding:6px 9px;background:${escapeAttribute(values.brandColor || "#003a7d")};color:#fff;font:700 10px ${fontUi}}.sizing-info{margin-left:auto;color:#9aa5b8;font:9px ${fontMono};white-space:nowrap}
</style>
</head>
<body>
  <header class="header"><div class="logo">${escapeHtml(values.logoText || "LOGO")}</div><div><h1>${escapeHtml(values.title || "Use-case Demo")}</h1><p>${escapeHtml(values.subtitle || "Configurable agent simulation template")}</p></div><label class="scenario-picker"><span>Scenario</span><select>${scenarioOptions}</select></label><button type="button" class="glossary-button">Glossary</button>${glossaryPreview}</header>
  <main class="main"><section class="chat"><div class="preview-messages">${messages.map(renderPreviewMessage).join("")}</div><div class="preview-input"><input readonly placeholder="Write your message here..." /><button type="button">Send</button></div></section><section class="right"><div class="right-tabs"><div class="right-tab active">Docs + Agent Log</div><div class="right-tab">Docs only</div><div class="right-tab">Agent Log only</div></div><div class="split-preview">${renderPreviewPrerequisitesDoc(sizing)}<div><div class="log-head"><span class="live-dot"></span><span>Agent Log - Live Processing</span></div><div class="logs">${logs.map(renderPreviewLog).join("")}</div></div></div></section></main>
  <footer class="demo-bar"><span class="demo-label">Simulation</span><button type="button">Start</button><button type="button" disabled>Pause</button><div class="sizing-info">${escapeHtml(sizingMeta)}</div></footer>
</body>
</html>`;
}

function parseDemoContentJson(contentJson) {
  try {
    const parsed = JSON.parse(contentJson || "[]");
    const scenarios = Array.isArray(parsed) ? parsed : parsed.scenarios;
    if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 8) return { error: "Content JSON must contain between 1 and 8 scenarios." };
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
    if (!Array.isArray(entries)) return { error: "Sizing JSON must be an array or an object with a sizing array." };
    const defaults = createDefaultSizingContent(scenarios);
    const byScenario = new Map(entries.map((entry) => [String(entry.scenarioId || ""), entry]));
    return {
      sizing: scenarios.map((scenario, index) => {
        const entry = byScenario.get(scenario.id) || {};
        const fallback = defaults[index];
        return {
          ...fallback,
          ...entry,
          connectedDataSources: Number(entry.connectedDataSources ?? fallback.connectedDataSources) || 0,
          connectedEnterpriseSystems: Number(entry.connectedEnterpriseSystems ?? fallback.connectedEnterpriseSystems) || 0,
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
    if (!Array.isArray(glossary)) return { error: "Glossary JSON must be an array or an object with a glossary array." };
    if (glossary.some((item) => Array.isArray(item.categories))) {
      return {
        glossary: scenarios.map((scenario, index) => {
          const entry = glossary.find((item) => String(item.scenarioId || "") === scenario.id) || glossary[index] || {};
          return { scenarioId: scenario.id, title: String(entry.title || `${scenario.label} Glossary`), categories: normalizePreviewGlossaryCategories(entry.categories) };
        }),
      };
    }
    return { glossary: [{ scenarioId: "*", title: "Glossary", categories: normalizePreviewGlossaryCategories(glossary) }] };
  } catch {
    return { error: "Glossary JSON is not valid JSON." };
  }
}

function normalizePreviewGlossaryCategories(categories) {
  const source = Array.isArray(categories) && categories.length ? categories : createDefaultGlossaryContent([{ id: "scenario-1", label: "Scenario 1" }])[0].categories;
  return source.map((category) => ({
    category: String(category.category || "Glossary"),
    entries: Array.isArray(category.entries) ? category.entries.map((entry) => ({ term: String(entry.term || "Term"), definition: String(entry.definition || "Definition") })) : [],
  }));
}

function renderPreviewMessage(message) {
  const role = message.role === "user" ? "user" : "agent";
  const avatar = role === "user" ? "U" : "A";
  return `<div class="preview-msg ${role}">${role === "agent" ? `<div class="preview-avatar agent">${avatar}</div>` : "<div></div>"}<div class="bubble">${sanitizePreviewHtml(message.text || "Placeholder message")}</div>${role === "user" ? `<div class="preview-avatar user">${avatar}</div>` : "<div></div>"}</div>`;
}

function renderPreviewPrerequisitesDoc(sizing) {
  const sourceItems = (sizing.knowledgeDataSources || []).slice(0, 3);
  const driverItems = (sizing.keySizingDrivers || []).slice(0, 3);
  const items = [...sourceItems, `Scope: ${sizing.implementationSize}`, ...driverItems].map((item) => `<div>${escapeHtml(item)}</div>`).join("");
  return `<div class="docs-preview"><article class="doc"><div class="doc-head">${escapeHtml(sizing.title || "Deployment Prerequisites")}</div><div class="doc-body"><strong>${escapeHtml(sizing.subtitle || "Scenario prerequisites")}</strong>${items}</div></article></div>`;
}

function renderPreviewLog(log) {
  const type = String(log.type || "info").toLowerCase();
  return `<div class="log-line"><span class="log-type ${escapeAttribute(type)}">${escapeHtml(type)}</span><span>${escapeHtml(log.text || "Processing step")}</span></div>`;
}

function renderPreviewGlossary(glossary, scenarioId) {
  const scenarioGlossary = (glossary || []).find((entry) => entry.scenarioId === scenarioId) || (glossary || []).find((entry) => entry.scenarioId === "*") || (glossary || [])[0] || { categories: [] };
  const entries = (scenarioGlossary.categories || []).flatMap((category) => category.entries || []).slice(0, 3).map((entry) => `<strong>${escapeHtml(entry.term)}</strong>: ${escapeHtml(entry.definition)}`).join("<br>");
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
  return !font || /[<>{};]/.test(font) ? fallback : font.slice(0, 120);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function currentMonthDateRange(date = new Date()) {
  return {
    from: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`,
    to: localDateInputValue(date),
  };
}

function previousMonthDateRange(date = new Date()) {
  const previousMonthStart = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const previousMonthEnd = new Date(date.getFullYear(), date.getMonth(), 0);
  return {
    from: localDateInputValue(previousMonthStart),
    to: localDateInputValue(previousMonthEnd),
  };
}

function localDateInputValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeInputValue(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isDateInRange(dateText, range) {
  return dateText >= range.from && dateText <= range.to;
}

function summarizePadelogMatches(matches) {
  const wins = matches.filter((match) => match.result === "Won").length;
  const losses = matches.filter((match) => match.result === "Lost").length;
  const draws = matches.filter((match) => match.result === "Draw").length;
  return {
    matches: matches.length,
    wins,
    losses,
    draws,
    winRate: matches.length ? Math.round((wins / matches.length) * 100) : 0,
    clubs: new Set(matches.map((match) => match.club)).size,
    teammates: new Set(matches.map((match) => match.teammate)).size,
    setsLogged: matches.filter((match) => match.sets && match.sets !== "-").length,
  };
}

function summarizeBetlogBets(bets) {
  const byBetId = new Map();
  for (const bet of bets) {
    const key = bet.betId || bet.id;
    if (!byBetId.has(key)) byBetId.set(key, bet);
  }
  const uniqueBets = Array.from(byBetId.values());
  const stake = uniqueBets.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  const returns = uniqueBets.reduce((sum, bet) => sum + Number(bet.returnAmount || 0), 0);
  const profit = returns - stake;
  const settled = uniqueBets.filter((bet) => !/^open$/i.test(String(bet.status || "")));
  const wins = settled.filter((bet) => Number(bet.returnAmount || 0) > Number(bet.stake || 0)).length;
  return {
    uniqueBets: uniqueBets.length,
    stake,
    returns,
    profit,
    roi: stake ? Math.round((profit / stake) * 1000) / 10 : 0,
    winRate: settled.length ? Math.round((wins / settled.length) * 100) : 0,
  };
}

function monthMetric(label, current, previous, options = {}) {
  const formatter = options.formatter || ((value) => `${formatSummaryNumber(value)}${options.suffix || ""}`);
  const delta = Number(current || 0) - Number(previous || 0);
  const higherIsGood = options.higherIsGood !== false;
  const tone = delta === 0 ? "is-neutral" : (delta > 0) === higherIsGood ? "is-positive" : "is-negative";
  const deltaPrefix = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const deltaFormatter = options.formatter || ((value) => `${formatSummaryNumber(value)}${options.suffix || ""}`);
  return {
    label,
    value: formatter(current),
    deltaLabel: `${deltaPrefix}${deltaFormatter(Math.abs(delta))} vs previous month`,
    tone,
  };
}

function formatSummaryNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatRangeDates(startingAt, endingAt) {
  const start = new Date(startingAt);
  const end = new Date(endingAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  const inclusiveEnd = new Date(end.getTime() - 1);
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(start)} - ${formatter.format(inclusiveEnd)}`;
}

function formatOdds(value) {
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function activeDateRange(range, customRange) {
  const today = new Date();
  const todayText = localDateInputValue(today);
  if (range === "year") return { from: `${today.getFullYear()}-01-01`, to: todayText, label: "Year to date" };
  if (range === "custom") return { from: customRange.from || "0000-01-01", to: customRange.to || "9999-12-31", label: "Custom range" };
  return { from: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`, to: todayText, label: "Month to date" };
}

function paginate(rows, page, pageSize) {
  const size = pageSize === "all" ? Infinity : Math.max(1, Number(pageSize) || 25);
  const totalPages = size === Infinity ? 1 : Math.max(1, Math.ceil(rows.length / size));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = size === Infinity ? 0 : (currentPage - 1) * size;
  const pageRows = size === Infinity ? rows : rows.slice(start, start + size);
  return { rows: pageRows, totalPages, start, end: start + pageRows.length };
}

function sortPadelogDisplay(matches, groupBy) {
  if (groupBy !== "club") return matches;
  return [...matches].sort((left, right) => String(left.club || "").localeCompare(String(right.club || "")) || right.date.localeCompare(left.date));
}

function sortBetlogDisplay(bets, groupBy) {
  if (groupBy === "status") return [...bets].sort((a, b) => String(a.status || "").localeCompare(String(b.status || "")) || b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  if (groupBy === "betType") return [...bets].sort((a, b) => String(a.betType || "").localeCompare(String(b.betType || "")) || b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return bets;
}

function withGroups(rows, groupBy, labelForRow) {
  const output = [];
  let active = "";
  for (const row of rows) {
    const label = labelForRow(row, groupBy);
    if (label && label !== active) {
      output.push({ type: "group", key: `${label}-${row.id}`, label });
      active = label;
    }
    output.push({ type: "row", row });
  }
  return output;
}

function padelogGroupLabel(match, groupBy) {
  if (groupBy === "none") return "";
  if (groupBy === "club") return match.club || "Unknown club";
  return formatMonth(match.date);
}

function betlogGroupLabel(bet, groupBy) {
  if (groupBy === "none") return "";
  if (groupBy === "status") return bet.status || "Unknown status";
  if (groupBy === "betType") return bet.betType || "Unknown bet type";
  return formatMonth(bet.date);
}

function formatDisplayDate(dateText) {
  if (!dateText) return "";
  const [year, month, day] = dateText.split("-");
  return `${day}/${month}/${year}`;
}

function formatCompactDate(dateText) {
  if (!dateText) return "";
  const [, month, day] = dateText.split("-");
  return `${day}/${month}`;
}

function formatMonth(dateText) {
  const [year, month] = String(dateText || "").split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return Number.isNaN(date.getTime()) ? "Unknown month" : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
}

function parsePadelogCsv(text) {
  return parseCsvRowsWithRequiredHeaders(text, ["Padel Club", "Date", "Opponents", "Result", "Sets"], { oneOf: [["Teamate", "Teammate"]], oneOfLabel: "Teamate" }).map((row) => ({
    club: row["Padel Club"] || row.club || row.padelClub,
    date: row.Date || row.date,
    teammate: row.Teamate || row.Teammate || row.teammate || row.teamate,
    opponents: row.Opponents || row.opponents,
    result: row.Result || row.result,
    sets: row.Sets || row.sets,
  }));
}

function parseBetlogCsv(text) {
  return parseCsvRowsWithRequiredHeaders(text, ["date", "time", "bet_id", "bet_type", "stake", "free_bet", "status", "return_amount", "selection", "odds", "market", "match", "score", "outcome_type", "legs"]).map((row) => ({
    date: row.date, time: row.time, betId: row.bet_id, betType: row.bet_type, stake: row.stake, freeBet: row.free_bet, status: row.status,
    returnAmount: row.return_amount, selection: row.selection, odds: row.odds, market: row.market, match: row.match, score: row.score, outcomeType: row.outcome_type, legs: row.legs,
  }));
}

function parseCsvRowsWithRequiredHeaders(text, requiredHeaders, options = {}) {
  const rows = parseCsvText(text).filter((row) => row.some((cell) => String(cell).trim()));
  if (rows.length < 2) throw new Error("CSV needs a header row and at least one data row.");
  const headers = rows[0].map((header) => String(header).trim());
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (options.oneOf) {
    options.oneOf.forEach((accepted, index) => {
      if (!headers.some((header) => accepted.includes(header))) missing.push(Array.isArray(options.oneOfLabel) ? options.oneOfLabel[index] : options.oneOfLabel);
    });
  }
  if (missing.length) throw new Error(`CSV is missing: ${missing.join(", ")}`);
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, String(cells[index] || "").trim()])));
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"'; index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      row.push(value); value = "";
    } else if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") index += 1;
      row.push(value); rows.push(row); row = []; value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  rows.push(row);
  return rows;
}

function padelogTemplate() {
  return 'Padel Club,Date,Teamate,Opponents,Result,Sets\nExample Club,2026-05-15,Partner Name,"Opponent A / Opponent B",Won,2-1\n';
}

function betlogTemplate() {
  return [
    "date,time,bet_id,bet_type,stake,free_bet,status,return_amount,selection,odds,market,match,score,outcome_type,legs",
    "2026-05-15,22:57,20020850127,Μονό,5.00,false,Χαμένο,0.00,Ααράου,2.55,Επόμενο Γκολ (Γκολ 5),Ααράου - Ιβερντόν,2-2,single,1",
  ].join("\n") + "\n";
}

function downloadTextFile(text, fileName, mimeType) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function betlogStatusTone(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["won", "win", "κερδισμένο", "cash out"].includes(normalized)) return "won";
  if (["lost", "loss", "χαμένο"].includes(normalized)) return "lost";
  return "draw";
}

function betlogStatusIcon(tone, status) {
  if (String(status || "").trim().toLowerCase() === "cash out") return "↗";
  if (tone === "won") return "✓";
  if (tone === "lost") return "×";
  return "…";
}

function isOpenBetStatus(status) {
  return ["open", "pending", "active", "ανοιχτό", "εκκρεμεί"].includes(String(status || "").trim().toLowerCase());
}

function isWinningBetStatus(status) {
  return ["won", "win", "κερδισμένο", "cash out"].includes(String(status || "").trim().toLowerCase());
}

function newNote() {
  const now = new Date().toISOString();
  return { id: randomId(), title: "Untitled note", createdAt: now, updatedAt: now, pages: [newPage()], exportedFileName: "", exportedAt: "" };
}

function newPage() {
  return { id: randomId(), width: NOTELOG_PAGE_WIDTH, height: NOTELOG_PAGE_HEIGHT, background: "grid", strokes: [] };
}

function normalizeNote(note) {
  return {
    ...note,
    title: note.title || "Untitled note",
    pages: Array.isArray(note.pages) && note.pages.length ? note.pages.map(normalizePage) : [newPage()],
    exportedFileName: note.exportedFileName || "",
    exportedAt: note.exportedAt || "",
  };
}

function normalizePage(page) {
  const width = Number(page?.width) || NOTELOG_PAGE_WIDTH;
  const height = Number(page?.height) || NOTELOG_PAGE_HEIGHT;
  if (width >= height) {
    return { ...page, width, height, background: page.background || "grid", strokes: page.strokes || [] };
  }
  const scaleX = NOTELOG_PAGE_WIDTH / width;
  const scaleY = NOTELOG_PAGE_HEIGHT / height;
  return {
    ...page,
    width: NOTELOG_PAGE_WIDTH,
    height: NOTELOG_PAGE_HEIGHT,
    background: page.background || "grid",
    strokes: (page.strokes || []).map((stroke) => ({
      ...stroke,
      points: (stroke.points || []).map((point) => ({ ...point, x: point.x * scaleX, y: point.y * scaleY })),
    })),
  };
}

function randomId() {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function structuredCloneSafe(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    pressure: event.pressure || 0.5,
  };
}

function calibratedCanvasPoint(event, canvas, calibration) {
  return applyNotelogCalibration(canvasPoint(event, canvas), calibration);
}

function loadNotelogCalibration() {
  try {
    const calibration = JSON.parse(localStorage.getItem(NOTELOG_CALIBRATION_STORAGE_KEY) || "null");
    return isValidNotelogCalibration(calibration) ? calibration : null;
  } catch {
    return null;
  }
}

function isValidNotelogCalibration(calibration) {
  return Boolean(
    calibration &&
      NOTELOG_CALIBRATION_STEPS.every((step) => Number.isFinite(calibration[step.id]?.x) && Number.isFinite(calibration[step.id]?.y)),
  );
}

function applyNotelogCalibration(point, calibration) {
  if (!isValidNotelogCalibration(calibration)) return point;

  const topLeft = calibration.topLeft;
  const topRight = calibration.topRight;
  const bottomLeft = calibration.bottomLeft;
  const axisX = { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y };
  const axisY = { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y };
  const determinant = axisX.x * axisY.y - axisX.y * axisY.x;
  if (Math.abs(determinant) < 0.001) return point;

  const raw = { x: point.x - topLeft.x, y: point.y - topLeft.y };
  const unitX = (raw.x * axisY.y - raw.y * axisY.x) / determinant;
  const unitY = (axisX.x * raw.y - axisX.y * raw.x) / determinant;
  return {
    ...point,
    x: clampNumber(unitX * NOTELOG_PAGE_WIDTH, 0, NOTELOG_PAGE_WIDTH),
    y: clampNumber(unitY * NOTELOG_PAGE_HEIGHT, 0, NOTELOG_PAGE_HEIGHT),
  };
}

function calibrationTargetStyle(calibrationDraft) {
  const step = NOTELOG_CALIBRATION_STEPS[calibrationDraft.points.length] || NOTELOG_CALIBRATION_STEPS[0];
  return {
    left: `${(step.x / NOTELOG_PAGE_WIDTH) * 100}%`,
    top: `${(step.y / NOTELOG_PAGE_HEIGHT) * 100}%`,
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pointDistance(left, right) {
  return Math.hypot((right.x || 0) - (left.x || 0), (right.y || 0) - (left.y || 0));
}

function smoothPoints(points) {
  if (!Array.isArray(points) || points.length < 4) return points || [];
  const smoothed = points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1];
    const next = points[index + 1];
    return {
      ...point,
      x: previous.x * 0.2 + point.x * 0.6 + next.x * 0.2,
      y: previous.y * 0.2 + point.y * 0.6 + next.y * 0.2,
      pressure: previous.pressure * 0.15 + point.pressure * 0.7 + next.pressure * 0.15,
    };
  });
  return smoothed.filter((point, index) => index === 0 || index === smoothed.length - 1 || pointDistance(smoothed[index - 1], point) >= 1.8);
}

function drawNotelogCanvas(canvas, page) {
  if (!canvas || !page) return;
  canvas.width = page.width || NOTELOG_PAGE_WIDTH;
  canvas.height = page.height || NOTELOG_PAGE_HEIGHT;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawNotelogBackground(context, page);
  for (const stroke of page.strokes || []) drawNotelogStroke(context, stroke);
}

function drawNotelogBackground(context, page) {
  context.save();
  context.strokeStyle = "#dbe7f6";
  context.fillStyle = "#dbe7f6";
  context.lineWidth = 1;
  if (page.background === "ruled" || page.background === "cornell" || page.background === "meeting") {
    for (let y = 96; y < page.height; y += 44) {
      context.beginPath(); context.moveTo(72, y); context.lineTo(page.width - 72, y); context.stroke();
    }
  } else if (page.background === "dots") {
    for (let y = 52; y < page.height; y += 32) {
      for (let x = 52; x < page.width; x += 32) {
        context.beginPath(); context.arc(x, y, 1.3, 0, Math.PI * 2); context.fill();
      }
    }
  } else if (page.background === "grid") {
    for (let x = 50; x < page.width; x += 32) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, page.height); context.stroke();
    }
    for (let y = 50; y < page.height; y += 32) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(page.width, y); context.stroke();
    }
  }
  context.strokeStyle = "#c6d4ea";
  context.lineWidth = 2;
  if (page.background === "cornell") {
    context.beginPath();
    context.moveTo(330, 70); context.lineTo(330, page.height - 190);
    context.moveTo(72, page.height - 190); context.lineTo(page.width - 72, page.height - 190);
    context.stroke();
  } else if (page.background === "meeting") {
    context.beginPath();
    context.moveTo(72, 92); context.lineTo(page.width - 72, 92);
    context.moveTo(72, 150); context.lineTo(page.width - 72, 150);
    context.moveTo(page.width - 360, 92); context.lineTo(page.width - 360, 150);
    context.moveTo(page.width - 360, 210); context.lineTo(page.width - 360, page.height - 72);
    context.moveTo(page.width - 360, page.height - 220); context.lineTo(page.width - 72, page.height - 220);
    context.stroke();
  }
  context.restore();
}

function drawNotelogStroke(context, stroke) {
  const points = stroke.points || [];
  if (points.length < 2) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color || "#111827";
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const pressure = Math.max(0.22, ((previous.pressure || 0.5) + (current.pressure || 0.5)) / 2);
    context.lineWidth = Math.max(0.8, (stroke.size || 4) * (0.55 + pressure));
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(current.x, current.y);
    context.stroke();
  }
  context.restore();
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function downloadBase64File(base64, fileName, mimeType) {
  const link = document.createElement("a");
  link.href = `data:${mimeType};base64,${base64}`;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

createRoot(document.getElementById("root")).render(<App />);
