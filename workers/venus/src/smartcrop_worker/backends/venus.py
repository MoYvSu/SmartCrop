from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from smartcrop_contracts import CropBox, Report

from .base import InferenceResult

LOGGER = logging.getLogger("smartcrop.worker.venus")
MAX_GENERATION_ATTEMPTS = 2
ANALYSIS_MAX_NEW_TOKENS = 512
CROP_MAX_NEW_TOKENS = 96
REPORT_MAX_NEW_TOKENS = 384

# These prompts are direct Chinese equivalents of the two upstream Venus evaluation tasks.
AESTHETIC_PROMPT = "请从美学角度专业、具体地分析这张图片。请使用简体中文。"
CROP_PROMPT = "请给出画面中视觉最平衡、最美观的构图区域边界框坐标。只返回两个角点坐标。"

PLACEHOLDER_TEXT = {
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


def _build_report_prompt(analysis: str, crop: CropBox) -> str:
    crop_xyxy = [
        round(crop.x * 1000),
        round(crop.y * 1000),
        round((crop.x + crop.width) * 1000),
        round((crop.y + crop.height) * 1000),
    ]
    return f"""
下面是 Venus 对一张图片生成的原始美学评论：
<analysis>
{analysis}
</analysis>

Venus 建议的归一化裁剪坐标是 {crop_xyxy}。
请把已有评论整理为结构化报告。只整理和概括已有内容，不添加原评论未提及的可见事实。
只返回一个 JSON 对象，不要使用 Markdown，也不要输出 JSON 以外的文字。
JSON 必须包含且只包含以下字段：
- overview：一句整体观察字符串；
- strengths：1 至 3 条画面优点的字符串数组；
- issues：1 至 3 条主要问题的字符串数组；
- crop_rationale：一句说明该裁剪如何改善构图的字符串；
- shooting_tips：1 至 3 条下次拍摄建议的字符串数组。
不要给出分数、星级、字段名占位词或空内容。
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

    def _generate_crop(self, image_path: Path) -> CropBox:
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response = self._chat(CROP_PROMPT, CROP_MAX_NEW_TOKENS, image_path)
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

    def _generate_report(self, analysis: str, crop: CropBox) -> Report:
        prompt = _build_report_prompt(analysis, crop)
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response = self._chat(prompt, REPORT_MAX_NEW_TOKENS)
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

    def analyze(self, image_path: Path) -> InferenceResult:
        analysis = self._chat(AESTHETIC_PROMPT, ANALYSIS_MAX_NEW_TOKENS, image_path)
        crop = self._generate_crop(image_path)
        report = self._generate_report(analysis, crop)
        return InferenceResult(crop=crop, report=report)
