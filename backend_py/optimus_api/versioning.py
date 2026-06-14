from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


DEPLOYED_VERSION_FILE = ".optimus-version"


def resolve_app_version(root_dir: Path) -> str:
    deployed_version = read_version_file(root_dir / DEPLOYED_VERSION_FILE)
    if deployed_version:
        return deployed_version

    git_version = describe_git_version(root_dir)
    if git_version:
        return git_version

    env_version = os.getenv("OPTIMUS_VERSION", "").strip()
    if env_version:
        return env_version

    package_version = read_package_version(root_dir / "package.json")
    if package_version:
        return f"v{package_version}"

    return read_version_file(root_dir / "VERSION") or "unknown"


def describe_git_version(root_dir: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--always", "--dirty"],
            cwd=root_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return ""
    return result.stdout.strip()


def read_version_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def read_package_version(path: Path) -> str:
    try:
        return str(json.loads(path.read_text(encoding="utf-8")).get("version") or "").strip()
    except (OSError, ValueError, TypeError):
        return ""
