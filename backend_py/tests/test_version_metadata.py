import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend_py.optimus_api.versioning import resolve_app_version


ROOT_DIR = Path(__file__).resolve().parents[2]


class VersionMetadataTests(unittest.TestCase):
    def test_release_versions_are_synchronized(self):
        package_version = json.loads((ROOT_DIR / "package.json").read_text(encoding="utf-8"))["version"]
        pyproject = (ROOT_DIR / "backend_py" / "pyproject.toml").read_text(encoding="utf-8")
        backend_version = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE).group(1)
        fallback_version = (ROOT_DIR / "VERSION").read_text(encoding="utf-8").strip().removeprefix("v")

        self.assertEqual(package_version, backend_version)
        self.assertEqual(".".join(package_version.split(".")[:2]), fallback_version)

    def test_deployment_snapshot_overrides_stale_environment_version(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root_dir = Path(temp_dir)
            (root_dir / ".optimus-version").write_text("v6.3-2-gabcdef0\n", encoding="utf-8")

            with patch.dict("os.environ", {"OPTIMUS_VERSION": "v6.2.2"}):
                self.assertEqual("v6.3-2-gabcdef0", resolve_app_version(root_dir))

    def test_package_version_is_used_when_deployment_and_git_metadata_are_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root_dir = Path(temp_dir)
            (root_dir / "package.json").write_text('{"version":"7.1.0"}\n', encoding="utf-8")

            with (
                patch.dict("os.environ", {}, clear=True),
                patch("backend_py.optimus_api.versioning.describe_git_version", return_value=""),
            ):
                self.assertEqual("v7.1.0", resolve_app_version(root_dir))
