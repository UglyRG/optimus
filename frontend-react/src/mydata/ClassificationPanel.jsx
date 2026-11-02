import React, { useEffect, useId, useState } from "react";

function CodeSelect({ label, value = "", choices, onChange, placeholder = "Choose…", disabled }) {
  const current = choices.some((choice) => choice.code === value);
  const descriptionId = useId();
  const description = choices.find((choice) => choice.code === value)?.label;
  return <label className="field">{label}<select aria-label={label} aria-describedby={value ? descriptionId : undefined} value={value} disabled={disabled} title={choices.find((choice) => choice.code === value)?.label || value} onChange={(e) => onChange(e.target.value)}>
    <option value="">{placeholder}</option>
    {value && !current && <option value={value}>Saved: {value} (needs review)</option>}
    {choices.map((choice) => <option key={choice.code} value={choice.code}>{choice.code} — {choice.label}</option>)}
  </select>{description && <small id={descriptionId} className="mydata-code-description">{description}</small>}{value && !current && <small id={descriptionId} className="mydata-classification-warning">This saved value is outside the available choices. Choose a listed value or clear it.</small>}</label>;
}

export function ClassificationPanel({ request, endpoint, draft, busy, patch }) {
  const [options, setOptions] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setOptions(null); setError("");
    const path = draft.id ? `${endpoint}/invoices/${draft.id}/classification-options` : "/tools/mydata-invoices/classification-options";
    request(path).then((result) => { if (active) setOptions(result); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request, endpoint, draft.id, draft.revision]);
  const data = options?.catalogue;
  const invoiceType = options?.context.remoteInvoiceType || draft.mydataInvoiceType || "";
  const documentRules = data?.invoiceTypes[invoiceType];
  const exact = documentRules?.mode === "explicit";
  const rules = exact ? documentRules.categories : data?.categoryTypes || {};
  const categories = data?.categories.filter((choice) => !exact || rules[choice.code]) || [];
  const e3 = (category) => data?.e3Types.filter((choice) => rules[category]?.types.includes(choice.code)) || [];
  const updateLine = (index, key, value) => patch("lines", draft.lines.map((row, pos) => pos === index ? { ...row, [key]: value } : row));
  const pair = (category, type, setCategory, setType, prefix) => <>
    <CodeSelect label={`${prefix}Expense category`} value={category} choices={categories} disabled={busy || !data} onChange={setCategory} placeholder="Choose expense category…" />
    <CodeSelect label={`${prefix}E3 code`} value={type} choices={e3(category)} disabled={busy || !data} onChange={setType} placeholder={!category ? "Choose a category first" : rules[category]?.mode === "no_e3" ? "No E3 classification for this category" : "Choose E3 code…"} />
    {rules[category]?.mode === "conditional" && <p className="mydata-classification-warning mydata-wide">This category has additional period conditions. Review its basis before using it.</p>}
  </>;
  return <details className="mydata-wide mydata-classifications"><summary>Classification notes and line allocations</summary>
    <p>Choose the official myDATA codes. Whole-document choices and line choices are saved separately.</p>
    {error && <p role="alert">Classification choices could not be loaded: {error}. Saved values remain in the draft.</p>}
    {!data && !error && <p>Loading myDATA choices…</p>}
    <div className="mydata-fields">
      {options?.context.remoteInvoiceType ? <p className="mydata-wide">myDATA document type: <strong>{invoiceType} — {documentRules?.label || "See AADE evidence"}</strong></p> : <div className="mydata-wide"><CodeSelect label="myDATA document type" value={draft.mydataInvoiceType} choices={Object.entries(data?.invoiceTypes || {}).map(([code, entry]) => ({ code, label: entry.label }))} onChange={(value) => patch("mydataInvoiceType", value)} disabled={busy || !data} placeholder="Choose type to filter combinations…" /></div>}
      {!exact && <p className="mydata-classification-warning mydata-wide">{documentRules?.mode === "conditional" ? "This document uses the related invoice’s combinations. Choose codes for preparation; related-document validation is still required." : "Showing general expense choices. Confirm the myDATA document type to check its specific combinations."}</p>}
      {options?.context.conflictingRemoteTypes && <p className="mydata-classification-warning mydata-wide">Linked AADE records disagree on document type. Review the remote evidence.</p>}
      {pair(draft.classificationCategory, draft.classificationType, (value) => patch("classificationCategory", value), (value) => patch("classificationType", value), "")}
      <div className="mydata-wide"><CodeSelect label="VAT classification code" value={draft.vatClassification} choices={data?.vatClassifications || []} disabled={busy || !data} onChange={(value) => patch("vatClassification", value)} placeholder="Choose VAT classification…" /></div>
      <label className="field mydata-wide">VAT notes (optional)<textarea rows={2} value={draft.vatTreatment || ""} onChange={(e) => patch("vatTreatment", e.target.value)} /></label>
    </div>
    <h4>Line allocations</h4>
    {draft.lines.map((row, index) => <section className="mydata-line" key={index}>
      <h4>Line {index + 1}</h4><div className="mydata-fields">
        <label className="field mydata-wide">Description<input value={row.description || ""} onChange={(e) => updateLine(index, "description", e.target.value)} /></label>
        {[["net", "Net amount"], ["vat", "VAT amount"]].map(([key, label]) => <label className="field" key={key}>{label}<input inputMode="decimal" value={row[key] || ""} onChange={(e) => updateLine(index, key, e.target.value)} /></label>)}
        {pair(row.category, row.type, (value) => updateLine(index, "category", value), (value) => updateLine(index, "type", value), `Line ${index + 1} `)}
        <div className="mydata-wide"><CodeSelect label={`Line ${index + 1} VAT classification code`} value={row.vatClassification} choices={data?.vatClassifications || []} disabled={busy || !data} onChange={(value) => updateLine(index, "vatClassification", value)} placeholder="Choose VAT classification…" /></div>
      </div><button className="button button-secondary" onClick={() => patch("lines", draft.lines.filter((_, pos) => pos !== index))}>Remove line {index + 1}</button>
    </section>)}
    <button className="button button-secondary" onClick={() => patch("lines", [...draft.lines, { description: "", net: "", vat: "", category: "", type: "", vatClassification: "" }])}>Add purchase line</button>
    {draft.classificationCheck?.warnings?.length > 0 && <div className="mydata-extraction-warning"><strong>Saved classification notes to review</strong><ul>{draft.classificationCheck.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    <p className="mydata-extraction-hint">The lists check codes and listed E3 combinations. VAT deduction rights, special conditions and historical applicability still need review. Nothing is submitted.</p>
    {data && <details><summary>Official source and catalogue version</summary><p>{data.version}. <a href={data.sources.combinations.url} target="_blank" rel="noreferrer">AADE combinations workbook</a> · <a href={data.sources.labels.url} target="_blank" rel="noreferrer">Official code descriptions</a>.</p><p>Codes absent from the pinned expense schema are omitted from selectable values, including E3_585_017. Existing saved values are retained for review.</p></details>}
  </details>;
}
