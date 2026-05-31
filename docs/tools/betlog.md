# Betlog

Betlog tracks placed bets and betting performance.

## Data

Each saved row represents one selection. Combo bets can repeat the same `bet_id`, stake, return, and metadata across multiple rows so individual selections remain analyzable.

Money metrics count stake and return once per unique bet ID, so combo rows do not double-count totals.

Data is persisted in Postgres under the `betlog_bets` app data key.

## Import

CSV import expects:

- `date`
- `time`
- `bet_id`
- `bet_type`
- `stake`
- `free_bet`
- `status`
- `return_amount`
- `selection`
- `odds`
- `market`
- `match`
- `score`
- `outcome_type`
- `legs`

## Analysis

The UI shows month-to-date, year-to-date, and custom-range statistics. AI performance insights use `ANTHROPIC_API_KEY` and the configured Anthropic chat model, then analyze the full saved betting history.

Saved insight runs are persisted and included in backup/restore.
