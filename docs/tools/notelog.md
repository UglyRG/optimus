# Notelog

Notelog captures handwritten notes from a pen tablet.

## Capabilities

- Landscape page canvas.
- Editable page and stroke data.
- Pen and stroke-only eraser tools. Erasing handwriting preserves the selected paper template.
- Pressure-aware strokes.
- Stroke stabilization.
- Undo and redo.
- Clear current page handwriting while preserving its paper template.
- Paper styles and page templates.
- Per-note autosave after edits and completed pen strokes.
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

The calibration overlay is anchored to the rendered paper element. Its targets follow the visible paper edges as the canvas resizes, rather than relying on fixed viewport offsets.
