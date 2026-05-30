HOSTED_TOOLS = [
    {
        "id": "padelog",
        "title": "Padelog",
        "description": "Track padel match results, import CSV batches, and review month, year, or custom-period performance.",
    },
    {
        "id": "betlog",
        "title": "Betlog",
        "description": "Log placed bets, import CSV batches, and review stake, returns, profit, and hit-rate performance.",
    },
    {
        "id": "notelog",
        "title": "Notelog",
        "description": "Capture handwritten pen-tablet notes on editable pages and export them as local PDFs.",
    },
    {
        "id": "demo-builder",
        "title": "Demo Builder",
        "description": "Create a branded, configurable agent demo template with scenarios, messages, docs, and logs.",
    },
    {
        "id": "presentation-suite",
        "title": "Presentation Suite Builder",
        "description": "Create a tabbed presentation suite HTML file with a deck tab and demo tabs.",
    },
    {
        "id": "html-base64",
        "title": "HTML to iframe Base64",
        "description": "Convert an HTML file into an iframe-ready Base64 data string and save it to Outputs.",
    },
    {
        "id": "pdf-base64",
        "title": "PDF to iframe Base64",
        "description": "Convert a PDF file into an iframe-ready Base64 data string and save it to Outputs.",
    },
    {
        "id": "combine-pdfs",
        "title": "Combine PDFs",
        "description": "Combine two to five PDF files into one new PDF while preserving page sizes.",
    },
    {
        "id": "csv-json-rows",
        "title": "CSV to JSON Rows",
        "description": "Convert every row in a CSV file into matching JSON files saved inside an Outputs subfolder.",
    },
    {
        "id": "csv-qa-markdown",
        "title": "CSV Q&A to Markdown",
        "description": "Convert a Q&A CSV with question and answer columns into a Markdown knowledge-base file.",
    },
    {
        "id": "token-usage",
        "title": "Check My Token Usage",
        "description": "Check OpenAI and Anthropic token usage for month-to-date, year-to-date, and a custom range.",
    },
    {
        "id": "knowledge-expert",
        "title": "Knowledge Expert",
        "description": "Upload a small knowledge base and ask grounded questions with source citations.",
    },
]

DEFAULT_TOOL_CATALOG_CONFIG = {
    "groups": [
        {"id": "builders", "name": "Builders", "displayOrder": 1},
        {"id": "utilities", "name": "Utilities", "displayOrder": 2},
    ],
    "tools": [
        {"id": "padelog", "groupId": "utilities", "displayOrder": 1, "enabled": True},
        {"id": "betlog", "groupId": "utilities", "displayOrder": 2, "enabled": True},
        {"id": "notelog", "groupId": "utilities", "displayOrder": 3, "enabled": True},
        {"id": "demo-builder", "groupId": "builders", "displayOrder": 1, "enabled": True},
        {"id": "presentation-suite", "groupId": "builders", "displayOrder": 2, "enabled": True},
        {"id": "html-base64", "groupId": "utilities", "displayOrder": 4, "enabled": True},
        {"id": "pdf-base64", "groupId": "utilities", "displayOrder": 5, "enabled": True},
        {"id": "combine-pdfs", "groupId": "utilities", "displayOrder": 6, "enabled": True},
        {"id": "csv-json-rows", "groupId": "utilities", "displayOrder": 7, "enabled": True},
        {"id": "csv-qa-markdown", "groupId": "utilities", "displayOrder": 8, "enabled": True},
        {"id": "token-usage", "groupId": "utilities", "displayOrder": 9, "enabled": True},
        {"id": "knowledge-expert", "groupId": "utilities", "displayOrder": 10, "enabled": True},
    ],
}
