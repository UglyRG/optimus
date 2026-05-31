# Notelog

Notelog captures handwritten notes from a pen tablet.

## Capabilities

- Landscape page canvas.
- Editable page and stroke data.
- Pen and eraser tools.
- Pressure-aware strokes.
- Stroke stabilization.
- Undo and redo.
- Paper styles and page templates.
- Autosave.
- Vector PDF export.
- Tablet calibration.

## Persistence

Editable note data is persisted in Postgres under the `notelog_notes` app data key.

Exported PDFs are saved in:

```text
Outputs/Notes/
```

## Calibration

Tablet calibration is stored in browser local storage. The user taps the four highlighted page corners to map tablet input to the page area.
