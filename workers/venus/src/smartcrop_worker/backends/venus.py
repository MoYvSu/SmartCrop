from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from PIL import Image
from smartcrop_contracts import AnalysisIntent, CropBox, CropCandidate, Report

from .base import InferenceResult, fit_crop_to_aspect

LOGGER = logging.getLogger("smartcrop.worker.venus")
MAX_GENERATION_ATTEMPTS = 2
CROP_MAX_NEW_TOKENS = 96
REPORT_MAX_NEW_TOKENS = 384

# Venus is trained and evaluated primarily with English instructions. Keep both
# product tasks direct and in English so the model is never asked to translate or
# restructure an earlier free-form response.
CROP_STRATEGIES = {
    "balanced": "a visually balanced composition with clear hierarchy",
    "subject": "a tighter composition that emphasizes the main subject",
    "story": "a wider composition that preserves useful environmental context",
}

SCENE_LABELS = {
    "general": "general photography",
    "portrait": "portrait photography",
    "landscape": "landscape photography",
    "product": "product photography",
    "social": "social-media publishing",
}

OUTPUT_TEMPLATE_LABELS = {
    "freeform": "a freeform original-resolution crop",
    "avatar": "a square profile avatar",
    "social_cover": "a wide social-media cover",
    "product_main": "a portrait-oriented product hero image",
    "presentation": "a widescreen presentation visual",
    "custom": "a custom-ratio publishing asset",
}


def _build_crop_prompt(intent: AnalysisIntent, strategy: str) -> str:
    resolved_ratio = intent.resolved_aspect_ratio
    ratio = "a free aspect ratio" if resolved_ratio == "free" else resolved_ratio
    template = (
        OUTPUT_TEMPLATE_LABELS[intent.output_template.value]
        if intent.output_template is not None
        else "a general publishing asset"
    )
    return (
        "Please provide the bounding box coordinate for "
        f"{CROP_STRATEGIES[strategy]}. The intended use is "
        f"{SCENE_LABELS[intent.scene.value]}; the delivery target is {template}, "
        f"and the requested output uses {ratio}. "
        "Return only two corner coordinates."
    )

PLACEHOLDER_TEXT = {
    "overview",
    "strength 1",
    "strength 2",
    "issue 1",
    "issue 2",
    "crop rationale",
    "tip 1",
    "tip 2",
    "整体观察",
    "优点1",
    "优点2",
    "问题1",
    "问题2",
    "裁剪理由",
    "建议1",
    "建议2",
}

REPORT_FIELD_ALIASES = {
    "overview": ("overview", "overall", "overall_observation", "整体观察", "整体评价"),
    "strengths": ("strengths", "advantages", "pros", "画面优点", "优点"),
    "issues": ("issues", "problems", "weaknesses", "cons", "主要问题", "问题"),
    "crop_rationale": (
        "crop_rationale",
        "crop_reason",
        "cropping_rationale",
        "裁剪理由",
    ),
    "shooting_tips": (
        "shooting_tips",
        "tips",
        "suggestions",
        "recommendations",
        "下次拍摄建议",
        "拍摄建议",
    ),
}


def _extract_json_object(text: str) -> dict[str, Any]:
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass

    start = stripped.find("{")
    if start < 0:
        raise ValueError("模型未返回 JSON 对象")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(stripped)):
        character = stripped[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                value = json.loads(stripped[start : index + 1])
                if not isinstance(value, dict):
                    raise ValueError("模型 JSON 根节点必须是对象")
                return value
    raise ValueError("模型返回了不完整的 JSON")


def _clean_text(value: str) -> str:
    value = re.sub(r"^\s*(?:[-*•]+|\d+[.)、])\s*", "", value.strip())
    return re.sub(r"\s+", " ", value)


def _flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        cleaned = _clean_text(value)
        return [cleaned] if cleaned else []
    if isinstance(value, (list, tuple)):
        flattened: list[str] = []
        for item in value:
            flattened.extend(_flatten_strings(item))
        return flattened
    return []


def _find_report_value(payload: dict[str, Any], field: str) -> Any:
    for alias in REPORT_FIELD_ALIASES[field]:
        if alias in payload:
            return payload[alias]
    return None


def _normalize_report_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for field in ("overview", "crop_rationale"):
        values = _flatten_strings(_find_report_value(payload, field))
        if values:
            normalized[field] = " ".join(values)[:1200]
    for field in ("strengths", "issues", "shooting_tips"):
        values = _flatten_strings(_find_report_value(payload, field))
        if values:
            normalized[field] = list(dict.fromkeys(values))[:5]
    return normalized


def _extract_crop_box(text: str) -> CropBox:
    number = r"-?\d+(?:\.\d+)?"
    pairs = re.findall(rf"\(\s*({number})\s*,\s*({number})\s*\)", text)
    if len(pairs) >= 2:
        values = [float(value) for pair in pairs[:2] for value in pair]
    else:
        bracket_values: list[float] | None = None
        for match in re.finditer(r"\[([^\[\]]+)\]", text):
            candidates = [float(value) for value in re.findall(number, match.group(1))]
            if len(candidates) == 4:
                bracket_values = candidates
                break
        if bracket_values is not None:
            values = bracket_values
        else:
            candidates = [float(value) for value in re.findall(number, text)]
            if len(candidates) != 4:
                raise ValueError("模型未返回四个裁剪坐标")
            values = candidates

    if max(abs(value) for value in values) <= 1:
        values = [value * 1000 for value in values]
    return CropBox.from_xyxy_1000(values)


def _build_direct_report_prompt(crop: CropBox) -> str:
    crop_xyxy = [
        round(crop.x * 1000),
        round(crop.y * 1000),
        round((crop.x + crop.width) * 1000),
        round((crop.y + crop.height) * 1000),
    ]
    return f"""
Analyze this image directly as a professional photography critic. The recommended
crop in normalized 0-1000 coordinates is {crop_xyxy}.

Return exactly one valid JSON object and no Markdown or extra text. The object must
contain exactly these fields:
- "overview": one concise sentence about the image;
- "strengths": an array of 1 to 3 concise strengths;
- "issues": an array of 1 to 3 concise issues;
- "crop_rationale": one concise sentence explaining how the recommended crop
  improves the composition;
- "shooting_tips": an array of 1 to 3 practical suggestions for a future shot.

Write every value in English. Base every observation on the visible image. Do not
include scores, star ratings, placeholders, empty values, or crop coordinates in
the JSON values.
""".strip()


def _build_review_prompt(intent: AnalysisIntent) -> str:
    return f"""
Analyze this final cropped image directly as a professional photography critic.
The intended use is {SCENE_LABELS[intent.scene.value]} and the requested aspect
ratio is {intent.resolved_aspect_ratio}.

Return exactly one valid JSON object and no Markdown or extra text. The object must
contain exactly these fields: "overview", "strengths", "issues",
"crop_rationale", and "shooting_tips". Use one concise sentence for overview and
crop_rationale, and arrays of 1 to 3 concise items for the other fields. Treat
crop_rationale as an assessment of the final composition, not a new crop request.
Write every value in English. Base every observation on the visible image. Do not
include scores, placeholders, empty values, or coordinates.
""".strip()


class VenusBackend:
    def __init__(self, model_path: Path, load_in_8bit: bool = True):
        if not model_path.exists():
            raise FileNotFoundError(f"Venus 模型目录不存在: {model_path}")

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
        except ImportError as exc:
            raise RuntimeError("Venus 后端需要安装 smartcrop[venus]") from exc

        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model_options: dict[str, Any] = {
            "device_map": "auto",
            "trust_remote_code": True,
            "torch_dtype": torch.float16,
        }
        if load_in_8bit:
            model_options["quantization_config"] = BitsAndBytesConfig(
                load_in_8bit=True,
                llm_int8_skip_modules=["visual"],
            )
        model = AutoModelForCausalLM.from_pretrained(model_path, **model_options).eval()

        self.tokenizer = tokenizer
        self.model = model

    def _chat(self, prompt: str, max_new_tokens: int, image_path: Path | None = None) -> str:
        parts = []
        if image_path is not None:
            parts.append({"image": str(image_path)})
        parts.append({"text": prompt})
        query = self.tokenizer.from_list_format(parts)
        response, _history = self.model.chat(
            self.tokenizer,
            query=query,
            history=None,
            max_new_tokens=max_new_tokens,
        )
        response_text = str(response).strip()
        if not response_text:
            raise ValueError("模型返回了空响应")
        return response_text

    def _generate_crop(self, image_path: Path, prompt: str) -> CropBox:
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response = self._chat(prompt, CROP_MAX_NEW_TOKENS, image_path)
            try:
                return _extract_crop_box(response)
            except ValueError as exc:
                last_error = exc
                LOGGER.warning(
                    "Rejected Venus crop response on attempt %d/%d (length=%d): %s",
                    attempt,
                    MAX_GENERATION_ATTEMPTS,
                    len(response),
                    exc,
                )
        raise ValueError("模型连续返回了无效的裁剪坐标") from last_error

    def _generate_report(self, image_path: Path, crop: CropBox) -> Report:
        prompt = _build_direct_report_prompt(crop)
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response = self._chat(prompt, REPORT_MAX_NEW_TOKENS, image_path)
            try:
                payload = _normalize_report_payload(_extract_json_object(response))
                text_values = [
                    value
                    for field_value in payload.values()
                    for value in _flatten_strings(field_value)
                ]
                if any(value in PLACEHOLDER_TEXT for value in text_values):
                    raise ValueError("模型返回了提示词占位内容")
                return Report.model_validate(payload)
            except ValueError as exc:
                last_error = exc
                LOGGER.warning(
                    "Rejected Venus report response on attempt %d/%d "
                    "(length=%d, closed_object=%s): %s",
                    attempt,
                    MAX_GENERATION_ATTEMPTS,
                    len(response),
                    response.rstrip().endswith("}"),
                    exc,
                )
        raise ValueError("模型连续返回了无效的结构化报告") from last_error

    def _generate_review(self, image_path: Path, intent: AnalysisIntent) -> Report:
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response = self._chat(_build_review_prompt(intent), REPORT_MAX_NEW_TOKENS, image_path)
            try:
                return Report.model_validate(
                    _normalize_report_payload(_extract_json_object(response))
                )
            except ValueError as exc:
                last_error = exc
                LOGGER.warning("Rejected Venus review on attempt %d: %s", attempt, exc)
        raise ValueError("模型连续返回了无效的终稿复评") from last_error

    def analyze(self, image_path: Path, intent: AnalysisIntent) -> InferenceResult:
        with Image.open(image_path) as image:
            width, height = image.size
        candidates = []
        for strategy in CROP_STRATEGIES:
            crop = self._generate_crop(image_path, _build_crop_prompt(intent, strategy))
            candidates.append(
                CropCandidate(
                    id=strategy,
                    crop=fit_crop_to_aspect(
                        crop,
                        intent.resolved_aspect_ratio,
                        width,
                        height,
                    ),
                )
            )
        report = self._generate_report(image_path, candidates[0].crop)
        return InferenceResult(candidates=candidates, report=report)

    def review(self, image_path: Path, intent: AnalysisIntent) -> Report:
        return self._generate_review(image_path, intent)
