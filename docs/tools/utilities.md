# Utilities

This page groups smaller utility tools.

## HTML to iframe Base64

Uploads an `.html` file and creates an iframe-ready `data:text/html;base64,...` string.

Outputs are saved in `Outputs/` using the source file stem:

```text
initialfilename-iframe.txt
```

## PDF to iframe Base64

Uploads a `.pdf` file and creates an iframe-ready `data:application/pdf;base64,...` string.

Outputs are saved in `Outputs/` using the source file stem:

```text
initialfilename-iframe.txt
```

## Combine PDFs

Combines two to five PDF files into one PDF. Pages are appended document by document in the selected order while preserving original page sizes.

## CSV to JSON Rows

Converts every row in a CSV file into matching JSON files saved inside an `Outputs/` subfolder.

## CSV Q&A to Markdown

Converts a comma- or semicolon-delimited Q&A CSV with question and answer columns into a Markdown knowledge-base file.
Standard CSV quoting is supported for delimiters, double quotes, and line breaks inside values.

## Check My Token Usage

Checks OpenAI and Anthropic token usage for:

- month-to-date
- year-to-date
- custom date range

This tool uses `OPENAI_ADMIN_KEY` and `ANTHROPIC_ADMIN_KEY`.
