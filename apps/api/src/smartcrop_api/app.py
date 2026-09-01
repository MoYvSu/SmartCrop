from __future__ import annotations

import asyncio
import hmac
import shutil
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from smartcrop_contracts import (
    ArtifactLinks,
    CropRequest,
    ErrorDetail,
    JobResponse,
    JobStatus,
)
from smartcrop_image_core import (
    ImageValidationError,
    crop_original,
    decode_image,
    save_normalized_original,
    save_preview,
)
from smartcrop_runtime import JobRecord, JobStore, Settings

ACCESS_HEADER = "X-SmartCrop-Access"


class PublicConfig(BaseModel):
    max_upload_bytes: int
    supported_types: list[str]
    retention_seconds: int
    mobile_supported: bool = False
    report_download_supported: bool = False


def _progress_message(record: JobRecord, queue_position: int | None) -> str:
    if record.status == JobStatus.QUEUED:
        return f"正在排队，前方还有 {max((queue_position or 1) - 1, 0)} 个任务"
    if record.status == JobStatus.RUNNING:
        return "Venus 正在分析构图与画面关系"
    if record.status == JobStatus.SUCCEEDED:
        return "分析完成"
    if record.status == JobStatus.FAILED:
        return "分析失败"
    if record.status == JobStatus.CANCELLED:
        return "任务已取消"
    return "任务已过期"


def _job_response(store: JobStore, record: JobRecord) -> JobResponse:
    position = store.queue_position(record.id)
    return JobResponse(
        id=record.id,
        status=record.status,
        queue_position=position,
        progress_message=_progress_message(record, position),
        created_at=record.created_at,
        expires_at=record.expires_at,
        image_width=record.image_width,
        image_height=record.image_height,
        ai_crop=record.ai_crop,
        final_crop=record.final_crop,
        manual_adjusted=record.manual_adjusted,
        manual_only=record.manual_only,
        report=record.report,
        artifacts=ArtifactLinks(
            preview=f"/v1/jobs/{record.id}/artifacts/preview",
            crop=(f"/v1/jobs/{record.id}/artifacts/crop" if record.crop_path else None),
        ),
        error=(
            ErrorDetail(
                code=record.error_code or "unknown",
                message=record.error_message or "未知错误",
            )
            if record.error_code and (record.status == JobStatus.FAILED or record.manual_only)
            else None
        ),
    )


def _remove_job_directory(record: JobRecord, jobs_root: Path) -> None:
    root = jobs_root.resolve()
    job_dir = record.input_path.parent.resolve()
    if job_dir.parent != root:
        return
    shutil.rmtree(job_dir, ignore_errors=True)


async def _read_upload(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > max_bytes:
            raise ImageValidationError(f"图片不能超过 {max_bytes // 1024 // 1024} MB")
        chunks.append(chunk)
    return b"".join(chunks)


def create_app(settings: Settings | None = None, *, serve_web: bool = True) -> FastAPI:
    resolved = settings or Settings.from_env()
    resolved.ensure_directories()
    store = JobStore(resolved.database_path)
    store.initialize()

    async def cleanup_loop(stop_cleanup: asyncio.Event) -> None:
        while not stop_cleanup.is_set():
            expired = await asyncio.to_thread(store.pop_expired)
            for record in expired:
                await asyncio.to_thread(_remove_job_directory, record, resolved.jobs_dir)
            try:
                await asyncio.wait_for(stop_cleanup.wait(), timeout=60)
            except TimeoutError:
                continue

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        stop_cleanup = asyncio.Event()
        task = asyncio.create_task(cleanup_loop(stop_cleanup))
        try:
            yield
        finally:
            stop_cleanup.set()
            await task

    app = FastAPI(
        title="SmartCrop API",
        version="1.0.0",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.store = store

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob: data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
        )
        if request.url.path.startswith("/v1/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def require_access(
        access_code: Annotated[str | None, Header(alias=ACCESS_HEADER)] = None,
    ) -> None:
        if not resolved.access_code:
            return
        if not access_code or not hmac.compare_digest(access_code, resolved.access_code):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="演示访问码无效",
                headers={"WWW-Authenticate": "SmartCrop-Access"},
            )

    access_dependency = Depends(require_access)

    @app.get("/health/live", tags=["health"])
    async def liveness() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready", tags=["health"])
    async def readiness() -> dict[str, str]:
        store.initialize()
        return {"status": "ready"}

    @app.get("/v1/config", response_model=PublicConfig, dependencies=[access_dependency])
    async def public_config() -> PublicConfig:
        return PublicConfig(
            max_upload_bytes=resolved.max_upload_bytes,
            supported_types=["image/jpeg", "image/png", "image/webp"],
            retention_seconds=resolved.retention_seconds,
        )

    @app.post(
        "/v1/jobs",
        response_model=JobResponse,
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[access_dependency],
    )
    async def create_job(file: Annotated[UploadFile, File(...)]) -> JobResponse:
        if store.count_queued() >= resolved.queue_limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="当前排队任务已满，请稍后重试",
                headers={"Retry-After": "30"},
            )
        try:
            payload = await _read_upload(file, resolved.max_upload_bytes)
            decoded = await asyncio.to_thread(
                decode_image,
                payload,
                file.content_type,
                resolved.max_upload_bytes,
            )
        except ImageValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        finally:
            await file.close()

        job_id = uuid.uuid4().hex
        job_dir = resolved.jobs_dir / job_id
        try:
            input_path = await asyncio.to_thread(save_normalized_original, decoded, job_dir)
            preview_path = await asyncio.to_thread(save_preview, decoded, job_dir)
            record = await asyncio.to_thread(
                store.create_job,
                job_id=job_id,
                input_path=input_path,
                preview_path=preview_path,
                source_format=decoded.source_format,
                image_width=decoded.width,
                image_height=decoded.height,
                retention_seconds=resolved.retention_seconds,
            )
        except Exception:
            await asyncio.to_thread(shutil.rmtree, job_dir, True)
            raise
        return _job_response(store, record)

    @app.get("/v1/jobs/{job_id}", response_model=JobResponse, dependencies=[access_dependency])
    async def get_job(job_id: str) -> JobResponse:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        return _job_response(store, record)

    @app.post(
        "/v1/jobs/{job_id}/crop",
        response_model=JobResponse,
        dependencies=[access_dependency],
    )
    async def update_crop(job_id: str, request: CropRequest) -> JobResponse:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        if record.status not in {JobStatus.SUCCEEDED, JobStatus.FAILED}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="任务尚未进入可裁剪状态",
            )

        suffix = ".png" if record.input_path.suffix.lower() == ".png" else ".jpg"
        crop_path = record.input_path.parent / f"crop{suffix}"
        await asyncio.to_thread(crop_original, record.input_path, request.crop, crop_path)
        updated_crop = await asyncio.to_thread(
            store.update_manual_crop,
            job_id,
            request.crop,
            crop_path,
        )
        if not updated_crop:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="任务状态已变化，请刷新后重试",
            )
        updated = await asyncio.to_thread(store.get_job, job_id)
        if updated is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务已过期")
        return _job_response(store, updated)

    @app.get(
        "/v1/jobs/{job_id}/artifacts/{artifact}",
        dependencies=[access_dependency],
        response_class=FileResponse,
    )
    async def get_artifact(job_id: str, artifact: str) -> FileResponse:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        if artifact == "preview":
            path = record.preview_path
            filename = None
        elif artifact == "crop" and record.crop_path:
            path = record.crop_path
            filename = f"SmartCrop_{job_id}{record.crop_path.suffix.lower()}"
        else:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="制品不存在")
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="制品已被清理")
        return FileResponse(
            path,
            filename=filename,
            media_type="image/png" if path.suffix.lower() == ".png" else "image/jpeg",
            headers={"Cache-Control": "private, no-store"},
        )

    if serve_web and resolved.web_dist.is_dir():
        assets = resolved.web_dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> FileResponse:
            candidate = (resolved.web_dist / path).resolve()
            if candidate.is_file() and candidate.is_relative_to(resolved.web_dist):
                return FileResponse(candidate)
            return FileResponse(resolved.web_dist / "index.html")

    return app
