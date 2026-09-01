from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from smartcrop_api import create_app
from smartcrop_contracts import JobStatus
from smartcrop_runtime import JobStore, Settings
from smartcrop_worker import Worker
from smartcrop_worker.backends import MockBackend


class FailingBackend:
    def analyze(self, _image_path: Path):
        raise RuntimeError("测试模型故障")


def _settings(tmp_path: Path) -> Settings:
    data = tmp_path / "data"
    return Settings(
        data_dir=data,
        database_path=data / "smartcrop.sqlite3",
        web_dist=tmp_path / "missing-dist",
        access_code="demo-code",
        worker_backend="mock",
    )


def _submit(client: TestClient, jpeg_bytes: bytes) -> dict:
    response = client.post(
        "/v1/jobs",
        headers={"X-SmartCrop-Access": "demo-code"},
        files={"file": ("sample.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert response.status_code == 202
    return response.json()


def test_authenticated_job_runs_and_returns_original_resolution_crop(
    jpeg_bytes: bytes,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        unauthorized = client.get("/v1/config")
        assert unauthorized.status_code == 401

        submitted = _submit(client, jpeg_bytes)
        store = JobStore(settings.database_path)
        assert Worker(settings, store, MockBackend()).run_once()

        result = client.get(
            f"/v1/jobs/{submitted['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert result.status_code == 200
        body = result.json()
        assert body["status"] == JobStatus.SUCCEEDED.value
        assert body["report"]["overview"]

        changed = client.post(
            f"/v1/jobs/{submitted['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={"crop": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}},
        )
        assert changed.status_code == 200
        assert changed.json()["manual_adjusted"] is True

        artifact = client.get(
            changed.json()["artifacts"]["crop"],
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert artifact.status_code == 200
        crop_path = settings.jobs_dir / submitted["id"] / "crop.jpg"
        with Image.open(crop_path) as crop:
            assert crop.size == (400, 300)


def test_inference_failure_offers_honest_manual_only_crop(
    jpeg_bytes: bytes,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        submitted = _submit(client, jpeg_bytes)
        store = JobStore(settings.database_path)
        assert Worker(settings, store, FailingBackend()).run_once()

        failed = client.get(
            f"/v1/jobs/{submitted['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        ).json()
        assert failed["status"] == JobStatus.FAILED.value

        manual = client.post(
            f"/v1/jobs/{submitted['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={"crop": {"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}},
        )
        assert manual.status_code == 200
        assert manual.json()["manual_only"] is True
        assert manual.json()["report"] is None
        assert manual.json()["error"]["code"] == "inference_failed"
