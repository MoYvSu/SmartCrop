from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageStat
from smartcrop_contracts import CropBox, Report

from .base import InferenceResult


class MockBackend:
    """Deterministic local backend for contract, UI, and deployment smoke tests."""

    def analyze(self, image_path: Path) -> InferenceResult:
        with Image.open(image_path) as opened:
            opened.load()
            image = opened.convert("RGB")
            width, height = image.size
            mean = ImageStat.Stat(image.resize((32, 32))).mean

        brightness = sum(mean) / 3
        orientation = "横向" if width >= height else "纵向"
        if width >= height:
            crop = CropBox(x=0.07, y=0.10, width=0.86, height=0.80)
        else:
            crop = CropBox(x=0.10, y=0.06, width=0.80, height=0.88)

        light_description = "明快" if brightness >= 145 else "沉静"
        report = Report(
            overview=f"这是一张{orientation}画面，整体光调{light_description}，主体关系清楚。",
            strengths=[
                "画面具有明确的视觉中心，观看路径较为自然。",
                "主要色块之间保持了可辨识的层次。",
            ],
            issues=[
                "画面边缘存在少量分散注意力的空间。",
                "主体与留白的比例仍可进一步收紧。",
            ],
            crop_rationale="建议从四周适度收拢画面，让主体更集中，同时保留必要的环境信息。",
            shooting_tips=[
                "拍摄时可提前检查画面边缘，避免无关元素进入。",
                "尝试让主体与主要留白形成更明确的方向关系。",
            ],
            language="zh-CN",
        )
        return InferenceResult(crop=crop, report=report)
