from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image
from smartcrop_contracts import AnalysisIntent, CropBox, JobStatus
from smartcrop_image_core import (
    crop_matches_ratio,
    crop_original,
    decode_image,
    save_normalized_original,
    save_preview,
)

from .preferences import GuideSettings
from .settings import Settings
from .store import JobRecord, JobStore, to_iso, utc_now

_OPERATIONS = threading.RLock()


class ProjectNotFound(LookupError):
    pass


class ProjectConflict(ValueError):
    pass


class ProjectValidationError(ValueError):
    pass


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _draft_with_guides(draft: dict) -> dict:
    return {**draft, **GuideSettings.model_validate({
        "guides": draft.get("guides", ["thirds"]),
    }).model_dump(mode="json")}


def _snapshot_with_guides(snapshot: dict) -> dict:
    draft = _draft_with_guides(snapshot["draft"])
    return {**snapshot, "guides": draft["guides"], "draft": draft}


def _default_crop(intent: AnalysisIntent, width: int, height: int) -> CropBox:
    ratio = intent.ratio_components
    normalized = ratio[0] / ratio[1] * height / width if ratio else 1.0
    crop_width, crop_height = (1.0, 1 / normalized) if normalized > 1 else (normalized, 1.0)
    try:
        crop = CropBox(
            x=(1 - crop_width) / 2,
            y=(1 - crop_height) / 2,
            width=crop_width,
            height=crop_height,
        )
    except ValueError as exc:
        raise ProjectValidationError("照片与目标比例差异过大，无法形成有效裁剪") from exc
    if not crop_matches_ratio(width, height, crop, ratio):
        raise ProjectValidationError("照片与目标比例无法形成有效裁剪")
    return crop


class ProjectStore:
    """Persistent photos and snapshots, independent of disposable inference jobs."""

    def __init__(self, database_path: Path, data_dir: Path):
        self.database_path = Path(database_path)
        self.projects_dir = Path(data_dir).resolve() / "projects"

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL,
                    revision INTEGER NOT NULL, image_width INTEGER NOT NULL,
                    image_height INTEGER NOT NULL, source_format TEXT NOT NULL,
                    original_name TEXT NOT NULL, preview_name TEXT NOT NULL,
                    intent_json TEXT NOT NULL, draft_json TEXT NOT NULL,
                    published_json TEXT, reference_json TEXT, active_job_id TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_projects_owner_updated
                    ON projects(owner_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS project_versions (
                    project_id TEXT NOT NULL, version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL, PRIMARY KEY(project_id, version)
                );
                CREATE TABLE IF NOT EXISTS project_jobs (
                    job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL,
                    capability_status TEXT NOT NULL, reference_json TEXT,
                    project_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
                );
            """)

    def _directory(self, project_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", project_id):
            raise ProjectNotFound("作品不存在")
        expected = self.projects_dir / project_id
        if expected.resolve() != expected or expected.parent != self.projects_dir:
            raise ProjectValidationError("作品文件目录不合法")
        return expected

    def _asset(self, project_id: str, filename: str) -> Path:
        directory = self._directory(project_id)
        target = directory / filename
        if target.resolve().parent != directory or target.name != filename:
            raise ProjectValidationError("作品文件路径不合法")
        return target

    def _row(self, project_id: str, owner_id: str) -> sqlite3.Row:
        self._directory(project_id)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM projects WHERE id=? AND owner_id=?",
                (project_id, owner_id),
            ).fetchone()
        if row is None:
            raise ProjectNotFound("作品不存在或无权访问")
        return row

    def _detail(self, row: sqlite3.Row) -> dict:
        published = (
            _snapshot_with_guides(json.loads(row["published_json"]))
            if row["published_json"] else None
        )
        draft = _draft_with_guides(json.loads(row["draft_json"]))
        intent = json.loads(row["intent_json"])
        public_published = (
            {k: v for k, v in published.items() if k != "filename"} if published else None
        )
        prefix = f"/v1/projects/{row['id']}/assets"
        return {
            "id": row["id"],
            "title": row["title"],
            "state": "archived" if published else "draft",
            "revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "archived_at": row["archived_at"],
            "image_width": row["image_width"],
            "image_height": row["image_height"],
            "intent": intent,
            "draft": draft,
            "published": public_published,
            "reference": json.loads(row["reference_json"]) if row["reference_json"] else None,
            "active_job_id": row["active_job_id"],
            "source": "upload",
            "exif": {},
            "has_draft_changes": not published
            or (draft != published["draft"] or intent != published["intent"]),
            "original_url": f"{prefix}/original",
            "preview_url": f"{prefix}/preview",
            "crop_url": f"{prefix}/crop",
            "published_url": (
                f"{prefix}/published?version={published['version']}" if published else None
            ),
        }

    def create_project(
        self,
        owner_id: str,
        title: str,
        payload: bytes,
        content_type: str | None,
        max_bytes: int,
        intent: AnalysisIntent,
        guides: list[str] | None = None,
    ) -> dict:
        guide_settings = GuideSettings() if guides is None else GuideSettings(guides=guides)
        project_id = uuid.uuid4().hex
        directory = self._directory(project_id)
        with _OPERATIONS:
            try:
                decoded = decode_image(payload, content_type, max_bytes)
                try:
                    # Copy only pixels. Pillow may otherwise preserve PNG metadata
                    # implicitly; neither GPS nor serial numbers reach persistent assets.
                    clean = Image.new(decoded.image.mode, decoded.image.size)
                    clean.paste(decoded.image)
                    decoded.image.close()
                    decoded.image = clean
                    crop = _default_crop(intent, decoded.width, decoded.height)
                    original = save_normalized_original(decoded, directory)
                    preview = save_preview(decoded, directory)
                    width, height = decoded.width, decoded.height
                finally:
                    decoded.image.close()
                now = to_iso(utc_now())
                draft = {
                    "crop": crop.model_dump(),
                    "selected_candidate_id": None,
                    "selection_reasons": [],
                    "selection_note": None,
                    "selection_explicit": False,
                    "reference_job_id": None,
                    "guides": guide_settings.guides,
                }
                with self._connect() as connection:
                    connection.execute(
                        """INSERT INTO projects (
                            id,owner_id,title,revision,image_width,image_height,source_format,
                            original_name,preview_name,intent_json,draft_json,created_at,updated_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            project_id,
                            owner_id,
                            self._title(title),
                            1,
                            width,
                            height,
                            "PNG" if original.suffix == ".png" else "JPEG",
                            original.name,
                            preview.name,
                            intent.model_dump_json(),
                            _json(draft),
                            now,
                            now,
                        ),
                    )
                    created_row = connection.execute(
                        "SELECT * FROM projects WHERE id=?",
                        (project_id,),
                    ).fetchone()
            except BaseException:
                if directory.exists():
                    shutil.rmtree(directory)
                raise
        return self._detail(created_row)

    @staticmethod
    def _title(value: str) -> str:
        value = value.strip()
        if not value or len(value) > 120 or any(ord(char) < 32 for char in value):
            raise ProjectValidationError("作品名称需为 1 至 120 个可显示字符")
        return value

    def get_project(self, project_id: str, owner_id: str) -> dict:
        with _OPERATIONS:
            row = self._row(project_id, owner_id)
            if row["active_job_id"]:
                try:
                    capture_project_job(self.database_path, row["active_job_id"])
                except Exception as exc:
                    # Optional AI snapshot repair must not invalidate a saved
                    # manual edit or hide its independent persistent assets.
                    logging.getLogger(__name__).warning(
                        "Project reference refresh deferred (%s)",
                        type(exc).__name__,
                    )
                row = self._row(project_id, owner_id)
            return self._detail(row)

    def list_projects(
        self,
        owner_id: str,
        *,
        state: str | None = None,
        search: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        items = []
        skipped = 0
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT * FROM projects WHERE owner_id=? AND title LIKE ?
                ORDER BY updated_at DESC,id DESC""",
                (owner_id, f"%{search}%"),
            )
            for row in rows:
                detail = self._detail(row)
                if state == "archived" and detail["published"] is None:
                    continue
                if state == "draft" and not detail["has_draft_changes"]:
                    continue
                if skipped < max(offset, 0):
                    skipped += 1
                    continue
                items.append({key: value for key, value in detail.items() if key != "reference"})
                # The API validates its page size, and asks for one extra item
                # to detect a following page without a second full-table read.
                if len(items) >= max(limit, 1):
                    break
        return items

    def save_draft(self, project_id: str, owner_id: str, revision: int, changes: dict) -> dict:
        with _OPERATIONS:
            row = self._row(project_id, owner_id)
            if row["revision"] != revision:
                raise ProjectConflict("作品已有新修改，请重新读取后继续；当前修改尚未覆盖")
            intent = AnalysisIntent.model_validate(
                changes.get("intent") or json.loads(row["intent_json"])
            )
            draft = _draft_with_guides(json.loads(row["draft_json"]))
            draft.update({key: value for key, value in changes.items() if key in draft})
            draft = _draft_with_guides(draft)
            crop = CropBox.model_validate(draft["crop"])
            if not crop_matches_ratio(
                row["image_width"], row["image_height"], crop, intent.ratio_components
            ):
                raise ProjectValidationError("裁剪框不符合当前目标比例")
            draft["crop"] = crop.model_dump()
            if draft["selection_note"] is not None:
                draft["selection_note"] = draft["selection_note"].strip() or None
                if draft["selection_note"] and len(draft["selection_note"]) > 200:
                    raise ProjectValidationError("选择说明不能超过 200 字")
            if not draft["selected_candidate_id"]:
                draft["reference_job_id"] = None
            elif "selected_candidate_id" in changes and "reference_job_id" not in changes:
                reference = json.loads(row["reference_json"]) if row["reference_json"] else None
                if (
                    reference
                    and draft["selected_candidate_id"]
                    != json.loads(row["draft_json"])["selected_candidate_id"]
                ):
                    draft["reference_job_id"] = reference["job_id"]
            if draft["reference_job_id"]:
                with self._connect() as connection:
                    linked = connection.execute(
                        "SELECT * FROM project_jobs WHERE job_id=? AND project_id=? AND owner_id=?",
                        (draft["reference_job_id"], project_id, owner_id),
                    ).fetchone()
                if linked is None:
                    raise ProjectValidationError("所选构图参考不属于当前作品")
                reference = (
                    json.loads(linked["reference_json"]) if linked["reference_json"] else None
                )
                if not reference or not any(
                    item["id"] == draft["selected_candidate_id"]
                    for item in reference.get("candidates", [])
                ):
                    raise ProjectValidationError("所选构图参考尚未成功生成")
            elif draft["selected_candidate_id"]:
                raise ProjectValidationError("请先选择当前作品已生成的构图参考")
            title = self._title(changes["title"]) if "title" in changes else row["title"]
            with self._connect() as connection:
                changed = connection.execute(
                    """UPDATE projects SET title=?,intent_json=?,draft_json=?,revision=revision+1,
                    updated_at=? WHERE id=? AND owner_id=? AND revision=?""",
                    (
                        title,
                        intent.model_dump_json(),
                        _json(draft),
                        to_iso(utc_now()),
                        project_id,
                        owner_id,
                        revision,
                    ),
                ).rowcount
                if not changed:
                    raise ProjectConflict("作品已有新修改，请重新读取后继续")
                saved_row = connection.execute(
                    "SELECT * FROM projects WHERE id=?",
                    (project_id,),
                ).fetchone()
        # Read the response snapshot under the same SQL write transaction.
        # A later writer, including another process, must not replace the
        # revision acknowledged by this successful save.
        return self._detail(saved_row)

    def archive(self, project_id: str, owner_id: str, revision: int) -> dict:
        with _OPERATIONS:
            row = self._row(project_id, owner_id)
            if row["revision"] != revision:
                raise ProjectConflict("作品已有新修改，请保存后再归档")
            draft = _draft_with_guides(json.loads(row["draft_json"]))
            original = self._asset(project_id, row["original_name"])
            target = self._asset(project_id, f"published-{uuid.uuid4().hex}{original.suffix}")
            try:
                crop_original(original, CropBox.model_validate(draft["crop"]), target)
                with Image.open(target) as image:
                    image.load()
                    width, height = image.size
                previous = json.loads(row["published_json"]) if row["published_json"] else None
                reference = json.loads(row["reference_json"]) if row["reference_json"] else None
                if draft["reference_job_id"]:
                    with self._connect() as connection:
                        linked = connection.execute(
                            "SELECT reference_json FROM project_jobs "
                            "WHERE job_id=? AND project_id=?",
                            (draft["reference_job_id"], project_id),
                        ).fetchone()
                    if linked and linked["reference_json"]:
                        reference = json.loads(linked["reference_json"])
                now = to_iso(utc_now())
                snapshot = {
                    **draft,
                    "version": previous["version"] + 1 if previous else 1,
                    "created_at": now,
                    "width": width,
                    "height": height,
                    "crop": draft["crop"],
                    "draft": draft,
                    "intent": json.loads(row["intent_json"]),
                    "filename": target.name,
                    "source": "upload",
                    "reference": reference,
                }
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    changed = connection.execute(
                        """UPDATE projects SET published_json=?,archived_at=?,updated_at=?,
                        revision=revision+1 WHERE id=? AND owner_id=? AND revision=?""",
                        (_json(snapshot), now, now, project_id, owner_id, revision),
                    ).rowcount
                    if not changed:
                        raise ProjectConflict("归档时作品已变化，请重新保存后重试")
                    connection.execute(
                        "INSERT INTO project_versions VALUES (?,?,?)",
                        (project_id, snapshot["version"], _json(snapshot)),
                    )
                    archived_row = connection.execute(
                        "SELECT * FROM projects WHERE id=?",
                        (project_id,),
                    ).fetchone()
            except BaseException:
                target.unlink(missing_ok=True)
                target.with_suffix(target.suffix + ".tmp").unlink(missing_ok=True)
                raise
        return self._detail(archived_row)

    def asset_path(
        self,
        project_id: str,
        owner_id: str,
        kind: str,
        revision: int | None = None,
        version: int | None = None,
    ) -> Path:
        with _OPERATIONS:
            row = self._row(project_id, owner_id)
            if kind in {"original", "preview"}:
                target = self._asset(project_id, row[f"{kind}_name"])
            elif kind == "published" and row["published_json"]:
                if version is None:
                    snapshot = json.loads(row["published_json"])
                else:
                    with self._connect() as connection:
                        archived = connection.execute(
                            "SELECT snapshot_json FROM project_versions "
                            "WHERE project_id=? AND version=?",
                            (project_id, version),
                        ).fetchone()
                    if archived is None:
                        raise ProjectNotFound("成片版本不存在")
                    snapshot = json.loads(archived["snapshot_json"])
                target = self._asset(project_id, snapshot["filename"])
            elif kind == "crop":
                if revision is not None and revision != row["revision"]:
                    raise ProjectConflict("草稿已由其他会话更新，请重新读取后再下载")
                original = self._asset(project_id, row["original_name"])
                target = self._asset(project_id, f"draft-{row['revision']}{original.suffix}")
                if not target.exists():
                    crop_original(
                        original,
                        CropBox.model_validate(json.loads(row["draft_json"])["crop"]),
                        target,
                    )
            else:
                raise ProjectNotFound("作品资源不存在")
            if not target.is_file():
                raise ProjectNotFound("作品资源不存在")
            return target

    def versions(self, project_id: str, owner_id: str) -> list[dict]:
        self._row(project_id, owner_id)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT snapshot_json FROM project_versions "
                "WHERE project_id=? ORDER BY version DESC",
                (project_id,),
            ).fetchall()
        return [
            {k: v for k, v in _snapshot_with_guides(json.loads(row[0])).items() if k != "filename"}
            for row in rows
        ]

    def get_job_link(self, job_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM project_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
        return {**dict(row), "deleted": bool(row["project_deleted"])} if row else None

    def start_analysis(
        self,
        project_id: str,
        owner_id: str,
        jobs: JobStore,
        settings: Settings,
        capability_status: str,
    ) -> JobRecord:
        with _OPERATIONS:
            row = self._row(project_id, owner_id)
            if row["active_job_id"]:
                active = jobs.get_job(row["active_job_id"])
                if (
                    active
                    and active.status in {JobStatus.QUEUED, JobStatus.RUNNING}
                    and active.expires_at > utc_now()
                ):
                    return active
            if jobs.count_queued() >= settings.queue_limit:
                raise ProjectConflict("当前排队任务已满，请稍后重试")
            job_id = uuid.uuid4().hex
            directory = settings.jobs_dir / job_id
            if directory.resolve().parent != settings.jobs_dir.resolve():
                raise ProjectValidationError("任务目录不合法")
            original = self._asset(project_id, row["original_name"])
            preview = self._asset(project_id, row["preview_name"])
            pending = {
                "job_id": job_id,
                "status": "queued",
                "candidates": [],
                "ai_crop": None,
                "report": None,
                "capability_status": capability_status,
                "processing_duration_ms": None,
                "error": None,
                "intent": json.loads(row["intent_json"]),
            }
            try:
                directory.mkdir(parents=True)
                job_original, job_preview = directory / original.name, directory / preview.name
                shutil.copyfile(original, job_original)
                shutil.copyfile(preview, job_preview)
                with self._connect() as connection:
                    connection.execute(
                        """INSERT INTO project_jobs
                        (job_id,project_id,owner_id,capability_status,reference_json,created_at)
                        VALUES (?,?,?,?,?,?)""",
                        (
                            job_id,
                            project_id,
                            owner_id,
                            capability_status,
                            _json(pending),
                            to_iso(utc_now()),
                        ),
                    )
                    connection.execute(
                        "UPDATE projects SET active_job_id=?,reference_json=? "
                        "WHERE id=? AND owner_id=?",
                        (job_id, _json(pending), project_id, owner_id),
                    )
                return jobs.create_job(
                    job_id=job_id,
                    input_path=job_original,
                    preview_path=job_preview,
                    source_format=row["source_format"],
                    image_width=row["image_width"],
                    image_height=row["image_height"],
                    retention_seconds=settings.retention_seconds,
                    intent=AnalysisIntent.model_validate_json(row["intent_json"]),
                )
            except BaseException:
                with self._connect() as connection:
                    connection.execute("DELETE FROM project_jobs WHERE job_id=?", (job_id,))
                    connection.execute(
                        """UPDATE projects SET active_job_id=?,reference_json=?
                        WHERE id=? AND active_job_id=?""",
                        (row["active_job_id"], row["reference_json"], project_id, job_id),
                    )
                if directory.exists():
                    shutil.rmtree(directory)
                raise

    def delete_project(self, project_id: str, owner_id: str) -> None:
        with _OPERATIONS:
            self._row(project_id, owner_id)
            directory = self._directory(project_id)
            if directory.exists():
                shutil.rmtree(directory)
            with self._connect() as connection:
                connection.execute("DELETE FROM project_versions WHERE project_id=?", (project_id,))
                connection.execute(
                    "UPDATE project_jobs SET project_deleted=1,reference_json=NULL "
                    "WHERE project_id=?",
                    (project_id,),
                )
                connection.execute(
                    "DELETE FROM projects WHERE id=? AND owner_id=?", (project_id, owner_id)
                )


def capture_project_job(database_path: Path, job_id: str) -> bool:
    """Copy JSON only; inference cleanup cannot invalidate a project's reference."""
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        if not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_jobs'",
        ).fetchone():
            return False
        # Serialize the snapshot read with its write. Otherwise a slower GET
        # that observed "running" could overwrite a worker's succeeded copy.
        connection.execute("BEGIN IMMEDIATE")
        linked = connection.execute(
            "SELECT * FROM project_jobs WHERE job_id=? AND project_deleted=0",
            (job_id,),
        ).fetchone()
        if linked is None:
            return False
        job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        previous = json.loads(linked["reference_json"]) if linked["reference_json"] else {}
        inactive = job is None or (
            job["status"] in {"queued", "running"}
            and datetime.fromisoformat(job["expires_at"]) <= utc_now()
        )
        if inactive:
            reference = previous
            if reference.get("status") in {None, "queued", "running"}:
                reference = {
                    **previous,
                    "job_id": job_id,
                    "status": "expired",
                    "candidates": [],
                    "ai_crop": None,
                    "report": None,
                    "capability_status": linked["capability_status"],
                    "processing_duration_ms": None,
                    "error": {
                        "code": "job_expired",
                        "message": "构图参考任务已过期，仍可继续手动创作",
                    },
                }
            connection.execute(
                "UPDATE project_jobs SET reference_json=? WHERE job_id=?",
                (_json(reference), job_id),
            )
            changed = connection.execute(
                "UPDATE projects SET reference_json=?,active_job_id=NULL "
                "WHERE id=? AND active_job_id=?",
                (_json(reference), linked["project_id"], job_id),
            ).rowcount
            connection.commit()
            return changed == 1
        duration = None
        if job["started_at"] and job["completed_at"]:
            duration = max(
                0,
                round(
                    (
                        datetime.fromisoformat(job["completed_at"])
                        - datetime.fromisoformat(job["started_at"])
                    ).total_seconds()
                    * 1000
                ),
            )
        reference = {
            "job_id": job_id,
            "status": job["status"],
            "candidates": json.loads(job["candidates_json"]) if job["candidates_json"] else [],
            "ai_crop": json.loads(job["ai_crop_json"]) if job["ai_crop_json"] else None,
            "report": json.loads(job["report_json"]) if job["report_json"] else None,
            "capability_status": linked["capability_status"],
            "processing_duration_ms": duration,
            "intent": json.loads(job["intent_json"]) if job["intent_json"] else {},
            "error": {"code": job["error_code"], "message": job["error_message"]}
            if job["error_code"]
            else None,
        }
        connection.execute(
            "UPDATE project_jobs SET reference_json=? WHERE job_id=?",
            (_json(reference), job_id),
        )
        updated = connection.execute(
            "UPDATE projects SET reference_json=? WHERE id=? AND active_job_id=?",
            (_json(reference), linked["project_id"], job_id),
        ).rowcount
        connection.commit()
        return updated == 1
    finally:
        connection.close()
