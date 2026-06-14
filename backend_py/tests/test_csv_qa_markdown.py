import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from optimus_api.config import Settings
from optimus_api.tools import save_csv_qa_markdown


class CsvQaMarkdownTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings = Settings(_env_file=None, outputs_dir=Path(self.temp_dir.name))

    def tearDown(self):
        self.temp_dir.cleanup()

    def convert(self, csv_text):
        return save_csv_qa_markdown({"fileName": "knowledge.csv", "csv": csv_text}, self.settings)

    def test_accepts_semicolon_delimiter_bom_and_unquoted_commas(self):
        result = self.convert(
            "\ufeffCategory;Question;Answer;Link\r\n"
            "Overview;What is it?;A framework with retrieval, computation, and tools;\r\n"
        )

        self.assertEqual(1, result["entryCount"])
        self.assertIn("A framework with retrieval, computation, and tools", result["markdown"])

    def test_preserves_quoted_delimiters_quotes_and_newlines(self):
        result = self.convert(
            'Category;Question;Answer;Link\n'
            'Details;"Does it support ;?";"Yes, it supports ""quoted"" text\nand newlines.";"https://example.test/a;b"\n'
        )

        self.assertIn("### Does it support ;?", result["markdown"])
        self.assertIn('Yes, it supports "quoted" text\nand newlines.', result["markdown"])
        self.assertIn("Source: https://example.test/a;b", result["markdown"])

    def test_still_accepts_comma_delimited_csv(self):
        result = self.convert(
            'Category,Question,Answer,Link\n'
            'Overview,"What is it?","A framework, with tools",\n'
        )

        self.assertEqual(1, result["entryCount"])
        self.assertIn("A framework, with tools", result["markdown"])

    def test_rejects_inconsistent_column_count(self):
        with self.assertRaises(HTTPException) as raised:
            self.convert("Category;Question;Answer\nOverview;Question?;Answer;Unexpected\n")

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("row 2", raised.exception.detail)

    def test_rejects_malformed_quoted_value(self):
        with self.assertRaises(HTTPException) as raised:
            self.convert('Category;Question;Answer\nOverview;"Question?;Answer\n')

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("malformed quoting or escaping", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
