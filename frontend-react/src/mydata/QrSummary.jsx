import React from "react";

const names = {recipientVat: "Recipient tax ID", supplierVat: "Supplier tax ID", number: "Document number", issueDate: "Issue date", currency: "Currency", mark: "MARK", net: "Net amount", vat: "VAT amount", total: "Total amount"};
export function QrSummary({ qr, choice, onChoice, disabled, onPage }) {
  if (!qr) return null;
  const eligible = qr.references.filter((reference) => reference.kind !== "unsupported");
  return <section className={`mydata-qr-status ${qr.status === "conflict" ? "has-conflict" : ""}`} aria-label="QR check">
    <strong>{qr.status === "retrieved" ? `QR · Data retrieved from ${qr.references.find((reference) => reference.id === qr.selectedId)?.provider || "provider"}` : qr.status === "not_found" ? "QR · Not found" : "QR · Found"}</strong>
    <p>{qr.message}</p>
    {qr.references.length > 0 && <details open={qr.status === "needs_selection" || qr.status === "conflict"}><summary>QR references and checks</summary>
      {qr.references.map((reference, index) => <div className="mydata-qr-reference" key={reference.id}>
        {eligible.length > 1 && reference.kind !== "unsupported" && <label><input type="radio" name="invoice-qr" value={reference.id} checked={choice === reference.id} disabled={disabled} onChange={() => onChoice(reference.id)} /> Use this QR</label>}
        <span>{reference.kind === "unsupported" ? "Unrecognised QR — not opened" : `${reference.provider} · ${reference.kind === "provider_invoice" ? "Provider invoice" : reference.kind === "provider_reference" ? "Provider verification" : reference.kind === "aade_receipt" ? "Receipt verification" : "Invoice verification"}`}</span>
        <div className="mydata-actions"><button className="mydata-page-link" onClick={() => onPage(reference.page)}>Page {reference.page}</button>
          {reference.verificationUrl?.startsWith("https://") && reference.kind !== "unsupported" && <a href={reference.verificationUrl} target="_blank" rel="noreferrer">Open verification page</a>}
        </div>
      </div>)}
      {qr.conflicts?.length > 0 && <div className="mydata-table-scroll"><table className="mydata-table"><thead><tr><th>Field</th><th>Document / company</th><th>QR source</th></tr></thead><tbody>{qr.conflicts.map((conflict, index) => <tr key={index}><td>{names[conflict.field] || conflict.field}</td><td>{conflict.local}</td><td>{conflict.remote}</td></tr>)}</tbody></table></div>}
      {qr.receiptHint && <p>Encoded receipt total: {qr.receiptHint.total}. This comes from the QR itself and has not been verified against AADE.</p>}
      {qr.data && <details><summary>Retrieved source evidence</summary><p>Provider-supplied invoice data · Series {qr.data.series || "—"} · myDATA document type {qr.data.invoiceType}. This does not establish accounting treatment or AADE acceptance.</p><pre>{qr.data.rawXml}</pre></details>}
    </details>}
  </section>;
}
