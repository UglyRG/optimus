import base64
import io
import unittest
import zipfile

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from optimus_api.knowledge import (
    build_knowledge_map_graph,
    build_source_coverage_report,
    normalize_knowledge_store,
    parse_document,
    parse_docx_document,
    parse_knowledge_file,
    parse_pdf_document,
)


class KnowledgeParserTraceabilityTests(unittest.TestCase):
    def assert_entries_link_to_chunks(self, result):
        chunk_ids = {chunk["id"] for chunk in result["sourceChunks"]}
        self.assertTrue(result["entries"])
        self.assertTrue(result["sourceChunks"])
        for entry in result["entries"]:
            self.assertTrue(entry["sourceChunkIds"])
            self.assertTrue(set(entry["sourceChunkIds"]).issubset(chunk_ids))

    def test_markdown_retains_blocks_headings_and_offsets(self):
        text = (
            "# Security\n\n"
            "Passwords must contain 12 characters. MFA is required for admins.\n\n"
            "Question: How often are backups created?\n"
            "Answer: Backups are created daily."
        )

        result = parse_document(text, "guide.md", "markdown")

        self.assertEqual(2, len(result["entries"]))
        self.assertEqual(2, len(result["sourceChunks"]))
        self.assert_entries_link_to_chunks(result)
        self.assertEqual("Security", result["sourceChunks"][0]["heading"])
        self.assertEqual(
            result["sourceChunks"][0]["content"],
            text[result["sourceChunks"][0]["charStart"]:result["sourceChunks"][0]["charEnd"]],
        )

    def test_html_retains_each_content_block(self):
        result = parse_document(
            "<h1>Security</h1><p>Passwords need 12 characters.</p><p>MFA is required for admins.</p>",
            "guide.html",
            "html",
        )

        self.assertEqual(2, len(result["entries"]))
        self.assertEqual(2, len(result["sourceChunks"]))
        self.assert_entries_link_to_chunks(result)
        self.assertTrue(all(chunk["sourceType"] == "html-block" for chunk in result["sourceChunks"]))

    def test_csv_retains_row_locator(self):
        result = parse_document(
            (
                "category,question,answer,link\n"
                "Security,What is required?,MFA,https://example.test\n"
                "Security,What is the timeout?,,\n"
            ),
            "guide.csv",
            "csv",
        )

        self.assert_entries_link_to_chunks(result)
        self.assertEqual("row 2", result["sourceChunks"][0]["locator"])
        self.assertEqual("csv-row", result["sourceChunks"][0]["sourceType"])
        self.assertEqual(1, len(result["entries"]))
        self.assertEqual(2, len(result["sourceChunks"]))

    def test_json_retains_array_locator(self):
        result = parse_document(
            '{"entries":[{"category":"Security","question":"What is required?","answer":"MFA"}]}',
            "guide.json",
            "json",
        )

        self.assert_entries_link_to_chunks(result)
        self.assertEqual("entries[0]", result["sourceChunks"][0]["locator"])
        self.assertEqual("json-entry", result["sourceChunks"][0]["sourceType"])

    def test_pdf_extracts_page_scoped_chunks(self):
        result = parse_pdf_document(
            make_pdf(
                [
                    "Question: What is the password rule?\nAnswer: Passwords require twelve characters.",
                    "Backups run daily and retain thirty copies.",
                ]
            ),
            "policy.pdf",
        )

        self.assertEqual(2, len(result["entries"]))
        self.assertEqual(2, len(result["sourceChunks"]))
        self.assert_entries_link_to_chunks(result)
        self.assertEqual(1, result["sourceChunks"][0]["sourcePage"])
        self.assertEqual("page 1 block 1", result["sourceChunks"][0]["locator"])
        self.assertEqual(2, result["entries"][1]["sourcePage"])

    def test_docx_extracts_headings_qa_pairs_and_table_rows(self):
        result = parse_docx_document(make_docx(), "policy.docx")

        self.assertEqual(3, len(result["entries"]))
        self.assertEqual(3, len(result["sourceChunks"]))
        self.assert_entries_link_to_chunks(result)
        self.assertEqual("Security", result["sourceChunks"][0]["heading"])
        self.assertEqual("paragraph 2 + paragraph 3", result["sourceChunks"][0]["locator"])
        self.assertEqual("extracted", result["entries"][0]["questionSource"])
        self.assertEqual("table 1 row 1", result["sourceChunks"][2]["locator"])
        self.assertEqual("docx-table-row", result["sourceChunks"][2]["sourceType"])

    def test_binary_upload_payload_routes_to_pdf_and_docx_extractors(self):
        files = [
            ("policy.pdf", make_pdf(["Backups run daily."]), "pdf"),
            ("policy.docx", make_docx(), "docx"),
        ]

        for file_name, contents, expected_type in files:
            with self.subTest(file_name=file_name):
                result = parse_knowledge_file(
                    {
                        "fileName": file_name,
                        "base64": base64.b64encode(contents).decode("ascii"),
                    }
                )
                self.assertEqual(expected_type, result["fileType"])
                self.assertTrue(result["entries"])
                self.assertTrue(result["sourceChunks"])

    def test_legacy_snapshot_defaults_to_empty_traceability(self):
        normalized = normalize_knowledge_store(
            {
                "entries": [{"question": "Q?", "answer": "A"}],
                "uploads": [{"fileName": "legacy.txt", "rowCount": 1}],
            }
        )

        self.assertEqual([], normalized["entries"][0]["sourceChunkIds"])
        self.assertEqual(0, normalized["uploads"][0]["chunkCount"])
        self.assertEqual([], normalized["sourceChunks"])

    def test_coverage_report_distinguishes_uncovered_and_unsupported_content(self):
        chunks = [
            {
                "id": "chunk-1",
                "upload_id": "upload-1",
                "source_doc": "policy.md",
                "chunk_index": 1,
                "locator": "block 1",
                "content": "Passwords require twelve characters and MFA for admins.",
            },
            {
                "id": "chunk-2",
                "upload_id": "upload-1",
                "source_doc": "policy.md",
                "chunk_index": 2,
                "locator": "block 2",
                "content": "Backups run daily and retain thirty copies.",
            },
            {
                "id": "chunk-3",
                "upload_id": "upload-1",
                "source_doc": "policy.md",
                "chunk_index": 3,
                "locator": "block 3",
                "content": "Audit logs remain available for ninety days.",
            },
        ]
        entries = [
            {
                "id": "entry-1",
                "question": "What is the password policy?",
                "answer": "Passwords require twelve characters and MFA for admins.",
                "source_chunk_ids": ["chunk-1"],
            },
            {
                "id": "entry-2",
                "question": "How long are audit logs retained?",
                "answer": "Records rotate weekly without archival.",
                "source_chunk_ids": ["chunk-3"],
            },
            {"id": "legacy-entry", "question": "Legacy?", "answer": "Legacy answer."},
        ]
        uploads = [{"id": "upload-1", "file_name": "policy.md", "file_type": "markdown"}]

        report = build_source_coverage_report(chunks, entries, uploads)

        self.assertEqual(3, report["totals"]["chunks"])
        self.assertEqual(2, report["totals"]["linkedChunks"])
        self.assertEqual(1, report["totals"]["uncoveredChunks"])
        self.assertEqual(1, report["totals"]["untraceableEntries"])
        self.assertEqual("uncovered", report["issues"][0]["status"])
        self.assertEqual("chunk-2", report["issues"][0]["id"])
        self.assertEqual("entry-2", report["lowSupportEntries"][0]["id"])

    def test_knowledge_map_builds_structural_edges_and_activity(self):
        uploads = [{"id": "upload-1", "file_name": "policy.md", "file_type": "markdown", "row_count": 1, "chunk_count": 2}]
        chunks = [
            {"id": "chunk-1", "upload_id": "upload-1", "source_doc": "policy.md", "chunk_index": 1, "locator": "block 1", "content": "MFA is required for admins."},
            {"id": "chunk-2", "upload_id": "upload-1", "source_doc": "policy.md", "chunk_index": 2, "locator": "block 2", "content": "Backups run daily."},
        ]
        entries = [
            {
                "id": "entry-1",
                "category": "Security",
                "question": "What is required?",
                "answer": "MFA is required for admins.",
                "source_chunk_ids": ["chunk-1"],
            }
        ]
        turns = [
            {
                "retrieved_entry_ids": ["entry-1"],
                "citations": [{"id": "entry-1"}],
            }
        ]

        graph = build_knowledge_map_graph(uploads, chunks, entries, turns)

        nodes = {node["id"]: node for node in graph["nodes"]}
        edge_ids = {edge["id"] for edge in graph["edges"]}
        self.assertIn("document:upload-1", nodes)
        self.assertEqual("uncovered", nodes["chunk:chunk-2"]["coverageStatus"])
        self.assertEqual(1, nodes["entry:entry-1"]["retrievedCount"])
        self.assertEqual(1, nodes["entry:entry-1"]["citedCount"])
        self.assertIn("document:upload-1->chunk:chunk-1", edge_ids)
        self.assertIn("chunk:chunk-1->entry:entry-1", edge_ids)


def make_pdf(page_texts):
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    for text in page_texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject(
                    {NameObject("/F1"): font_ref}
                )
            }
        )
        lines = [
            line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            for line in text.splitlines()
        ]
        commands = ["BT /F1 12 Tf 72 720 Td"]
        for index, line in enumerate(lines):
            if index:
                commands.append("0 -18 Td")
            commands.append(f"({line}) Tj")
        commands.append("ET")
        stream = DecodedStreamObject()
        stream.set_data(("\n".join(commands) + "\n").encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def make_docx():
    document_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Security</w:t></w:r></w:p>
    <w:p><w:r><w:t>Question: What is required?</w:t></w:r></w:p>
    <w:p><w:r><w:t>Answer: MFA is required for admins.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Passwords require twelve characters.</w:t></w:r></w:p>
    <w:tbl><w:tr>
      <w:tc><w:p><w:r><w:t>Backup schedule</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Daily</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>
"""
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>
"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


if __name__ == "__main__":
    unittest.main()
