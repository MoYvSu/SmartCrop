from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image


@pytest.fixture
def jpeg_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (800, 600), (58, 96, 152)).save(output, format="JPEG", quality=92)
    return output.getvalue()


@pytest.fixture
def png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGBA", (320, 240), (60, 120, 180, 128)).save(output, format="PNG")
    return output.getvalue()
