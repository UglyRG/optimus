# Optimus

Version: `0.2.0`

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
SPORTMONKS_API_KEY=your-sportmonks-api-key
```

If `OPTIMUS_ACCESS_KEY` is not set, the local development key is `optimus`.
The API provider keys are optional until a tool or integration needs them.

## Assets

Branding and favicon files live in `frontend/assets/`. A root `frontend/favicon.ico` is also present so browsers can resolve `/favicon.ico` without a 404.

## Tools

The backend exposes the tool catalog at `GET /api/tools`. Tool group, visibility, and display order are managed from the frontend "Manage tools" dashboard and persisted in `data/tool-catalog.json`. The frontend renders the index from this metadata and maps each hosted tool `id` to its local UI.

### Padelog

Track padel match performance from the Personal tools group. Each match stores Padel Club, Date, Teammate, Opponents, Result (`Won`, `Lost`, or `Draw`), and Sets. Matches can be added manually one at a time or imported in batches from CSV using the columns `Padel Club`, `Date`, `Teamate`, `Opponents`, `Result`, and `Sets`. The UI shows month-to-date, year-to-date, and custom date-range statistics above the manual and CSV entry panels.

Padelog match data is persisted locally in `data/padelog-matches.json` when the first match is saved.

### Demo Builder

Build a branded, configurable agent demo from uploaded or pasted JSON files for content, sizing/prerequisites, and per-scenario glossary terms. The generated demo supports scenario selection, progressive chat playback, document reveal, grouped agent logs, glossary modal, simulation speed controls, pause/resume, and a chat-style interface with avatars. Outputs are saved locally in `Outputs/` as the requested `.html` file.

### HTML to iframe Base64

Upload an `.html` file from the UI to create an iframe-ready `data:text/html;base64,...` string. Outputs are saved locally in `Outputs/` as `base62-initialfilename.txt`.

### PDF to iframe Base64

Upload a `.pdf` file from the UI to create an iframe-ready `data:application/pdf;base64,...` string. Outputs are saved locally in `Outputs/` as `base64-pdf-initialfilename.txt`.

### Presentation Suite Builder

Specify an output filename, number of tabs, tab labels, and optional iframe sources to generate a tabbed presentation suite HTML template. The first tab is always the deck, remaining tabs are demos, and the date badge uses `Month YY` format. Iframe sources are selected from `.txt` files in `Outputs/`, including HTML and PDF Base64 outputs, and embedded directly into the generated HTML, so the final file does not reference the source `.txt` files. Outputs are saved locally in `Outputs/` as the requested `.html` file.
