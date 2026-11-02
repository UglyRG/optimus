import React, { useEffect, useState } from "react";

export function OriginalDocument({ request, endpoint, apiBase, documentId, page, onPage }) {
  const [metadata, setMetadata] = useState(null);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [zoom, setZoom] = useState(1);
  const path = `${endpoint}/documents/${documentId}`;
  useEffect(() => {
    let current = true;
    setError(""); setMetadata(null); setZoom(1);
    request(`${path}/metadata`).then((value) => { if (current) setMetadata(value); }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [path, request]);
  useEffect(() => { setRendering(true); }, [page, documentId]);
  return <>
    {metadata && <div className="mydata-actions"><button className="button button-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous page</button><span>Page {page} of {metadata.pages}</span><button className="button button-secondary" disabled={page >= metadata.pages} onClick={() => onPage(page + 1)}>Next page</button></div>}
    <div className="mydata-actions"><button className="button button-secondary" aria-label="Zoom out document" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - .5))}>−</button><span>{Math.round(zoom * 100)}%</span><button className="button button-secondary" aria-label="Zoom in document" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .5))}>+</button></div>
    {error && <p role="alert">{error}</p>}
    {rendering && !error && <p role="status">Rendering document page…</p>}
    {!error && <div className="mydata-document-viewport"><img style={{ width: `${zoom * 100}%`, maxWidth: "none", maxHeight: "none" }} className="mydata-document-image" alt={`Original purchase document, page ${page}`} src={`${apiBase}${path}/preview?page=${page}`} onLoad={() => setRendering(false)} onError={() => { setRendering(false); setError("Page preview unavailable. Use Open original below."); }} /></div>}
    <a className="button button-secondary" target="_blank" rel="noreferrer" href={`${apiBase}${path}/content`}>Open original</a>
  </>;
}
