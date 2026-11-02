import React, { useEffect, useRef, useState } from "react";
import "./mydata.css";
import { ExtractionPanel } from "./ExtractionPanel";
import { OriginalDocument } from "./OriginalDocument";

const root = "/tools/mydata-invoices";
const kinds = { supplier_invoice: "Supplier invoice", retail_receipt: "Retail receipt", credit_note: "Credit note", other: "Other document" };
function lastMonth() {
  const date = new Date();
  date.setDate(1); date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function blank(month) {
  return { reviewMonth: month, kind: "supplier_invoice", currency: "EUR", lines: [], supplier: "", supplierVat: "", number: "",
    issueDate: "", net: "", vat: "", otherTaxes: "", total: "", description: "", businessPurpose: "",
    classificationCategory: "", classificationType: "", vatTreatment: "", mark: "", notes: "" };
}

export function MydataPurchases({ request, apiBase, onBack }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [period, setPeriod] = useState(lastMonth);
  const [end, setEnd] = useState(lastMonth);
  const [custom, setCustom] = useState(false);
  const [uploadQrLookup, setUploadQrLookup] = useState(() => localStorage.getItem("optimus-mydata-qr-lookup") !== "off");
  const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ invoices: [], total: 0, progress: {} });
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [settings, setSettings] = useState(false);
  const [companyDraft, setCompanyDraft] = useState({ name: "", vatNumber: "", notes: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [previewPage, setPreviewPage] = useState(1);
  const guard = useRef({ dirty, busy });
  guard.current = { dirty, busy };
  const filesRef = useRef(null);
  const restoreRef = useRef(null);
  const activeCompany = companies.find((company) => company.id === companyId);
  const rangeEnd = custom ? end : period;
  const endpoint = `${root}/companies/${companyId}`;

  useEffect(() => {
    let current = true;
    request(`${root}/companies`).then((result) => {
      if (!current) return;
      setCompanies(result.companies);
      setCompanyId(result.companies[0]?.id || "");
      if (!result.companies.length) setSettings(true);
    }).catch((e) => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [request]);

  useEffect(() => {
    if (!companyId) return;
    let current = true;
    setLoading(true); setError("");
    request(`${endpoint}/invoices?${new URLSearchParams({ start: period, end: rangeEnd, offset, status: filter })}`)
      .then((result) => { if (current) setData(result); })
      .catch((e) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [companyId, period, rangeEnd, offset, filter, refresh, request]);

  useEffect(() => {
    if (draft || settings || !data.invoices.some((invoice) => ["queued", "running"].includes(invoice.extractionState))) return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 3000);
    return () => clearTimeout(timer);
  }, [draft, settings, data.invoices]);

  useEffect(() => {
    function unload(event) { if (guard.current.dirty || guard.current.busy) { event.preventDefault(); event.returnValue = ""; } }
    function logout(event) {
      if (guard.current.busy) { event.preventDefault(); return; }
      if (guard.current.dirty) {
        event.preventDefault();
        setConfirmation({ message: "You have unsaved myDATA changes. Discard them and leave?", label: "Discard and leave", proceed: () => {
          guard.current.dirty = false; setDirty(false); event.detail?.proceed?.();
        } });
      }
    }
    window.addEventListener("beforeunload", unload);
    window.addEventListener("optimus-before-navigation", logout);
    window.addEventListener("sticky-notes-before-logout", logout);
    return () => { window.removeEventListener("beforeunload", unload); window.removeEventListener("optimus-before-navigation", logout); window.removeEventListener("sticky-notes-before-logout", logout); };
  }, [dirty]);

  function leave(action) {
    if (busy) return;
    const proceed = () => {
      guard.current.dirty = false;
      setDirty(false); setDraft(null); setHistory(null); setNotice(""); setError(""); action();
    };
    if (dirty) setConfirmation({ message: "Discard your unsaved changes?", label: "Discard changes", proceed });
    else proceed();
  }
  function edit(row) { leave(() => { setSettings(false); setPreviewPage(1); setDraft(structuredClone(row)); }); }
  function setQrLookupPreference(value) {
    setUploadQrLookup(value); localStorage.setItem("optimus-mydata-qr-lookup", value ? "on" : "off");
  }
  function patch(key, value) { setDirty(true); setDraft((old) => ({ ...old, [key]: value })); }
  async function run(action) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function save(reviewed, next = false) {
    await run(async () => {
      const result = await request(`${endpoint}/invoices`, { method: "POST", body: JSON.stringify({ ...draft, markReviewed: reviewed }) });
      setDirty(false); setHistory(null); setRefresh((value) => value + 1);
      const following = next ? data.invoices.find((row) => row.id !== draft.id && !row.reviewed) : null;
      setDraft(following ? structuredClone(following) : result.invoice);
      setNotice(next && !following ? "Saved. No further unreviewed purchases on this page." : reviewed ? "Details reviewed. AADE submission is not enabled yet." : "Draft saved. Any previous review has been cleared.");
    });
  }
  async function upload(files) {
    if (!files.length) return;
    if (files.length > 50) { setError("Choose up to 50 files per batch."); return; }
    await run(async () => {
      let added = 0, duplicates = 0;
      const failures = [];
      for (let index = 0; index < files.length; index++) {
        setNotice(`Uploading ${index + 1} of ${files.length}…`);
        if (files[index].size > 25 * 1024 * 1024) { failures.push(`${files[index].name}: exceeds 25 MB`); continue; }
        const form = new FormData(); form.append("file", files[index]); form.append("reviewMonth", period); form.append("lookupQr", String(uploadQrLookup));
        try {
          const result = await request(`${endpoint}/documents`, { method: "POST", headers: {}, body: form });
          if (result.duplicate) duplicates++; else added++;
        } catch (e) { failures.push(`${files[index].name}: ${e.message}`); }
      }
      setOffset(0); setFilter("all"); setRefresh((value) => value + 1);
      setNotice(`${added} added. ${duplicates} duplicate${duplicates === 1 ? "" : "s"} already in this company’s records (possibly another month).`);
      if (failures.length) setError(failures.join("\n"));
    });
  }
  async function saveCompany(event) {
    event.preventDefault();
    await run(async () => {
      const result = await request(`${root}/companies`, { method: "POST", body: JSON.stringify(companyDraft) });
      const list = (await request(`${root}/companies`)).companies;
      setCompanies(list); setCompanyId(result.company.id); setCompanyDraft(result.company); setDirty(false);
      setRefresh((value) => value + 1); setNotice("Company saved.");
    });
  }
  async function restore(file) {
    if (!file) return;
    setConfirmation({ message: "Replace all myDATA companies, purchases and originals with this backup? All restored purchases will need review again. Other Optimus tools are unaffected.", label: "Restore backup", proceed: () => restoreFile(file) });
  }
  async function restoreFile(file) {
    await run(async () => {
      const envelope = JSON.parse(await file.text());
      await request(`${root}/restore`, { method: "POST", body: JSON.stringify(envelope) });
      const result = await request(`${root}/companies`);
      setCompanies(result.companies); setCompanyId(result.companies[0]?.id || "");
      setCompanyDraft({ name: "", vatNumber: "", notes: "" }); setDirty(false); setOffset(0);
      setData({ invoices: [], total: 0, progress: {} }); setRefresh((value) => value + 1);
      setNotice("Backup restored. Review is required again. No AADE writes are enabled.");
    });
  }
  const field = (label, key, options = {}) => <label className="field" key={key}>{label}
    {options.area ? <textarea rows={options.rows || 3} value={draft[key] || ""} onChange={(e) => patch(key, e.target.value)} /> :
      <input type={options.type || "text"} inputMode={options.money ? "decimal" : undefined} value={draft[key] || ""} onChange={(e) => patch(key, e.target.value)} />}</label>;

  return <section className="index-page mydata-page">
    {confirmation && <div className="mydata-confirm-backdrop"><section className="tool-panel mydata-confirm" role="dialog" aria-modal="true" aria-labelledby="mydata-confirm-title">
      <h2 id="mydata-confirm-title">Confirm action</h2><p>{confirmation.message}</p><div className="mydata-actions">
        <button className="button button-secondary" autoFocus onClick={() => setConfirmation(null)}>Keep working</button>
        <button className="button button-primary" onClick={() => { const proceed = confirmation.proceed; setConfirmation(null); proceed(); }}>{confirmation.label}</button>
      </div></section></div>}
    <div className="page-head"><div className="page-title"><h1>myDATA Purchases</h1><p>Monthly purchase review · Χαρακτηρισμός παραστατικών</p></div>
      <button className="button button-secondary" disabled={busy} onClick={() => leave(onBack)}>Back to tools</button></div>
    <p className="mydata-stage">Preparation workspace · AADE import and submission are coming in the next stages. No invoices or classifications are submitted.</p>
    <div className="mydata-toolbar tool-panel">
      <label className="field">Company<select disabled={busy} value={companyId} onChange={(e) => leave(() => { setCompanyId(e.target.value); setSettings(false); setOffset(0); })}>
        <option value="" disabled>Select company</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
      <label className="field">{custom ? "From month" : "Review month"}<input disabled={busy} type="month" value={period} onChange={(e) => leave(() => { setPeriod(e.target.value); setOffset(0); })} /></label>
      {custom && <label className="field">Through month<input disabled={busy} type="month" value={end} onChange={(e) => leave(() => { setEnd(e.target.value); setOffset(0); })} /></label>}
      <button className="button button-secondary" disabled={busy} onClick={() => leave(() => { setCustom(!custom); setEnd(period); setOffset(0); })}>{custom ? "Single month" : "Catch up older purchases"}</button>
      <button className="button button-secondary" disabled={busy} onClick={() => leave(() => { setSettings(!settings); setCompanyDraft(activeCompany || { name: "", vatNumber: "", notes: "" }); })}>{settings ? "Purchases" : "Settings"}</button>
    </div>
    {error && <p className="error is-visible mydata-message" role="alert">{error}</p>}
    {notice && <p className="mydata-message" role="status">{notice}</p>}
    {settings ? <section className="tool-panel mydata-settings">
      <h2>Your companies</h2><p>Add up to three companies. Accountant details are optional and are not required here.</p>
      <div className="mydata-actions">{companies.map((company) => <button className="button button-secondary" disabled={busy} key={company.id} onClick={() => leave(() => setCompanyDraft(company))}>{company.name}</button>)}
        {companies.length < 3 && <button className="button button-secondary" disabled={busy} onClick={() => leave(() => setCompanyDraft({ name: "", vatNumber: "", notes: "" }))}>Add company</button>}</div>
      <form onSubmit={saveCompany}><fieldset disabled={busy} className="mydata-fields">
        <label className="field">Company name<input required maxLength={200} value={companyDraft.name} onChange={(e) => { setCompanyDraft({ ...companyDraft, name: e.target.value }); setDirty(true); }} /></label>
        <label className="field">ΑΦΜ (optional during setup)<input inputMode="numeric" maxLength={9} value={companyDraft.vatNumber} onChange={(e) => { setCompanyDraft({ ...companyDraft, vatNumber: e.target.value }); setDirty(true); }} /></label>
        <label className="field mydata-wide">Company notes<textarea value={companyDraft.notes} maxLength={4000} onChange={(e) => { setCompanyDraft({ ...companyDraft, notes: e.target.value }); setDirty(true); }} /></label>
        <button className="button button-primary" type="submit">{busy ? "Saving…" : "Save company"}</button>
      </fieldset></form>
      <h2>Backup and recovery</h2><p>Encrypted backups include all three companies, purchase drafts, originals and history. Keep <code>data/.mydata.key</code> separately in secure storage; it is required to recover a backup. API keys are excluded.</p>
      <div className="mydata-actions"><button className="button button-secondary" disabled={busy || !companies.length} onClick={() => run(async () => {
        const result = await request(`${root}/backup`, { method: "POST" });
        if (result.backup) { download(result.backup, "optimus-mydata-backup.json"); setNotice("Encrypted backup downloaded. Keep data/.mydata.key separately."); }
      })}>Download encrypted backup</button>
      <button className="button button-secondary" disabled={busy || dirty} onClick={() => restoreRef.current.click()}>Restore myDATA backup</button>
      <input ref={restoreRef} hidden type="file" accept=".json,application/json" onChange={(e) => { restore(e.target.files[0]); e.target.value = ""; }} /></div>
      <h2>AADE connections</h2><p>AADE company imports are not connected yet. Public QR lookup supports recognised invoice providers without credentials. Company and optional accountant API credentials will be configured only in the installation’s private .env file.</p>
    </section> : draft ? <>
      <div className="mydata-review-head"><div><h2>{draft.supplier || draft.filename || "New purchase"}</h2><p>{activeCompany?.name} · {draft.reviewMonth} · {dirty ? "Unsaved changes" : draft.id ? "Saved" : "Not saved yet"}</p></div>
        <button className="button button-secondary" disabled={busy} onClick={() => leave(() => {})}>Back to purchases</button></div>
      <div className="mydata-review">
        <section className="tool-panel mydata-original"><h3>Original document</h3>{draft.documentId ? <>
          <OriginalDocument request={request} endpoint={endpoint} apiBase={apiBase} documentId={draft.documentId} page={previewPage} onPage={setPreviewPage} />
        </> : <p>No document attached. This is a manual purchase draft.</p>}</section>
        <section className="tool-panel">
          {draft.id && draft.documentId && <ExtractionPanel key={draft.id} request={request} endpoint={endpoint} draft={draft} dirty={dirty} busy={busy} lookupQr={uploadQrLookup} onLookupQrChange={setQrLookupPreference} setBusy={setBusy} onError={setError} onPage={setPreviewPage} onApplied={(invoice) => {
            setDraft(invoice); setDirty(false); setHistory(null); setRefresh((value) => value + 1); setNotice("Selected suggestions applied. Review and edit the fields below before marking details reviewed.");
          }} />}
          <fieldset className="mydata-fields" disabled={busy}>
          <label className="field">Document kind<select value={draft.kind} onChange={(e) => patch("kind", e.target.value)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {field("Review month", "reviewMonth", { type: "month" })}
          {field("Supplier", "supplier")}{field("Supplier ΑΦΜ / tax ID", "supplierVat")}
          {field("Document number", "number")}{field("Issue date", "issueDate", { type: "date" })}
          {field("Currency", "currency")}{field("Printed MARK (unverified)", "mark")}
          {field("Net amount", "net", { money: true })}{field("VAT amount", "vat", { money: true })}
          {field("Other taxes / adjustments", "otherTaxes", { money: true })}{field("Total amount", "total", { money: true })}
          <div className="mydata-wide">{field("Purchase description", "description", { area: true })}{field("Business purpose", "businessPurpose", { area: true })}</div>
          <details className="mydata-wide"><summary>Classification notes and line allocations</summary><p>Manual working notes only. Codes and treatment are not validated against AADE yet.</p>
            {field("Proposed category", "classificationCategory")}{field("Proposed E3 type", "classificationType")}{field("VAT treatment", "vatTreatment", { area: true })}
            {draft.lines.map((row, index) => <div className="mydata-line" key={index}>
              {[['description', 'Description'], ['net', 'Net'], ['vat', 'VAT'], ['category', 'Category'], ['type', 'E3 type']].map(([key, label]) => <label className="field" key={key}>{label}<input inputMode={key === "net" || key === "vat" ? "decimal" : undefined} value={row[key]} onChange={(e) => patch("lines", draft.lines.map((line, position) => position === index ? { ...line, [key]: e.target.value } : line))} /></label>)}
              <button className="button button-secondary" onClick={() => patch("lines", draft.lines.filter((_, position) => position !== index))}>Remove line {index + 1}</button>
            </div>)}
            <button className="button button-secondary" onClick={() => patch("lines", [...draft.lines, { description: "", net: "", vat: "", category: "", type: "" }])}>Add purchase line</button>
          </details>
          <div className="mydata-wide">{field("Review notes", "notes", { area: true })}</div>
        </fieldset>
        {!dirty && draft.issues?.length > 0 && <div className="mydata-issues"><strong>Needs attention</strong><ul>{draft.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
        <div className="mydata-actions mydata-save"><button className="button button-secondary" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="button button-primary" disabled={busy} onClick={() => save(true)}>Mark details reviewed</button>
          <button className="button button-secondary" disabled={busy} onClick={() => save(true, true)}>Reviewed and next</button></div>
        <p>Any edit clears the previous review when saved. Reviewed details do not establish correct tax treatment.</p>
        </section>
      </div>
      <details className="tool-panel"><summary>History and preparation export</summary><div className="mydata-actions">
        <button className="button button-secondary" disabled={!draft.id || busy || dirty} onClick={() => run(async () => { setHistory((await request(`${endpoint}/invoices/${draft.id}/history`)).events); })}>Load saved history</button>
        <button className="button button-secondary" disabled={!draft.id || busy || dirty} onClick={() => download({ version: 1, status: "PREPARATION ONLY — NOT SUBMITTED OR TAX VALIDATED", company: activeCompany, purchase: draft }, `purchase-${draft.id}.json`)}>Export saved draft</button></div>
        {history?.map((event, index) => <details key={index}><summary>{event.at} · {event.action} · {event.actor}</summary><pre>{JSON.stringify(event.snapshot, null, 2)}</pre></details>)}
      </details>
    </> : <>
      <div className="mydata-progress">{companies.map((company) => { const progress = data.progress[company.id]; return <button className={`tool-panel ${company.id === companyId ? "is-selected" : ""}`} key={company.id} disabled={busy || loading} onClick={() => leave(() => { setCompanyId(company.id); setOffset(0); })}>
        <strong>{company.name}</strong><span>{progress ? `${progress.total - progress.reviewed} to review · ${progress.reviewed} reviewed` : "No purchases in this period"}</span></button>; })}</div>
      <section className="tool-panel"><div className="mydata-actions">
        <button className="button button-primary" disabled={!companyId || busy || loading} onClick={() => filesRef.current.click()}>Add invoices / receipts</button>
        <button className="button button-secondary" disabled={!companyId || busy || loading} onClick={() => edit(blank(period))}>Enter manually</button>
        <input ref={filesRef} hidden type="file" multiple accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { upload(Array.from(e.target.files)); e.target.value = ""; }} />
        <label className="field">Show<select disabled={busy} value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }}><option value="all">All purchases</option><option value="needs_review">Needs review</option><option value="reviewed">Details reviewed</option></select></label>
      </div>
      <label className="mydata-ai-choice"><input type="checkbox" checked={uploadQrLookup} disabled={busy} onChange={(e) => setQrLookupPreference(e.target.checked)} /> Look up recognised invoice QR links after upload</label>
      <p className="mydata-extraction-hint">This contacts supported providers using only the QR reference. No original file or credentials are uploaded. Turn it off for offline extraction.</p>
      <p>Uploads enter {period}. Unknown issue dates stay empty until you review them. Local extraction runs after upload; open Review to inspect suggestions. One invoice per file.</p>
      {loading ? <p role="status">Loading purchases…</p> : !companyId ? <p>Add your companies in Settings to get started.</p> : <>
        {data.invoices.length ? <div className="mydata-table-scroll"><table className="mydata-table"><thead><tr><th>Supplier / document</th><th>Issue date</th><th>Review month</th><th>Total</th><th>Status</th><th>Action</th></tr></thead><tbody>
          {data.invoices.map((row) => <tr key={row.id}><td><strong>{row.supplier || row.filename || "Manual purchase"}</strong><small>{kinds[row.kind]}{row.number ? ` · ${row.number}` : ""}</small></td><td>{row.issueDate || "Needs date"}</td><td>{row.reviewMonth}</td><td>{row.total ? `${row.currency} ${row.total}` : "—"}</td><td><span className={`mydata-status ${row.reviewed ? "is-reviewed" : ""}`}>{row.reviewed ? "Details reviewed" : "Needs review"}</span>{row.extractionState && <small>{{queued: "Extraction queued", running: "Reading document…", completed: "Extraction available", failed: "Extraction needs attention", cancelled: "Extraction cancelled"}[row.extractionState]}</small>}</td><td><button className="button button-secondary" onClick={() => edit(row)}>Review</button></td></tr>)}
        </tbody></table></div> : <div className="mydata-empty"><h2>{filter === "all" ? "Start this period’s purchase review" : "No purchases match this filter"}</h2><p>Add supplier invoices or receipts for local extraction, or enter a purchase manually. AADE import will be added in the next stage.</p></div>}
        <div className="mydata-actions"><span>{data.total} purchases{data.total > 0 ? ` · ${offset + 1}–${Math.min(offset + 100, data.total)}` : ""}</span>
          <button className="button button-secondary" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous page</button>
          <button className="button button-secondary" disabled={offset + 100 >= data.total || busy} onClick={() => setOffset(offset + 100)}>Next page</button></div>
      </>}
      </section>
    </>}
  </section>;
}
