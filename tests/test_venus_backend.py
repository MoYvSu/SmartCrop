import pytest
from smartcrop_worker.backends.venus import (
    _extract_crop_box,
    _normalize_report_payload,
)


def test_extract_crop_box_supports_upstream_coordinate_pairs() -> None:
    crop = _extract_crop_box("The bounding box is (120, 80), (900, 760).")

    assert crop.model_dump() == pytest.approx(
        {"x": 0.12, "y": 0.08, "width": 0.78, "height": 0.68}
    )


def test_extract_crop_box_supports_legacy_array() -> None:
    crop = _extract_crop_box("[100, 200, 800, 900]")

    assert crop.model_dump() == pytest.approx(
        {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.7}
    )


def test_normalize_report_payload_flattens_model_variants() -> None:
    payload = _normalize_report_payload(
        {
            "整体观察": "主体明确。",
            "strengths": [["层次清楚。"], "色彩统一。"],
            "problems": "边缘略显拥挤。",
            "crop_reason": "收拢边缘以突出主体。",
            "suggestions": [["拍摄时留意背景。"]],
            "ignored": "not part of the contract",
        }
    )

    assert payload == {
        "overview": "主体明确。",
        "strengths": ["层次清楚。", "色彩统一。"],
        "issues": ["边缘略显拥挤。"],
        "crop_rationale": "收拢边缘以突出主体。",
        "shooting_tips": ["拍摄时留意背景。"],
    }
