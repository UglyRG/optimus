# Optimus

Optimus is split into two local services:

- `npm run dev` starts the frontend and backend together in one terminal.
- `npm run backend` starts the API at `http://localhost:8787`.
- `npm run frontend` starts the Node static UI server at `http://localhost:4173`.

Create a local `.env` file for private values. It is ignored by Git.

```env
OPTIMUS_ACCESS_KEY=your-login-password
```

If `OPTIMUS_ACCESS_KEY` is not set, the local development key is `optimus`.

## Assets

Branding and favicon files live in `frontend/assets/`. A root `frontend/favicon.ico` is also present so browsers can resolve `/favicon.ico` without a 404.

## Tools

### HTML to iframe Base64

Upload an `.html` file from the UI to create an iframe-ready `data:text/html;base64,...` string. Outputs are saved locally in `Outputs/` as `base62-initialfilename.txt`.

### Presentation Suite Builder

Specify an output filename, number of tabs, and tab labels to generate a tabbed presentation suite HTML template. The first tab is always the deck, remaining tabs are demos, and the date badge uses `Month YY` format. Outputs are saved locally in `Outputs/` as the requested `.html` file.
