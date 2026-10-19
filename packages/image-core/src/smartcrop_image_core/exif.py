from __future__ import annotations

import math
import unicodedata
from numbers import Real

from PIL import ExifTags, Image

# Deliberately exclude GPS, timestamps, serial numbers, author and MakerNote.
_TEXT_TAGS = {
    "camera_make": ExifTags.Base.Make,
    "camera_model": ExifTags.Base.Model,
    "lens_model": ExifTags.Base.LensModel,
}
_NUMBER_TAGS = {
    "focal_length_mm": (ExifTags.Base.FocalLength, 20_000),
    "aperture": (ExifTags.Base.FNumber, 1_024),
    "exposure_seconds": (ExifTags.Base.ExposureTime, 86_400),
    "iso": (ExifTags.Base.ISOSpeedRatings, 10_000_000),
}


def _text(value: object) -> str | None:
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(value, str):
        return None
    # Exif strings often have trailing NULs. Also remove bidi/control characters
    # before sending a short display label to the browser.
    visible = "".join(
        " " if character.isspace() else character
        for character in value
        if not unicodedata.category(character).startswith("C") or character.isspace()
    )
    return " ".join(visible.split())[:160] or None


def _number(value: object, maximum: int) -> int | float | None:
    # Do not interpret arbitrary strings, bools, arrays or custom objects as
    # camera measurements. Pillow's IFDRational implements numbers.Real.
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError, ZeroDivisionError):
        return None
    if not math.isfinite(number) or not 0 < number <= maximum:
        return None
    return int(number) if number.is_integer() else number


def extract_camera_exif(image: Image.Image) -> dict[str, str | int | float]:
    """Read a small display-only whitelist; optional metadata must not block import."""
    result: dict[str, str | int | float] = {}
    try:
        primary = image.getexif()
    except Exception:
        # Corrupt metadata is not equivalent to corrupt image pixels.
        return result
    try:
        camera = primary.get_ifd(ExifTags.IFD.Exif)
    except Exception:
        camera = {}

    for key, tag in _TEXT_TAGS.items():
        for source in (primary, camera):
            try:
                value = _text(source.get(tag))
            except Exception:
                continue
            if value is not None:
                result[key] = value
                break
    for key, (tag, maximum) in _NUMBER_TAGS.items():
        for source in (camera, primary):
            try:
                value = _number(source.get(tag), maximum)
            except Exception:
                continue
            if value is not None and (key != "iso" or isinstance(value, int)):
                result[key] = value
                break
    return result
