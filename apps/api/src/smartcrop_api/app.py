from __future__ import annotations

import asyncio
import hmac
import json
import shutil
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError
from smartcrop_contracts import (
    MIN_NORMALIZED_CROP_DIMENSION,
    AnalysisIntent,
    ArtifactLinks,
    AspectRatio,
    CropRequest,
    CustomRatio,
    ErrorDetail,
    JobMode,
    JobResponse,
    JobStatus,
    OutputTemplate,
    SceneType,
)
from smartcrop_image_core import (
    ImageValidationError,
    crop_matches_ratio,
    crop_original,
    crop_pixel_size,
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
    report_download_supported: bool = True
    p0_capability_status: str


def _progress_message(record: JobRecord, queue_position: int | None) -> str:
    if record.status == JobStatus.QUEUED:
        return f"正在排队，前方还有 {max((queue_position or 1) - 1, 0)} 个任务"
    if record.status == JobStatus.RUNNING:
        return (
            "Venus 正在复评最终成片"
            if record.mode == JobMode.REVIEW
            else "Venus 正在分析构图与画面关系"
        )
    if record.status == JobStatus.SUCCEEDED:
        return "分析完成"
    if record.status == JobStatus.FAILED:
        return "分析失败"
    if record.status == JobStatus.CANCELLED:
        return "任务已取消"
    return "任务已过期"


def _capability_status(settings: Settings) -> str:
    if settings.worker_backend == "mock":
        return "mock"
    return "verified" if settings.p0_capabilities_verified else "unverified"


def _ensure_ratio_is_feasible(intent: AnalysisIntent, image_width: int, image_height: int) -> None:
    ratio = intent.ratio_components
    if ratio is None:
        return
    normalized_ratio = (ratio[0] / ratio[1]) * image_height / image_width
    if not (
        MIN_NORMALIZED_CROP_DIMENSION
        <= normalized_ratio
        <= 1 / MIN_NORMALIZED_CROP_DIMENSION
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"原图宽高与目标比例 {intent.resolved_aspect_ratio} 差异过大，"
                "无法保留最小有效裁剪区域"
            ),
        )


def _processing_duration_ms(record: JobRecord) -> int | None:
    if record.started_at is None or record.completed_at is None:
        return None
    return max(0, round((record.completed_at - record.started_at).total_seconds() * 1000))


def _crop_matches(left, right, epsilon: float = 1e-4) -> bool:
    if left is None or right is None:
        return False
    return all(
        abs(getattr(left, field) - getattr(right, field)) <= epsilon
        for field in ("x", "y", "width", "height")
    )


def _plan_payload(record: JobRecord, settings: Settings) -> dict:
    output_width = output_height = None
    ratio_compliant = None
    if record.final_crop is not None:
        output_width, output_height = crop_pixel_size(
            record.image_width,
            record.image_height,
            record.final_crop,
        )
        ratio_compliant = crop_matches_ratio(
            record.image_width,
            record.image_height,
            record.final_crop,
            record.intent.ratio_components,
        )
    initial_report = record.report.model_dump(mode="json") if record.report else None
    return {
        "schema_version": "1.2",
        "job_id": record.id,
        "intent": record.intent.model_dump(mode="json"),
        "selection_mode": "human" if record.selection_confirmed else "unconfirmed",
        "selection_confirmed": record.selection_confirmed,
        "selected_candidate_id": record.selected_candidate_id,
        "selection_reasons": [reason.value for reason in record.selection_reasons],
        "selection_note": record.selection_note,
        "manual_adjusted": record.manual_adjusted,
        "processing_duration_ms": _processing_duration_ms(record),
        "final_crop": record.final_crop.model_dump() if record.final_crop else None,
        "initial_report": initial_report,
        "report": initial_report,
        "capability_status": _capability_status(settings),
        "provenance": "runtime",
        "output": {
            "source_size": {"width": record.image_width, "height": record.image_height},
            "crop_size": {"width": output_width, "height": output_height},
            "requested_ratio": record.intent.resolved_aspect_ratio,
            "ratio_compliant": ratio_compliant,
        },
    }


def _job_response(store: JobStore, record: JobRecord, settings: Settings) -> JobResponse:
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
        mode=record.mode,
        parent_job_id=record.parent_job_id,
        intent=record.intent,
        candidates=record.candidates,
        selected_candidate_id=record.selected_candidate_id,
        capability_status=_capability_status(settings),
        ai_crop=record.ai_crop,
        final_crop=record.final_crop,
        manual_adjusted=record.manual_adjusted,
        manual_only=record.manual_only,
        selection_confirmed=record.selection_confirmed,
        selection_reasons=record.selection_reasons,
        selection_note=record.selection_note,
        processing_duration_ms=_processing_duration_ms(record),
        report=record.report,
        artifacts=ArtifactLinks(
            preview=f"/v1/jobs/{record.id}/artifacts/preview",
            crop=(f"/v1/jobs/{record.id}/artifacts/crop" if record.crop_path else None),
            plan=(f"/v1/jobs/{record.id}/artifacts/plan" if record.mode == JobMode.CROP else None),
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
            p0_capability_status=_capability_status(resolved),
        )

    @app.post(
        "/v1/jobs",
        response_model=JobResponse,
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[access_dependency],
    )
    async def create_job(
        file: Annotated[UploadFile, File(...)],
        scene: Annotated[SceneType, Form()] = SceneType.GENERAL,
        aspect_ratio: Annotated[AspectRatio, Form()] = AspectRatio.FREE,
        output_template: Annotated[OutputTemplate | None, Form()] = None,
        custom_ratio_width: Annotated[int | None, Form()] = None,
        custom_ratio_height: Annotated[int | None, Form()] = None,
    ) -> JobResponse:
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
            if (custom_ratio_width is None) != (custom_ratio_height is None):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="自定义比例的宽和高必须同时填写",
                )
            try:
                custom_ratio = (
                    CustomRatio(width=custom_ratio_width, height=custom_ratio_height)
                    if custom_ratio_width is not None and custom_ratio_height is not None
                    else None
                )
                intent = AnalysisIntent(
                    scene=scene,
                    aspect_ratio=aspect_ratio,
                    output_template=output_template,
                    custom_ratio=custom_ratio,
                )
            except ValidationError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc.errors()[0]["msg"]),
                ) from exc
            _ensure_ratio_is_feasible(intent, decoded.width, decoded.height)
            record = await asyncio.to_thread(
                store.create_job,
                job_id=job_id,
                input_path=input_path,
                preview_path=preview_path,
                source_format=decoded.source_format,
                image_width=decoded.width,
                image_height=decoded.height,
                retention_seconds=resolved.retention_seconds,
                intent=intent,
            )
        except Exception:
            await asyncio.to_thread(shutil.rmtree, job_dir, True)
            raise
        return _job_response(store, record, resolved)

    @app.get("/v1/jobs/{job_id}", response_model=JobResponse, dependencies=[access_dependency])
    async def get_job(job_id: str) -> JobResponse:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        return _job_response(store, record, resolved)

    @app.post(
        "/v1/jobs/{job_id}/crop",
        response_model=JobResponse,
        dependencies=[access_dependency],
    )
    async def update_crop(job_id: str, request: CropRequest) -> JobResponse:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        if record.mode != JobMode.CROP:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="复评任务不可裁剪")
        if record.status not in {JobStatus.SUCCEEDED, JobStatus.FAILED}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="任务尚未进入可裁剪状态",
            )
        if not crop_matches_ratio(
            record.image_width,
            record.image_height,
            request.crop,
            record.intent.ratio_components,
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"裁剪框不符合目标比例 {record.intent.resolved_aspect_ratio}",
            )

        suffix = ".png" if record.input_path.suffix.lower() == ".png" else ".jpg"
        crop_path = record.input_path.parent / f"crop{suffix}"
        await asyncio.to_thread(crop_original, record.input_path, request.crop, crop_path)
        reference_crop = next(
            (
                candidate.crop
                for candidate in record.candidates
                if candidate.id == request.candidate_id
            ),
            record.ai_crop,
        )
        updated_crop = await asyncio.to_thread(
            store.update_manual_crop,
            job_id,
            request.crop,
            crop_path,
            request.candidate_id,
            request.selection_reasons,
            request.selection_note,
            not _crop_matches(reference_crop, request.crop),
        )
        if not updated_crop:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="任务状态已变化，请刷新后重试",
            )
        updated = await asyncio.to_thread(store.get_job, job_id)
        if updated is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务已过期")
        return _job_response(store, updated, resolved)

    @app.post(
        "/v1/jobs/{job_id}/review",
        response_model=JobResponse,
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[access_dependency],
    )
    async def create_review(job_id: str) -> JobResponse:
        if store.count_queued() >= resolved.queue_limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="当前排队任务已满，请稍后重试",
                headers={"Retry-After": "30"},
            )
        parent = await asyncio.to_thread(store.get_job, job_id)
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        if (
            parent.mode != JobMode.CROP
            or parent.status != JobStatus.SUCCEEDED
            or not parent.crop_path
        ):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="请先保存最终裁剪")
        if not parent.crop_path.exists():
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="最终裁剪已被清理")

        review_id = uuid.uuid4().hex
        review_dir = resolved.jobs_dir / review_id
        try:
            content_type = (
                "image/png" if parent.crop_path.suffix.lower() == ".png" else "image/jpeg"
            )
            payload = await asyncio.to_thread(parent.crop_path.read_bytes)
            decoded = await asyncio.to_thread(
                decode_image,
                payload,
                content_type,
                max(len(payload), resolved.max_upload_bytes),
            )
            input_path = await asyncio.to_thread(save_normalized_original, decoded, review_dir)
            preview_path = await asyncio.to_thread(save_preview, decoded, review_dir)
            review = await asyncio.to_thread(
                store.create_job,
                job_id=review_id,
                input_path=input_path,
                preview_path=preview_path,
                source_format=decoded.source_format,
                image_width=decoded.width,
                image_height=decoded.height,
                retention_seconds=resolved.retention_seconds,
                intent=parent.intent,
                mode=JobMode.REVIEW,
                parent_job_id=parent.id,
            )
        except Exception:
            await asyncio.to_thread(shutil.rmtree, review_dir, True)
            raise
        return _job_response(store, review, resolved)

    @app.get(
        "/v1/jobs/{job_id}/artifacts/{artifact}",
        dependencies=[access_dependency],
    )
    async def get_artifact(job_id: str, artifact: str) -> Response:
        record = await asyncio.to_thread(store.get_job, job_id)
        if record is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在或已过期")
        if artifact == "preview":
            path = record.preview_path
            filename = None
        elif artifact == "crop" and record.crop_path:
            path = record.crop_path
            filename = f"SmartCrop_{job_id}{record.crop_path.suffix.lower()}"
        elif artifact == "plan" and record.mode == JobMode.CROP:
            body = _plan_payload(record, resolved)
            return Response(
                content=json.dumps(body, ensure_ascii=False, indent=2),
                media_type="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="SmartCrop_{job_id}_plan.json"',
                    "Cache-Control": "private, no-store",
                },
            )
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
