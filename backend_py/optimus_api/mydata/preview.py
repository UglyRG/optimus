"""Render private PDF pages without relying on a browser PDF plugin."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi import HTTPException


def preview(data, mime, page):
    if mime != "application/pdf":
        if page != 1:
            raise HTTPException(404, "Page not found")
        return data, mime
    environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"}}
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    try:
        response = subprocess.run([sys.executable, "-m", "optimus_api.mydata.extract_process"],
                                  input=json.dumps({"content": base64.b64encode(data).decode(), "preview": page}).encode(),
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25, env=environment)
        result = json.loads(response.stdout)
        if response.returncode or result.get("event") != "preview":
            raise ValueError()
        return base64.b64decode(result["png"], validate=True), "image/png"
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        raise HTTPException(400, "Could not render this page. Use Open original to view the saved document.") from exc
