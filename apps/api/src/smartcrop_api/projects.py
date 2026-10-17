from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from contextlib import suppress
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from smartcrop_contracts import (
    AnalysisIntent,
    AspectRatio,
    CropBox,
    CustomRatio,
    JobResponse,
    OutputTemplate,
    SceneType,
    SelectionReason,
)
from smartcrop_image_core import ImageValidationError
from smartcrop_runtime import JobRecord, JobStore, Settings
from smartcrop_runtime.preferences import CompositionGuide, GuideSettings, PreferenceStore
from smartcrop_runtime.projects import (
    ProjectConflict,
    ProjectNotFound,
    ProjectStore,
    ProjectValidationError,
)


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    crop: CropBox | None = None
    intent: AnalysisIntent | None = None
    selected_candidate_id: Literal["balanced", "subject", "story"] | None = None
    selection_reasons: list[SelectionReason] = Field(default_factory=list, max_length=5)
    selection_note: str | None = Field(default=None, max_length=200)
    selection_explicit: bool = False
    reference_job_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    guides: list[CompositionGuide] | None = Field(default=None, max_length=4)

    @field_validator("guides")
    @classmethod
    def validate_guides(cls, value):
        if value is not None:
            GuideSettings(guides=value)
        return value

    @model_validator(mode="after")
    def non_null_edits(self):
        for field in ("crop", "intent", "title", "guides"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class ArchiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


async def _blocking(function, *args):
    operation = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        with suppress(Exception):
            await asyncio.shield(operation)
        raise


def register_project_routes(
    app: FastAPI,
    settings: Settings,
    job_store: JobStore,
    *,
    job_to_response: Callable[[JobRecord], JobResponse],
    image_operation_slots: asyncio.Semaphore | None = None,
) -> ProjectStore:
    projects = ProjectStore(settings.database_path, settings.data_dir)
    projects.initialize()
    app.state.projects = projects
    preferences = getattr(app.state, "preferences", None)
    if preferences is None:
        preferences = PreferenceStore(settings.database_path)
        preferences.initialize()
    image_slots = image_operation_slots or asyncio.Semaphore(settings.image_decode_concurrency)

    def owner(request: Request, *, write: bool = False) -> str:
        return app.state.auth.require_user(request, write=write).id

    async def run(function, *args, image: bool = False):
        try:
            if image:
                async with image_slots:
                    return await _blocking(function, *args)
            return await _blocking(function, *args)
        except ProjectNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ProjectConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (ProjectValidationError, ImageValidationError, ValidationError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=410, detail="照片资源不可用，请重新选择原图") from exc

    @app.post("/v1/projects", status_code=201, tags=["projects"])
    async def create_project(
        request: Request,
        file: Annotated[UploadFile, File(...)],
        scene: Annotated[SceneType | None, Form()] = None,
        aspect_ratio: Annotated[AspectRatio | None, Form()] = None,
        output_template: Annotated[OutputTemplate | None, Form()] = None,
        custom_ratio_width: Annotated[int | None, Form()] = None,
        custom_ratio_height: Annotated[int | None, Form()] = None,
        title: Annotated[str | None, Form(min_length=1, max_length=120)] = None,
        guides: Annotated[str | None, Form()] = None,
    ) -> dict:
        actor_id = owner(request, write=True)
        try:
            inherit_intent = all(value is None for value in (
                scene, aspect_ratio, output_template, custom_ratio_width, custom_ratio_height,
            ))
            try:
                defaults = (
                    await _blocking(preferences.get, actor_id)
                    if inherit_intent or guides is None else None
                )
            except (ValueError, TypeError) as exc:
                raise HTTPException(422, "无法读取已保存的偏好，请前往摄影档案检查后重试") from exc
            if (custom_ratio_width is None) != (custom_ratio_height is None):
                raise HTTPException(422, "自定义比例宽高必须同时填写")
            try:
                custom = (
                    CustomRatio(width=custom_ratio_width, height=custom_ratio_height)
                    if custom_ratio_width is not None and custom_ratio_height is not None
                    else None
                )
                intent = (
                    AnalysisIntent.model_validate(defaults["intent"])
                    if inherit_intent else AnalysisIntent(
                        scene=scene or SceneType.GENERAL,
                        aspect_ratio=aspect_ratio or AspectRatio.FREE,
                        output_template=output_template,
                        custom_ratio=custom,
                    )
                )
                selected_guides = GuideSettings(guides=(
                    defaults["guides"] if guides is None else json.loads(guides)
                )).guides
            except ValidationError as exc:
                raise HTTPException(422, str(exc.errors()[0]["msg"])) from exc
            except (ValueError, TypeError) as exc:
                raise HTTPException(422, "辅助线设置格式不正确") from exc
            chunks, total = [], 0
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise HTTPException(422, "照片超过允许的上传大小")
                chunks.append(chunk)
            filename = (file.filename or "未命名照片").replace("\\", "/").rsplit("/", 1)[-1]
            return await run(
                projects.create_project,
                actor_id,
                title or filename or "未命名照片",
                b"".join(chunks),
                file.content_type,
                settings.max_upload_bytes,
                intent,
                selected_guides,
                image=True,
            )
        finally:
            await file.close()

    @app.get("/v1/projects", tags=["projects"])
    async def list_projects(
        request: Request,
        state: Literal["draft", "archived"] | None = None,
        search: Annotated[str, Query(max_length=120)] = "",
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict:
        actor_id = owner(request)
        items = await run(
            lambda: projects.list_projects(
                actor_id,
                state=state,
                search=search,
                limit=limit + 1,
                offset=offset,
            )
        )
        return {
            "items": items[:limit],
            "next_offset": offset + limit if len(items) > limit else None,
        }

    @app.get("/v1/projects/{project_id}", tags=["projects"])
    async def get_project(project_id: str, request: Request) -> dict:
        return await run(projects.get_project, project_id, owner(request))

    @app.patch("/v1/projects/{project_id}", tags=["projects"])
    async def save_draft(project_id: str, request: Request, patch: ProjectPatch) -> dict:
        changes = patch.model_dump(exclude_unset=True, mode="json")
        changes.pop("revision")
        return await run(
            projects.save_draft, project_id, owner(request, write=True), patch.revision, changes
        )

    @app.post("/v1/projects/{project_id}/archive", tags=["projects"])
    async def archive(project_id: str, request: Request, body: ArchiveRequest) -> dict:
        return await run(
            projects.archive, project_id, owner(request, write=True), body.revision, image=True
        )

    @app.get("/v1/projects/{project_id}/versions", tags=["projects"])
    async def versions(project_id: str, request: Request) -> dict:
        return {"items": await run(projects.versions, project_id, owner(request))}

    @app.post("/v1/projects/{project_id}/analyze", status_code=202, tags=["projects"])
    async def analyze(project_id: str, request: Request) -> JobResponse:
        capability = (
            "mock"
            if settings.worker_backend == "mock"
            else ("verified" if settings.p0_capabilities_verified else "unverified")
        )
        job = await run(
            projects.start_analysis,
            project_id,
            owner(request, write=True),
            job_store,
            settings,
            capability,
            image=True,
        )
        return job_to_response(job)

    @app.get("/v1/projects/{project_id}/assets/{kind}", tags=["projects"])
    async def asset(
        project_id: str,
        kind: str,
        request: Request,
        revision: Annotated[int | None, Query(ge=1)] = None,
        version: Annotated[int | None, Query(ge=1)] = None,
    ) -> FileResponse:
        actor_id = owner(request)
        # Crop generation is a read-only download operation; it never mutates
        # editing state, so GET still requires ownership but not a CSRF token.
        path = await run(
            projects.asset_path,
            project_id,
            actor_id,
            kind,
            revision,
            version,
            image=kind == "crop",
        )
        download = kind in {"crop", "published"}
        return FileResponse(
            path,
            media_type="image/png" if path.suffix == ".png" else "image/jpeg",
            filename=f"SmartCrop_{project_id[:8]}{path.suffix}" if download else None,
            headers={"Cache-Control": "private, no-store"},
        )

    @app.delete("/v1/projects/{project_id}", status_code=204, tags=["projects"])
    async def delete(project_id: str, request: Request) -> Response:
        await run(projects.delete_project, project_id, owner(request, write=True))
        return Response(status_code=204)

    return projects
