from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from smartcrop_contracts import CropBox

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_PIXELS = 50_000_000
MIN_EDGE = 64


class ImageValidationError(ValueError):
    pass


@dataclass
class DecodedImage:
    image: Image.Image
    source_format: str

    @property
    def width(self) -> int:
        return self.image.width

    @property
    def height(self) -> int:
        return self.image.height


def decode_image(data: bytes, content_type: str | None, max_bytes: int) -> DecodedImage:
    if not data:
        raise ImageValidationError("图片文件为空")
    if len(data) > max_bytes:
        raise ImageValidationError(f"图片不能超过 {max_bytes // 1024 // 1024} MB")
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError("仅支持 JPEG、PNG 和 WebP 图片")

    original_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(BytesIO(data)) as opened:
            source_format = (opened.format or "").upper()
            if source_format not in ALLOWED_FORMATS:
                raise ImageValidationError("图片实际格式与支持范围不符")
            opened.load()
            oriented = ImageOps.exif_transpose(opened)
            if oriented.width < MIN_EDGE or oriented.height < MIN_EDGE:
                raise ImageValidationError(f"图片宽高至少为 {MIN_EDGE} 像素")
            if oriented.width * oriented.height > MAX_IMAGE_PIXELS:
                raise ImageValidationError("图片像素数量过大")
            if oriented.mode not in {"RGB", "RGBA"}:
                oriented = oriented.convert("RGBA" if "transparency" in oriented.info else "RGB")
            return DecodedImage(image=oriented.copy(), source_format=source_format)
    except ImageValidationError:
        raise
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ImageValidationError("无法解码该图片，请检查文件是否损坏") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = original_limit


def _has_alpha(image: Image.Image) -> bool:
    return image.mode == "RGBA" and image.getextrema()[3][0] < 255


def save_normalized_original(decoded: DecodedImage, target_dir: Path) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    if _has_alpha(decoded.image):
        path = target_dir / "original.png"
        decoded.image.save(path, format="PNG", optimize=True)
        return path

    path = target_dir / "original.jpg"
    rgb = decoded.image.convert("RGB")
    rgb.save(path, format="JPEG", quality=95, subsampling=0, optimize=True)
    return path


def save_preview(decoded: DecodedImage, target_dir: Path, max_edge: int = 1600) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    preview = decoded.image.convert("RGB")
    preview.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    path = target_dir / "preview.jpg"
    preview.save(path, format="JPEG", quality=88, optimize=True)
    return path


def crop_original(original_path: Path, crop: CropBox, target_path: Path | None = None) -> Path:
    with Image.open(original_path) as opened:
        opened.load()
        image = opened.copy()

    x1 = round(crop.x * image.width)
    y1 = round(crop.y * image.height)
    x2 = round((crop.x + crop.width) * image.width)
    y2 = round((crop.y + crop.height) * image.height)
    x1 = max(0, min(x1, image.width - 1))
    y1 = max(0, min(y1, image.height - 1))
    x2 = max(x1 + 1, min(x2, image.width))
    y2 = max(y1 + 1, min(y2, image.height))
    result = image.crop((x1, y1, x2, y2))

    has_alpha = _has_alpha(result)
    if target_path is None:
        target_path = original_path.parent / ("crop.png" if has_alpha else "crop.jpg")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    temporary = target_path.with_suffix(target_path.suffix + ".tmp")
    if target_path.suffix.lower() == ".png" or has_alpha:
        result.save(temporary, format="PNG", optimize=True)
    else:
        result.convert("RGB").save(
            temporary,
            format="JPEG",
            quality=95,
            subsampling=0,
            optimize=True,
        )
    temporary.replace(target_path)
    return target_path
