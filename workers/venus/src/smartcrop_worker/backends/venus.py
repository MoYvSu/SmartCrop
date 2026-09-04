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
MAX_NEW_TOKENS = 768

PROMPT = """
请分析这张图片的构图与美学质量，并给出最佳裁剪框。
只返回一个 JSON 对象，不要使用 Markdown，不要添加 JSON 之外的文字。
对象必须包含 overview、strengths、issues、crop_rationale、shooting_tips 和 crop_box 六个字段。
overview、crop_rationale 是具体中文字符串；strengths、issues、shooting_tips 是具体中文字符串数组。
每段文字必须描述当前图片的可见内容，禁止复述字段名、占位词或本指令。
crop_box 使用 0 到 1000 的整数坐标，原图左上角为 [0, 0]，右下角为 [1000, 1000]。
不要给出美学分数或星级。使用简体中文。
""".strip()

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


def _normalize_string_lists(payload: dict[str, Any]) -> None:
    for field in ("strengths", "issues", "shooting_tips"):
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            payload[field] = [value.strip()]


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

    def analyze(self, image_path: Path) -> InferenceResult:
        query = self.tokenizer.from_list_format(
            [
                {"image": str(image_path)},
                {"text": PROMPT},
            ]
        )
        last_error: ValueError | None = None
        for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
            response, _history = self.model.chat(
                self.tokenizer,
                query=query,
                history=None,
                max_new_tokens=MAX_NEW_TOKENS,
            )
            response_text = str(response)
            try:
                return self._build_result(response_text)
            except ValueError as exc:
                last_error = exc
                LOGGER.warning(
                    "Rejected Venus response on attempt %d/%d "
                    "(length=%d, closed_object=%s): %s",
                    attempt,
                    MAX_GENERATION_ATTEMPTS,
                    len(response_text),
                    response_text.rstrip().endswith("}"),
                    exc,
                )

        raise ValueError("模型连续返回了无效的结构化结果") from last_error

    @staticmethod
    def _build_result(response: str) -> InferenceResult:
        payload = _extract_json_object(response)
        raw_box = payload.pop("crop_box", None)
        if not isinstance(raw_box, list):
            raise ValueError("模型结果缺少 crop_box")
        _normalize_string_lists(payload)
        text_values = [payload.get("overview"), payload.get("crop_rationale")]
        for field in ("strengths", "issues", "shooting_tips"):
            value = payload.get(field)
            if isinstance(value, list):
                text_values.extend(value)
        if any(value in PLACEHOLDER_TEXT for value in text_values):
            raise ValueError("模型返回了提示词占位内容")
        crop = CropBox.from_xyxy_1000(raw_box)
        report = Report.model_validate(payload)
        return InferenceResult(crop=crop, report=report)
