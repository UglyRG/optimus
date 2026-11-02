import React, { useEffect, useState } from "react";
import { QrSummary } from "./QrSummary";

function display(value) {
  return Array.isArray(value) ? `${value.length} printed purchase lines` : String(value ?? "");
}
export function ExtractionPanel({ request, endpoint, draft, dirty, busy, lookupQr, onLookupQrChange, setBusy, onApplied, onError, onPage }) {
  const [capabilities, setCapabilities] = useState(null);
  const [job, setJob] = useState(null);
  const [selected, setSelected] = useState([]);
  const [ai, setAi] = useState(false);
  const [qrChoice, setQrChoice] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const path = `${endpoint}/invoices/${draft.id}/extractions`;
  const active = job && ["queued", "running"].includes(job.state);
  const stale = job && job.baseRevision !== draft.revision;
  const applied = job && draft.extractionId === job.id;
  const fieldOrder = ["supplier", "supplierVat", "number", "issueDate", "kind", "currency", "net", "vat", "otherTaxes", "total", "mark", "description", "lines"];

  useEffect(() => {
    let current = true;
    request("/tools/mydata-invoices/extraction-capabilities").then((result) => { if (current) setCapabilities(result); })
      .catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [request]);
  useEffect(() => {
    let current = true, timer;
    setJob(null); setSelected([]); setError(""); setAi(false);
    async function poll() {
      try {
        const result = await request(path);
        if (!current) return;
        setJob(result.extraction);
        if (result.extraction && ["queued", "running"].includes(result.extraction.state)) timer = setTimeout(poll, 3000);
      } catch (e) { if (current) setError(e.message); }
    }
    poll();
    return () => { current = false; clearTimeout(timer); };
  }, [path, draft.revision, refresh, request]);
  useEffect(() => {
    const fields = job?.result?.fields || {};
    setQrChoice(job?.qrChoice || "");
    setSelected(Object.keys(fields).filter((key) => (Array.isArray(draft[key]) ? !draft[key].length : !draft[key]) && !["header_guess", "logo_ocr_guess", "qr_unverified"].includes(fields[key].basis)));
  }, [job?.id, job?.state]);

  async function perform(action) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e.message); onError(e.message); } finally { setBusy(false); }
  }
  function start() {
    perform(async () => {
      await request(path, { method: "POST", body: JSON.stringify({ revision: draft.revision, provider: ai ? "anthropic" : "local", consent: ai, lookupQr, qrChoice: qrChoice || null }) });
      setRefresh((value) => value + 1);
    });
  }
  const result = job?.result;
  const outdated = result && capabilities?.parserVersion && result.version !== capabilities.parserVersion;
  return <section className="mydata-extraction" aria-label="Document extraction">
    <div className="mydata-extraction-heading"><h3>Read this document</h3><span>Review before applying</span></div>
    <p>Extract printed facts, then choose what to apply. Your current values stay unchanged until you confirm.</p>
    {capabilities && !capabilities.ocr && <p className="mydata-extraction-warning">Scanned pages need Tesseract with Greek and English language data. PDF text extraction is available; manual editing always works.</p>}
    <label className="mydata-ai-choice"><input type="checkbox" checked={lookupQr} disabled={busy || active} onChange={(e) => onLookupQrChange(e.target.checked)} /> Look up recognised invoice QR links</label>
    <p className="mydata-extraction-hint">QR decoding stays local. Online lookup contacts supported invoice providers using the QR reference; it sends no original file or credentials. Turn this off for offline use.</p>
    <label className="mydata-ai-choice"><input type="checkbox" checked={ai} disabled={busy || active || !capabilities?.ai} onChange={(e) => setAi(e.target.checked)} /> Use AI assistance for this extraction</label>
    {ai ? <p className="mydata-extraction-warning">This sends extracted invoice text, including names, tax IDs and amounts, to Anthropic ({capabilities?.aiModel || "configured model"}). Original files and API credentials are not included in the prompt.</p> : <p className="mydata-extraction-hint">{capabilities?.ai ? "AI assistance is optional and off." : "AI assistance is not configured. Local extraction is available."}</p>}
    <div className="mydata-actions"><button className="button button-primary" disabled={busy || dirty || active} onClick={start}>{job ? "Extract again" : "Extract information"}</button>
      {active && <button className="button button-secondary" disabled={busy} onClick={() => perform(async () => {
        await request(`${path}/${job.id}/cancel`, { method: "POST" }); setRefresh((value) => value + 1);
      })}>Cancel extraction</button>}
    </div>
    {dirty && <p>Save your edits before extracting or applying suggestions.</p>}
    {job && <p role="status">{job.state === "cancelled" ? "Extraction cancelled. Your purchase details were not changed." : job.progress}</p>}
    {error && <p role="alert" className="error is-visible">{error}</p>}
    {result && <details className="mydata-extraction-result" open={!stale}>
      <summary>{applied ? "Applied extraction — source evidence" : "Extracted suggestions"}</summary>
      <QrSummary qr={result.qr} choice={qrChoice} onChoice={setQrChoice} disabled={busy || active || dirty} onPage={onPage} />
      {outdated && <p className="mydata-extraction-warning">The extraction method has been improved. Click Extract again to refresh these suggestions.</p>}
      {applied && <p>Selected suggestions were applied. Review and edit the saved purchase details below.</p>}
      {stale && !applied && <p className="mydata-extraction-warning">These suggestions belong to an earlier purchase revision. Extract again to apply suggestions to the current version.</p>}
      {result.warnings?.length > 0 && <ul className="mydata-extraction-warning">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {Object.keys(result.fields).length > 0 ? <>
        <div className="mydata-extraction-fields">{Object.entries(result.fields).sort(([a], [b]) => fieldOrder.indexOf(a) - fieldOrder.indexOf(b)).map(([key, suggestion]) => {
          const evidence = Array.isArray(suggestion.evidence) ? suggestion.evidence : [suggestion.evidence];
          return <div className="mydata-extraction-field" key={key}>
            <label><input type="checkbox" disabled={busy || dirty || stale || outdated} checked={selected.includes(key)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, key] : old.filter((value) => value !== key))} /> <strong>{suggestion.label}</strong></label>
            <div><span className="mydata-extraction-hint">Current:</span> {display(draft[key]) || "Empty"}</div>
            <div><span className="mydata-extraction-hint">Suggested:</span> {display(suggestion.value)}</div>
            <small>{suggestion.basis === "provider_xml" ? `Retrieved from ${suggestion.evidence.provider} XML — review against original` : suggestion.basis === "qr_unverified" ? "Encoded in QR only — not verified online" : suggestion.basis === "logo_ocr_guess" ? "Name read from logo — verify legal or trading name" : suggestion.basis === "header_guess" ? "Header guess — check supplier carefully" : suggestion.basis === "ai_suggested" ? "AI suggestion — check against original" : "Printed field — needs your review"}</small>
            <details><summary>Show source evidence</summary>
              {Array.isArray(suggestion.value) && <pre>{JSON.stringify(suggestion.value, null, 2)}</pre>}
              {evidence.map((source, index) => <div key={index}><button className="mydata-page-link" onClick={() => onPage(source.page)}>{source.source === "provider_xml" ? "QR on page" : "Page"} {source.page}</button><blockquote>{source.text}</blockquote>
                {source.ocrConfidence !== undefined && <small>OCR word confidence: {source.ocrConfidence}% (does not measure accounting correctness)</small>}</div>)}
            </details>
          </div>;
        })}</div>
        <button className="button button-primary" disabled={busy || dirty || stale || outdated || !selected.length} onClick={() => perform(async () => {
          const response = await request(`${path}/${job.id}/apply`, { method: "POST", body: JSON.stringify({ revision: draft.revision, fields: selected }) });
          onApplied(response.invoice);
        })}>Apply {selected.length} selected suggestion{selected.length === 1 ? "" : "s"}</button>
      </> : <p>No reliable field suggestions were found. Read the source text or enter the details manually.</p>}
      <details><summary>Extracted text by page</summary>{result.pages.map((page) => <section key={page.page}><h4>Page {page.page} · {page.method === "ocr" ? "Greek/English OCR" : page.method === "pdf_text" ? "Embedded PDF text" : "Unreadable"}</h4><pre>{page.text || "No readable text"}</pre>{page.imageTexts?.map((region, index) => <div key={index}><h4>Header branding · local OCR · verify name</h4><pre>{region.text}</pre></div>)}</section>)}</details>
    </details>}
  </section>;
}
