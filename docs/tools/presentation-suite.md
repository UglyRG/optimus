# Presentation Suite Builder

Presentation Suite Builder creates a tabbed HTML presentation shell.

## Behavior

- The first tab is always the deck.
- Remaining tabs are demos.
- The date badge uses `Month YY` format.
- Iframe sources are selected from `.txt` files in `Outputs/`.
- HTML and PDF Base64 outputs are embedded directly into the generated HTML.

## Output

Generated suites are saved in `Outputs/` as HTML files.

The final file does not depend on the source `.txt` files after generation.
