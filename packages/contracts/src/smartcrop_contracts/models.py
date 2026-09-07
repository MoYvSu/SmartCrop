from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MIN_NORMALIZED_CROP_DIMENSION = 0.02


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
    CUSTOM = "custom"


class OutputTemplate(str, Enum):
    FREEFORM = "freeform"
    AVATAR = "avatar"
    SOCIAL_COVER = "social_cover"
    PRODUCT_MAIN = "product_main"
    PRESENTATION = "presentation"
    CUSTOM = "custom"


class CustomRatio(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: int = Field(ge=1, le=100)
    height: int = Field(ge=1, le=100)


class SelectionReason(str, Enum):
    SUBJECT_EMPHASIS = "subject_emphasis"
    CONTEXT_PRESERVATION = "context_preservation"
    VISUAL_BALANCE = "visual_balance"
    PLATFORM_FIT = "platform_fit"
    OTHER = "other"


class AnalysisIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene: SceneType = SceneType.GENERAL
    aspect_ratio: AspectRatio = AspectRatio.FREE
    output_template: OutputTemplate | None = None
    custom_ratio: CustomRatio | None = None

    @model_validator(mode="after")
    def validate_ratio_and_template(self) -> AnalysisIntent:
        if self.aspect_ratio == AspectRatio.CUSTOM and self.custom_ratio is None:
            raise ValueError("custom ratio dimensions are required")
        if self.aspect_ratio != AspectRatio.CUSTOM and self.custom_ratio is not None:
            raise ValueError("custom ratio dimensions require aspect_ratio=custom")
        if self.custom_ratio is not None:
            ratio = self.custom_ratio.width / self.custom_ratio.height
            if not 0.1 <= ratio <= 10:
                raise ValueError("custom ratio must be between 1:10 and 10:1")

        expected_ratios = {
            OutputTemplate.FREEFORM: AspectRatio.FREE,
            OutputTemplate.AVATAR: AspectRatio.SQUARE,
            OutputTemplate.SOCIAL_COVER: AspectRatio.LANDSCAPE_16_9,
            OutputTemplate.PRODUCT_MAIN: AspectRatio.PORTRAIT_4_5,
            OutputTemplate.PRESENTATION: AspectRatio.LANDSCAPE_16_9,
            OutputTemplate.CUSTOM: AspectRatio.CUSTOM,
        }
        if (
            self.output_template is not None
            and self.aspect_ratio != expected_ratios[self.output_template]
        ):
            raise ValueError("output template and aspect ratio do not match")
        return self

    @property
    def resolved_aspect_ratio(self) -> str:
        if self.aspect_ratio == AspectRatio.CUSTOM and self.custom_ratio is not None:
            return f"{self.custom_ratio.width}:{self.custom_ratio.height}"
        return self.aspect_ratio.value

    @property
    def ratio_components(self) -> tuple[int, int] | None:
        if self.custom_ratio is not None:
            return self.custom_ratio.width, self.custom_ratio.height
        return {
            AspectRatio.SQUARE: (1, 1),
            AspectRatio.PORTRAIT_4_5: (4, 5),
            AspectRatio.PORTRAIT_3_4: (3, 4),
            AspectRatio.LANDSCAPE_16_9: (16, 9),
        }.get(self.aspect_ratio)


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
        if (
            self.width < MIN_NORMALIZED_CROP_DIMENSION
            or self.height < MIN_NORMALIZED_CROP_DIMENSION
        ):
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
    capability_status: Literal["not_run", "mock", "unverified", "verified"] = "unverified"
    ai_crop: CropBox | None = None
    final_crop: CropBox | None = None
    manual_adjusted: bool = False
    manual_only: bool = False
    selection_confirmed: bool = False
    selection_reasons: list[SelectionReason] = Field(default_factory=list, max_length=5)
    selection_note: str | None = Field(default=None, max_length=200)
    processing_duration_ms: int | None = Field(default=None, ge=0)
    report: Report | None = None
    artifacts: ArtifactLinks
    error: ErrorDetail | None = None


class CropRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    crop: CropBox
    candidate_id: Literal["balanced", "subject", "story"] | None = None
    selection_reasons: list[SelectionReason] = Field(default_factory=list, max_length=5)
    selection_note: str | None = Field(default=None, max_length=200)
