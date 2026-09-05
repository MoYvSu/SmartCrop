from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class JobMode(str, Enum):
    CROP = "crop"
    REVIEW = "review"


class SceneType(str, Enum):
    GENERAL = "general"
    PORTRAIT = "portrait"
    LANDSCAPE = "landscape"
    PRODUCT = "product"
    SOCIAL = "social"


class AspectRatio(str, Enum):
    FREE = "free"
    SQUARE = "1:1"
    PORTRAIT_4_5 = "4:5"
    PORTRAIT_3_4 = "3:4"
    LANDSCAPE_16_9 = "16:9"


class AnalysisIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene: SceneType = SceneType.GENERAL
    aspect_ratio: AspectRatio = AspectRatio.FREE


class CropBox(BaseModel):
    """A normalized crop box. Every coordinate is relative to the oriented source image."""

    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_bounds(self) -> CropBox:
        epsilon = 1e-6
        if self.x + self.width > 1.0 + epsilon:
            raise ValueError("crop box exceeds the image width")
        if self.y + self.height > 1.0 + epsilon:
            raise ValueError("crop box exceeds the image height")
        if self.width < 0.02 or self.height < 0.02:
            raise ValueError("crop box is too small")
        return self

    @classmethod
    def from_xyxy_1000(cls, values: list[float]) -> CropBox:
        if len(values) != 4:
            raise ValueError("expected four crop coordinates")
        x1, y1, x2, y2 = (max(0.0, min(float(value), 1000.0)) / 1000 for value in values)
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        return cls(x=left, y=top, width=right - left, height=bottom - top)


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overview: str = Field(min_length=1, max_length=1200)
    strengths: list[str] = Field(min_length=1, max_length=5)
    issues: list[str] = Field(min_length=1, max_length=5)
    crop_rationale: str = Field(min_length=1, max_length=1200)
    shooting_tips: list[str] = Field(min_length=1, max_length=5)
    language: Literal["en", "zh-CN"] = "en"
    translation_provider: Literal["deepseek"] | None = None


class CropCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Literal["balanced", "subject", "story"]
    crop: CropBox


class ErrorDetail(BaseModel):
    code: str
    message: str


class ArtifactLinks(BaseModel):
    preview: str | None = None
    crop: str | None = None
    plan: str | None = None


class JobResponse(BaseModel):
    id: str
    status: JobStatus
    queue_position: int | None = None
    progress_message: str
    created_at: datetime
    expires_at: datetime
    image_width: int
    image_height: int
    mode: JobMode = JobMode.CROP
    parent_job_id: str | None = None
    intent: AnalysisIntent = Field(default_factory=AnalysisIntent)
    candidates: list[CropCandidate] = Field(default_factory=list, max_length=3)
    selected_candidate_id: Literal["balanced", "subject", "story"] | None = None
    capability_status: Literal["mock", "unverified", "verified"] = "unverified"
    ai_crop: CropBox | None = None
    final_crop: CropBox | None = None
    manual_adjusted: bool = False
    manual_only: bool = False
    report: Report | None = None
    artifacts: ArtifactLinks
    error: ErrorDetail | None = None


class CropRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    crop: CropBox
    candidate_id: Literal["balanced", "subject", "story"] | None = None
