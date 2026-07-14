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

## FAQPage JSON-LD Generator

Creates a copy-ready `FAQPage` JSON-LD script block for one page at a time.

Inputs:

- page URL
- language
- one or more visible question and answer pairs

The generated block is browser-local and is not saved to `Outputs/`. Copy the full script block into the matching page, then validate it with [Google's Rich Results Test](https://search.google.com/test/rich-results) or [Schema.org validator](https://validator.schema.org/).

## Document to Markdown

Converts a source document with Microsoft MarkItDown and saves a Markdown file in `Outputs/`.
The output filename uses the source file stem:

```text
initialfilename.md
```

Supported formats depend on the installed MarkItDown extras. The Optimus backend installs the local document extras for DOCX, PDF, PPTX, XLS, and XLSX conversion without the remote, audio, and video extras from `markitdown[all]`.

## Check My Token Usage

Checks OpenAI and Anthropic token usage for:

- month-to-date
- year-to-date
- custom date range

This tool uses `OPENAI_ADMIN_KEY` and `ANTHROPIC_ADMIN_KEY`.
