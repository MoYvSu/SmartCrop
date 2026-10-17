from __future__ import annotations

import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from smartcrop_api import create_app
from smartcrop_runtime import Settings


@pytest.mark.parametrize("translator", ["none", "deepseek"])
def test_cli_without_translation_key_still_produces_downloadable_crop(
    tmp_path: Path,
    jpeg_bytes: bytes,
    translator: str,
) -> None:
    data = tmp_path / "data"
    settings = Settings(
        data_dir=data,
        database_path=data / "jobs.sqlite3",
        web_dist=tmp_path / "dist",
        access_code="",
        worker_backend="mock",
        report_translator=translator,
        deepseek_api_key="",
    )
    # Explicitly isolate the test from any developer/server credentials.
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith("SMARTCROP_")
    }
    environment.update({
        "SMARTCROP_DATA_DIR": str(data),
        "SMARTCROP_DATABASE_PATH": str(settings.database_path),
        "SMARTCROP_WORKER_BACKEND": "mock",
        "SMARTCROP_ACCESS_CODE": "",
        "SMARTCROP_REPORT_TRANSLATOR": translator,
        "SMARTCROP_DEEPSEEK_API_KEY": "",
    })
    with TestClient(create_app(settings, serve_web=False)) as client:
        submitted = client.post(
            "/v1/jobs",
            files={"file": ("sample.jpg", jpeg_bytes, "image/jpeg")},
        )
        assert submitted.status_code == 202
        result = subprocess.run(
            [sys.executable, "-m", "smartcrop_worker.cli", "--once"],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        if translator == "deepseek":
            assert "API key is missing; using original reports" in result.stderr
        job = client.get(f"/v1/jobs/{submitted.json()['id']}").json()
        assert job["status"] == "succeeded"
        assert job["report"]["translation_provider"] is None
        artifact = client.get(job["artifacts"]["crop"])
        assert artifact.status_code == 200
        with Image.open(BytesIO(artifact.content)) as image:
            image.load()
            assert image.format == "JPEG"
            assert image.width > 0 and image.height > 0
