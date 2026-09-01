from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from smartcrop_contracts import CropBox, JobStatus, Report


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def from_iso(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


@dataclass
class JobRecord:
    id: str
    status: JobStatus
    input_path: Path
    preview_path: Path
    crop_path: Path | None
    source_format: str
    image_width: int
    image_height: int
    ai_crop: CropBox | None
    final_crop: CropBox | None
    report: Report | None
    manual_adjusted: bool
    manual_only: bool
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    expires_at: datetime


class JobStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    input_path TEXT NOT NULL,
                    preview_path TEXT NOT NULL,
                    crop_path TEXT,
                    source_format TEXT NOT NULL,
                    image_width INTEGER NOT NULL,
                    image_height INTEGER NOT NULL,
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
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                    ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_jobs_expires
                    ON jobs(expires_at);
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            if "manual_only" not in columns:
                connection.execute(
                    "ALTER TABLE jobs ADD COLUMN manual_only INTEGER NOT NULL DEFAULT 0"
                )

    def create_job(
        self,
        *,
        job_id: str,
        input_path: Path,
        preview_path: Path,
        source_format: str,
        image_width: int,
        image_height: int,
        retention_seconds: int,
    ) -> JobRecord:
        now = utc_now()
        expires_at = now + timedelta(seconds=retention_seconds)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (
                    id, status, input_path, preview_path, source_format,
                    image_width, image_height, created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    JobStatus.QUEUED.value,
                    str(input_path),
                    str(preview_path),
                    source_format,
                    image_width,
                    image_height,
                    to_iso(now),
                    to_iso(now),
                    to_iso(expires_at),
                ),
            )
        record = self.get_job(job_id)
        if record is None:
            raise RuntimeError("failed to create job")
        return record

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_record(row) if row else None

    def count_queued(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE status = ?",
                (JobStatus.QUEUED.value,),
            ).fetchone()
        return int(row["count"])

    def get_running(self) -> JobRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM jobs
                WHERE status = ?
                ORDER BY started_at ASC
                LIMIT 1
                """,
                (JobStatus.RUNNING.value,),
            ).fetchone()
        return self._row_to_record(row) if row else None

    def queue_position(self, job_id: str) -> int | None:
        record = self.get_job(job_id)
        if record is None or record.status != JobStatus.QUEUED:
            return None
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count FROM jobs
                WHERE status = ? AND created_at <= ?
                """,
                (JobStatus.QUEUED.value, to_iso(record.created_at)),
            ).fetchone()
        return int(row["count"])

    def claim_next(self) -> JobRecord | None:
        now = utc_now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT id FROM jobs
                WHERE status = ?
                ORDER BY created_at ASC
                LIMIT 1
                """,
                (JobStatus.QUEUED.value,),
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            job_id = str(row["id"])
            updated = connection.execute(
                """
                UPDATE jobs SET status = ?, started_at = ?, updated_at = ?
                WHERE id = ? AND status = ?
                """,
                (
                    JobStatus.RUNNING.value,
                    to_iso(now),
                    to_iso(now),
                    job_id,
                    JobStatus.QUEUED.value,
                ),
            ).rowcount
            connection.commit()
        return self.get_job(job_id) if updated else None

    def complete_job(
        self,
        job_id: str,
        *,
        report: Report,
        ai_crop: CropBox,
        crop_path: Path,
    ) -> bool:
        now = utc_now()
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE jobs SET
                    status = ?, report_json = ?, ai_crop_json = ?, final_crop_json = ?,
                    crop_path = ?, manual_adjusted = 0, completed_at = ?, updated_at = ?,
                    error_code = NULL, error_message = NULL, manual_only = 0
                WHERE id = ? AND status = ?
                """,
                (
                    JobStatus.SUCCEEDED.value,
                    report.model_dump_json(),
                    ai_crop.model_dump_json(),
                    ai_crop.model_dump_json(),
                    str(crop_path),
                    to_iso(now),
                    to_iso(now),
                    job_id,
                    JobStatus.RUNNING.value,
                ),
            )
        return result.rowcount == 1

    def fail_job(self, job_id: str, code: str, message: str) -> bool:
        now = utc_now()
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE jobs SET status = ?, error_code = ?, error_message = ?,
                    completed_at = ?, updated_at = ?
                WHERE id = ? AND status IN (?, ?)
                """,
                (
                    JobStatus.FAILED.value,
                    code,
                    message[:1000],
                    to_iso(now),
                    to_iso(now),
                    job_id,
                    JobStatus.QUEUED.value,
                    JobStatus.RUNNING.value,
                ),
            )
        return result.rowcount == 1

    def update_manual_crop(self, job_id: str, crop: CropBox, crop_path: Path) -> bool:
        now = utc_now()
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE jobs SET status = ?, final_crop_json = ?, crop_path = ?,
                    manual_adjusted = 1,
                    manual_only = CASE WHEN report_json IS NULL THEN 1 ELSE manual_only END,
                    completed_at = COALESCE(completed_at, ?), updated_at = ?
                WHERE id = ? AND status IN (?, ?)
                """,
                (
                    JobStatus.SUCCEEDED.value,
                    crop.model_dump_json(),
                    str(crop_path),
                    to_iso(now),
                    to_iso(now),
                    job_id,
                    JobStatus.SUCCEEDED.value,
                    JobStatus.FAILED.value,
                ),
            )
        return result.rowcount == 1

    def expire_stale_running(self, timeout_seconds: int) -> int:
        threshold = utc_now() - timedelta(seconds=timeout_seconds)
        now = utc_now()
        with self._connect() as connection:
            result = connection.execute(
                """
                UPDATE jobs SET status = ?, error_code = ?, error_message = ?,
                    completed_at = ?, updated_at = ?
                WHERE status = ? AND started_at < ?
                """,
                (
                    JobStatus.FAILED.value,
                    "inference_timeout",
                    "模型推理超过允许时间，请稍后重试",
                    to_iso(now),
                    to_iso(now),
                    JobStatus.RUNNING.value,
                    to_iso(threshold),
                ),
            )
        return result.rowcount

    def pop_expired(self) -> list[JobRecord]:
        now = to_iso(utc_now())
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM jobs WHERE expires_at <= ?",
                (now,),
            ).fetchall()
            if rows:
                connection.executemany(
                    "DELETE FROM jobs WHERE id = ?",
                    [(row["id"],) for row in rows],
                )
        return [self._row_to_record(row) for row in rows]

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> JobRecord:
        ai_crop = CropBox.model_validate_json(row["ai_crop_json"]) if row["ai_crop_json"] else None
        final_crop = (
            CropBox.model_validate_json(row["final_crop_json"])
            if row["final_crop_json"]
            else None
        )
        report = Report.model_validate_json(row["report_json"]) if row["report_json"] else None
        return JobRecord(
            id=row["id"],
            status=JobStatus(row["status"]),
            input_path=Path(row["input_path"]),
            preview_path=Path(row["preview_path"]),
            crop_path=Path(row["crop_path"]) if row["crop_path"] else None,
            source_format=row["source_format"],
            image_width=int(row["image_width"]),
            image_height=int(row["image_height"]),
            ai_crop=ai_crop,
            final_crop=final_crop,
            report=report,
            manual_adjusted=bool(row["manual_adjusted"]),
            manual_only=bool(row["manual_only"]),
            error_code=row["error_code"],
            error_message=row["error_message"],
            created_at=from_iso(row["created_at"]),
            updated_at=from_iso(row["updated_at"]),
            started_at=from_iso(row["started_at"]),
            completed_at=from_iso(row["completed_at"]),
            expires_at=from_iso(row["expires_at"]),
        )
