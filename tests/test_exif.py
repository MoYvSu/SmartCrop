from __future__ import annotations

from io import BytesIO

import pytest
from PIL import ExifTags, Image, ImageOps
from PIL.TiffImagePlugin import IFDRational
from smartcrop_image_core import DecodedImage, decode_image
from smartcrop_image_core.exif import extract_camera_exif


def _camera_exif(*, nested: bool = True) -> Image.Exif:
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "Canon"
    exif[ExifTags.Base.Model] = "Canon EOS R6"
    camera = {
        ExifTags.Base.LensModel: "RF 24-105mm F4",
        ExifTags.Base.FocalLength: IFDRational(35, 1),
        ExifTags.Base.FNumber: IFDRational(28, 10),
        ExifTags.Base.ExposureTime: IFDRational(1, 125),
        ExifTags.Base.ISOSpeedRatings: 400,
        ExifTags.Base.BodySerialNumber: "private-camera-serial",
        ExifTags.Base.DateTimeOriginal: "2026:10:19 18:30:00",
        ExifTags.Base.MakerNote: b"private-maker-note",
    }
    if nested:
        exif[ExifTags.IFD.Exif] = camera
    else:
        for tag, value in camera.items():
            exif[tag] = value
    exif[ExifTags.Base.Artist] = "private-author"
    exif[ExifTags.IFD.GPSInfo] = {
        1: "N", 2: (IFDRational(39), IFDRational(1), IFDRational(2)),
        3: "E", 4: (IFDRational(116), IFDRational(3), IFDRational(4)),
    }
    return exif


@pytest.mark.parametrize("source_format", ["JPEG", "PNG", "WEBP"])
@pytest.mark.parametrize("nested", [True, False])
def test_decode_extracts_only_camera_whitelist_from_primary_or_sub_ifd(source_format, nested):
    output = BytesIO()
    Image.new("RGB", (160, 120), "green").save(
        output, format=source_format, exif=_camera_exif(nested=nested),
    )
    mime = "image/jpeg" if source_format == "JPEG" else f"image/{source_format.lower()}"
    decoded = decode_image(output.getvalue(), mime, 1_000_000)
    try:
        assert decoded.exif == {
            "camera_make": "Canon",
            "camera_model": "Canon EOS R6",
            "lens_model": "RF 24-105mm F4",
            "focal_length_mm": 35,
            "aperture": 2.8,
            "exposure_seconds": 0.008,
            "iso": 400,
        }
    finally:
        decoded.image.close()


def test_orientation_and_camera_fields_are_both_read_before_normalization():
    exif = _camera_exif()
    exif[ExifTags.Base.Orientation] = 6
    output = BytesIO()
    Image.new("RGB", (160, 120)).save(output, format="JPEG", exif=exif)
    decoded = decode_image(output.getvalue(), "image/jpeg", 1_000_000)
    try:
        assert (decoded.width, decoded.height) == (120, 160)
        assert decoded.exif["camera_model"] == "Canon EOS R6"
    finally:
        decoded.image.close()


def test_missing_camera_metadata_is_empty_and_decoded_image_default_is_independent(jpeg_bytes):
    decoded = decode_image(jpeg_bytes, "image/jpeg", 1_000_000)
    first = DecodedImage(Image.new("RGB", (1, 1)), "JPEG")
    second = DecodedImage(Image.new("RGB", (1, 1)), "JPEG")
    try:
        assert decoded.exif == {}
        first.exif["camera_model"] = "test"
        assert second.exif == {}
    finally:
        for item in (decoded, first, second):
            item.image.close()


@pytest.mark.parametrize("bad", [
    0, -1, float("nan"), float("inf"), IFDRational(1, 0),
    IFDRational(0, 0), True, "35", (35, 1), [35], {}, object(),
])
def test_invalid_numeric_metadata_is_skipped_without_guessing(bad):
    class Metadata(dict):
        def get_ifd(self, _tag):
            return {
                ExifTags.Base.FocalLength: bad,
                ExifTags.Base.FNumber: bad,
                ExifTags.Base.ExposureTime: bad,
                ExifTags.Base.ISOSpeedRatings: bad,
            }

    class Photo:
        def getexif(self):
            return Metadata({ExifTags.Base.Model: "Camera"})

    assert extract_camera_exif(Photo()) == {"camera_model": "Camera"}


def test_limits_text_and_number_ranges_and_keeps_independently_valid_fields():
    class Metadata(dict):
        def get_ifd(self, _tag):
            return {
                ExifTags.Base.LensModel: object(),
                ExifTags.Base.FocalLength: 20_001,
                ExifTags.Base.FNumber: 1_025,
                ExifTags.Base.ExposureTime: 86_401,
                ExifTags.Base.ISOSpeedRatings: 10_000_001,
            }

    class Photo:
        def getexif(self):
            return Metadata({
                ExifTags.Base.Make: "  Canon\x00\n EOS\u202e ",
                ExifTags.Base.Model: "C" * 200,
                ExifTags.Base.FocalLength: IFDRational(50, 1),
            })

    assert extract_camera_exif(Photo()) == {
        "camera_make": "Canon EOS", "camera_model": "C" * 160, "focal_length_mm": 50,
    }


def test_broken_sub_ifd_does_not_hide_valid_camera_make():
    class Metadata(dict):
        def get_ifd(self, _tag):
            raise ValueError("broken nested metadata")

    class Photo:
        def getexif(self):
            return Metadata({ExifTags.Base.Make: b"Sony\x00"})

    assert extract_camera_exif(Photo()) == {"camera_make": "Sony"}


def test_broken_exif_does_not_prevent_decoding_valid_image_pixels(jpeg_bytes, monkeypatch):
    def broken_metadata(_image):
        raise ValueError("broken EXIF directory")

    monkeypatch.setattr(Image.Image, "getexif", broken_metadata)
    decoded = decode_image(jpeg_bytes, "image/jpeg", 1_000_000)
    try:
        assert (decoded.width, decoded.height) == (800, 600)
        assert decoded.exif == {}
    finally:
        decoded.image.close()


def test_broken_orientation_does_not_discard_readable_camera_fields(jpeg_bytes, monkeypatch):
    def broken_orientation(_image):
        raise ValueError("broken EXIF orientation")

    monkeypatch.setattr(ImageOps, "exif_transpose", broken_orientation)
    decoded = decode_image(jpeg_bytes, "image/jpeg", 1_000_000)
    try:
        assert (decoded.width, decoded.height) == (800, 600)
    finally:
        decoded.image.close()
