from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from smartcrop_contracts import CropBox
from smartcrop_image_core import (
    ImageValidationError,
    crop_matches_ratio,
    crop_original,
    crop_pixel_size,
    decode_image,
    save_normalized_original,
)


def test_decode_and_crop_preserves_original_resolution(jpeg_bytes: bytes, tmp_path: Path) -> None:
    decoded = decode_image(jpeg_bytes, "image/jpeg", max_bytes=20 * 1024 * 1024)
    original = save_normalized_original(decoded, tmp_path)
    crop_path = crop_original(
        original,
        CropBox(x=0.25, y=0.25, width=0.5, height=0.5),
    )

    with Image.open(crop_path) as result:
        assert result.size == (400, 300)


def test_alpha_input_is_normalized_as_png(png_bytes: bytes, tmp_path: Path) -> None:
    decoded = decode_image(png_bytes, "image/png", max_bytes=20 * 1024 * 1024)
    original = save_normalized_original(decoded, tmp_path)
    assert original.suffix == ".png"


def test_content_type_and_payload_are_both_validated(jpeg_bytes: bytes) -> None:
    with pytest.raises(ImageValidationError, match="仅支持"):
        decode_image(jpeg_bytes, "text/plain", max_bytes=20 * 1024 * 1024)

    with pytest.raises(ImageValidationError, match="无法解码"):
        decode_image(b"not an image", "image/jpeg", max_bytes=20 * 1024 * 1024)


def test_crop_metrics_use_same_pixel_rounding_as_artifact() -> None:
    crop = CropBox(x=0.1, y=0.1, width=0.7, height=0.7)

    assert crop_pixel_size(801, 601, crop) == (561, 421)
    assert crop_matches_ratio(801, 601, crop, (4, 3))
    assert not crop_matches_ratio(801, 601, crop, (1, 1))
