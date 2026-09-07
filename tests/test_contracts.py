from __future__ import annotations

import pytest
from pydantic import ValidationError
from smartcrop_contracts import (
    AnalysisIntent,
    AspectRatio,
    CropBox,
    CustomRatio,
    OutputTemplate,
)


def test_crop_box_converts_model_coordinates() -> None:
    crop = CropBox.from_xyxy_1000([100, 200, 900, 800])
    assert crop.x == pytest.approx(0.1)
    assert crop.y == pytest.approx(0.2)
    assert crop.width == pytest.approx(0.8)
    assert crop.height == pytest.approx(0.6)


@pytest.mark.parametrize(
    "payload",
    [
        {"x": 0.9, "y": 0.0, "width": 0.2, "height": 0.5},
        {"x": 0.0, "y": 0.0, "width": 0.01, "height": 0.5},
    ],
)
def test_crop_box_rejects_unsafe_bounds(payload: dict[str, float]) -> None:
    with pytest.raises(ValidationError):
        CropBox.model_validate(payload)


def test_analysis_intent_keeps_legacy_ratio_compatible() -> None:
    intent = AnalysisIntent.model_validate({"scene": "portrait", "aspect_ratio": "4:5"})

    assert intent.aspect_ratio == AspectRatio.PORTRAIT_4_5
    assert intent.output_template is None
    assert intent.ratio_components == (4, 5)


def test_analysis_intent_accepts_valid_custom_ratio() -> None:
    intent = AnalysisIntent(
        aspect_ratio=AspectRatio.CUSTOM,
        output_template=OutputTemplate.CUSTOM,
        custom_ratio=CustomRatio(width=7, height=5),
    )

    assert intent.resolved_aspect_ratio == "7:5"
    assert intent.ratio_components == (7, 5)


@pytest.mark.parametrize(
    "payload",
    [
        {"aspect_ratio": "custom"},
        {"aspect_ratio": "custom", "custom_ratio": {"width": 100, "height": 1}},
        {"aspect_ratio": "1:1", "custom_ratio": {"width": 1, "height": 1}},
        {"aspect_ratio": "4:5", "output_template": "avatar"},
    ],
)
def test_analysis_intent_rejects_inconsistent_output_target(payload: dict) -> None:
    with pytest.raises(ValidationError):
        AnalysisIntent.model_validate(payload)
