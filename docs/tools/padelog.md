# Padelog

Padelog tracks padel match performance.

## Data

Each match stores:

- Padel club
- Date
- Teammate
- Opponents
- Result: `Won`, `Lost`, or `Draw`
- Sets, such as `1-0`, `2-1`, `1-1`, or `2-2`

Data is persisted in Postgres under the `padelog_matches` app data key.

## Import

CSV import expects:

- `Padel Club`
- `Date`
- `Teamate`
- `Opponents`
- `Result`
- `Sets`

Dates can use `YYYY-MM-DD` or day/month formats such as `8/1/26`.

## Analysis

The UI shows month-to-date, year-to-date, and custom-range statistics. AI performance insights use `ANTHROPIC_API_KEY` and the configured Anthropic chat model, then analyze the full saved match history.

Saved insight runs are persisted and included in backup/restore.
