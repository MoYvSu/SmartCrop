from __future__ import annotations

import sqlite3
from pathlib import Path

from smartcrop_contracts import CropBox, CropCandidate, JobStatus, Report, SelectionReason
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


def test_selection_evidence_round_trips_with_manual_crop(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite3")
    store.initialize()
    _create(store, tmp_path)
    assert store.fail_job("job-1", "inference_failed", "模型错误")
    crop = CropBox(x=0.1, y=0.1, width=0.8, height=0.8)

    assert store.update_manual_crop(
        "job-1",
        crop,
        tmp_path / "job-1" / "crop.jpg",
        selection_reasons=[SelectionReason.PLATFORM_FIT, SelectionReason.VISUAL_BALANCE],
        selection_note="为标题保留右侧空间",
        manual_adjusted=False,
    )
    record = store.get_job("job-1")

    assert record.selection_reasons == [
        SelectionReason.PLATFORM_FIT,
        SelectionReason.VISUAL_BALANCE,
    ]
    assert record.selection_note == "为标题保留右侧空间"
    assert not record.manual_adjusted
    assert record.selection_confirmed


def test_existing_database_gains_selection_evidence_columns(tmp_path: Path) -> None:
    database = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                input_path TEXT NOT NULL,
                preview_path TEXT NOT NULL,
                crop_path TEXT,
                source_format TEXT NOT NULL,
                image_width INTEGER NOT NULL,
                image_height INTEGER NOT NULL,
                mode TEXT NOT NULL DEFAULT 'crop',
                parent_job_id TEXT,
                intent_json TEXT,
                candidates_json TEXT,
                selected_candidate_id TEXT,
                ai_crop_json TEXT,
                final_crop_json TEXT,
                report_json TEXT,
                manual_adjusted INTEGER NOT NULL DEFAULT 0,
                manual_only INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                expires_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO jobs (
                id, status, input_path, preview_path, source_format,
                image_width, image_height, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy",
                "queued",
                str(tmp_path / "legacy" / "original.jpg"),
                str(tmp_path / "legacy" / "preview.jpg"),
                "JPEG",
                800,
                600,
                "2026-09-07T00:00:00+00:00",
                "2026-09-07T00:00:00+00:00",
                "2026-09-07T01:00:00+00:00",
            ),
        )
    connection.close()

    store = JobStore(database)
    store.initialize()
    record = store.get_job("legacy")

    assert record is not None
    assert not record.selection_confirmed
    assert record.selection_reasons == []
    assert record.selection_note is None


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
