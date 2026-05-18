# Optimus

Version: `v4.5`

Optimus is split into two local services:

- `npm run dev` starts the frontend and backend together in one terminal.
- `npm run backend` starts the API at `http://localhost:8787`.
- `npm run frontend` starts the Node static UI server at `http://localhost:4173`.

The `optimus` command is installed in `~/.local/bin` and can be run from anywhere. It switches to this project directory and runs `npm run dev`.

Create a local `.env` file for private values. It is ignored by Git.

```env
OPTIMUS_ACCESS_KEY=your-login-password
ANTHROPIC_API_KEY=your-anthropic-api-key
OPENAI_API_KEY=your-openai-api-key
# Admin keys for organization usage reports:
ANTHROPIC_ADMIN_KEY=your-anthropic-admin-api-key
OPENAI_ADMIN_KEY=your-openai-admin-api-key
SPORTMONKS_API_KEY=your-sportmonks-api-key
```

If `OPTIMUS_ACCESS_KEY` is not set, the local development key is `optimus`.
The API provider keys are optional until a tool or integration needs them.

## Assets

Branding and favicon files live in `frontend/assets/`. A root `frontend/favicon.ico` is also present so browsers can resolve `/favicon.ico` without a 404.

## Tools

The backend exposes the tool catalog at `GET /api/tools`. Tool group, visibility, and display order are managed from the frontend "Manage tools" dashboard and persisted in `data/tool-catalog.json`. The frontend renders the index from this metadata and maps each hosted tool `id` to its local UI.

### Padelog

Track padel match performance from the Personal tools group. Each match stores Padel Club, Date, Teammate, Opponents, Result (`Won`, `Lost`, or `Draw`), and Sets as a set score such as `1-0`, `2-1`, `1-1`, or `2-2`. Matches can be added manually one at a time or imported in batches from CSV using the columns `Padel Club`, `Date`, `Teamate`, `Opponents`, `Result`, and `Sets`. CSV dates can use `YYYY-MM-DD` or day/month formats such as `8/1/26`. The UI shows month-to-date, year-to-date, and custom date-range statistics above the manual and CSV entry panels, plus editable, paginated match history grouped by month, club, or no grouping.

Padelog match data is persisted locally in `data/padelog-matches.json` when the first match is saved.

### Betlog

Track placed bets from the Personal tools group. Each saved row represents one selection, so combo bets can repeat the same `bet_id`, stake, return, and metadata across multiple rows for analysis. Bets can be added manually one at a time or imported in batches from CSV using the columns `date`, `time`, `bet_id`, `bet_type`, `stake`, `free_bet`, `status`, `return_amount`, `selection`, `odds`, `market`, `match`, `score`, `outcome_type`, and `legs`. The UI shows month-to-date, year-to-date, and custom date-range statistics, with stake and return calculated once per unique bet ID so combo rows do not double-count money.

Betlog data is persisted locally in `data/betlog-bets.json` when the first bet is saved.

### Notelog

Capture handwritten notes from a pen tablet in the Personal tools group. Notes use a landscape page canvas and are stored locally as editable page and stroke data, with page controls, pen/eraser tools, pressure-aware strokes, stabilization, undo/redo, paper styles, page templates, autosave, and one-click vector PDF export. The Notelog workspace uses a left-side Notes/Tools panel and a compact Optimus rail so the writing area can use the full page height.

Tablet calibration is available from the Notelog Tools tab. Tap the four highlighted page corners to map tablet input to the note page area; calibration is stored in the browser and can be reset from the same panel. Exported PDFs are saved in `Outputs/Notes/` and can be opened from the Notelog export link.

Notelog data is persisted locally in `data/notelog-notes.json` when the first note is saved.

### Demo Builder

Build a branded, configurable agent demo from uploaded or pasted JSON files for content, sizing/prerequisites, and per-scenario glossary terms. The generated demo supports scenario selection, progressive chat playback, document reveal, grouped agent logs, glossary modal, simulation speed controls, pause/resume, and a chat-style interface with avatars. Outputs are saved locally in `Outputs/` as the requested `.html` file.

### HTML to iframe Base64

Upload an `.html` file from the UI to create an iframe-ready `data:text/html;base64,...` string. Outputs are saved locally in `Outputs/` as `base62-initialfilename.txt`.

### PDF to iframe Base64

Upload a `.pdf` file from the UI to create an iframe-ready `data:application/pdf;base64,...` string. Outputs are saved locally in `Outputs/` as `base64-pdf-initialfilename.txt`.

### Combine PDFs

Select two to five `.pdf` files, reorder them in the UI, and save a single combined PDF under a new file name. Pages are appended document by document in the chosen order, while preserving each page's original size. Outputs are saved locally in `Outputs/` as the requested `.pdf` file.

### Check My Token Usage

Check OpenAI and Anthropic token usage for month-to-date, year-to-date, and a custom date range. Month-to-date and year-to-date are loaded automatically when the tool opens. The tool reads `OPENAI_ADMIN_KEY` and `ANTHROPIC_ADMIN_KEY` from `.env`; normal model-call keys are not used for usage reports.

### Presentation Suite Builder

Specify an output filename, number of tabs, tab labels, and optional iframe sources to generate a tabbed presentation suite HTML template. The first tab is always the deck, remaining tabs are demos, and the date badge uses `Month YY` format. Iframe sources are selected from `.txt` files in `Outputs/`, including HTML and PDF Base64 outputs, and embedded directly into the generated HTML, so the final file does not reference the source `.txt` files. Outputs are saved locally in `Outputs/` as the requested `.html` file.
