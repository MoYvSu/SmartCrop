from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from smartcrop_api import create_app
from smartcrop_contracts import JobStatus
from smartcrop_runtime import JobStore, Settings
from smartcrop_worker import Worker
from smartcrop_worker.backends import MockBackend


class FailingBackend:
    def analyze(self, _image_path: Path, _intent):
        raise RuntimeError("测试模型故障")

    def review(self, _image_path: Path, _intent):
        raise RuntimeError("测试模型故障")


class FailingTranslator:
    def translate(self, _report):
        raise RuntimeError("测试翻译服务故障")


def _settings(tmp_path: Path) -> Settings:
    data = tmp_path / "data"
    return Settings(
        data_dir=data,
        database_path=data / "smartcrop.sqlite3",
        web_dist=tmp_path / "missing-dist",
        access_code="demo-code",
        worker_backend="mock",
    )


def _submit(
    client: TestClient,
    jpeg_bytes: bytes,
    *,
    aspect_ratio: str = "free",
    extra_intent: dict[str, str] | None = None,
) -> dict:
    intent = {"scene": "portrait", "aspect_ratio": aspect_ratio}
    intent.update(extra_intent or {})
    response = client.post(
        "/v1/jobs",
        headers={"X-SmartCrop-Access": "demo-code"},
        files={"file": ("sample.jpg", jpeg_bytes, "image/jpeg")},
        data=intent,
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

        submitted = _submit(client, jpeg_bytes, aspect_ratio="4:5")
        pending_plan = client.get(
            submitted["artifacts"]["plan"],
            headers={"X-SmartCrop-Access": "demo-code"},
        ).json()
        assert pending_plan["selection_mode"] == "unconfirmed"
        assert pending_plan["selection_confirmed"] is False
        assert pending_plan["output"]["ratio_compliant"] is None
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
        assert body["intent"] == {
            "scene": "portrait",
            "aspect_ratio": "4:5",
            "output_template": None,
            "custom_ratio": None,
        }
        assert [candidate["id"] for candidate in body["candidates"]] == [
            "balanced",
            "subject",
            "story",
        ]
        for candidate in body["candidates"]:
            crop = candidate["crop"]
            assert crop["width"] * 800 / (crop["height"] * 600) == pytest.approx(0.8)
        assert body["capability_status"] == "mock"
        assert body["selection_confirmed"] is False

        selected = client.post(
            f"/v1/jobs/{submitted['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={
                "crop": body["candidates"][1]["crop"],
                "candidate_id": "subject",
            },
        )
        assert selected.status_code == 200
        assert selected.json()["selection_confirmed"] is True
        assert selected.json()["manual_adjusted"] is False

        changed = client.post(
            f"/v1/jobs/{submitted['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={
                "crop": {"x": 0.25, "y": 0.1, "width": 0.48, "height": 0.8},
                "candidate_id": "subject",
                "selection_reasons": ["subject_emphasis", "platform_fit"],
                "selection_note": "为发布模板收紧主体",
            },
        )
        assert changed.status_code == 200
        assert changed.json()["manual_adjusted"] is True
        assert changed.json()["selection_confirmed"] is True
        assert changed.json()["selection_reasons"] == ["subject_emphasis", "platform_fit"]

        artifact = client.get(
            changed.json()["artifacts"]["crop"],
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert artifact.status_code == 200
        crop_path = settings.jobs_dir / submitted["id"] / "crop.jpg"
        with Image.open(crop_path) as crop:
            assert crop.size == (384, 480)

        review = client.post(
            f"/v1/jobs/{submitted['id']}/review",
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert review.status_code == 202
        assert Worker(settings, store, MockBackend()).run_once()
        reviewed = client.get(
            f"/v1/jobs/{review.json()['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        ).json()
        assert reviewed["mode"] == "review"
        assert reviewed["parent_job_id"] == submitted["id"]
        assert reviewed["report"]["overview"].startswith("终稿为")
        rejected_review_crop = client.post(
            f"/v1/jobs/{reviewed['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={"crop": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}},
        )
        assert rejected_review_crop.status_code == 409

        plan = client.get(
            body["artifacts"]["plan"],
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert plan.status_code == 200
        assert plan.json()["schema_version"] == "1.2"
        assert plan.json()["selection_mode"] == "human"
        assert plan.json()["selection_confirmed"] is True
        assert plan.json()["selection_reasons"] == ["subject_emphasis", "platform_fit"]
        assert plan.json()["selection_note"] == "为发布模板收紧主体"
        assert isinstance(plan.json()["processing_duration_ms"], int)
        assert plan.json()["initial_report"]["overview"]
        assert plan.json()["provenance"] == "runtime"
        assert plan.json()["intent"]["aspect_ratio"] == "4:5"
        assert plan.json()["output"]["crop_size"] == {"width": 384, "height": 480}
        assert plan.json()["output"]["ratio_compliant"] is True


def test_custom_ratio_runs_end_to_end_and_rejects_invalid_manual_crop(
    jpeg_bytes: bytes,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        submitted = _submit(
            client,
            jpeg_bytes,
            aspect_ratio="custom",
            extra_intent={
                "output_template": "custom",
                "custom_ratio_width": "7",
                "custom_ratio_height": "5",
            },
        )
        store = JobStore(settings.database_path)
        assert Worker(settings, store, MockBackend()).run_once()
        result = client.get(
            f"/v1/jobs/{submitted['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        ).json()

        assert result["intent"]["custom_ratio"] == {"width": 7, "height": 5}
        rejected = client.post(
            f"/v1/jobs/{submitted['id']}/crop",
            headers={"X-SmartCrop-Access": "demo-code"},
            json={"crop": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}},
        )
        assert rejected.status_code == 422
        assert "7:5" in rejected.json()["detail"]


@pytest.mark.parametrize(
    ("size", "ratio"),
    [
        ((6400, 64), (1, 10)),
        ((64, 6400), (10, 1)),
    ],
)
def test_infeasible_target_ratio_is_rejected_before_inference(
    tmp_path: Path,
    size: tuple[int, int],
    ratio: tuple[int, int],
) -> None:
    output = BytesIO()
    Image.new("RGB", size, (58, 96, 152)).save(output, format="JPEG", quality=80)
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs",
            headers={"X-SmartCrop-Access": "demo-code"},
            files={"file": ("extreme.jpg", output.getvalue(), "image/jpeg")},
            data={
                "scene": "general",
                "aspect_ratio": "custom",
                "output_template": "custom",
                "custom_ratio_width": str(ratio[0]),
                "custom_ratio_height": str(ratio[1]),
            },
        )

    assert response.status_code == 422
    assert "差异过大" in response.json()["detail"]


@pytest.mark.parametrize(
    ("size", "ratio"),
    [
        ((400, 100), (1, 10)),
        ((100, 400), (10, 1)),
        ((4000, 90), (1, 1)),
    ],
)
def test_near_boundary_target_ratio_produces_valid_candidates(
    tmp_path: Path,
    size: tuple[int, int],
    ratio: tuple[int, int],
) -> None:
    output = BytesIO()
    Image.new("RGB", size, (58, 96, 152)).save(output, format="JPEG", quality=80)
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs",
            headers={"X-SmartCrop-Access": "demo-code"},
            files={"file": ("boundary.jpg", output.getvalue(), "image/jpeg")},
            data={
                "scene": "general",
                "aspect_ratio": "custom",
                "output_template": "custom",
                "custom_ratio_width": str(ratio[0]),
                "custom_ratio_height": str(ratio[1]),
            },
        )
        assert response.status_code == 202
        store = JobStore(settings.database_path)
        assert Worker(settings, store, MockBackend()).run_once()
        result = client.get(
            f"/v1/jobs/{response.json()['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        ).json()

    assert result["status"] == JobStatus.SUCCEEDED.value
    for candidate in result["candidates"]:
        crop = candidate["crop"]
        assert crop["width"] >= 0.02
        assert crop["height"] >= 0.02
        assert crop["width"] * size[0] / (crop["height"] * size[1]) == pytest.approx(
            ratio[0] / ratio[1]
        )


@pytest.mark.parametrize(
    "extra_intent",
    [
        {"output_template": "custom", "custom_ratio_width": "7"},
        {"output_template": "avatar"},
    ],
)
def test_invalid_output_template_forms_are_rejected(
    jpeg_bytes: bytes,
    tmp_path: Path,
    extra_intent: dict[str, str],
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs",
            headers={"X-SmartCrop-Access": "demo-code"},
            files={"file": ("sample.jpg", jpeg_bytes, "image/jpeg")},
            data={"scene": "portrait", "aspect_ratio": "free", **extra_intent},
        )

    assert response.status_code == 422


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


def test_translation_failure_keeps_successful_crop_and_original_report(
    jpeg_bytes: bytes,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client:
        submitted = _submit(client, jpeg_bytes)
        store = JobStore(settings.database_path)
        assert Worker(settings, store, MockBackend(), FailingTranslator()).run_once()

        result = client.get(
            f"/v1/jobs/{submitted['id']}",
            headers={"X-SmartCrop-Access": "demo-code"},
        )
        assert result.status_code == 200
        body = result.json()
        assert body["status"] == JobStatus.SUCCEEDED.value
        assert body["artifacts"]["crop"]
        assert body["report"]["overview"]
