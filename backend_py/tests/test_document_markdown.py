import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from optimus_api.config import Settings
from optimus_api.tools import convert_document_to_markdown


class FakeMarkItDown:
    def __init__(self, enable_plugins=False):
        self.enable_plugins = enable_plugins

    def convert(self, path):
        return SimpleNamespace(text_content=f"# Converted\n\nSource: {Path(path).suffix}\n")


class DocumentMarkdownTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings = Settings(_env_file=None, outputs_dir=Path(self.temp_dir.name))

    def tearDown(self):
        self.temp_dir.cleanup()

    def convert(self, file_name="Quarterly Report.docx", content=b"document bytes"):
        return convert_document_to_markdown(
            {"fileName": file_name, "base64": base64.b64encode(content).decode("ascii")},
            self.settings,
        )

    def test_converts_document_and_saves_markdown_output(self):
        with patch("optimus_api.tools.MarkItDown", FakeMarkItDown):
            result = self.convert()

        self.assertEqual("Quarterly-Report.md", result["fileName"])
        self.assertIn("# Converted", result["markdown"])
        self.assertTrue((Path(self.temp_dir.name) / "Quarterly-Report.md").exists())

    def test_rejects_invalid_base64(self):
        with self.assertRaises(HTTPException) as raised:
            convert_document_to_markdown({"fileName": "report.pdf", "base64": "not base64"}, self.settings)

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("Base64", raised.exception.detail)

    def test_reports_missing_markitdown_dependency(self):
        with patch("optimus_api.tools.MarkItDown", None):
            with self.assertRaises(HTTPException) as raised:
                self.convert()

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("MarkItDown is not installed", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
