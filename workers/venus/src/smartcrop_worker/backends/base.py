from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from smartcrop_contracts import CropBox, Report


@dataclass(frozen=True)
class InferenceResult:
    crop: CropBox
    report: Report


class InferenceBackend(Protocol):
    def analyze(self, image_path: Path) -> InferenceResult: ...
