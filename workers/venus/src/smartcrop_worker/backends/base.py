from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from smartcrop_contracts import AnalysisIntent, CropBox, CropCandidate, Report


@dataclass(frozen=True)
class InferenceResult:
    candidates: list[CropCandidate]
    report: Report

    @property
    def crop(self) -> CropBox:
        return self.candidates[0].crop


class InferenceBackend(Protocol):
    def analyze(self, image_path: Path, intent: AnalysisIntent) -> InferenceResult: ...

    def review(self, image_path: Path, intent: AnalysisIntent) -> Report: ...


PIXEL_ASPECT_RATIOS = {
    "1:1": 1.0,
    "4:5": 4 / 5,
    "3:4": 3 / 4,
    "16:9": 16 / 9,
}


def fit_crop_to_aspect(
    crop: CropBox,
    aspect_ratio: str,
    image_width: int,
    image_height: int,
) -> CropBox:
    """Fit a normalized box to a pixel aspect ratio while retaining its center."""
    pixel_ratio = PIXEL_ASPECT_RATIOS.get(aspect_ratio)
    if pixel_ratio is None:
        return crop
    target = pixel_ratio * image_height / image_width
    width, height = crop.width, crop.height
    if width / height < target:
        height = width / target
    else:
        width = height * target
    center_x = crop.x + crop.width / 2
    center_y = crop.y + crop.height / 2
    x = min(max(center_x - width / 2, 0), 1 - width)
    y = min(max(center_y - height / 2, 0), 1 - height)
    return CropBox(x=x, y=y, width=width, height=height)
