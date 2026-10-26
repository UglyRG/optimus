import React, { createContext, useContext, useEffect, useRef, useState } from "react";

const NotesContext = createContext(null);
const endpoint = "/tools/sticky-notes";

// Keep drafts and save queues alive while navigating between home and tool pages.
export function StickyNotesProvider({ request, children }) {
  const [notes, setNotes] = useState([]);
  const [status, setStatus] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const records = useRef(new Map());
  const busy = useRef(false);
  function publish() {
    setNotes([...records.current.values()].map((r) => r.note).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)));
  }
  async function load() {
    if ([...records.current.values()].some((r) => r.dirty || r.saving)) {
      setError("Copy any unsaved text before reloading. Resolve or discard unsaved edits first.");
      return;
    }
    setLoading(true);
    try {
      const result = await request(`${endpoint}/notes`);
      records.current = new Map(result.notes.map((note) => [note.id, { note, revision: note.revision }]));
      publish(); setStatus({}); setError("");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function save(id) {
    const record = records.current.get(id);
    if (!record || record.saving || !record.dirty || record.blocked) return;
    clearTimeout(record.timer);
    record.saving = true;
    record.dirty = false;
    setStatus((s) => ({ ...s, [id]: "Saving…" }));
    try {
      const result = await request(`${endpoint}/notes`, { method: "POST", body: JSON.stringify({ ...record.note, revision: record.revision }) });
      record.revision = result.note.revision;
      record.note = { ...record.note, revision: result.note.revision, updatedAt: result.note.updatedAt };
      setStatus((s) => ({ ...s, [id]: record.dirty ? "Unsaved changes" : "Saved" }));
    } catch (e) {
      record.dirty = true; record.blocked = true;
      setStatus((s) => ({ ...s, [id]: e.message }));
    } finally {
      record.saving = false;
      publish();
      if (record.dirty && !record.blocked) save(id);
    }
  }
  function patch(id, changes) {
    const record = records.current.get(id);
    if (!record) return;
    record.note = { ...record.note, ...changes };
    record.dirty = true;
    publish();
    if (!record.blocked) {
      setStatus((s) => ({ ...s, [id]: "Unsaved changes" }));
      clearTimeout(record.timer);
      record.timer = setTimeout(() => save(id), 600);
    }
  }
  async function create() {
    if (busy.current) return;
    busy.current = true;
    try {
      const order = Math.max(0, ...[...records.current.values()].map((r) => r.note.order)) + 10;
      const result = await request(`${endpoint}/notes`, { method: "POST", body: JSON.stringify({ text: "", color: "yellow", size: "small", showOnHome: true, order }) });
      records.current.set(result.note.id, { note: result.note, revision: result.note.revision });
      publish(); setError("");
    } catch (e) { setError(e.message); }
    finally { busy.current = false; }
  }
  async function remove(id) {
    const record = records.current.get(id);
    if (!record || record.saving || !window.confirm("Delete this sticky note?")) return;
    clearTimeout(record.timer);
    record.blocked = true;
    try {
      await request(`${endpoint}/delete`, { method: "POST", body: JSON.stringify({ id, revision: record.revision }) });
      records.current.delete(id); publish();
    } catch (e) { setStatus((s) => ({ ...s, [id]: e.message })); }
  }
  async function reloadNote(id) {
    if (!window.confirm("Discard local edits to this note and load the saved version? Copy any text you want to keep first.")) return;
    const record = records.current.get(id);
    if (record?.saving) return;
    clearTimeout(record?.timer);
    try {
      const result = await request(`${endpoint}/notes`);
      const note = result.notes.find((n) => n.id === id);
      if (note) records.current.set(id, { note, revision: note.revision });
      else records.current.delete(id);
      setStatus((s) => ({ ...s, [id]: "Saved" })); publish();
    } catch (e) { setStatus((s) => ({ ...s, [id]: e.message })); }
  }
  function retry(id) {
    const record = records.current.get(id);
    if (record) { record.blocked = false; save(id); }
  }
  function move(id, direction) {
    const index = notes.findIndex((n) => n.id === id);
    const other = notes[index + direction];
    if (!other) return;
    // Renumber first so notes restored with equal orders can still be moved.
    const ordered = [...notes];
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    ordered.forEach((note, i) => { if (note.order !== i * 10) patch(note.id, { order: i * 10 }); });
  }
  useEffect(() => {
    function beforeUnload(event) {
      if ([...records.current.values()].some((r) => r.dirty || r.saving)) {
        event.preventDefault(); event.returnValue = "";
      }
    }
    function logout(event) {
      if ([...records.current.values()].some((r) => r.dirty || r.saving)) {
        event.preventDefault();
        window.alert("Your sticky notes have unsaved changes. Wait for saving to finish, or resolve the save error before logging out.");
      }
    }
    function flush() {
      if (document.visibilityState === "hidden") records.current.forEach((r, id) => save(id));
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("sticky-notes-before-logout", logout);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("sticky-notes-before-logout", logout);
      document.removeEventListener("visibilitychange", flush);
      records.current.forEach((r) => clearTimeout(r.timer));
    };
  }, []);
  return <NotesContext.Provider value={{ notes, status, error, loading, patch, save, create, remove, move, load, reloadNote, retry }}>{children}</NotesContext.Provider>;
}

export function StickyNotesBoard({ home = false }) {
  const { notes, status, error, loading, patch, save, create, remove, move, load, reloadNote, retry } = useContext(NotesContext);
  const visible = home ? notes.filter((note) => note.showOnHome) : notes;
  return <aside className={`sticky-board ${home ? "sticky-board-home" : ""}`} aria-label="Sticky notes">
    <div className="sticky-board-head"><h2>Sticky notes</h2><div>
      <button type="button" className="button button-secondary" onClick={load}>Refresh</button>{" "}
      <button type="button" className="button button-primary" disabled={loading || !!error} onClick={create}>+ New note</button>
    </div></div>
    {loading && <p role="status">Loading notes…</p>}
    {error && <p className="error is-visible" role="alert">{error}</p>}
    {!loading && !error && !visible.length && <p className="sticky-empty">{home ? "Pin a thought here. Add a note to get started, or manage hidden notes in Sticky Notes." : "Add your first note. Click any card to edit its text."}</p>}
    <div className="sticky-grid">{visible.map((note) => <article key={note.id} className={`sticky-card sticky-${note.color} sticky-size-${note.size}`}>
      <textarea aria-label="Note text" placeholder="Write a note…" maxLength={20000} value={note.text} onChange={(e) => patch(note.id, { text: e.target.value })} onBlur={() => save(note.id)} />
      <div className="sticky-controls">
        <label>Color <select value={note.color} onChange={(e) => patch(note.id, { color: e.target.value })}>{["yellow", "pink", "blue", "green", "orange"].map((color) => <option key={color}>{color}</option>)}</select></label>
        <label>Size <select value={note.size} onChange={(e) => patch(note.id, { size: e.target.value })}><option value="small">Small</option><option value="large">Large</option></select></label>
        <label><input type="checkbox" checked={note.showOnHome} onChange={(e) => patch(note.id, { showOnHome: e.target.checked })} /> Home</label>
        <button type="button" aria-label="Move note earlier" disabled={notes[0]?.id === note.id} onClick={() => move(note.id, -1)}>↑</button>
        <button type="button" aria-label="Move note later" disabled={notes.at(-1)?.id === note.id} onClick={() => move(note.id, 1)}>↓</button>
        <button type="button" disabled={status[note.id] === "Saving…"} onClick={() => remove(note.id)}>Delete</button>
      </div>
      <div className="sticky-save" role="status">{status[note.id] || "Saved"}
        {status[note.id] && !["Saved", "Saving…", "Unsaved changes"].includes(status[note.id]) && <><button type="button" onClick={() => retry(note.id)}>Retry save</button><button type="button" onClick={() => reloadNote(note.id)}>Discard edits / reload</button></>}
      </div>
    </article>)}</div>
  </aside>;
}
