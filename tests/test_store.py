from __future__ import annotations

from pathlib import Path

from smartcrop_contracts import CropBox, CropCandidate, JobStatus, Report
from smartcrop_runtime import JobStore


def _report() -> Report:
    return Report(
        overview="整体构图清晰。",
        strengths=["主体明确。"],
        issues=["边缘略显分散。"],
        crop_rationale="收拢边缘以突出主体。",
        shooting_tips=["留意背景边缘。"],
    )


def _create(store: JobStore, tmp_path: Path, job_id: str = "job-1") -> None:
    job_dir = tmp_path / job_id
    job_dir.mkdir()
    original = job_dir / "original.jpg"
    preview = job_dir / "preview.jpg"
    original.touch()
    preview.touch()
    store.create_job(
        job_id=job_id,
        input_path=original,
        preview_path=preview,
        source_format="JPEG",
        image_width=800,
        image_height=600,
        retention_seconds=3600,
    )


def test_late_result_cannot_overwrite_failure(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.initialize()
    _create(store, tmp_path)
    assert store.claim_next() is not None
    assert store.fail_job("job-1", "inference_timeout", "超时")

    committed = store.complete_job(
        "job-1",
        report=_report(),
        candidates=[
            CropCandidate(
                id="balanced",
                crop=CropBox(x=0.1, y=0.1, width=0.8, height=0.8),
            )
        ],
        crop_path=tmp_path / "job-1" / "crop.jpg",
    )

    assert not committed
    assert store.get_job("job-1").status == JobStatus.FAILED


def test_failed_job_can_become_explicit_manual_only_result(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.initialize()
    _create(store, tmp_path)
    assert store.fail_job("job-1", "inference_failed", "模型错误")
    crop = CropBox(x=0.05, y=0.05, width=0.9, height=0.9)

    assert store.update_manual_crop("job-1", crop, tmp_path / "job-1" / "crop.jpg")
    record = store.get_job("job-1")

    assert record.status == JobStatus.SUCCEEDED
    assert record.manual_only
    assert record.report is None
    assert record.error_code == "inference_failed"


def test_expired_job_record_is_removed(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.initialize()
    job_dir = tmp_path / "expired"
    job_dir.mkdir()
    original = job_dir / "original.jpg"
    preview = job_dir / "preview.jpg"
    original.touch()
    preview.touch()
    store.create_job(
        job_id="expired",
        input_path=original,
        preview_path=preview,
        source_format="JPEG",
        image_width=800,
        image_height=600,
        retention_seconds=-1,
    )

    removed = store.pop_expired()

    assert [record.id for record in removed] == ["expired"]
    assert store.get_job("expired") is None
