import React, { useEffect, useRef, useState } from "react";

const labels = { supplier: "Supplier", supplierVat: "Supplier tax ID", number: "Document number", series: "Series", issueDate: "Issue date", currency: "Currency", mark: "MARK", kind: "Document kind", net: "Net amount", vat: "VAT", total: "Total", otherTaxes: "Adjustments", description: "Description", lines: "Purchase lines" };
const display = (value) => typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
const environmentLabel = (value) => value === "prod" ? "Production" : "Sandbox (test data)";

export function SyncPanel({ request, endpoint, company, start, end, dirty, busy, run, refresh, onRefresh, onSettings }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [records, setRecords] = useState(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const lastJob = useRef("");
  useEffect(() => {
    let active = true;
    let timer;
    async function poll() {
      try {
        const result = await request(`${endpoint}/sync`);
        if (!active) return;
        setStatus(result); setError("");
        const jobKey = `${result.job?.id}:${result.job?.state}:${result.job?.pages}`;
        if (lastJob.current && lastJob.current !== jobKey) onRefresh((v) => v + 1);
        lastJob.current = jobKey;
        if (["queued", "running"].includes(result.job?.state)) timer = setTimeout(poll, 3000);
      } catch (e) { if (active) setError(e.message); }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [request, endpoint, refresh, onRefresh]);
  useEffect(() => { setOffset(0); setRecords(null); }, [endpoint, start, end]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    request(`${endpoint}/remote-records?${new URLSearchParams({ start, end, offset })}`)
      .then((result) => { if (active) setRecords(result); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request, endpoint, start, end, offset, open, refresh]);
  const running = ["queued", "running"].includes(status?.job?.state);
  async function queue(test = false) {
    await run(async () => {
      await request(`${endpoint}/${test ? "connection/test" : "sync"}`, { method: "POST", body: JSON.stringify({ start, end, companyRevision: company.revision }) });
      onRefresh((v) => v + 1);
    });
  }
  return <section className="tool-panel mydata-intake">
    <div className="mydata-actions"><h2>AADE intake</h2>
      <button className="button button-primary" disabled={busy || dirty || !status?.ready || running} onClick={() => queue()}>Sync from AADE</button>
      {!status?.ready && <button className="button button-secondary" disabled={busy} onClick={onSettings}>Connection settings</button>}
      {status?.ready && <button className="button button-secondary" disabled={busy || dirty || running} onClick={() => queue(true)}>Test connection</button>}
      {running && <button className="button button-secondary" disabled={busy} onClick={() => run(async () => { await request(`${endpoint}/sync/${status.job.id}/cancel`, { method: "POST" }); onRefresh((v) => v + 1); })}>Cancel sync</button>}
    </div>
    <p>Reads incoming purchases for {start === end ? start : `${start} through ${end}`}. You can review and edit every draft. Nothing is submitted.</p>
    {status?.configurationMessage && <p>{status.configurationMessage}</p>}
    {status?.lastCompletedAt && <small>Last completed sync for this connection: {new Date(status.lastCompletedAt).toLocaleString()}</small>}
    {status?.job && <p role="status">{environmentLabel(status.job.environment)} · {status.job.progress}{status.job.mode === "sync" ? ` · ${status.job.imported} new drafts · ${status.job.changed} remote updates` : ""}</p>}
    {status?.pendingMatching > 0 && <p className="mydata-issues">{status.pendingMatching} AADE records need matching across this company’s periods. Select their review month and open matching below.</p>}
    {status?.job?.skipped > 0 && <p>{status.job.skipped} returned documents were left out because their recipient could not be confirmed as this company.</p>}
    {error && <p role="alert">{error}</p>}
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}><summary>AADE records and matching</summary>
      {open && !records && <p>Loading AADE records…</p>}
      {records?.records.map((row) => <article className="mydata-qr-status" key={row.id}>
        <strong>{row.supplier || row.issuerVat} · {row.series} {row.number}</strong>
        <p>{row.issueDate} · {row.currency} {row.summary?.totalGrossValue} · MARK {row.mark} · {environmentLabel(row.environment)}</p>
        <p>{row.cancelled ? "Cancelled in AADE · " : ""}{row.matchStatus === "linked" ? "Linked to a purchase" : row.matchStatus === "conflict" ? "Linked purchase differs — open Review to compare" : "Choose the corresponding purchase or create a separate draft"}</p>
        {row.candidates?.map((candidate) => <div key={candidate.invoiceId}><p>{candidate.supplier || "Purchase"} · {candidate.number} · {candidate.reviewMonth}</p>
          {candidate.conflicts.length > 0 && <p>Resolve differences first: {candidate.conflicts.map((item) => `${labels[item.field]} (${item.local} / ${item.remote})`).join(", ")}</p>}
          <button className="button button-secondary" disabled={busy || !!candidate.conflicts.length} onClick={() => run(async () => { await request(`${endpoint}/remote-records/${row.id}/match`, { method: "POST", body: JSON.stringify({ remoteRevision: row.revision, invoiceId: candidate.invoiceId, revision: candidate.revision }) }); onRefresh((v) => v + 1); })}>Link this purchase</button>
        </div>)}
        {!row.invoiceId && <button className="button button-secondary" disabled={busy} onClick={() => run(async () => { await request(`${endpoint}/remote-records/${row.id}/match`, { method: "POST", body: JSON.stringify({ remoteRevision: row.revision, create: true }) }); onRefresh((v) => v + 1); })}>Create a separate purchase draft</button>}
      </article>)}
      {records && <div className="mydata-actions"><span>{records.total} AADE records</span><button className="button button-secondary" disabled={!offset || busy} onClick={() => setOffset((n) => n - 100)}>Previous</button><button className="button button-secondary" disabled={offset + 100 >= records.total || busy} onClick={() => setOffset((n) => n + 100)}>Next</button></div>}
    </details>
  </section>;
}

export function RemoteEvidence({ request, endpoint, draft, busy, dirty, run, onApplied }) {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState({});
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request(`${endpoint}/invoices/${draft.id}/remote-records`).then((result) => { if (active) { setRecords(result.records); setSelected({}); } }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request, endpoint, draft.id, draft.revision]);
  return <>{error && <p role="alert">{error}</p>}{records.map((record) => <section className="mydata-qr-status" key={record.id}>
    <h3>AADE record · {environmentLabel(record.environment)}</h3>
    <p>MARK {record.mark} · {record.issueDate} · Retrieved {new Date(record.retrievedAt).toLocaleString()}</p>
    {record.cancelled && <p className="mydata-issues">AADE reports this invoice as cancelled.</p>}
    {record.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
    {record.conflicts?.length > 0 && <div className="mydata-issues"><strong>Your draft differs from AADE</strong>{record.conflicts.map((item) => <p key={item.field}>{labels[item.field]}: draft {item.local} · AADE {item.remote}</p>)}</div>}
    <details><summary>Compare and use AADE fields</summary><p>Choose fields to copy into your saved draft. Your other fields remain as saved. Applying clears the details review.</p>
      {Object.entries(record.proposedFields || {}).filter(([key, value]) => labels[key] && value !== "" && (!Array.isArray(value) || value.length)).map(([key, value]) => <label className="mydata-extraction-field" key={key}><span className="mydata-ai-choice"><input type="checkbox" disabled={busy || dirty} checked={!!selected[`${record.id}:${key}`]} onChange={(e) => setSelected((old) => ({ ...old, [`${record.id}:${key}`]: e.target.checked }))} />{labels[key]}</span><small>Draft: {display(draft[key])}</small><pre>AADE: {display(value)}</pre></label>)}
      <button className="button button-secondary" disabled={busy || dirty || !Object.keys(labels).some((key) => selected[`${record.id}:${key}`])} onClick={() => run(async () => { const result = await request(`${endpoint}/invoices/${draft.id}/remote-records/${record.id}/apply`, { method: "POST", body: JSON.stringify({ revision: draft.revision, remoteRevision: record.revision, fields: Object.keys(labels).filter((key) => selected[`${record.id}:${key}`]) }) }); onApplied(result.invoice); })}>Apply selected AADE fields</button>
      {dirty && <p>Save your edits before applying AADE fields.</p>}
    </details>
    <details><summary>Existing classifications and remote lines</summary><p>Read-only evidence. These codes are not applied to your classification notes. Event entries show observed history; they are not a reconstructed current tax balance.</p><pre>{JSON.stringify({ invoiceType: record.invoiceType, summaryClassifications: record.classifications, lines: record.lines, events: record.events }, null, 2)}</pre></details>
  </section>)}</>;
}
