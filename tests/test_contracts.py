from __future__ import annotations

import pytest
from pydantic import ValidationError
from smartcrop_contracts import CropBox


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
