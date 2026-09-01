from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from smartcrop_contracts import CropBox, Report

from .base import InferenceResult

PROMPT = """
请分析这张图片的构图与美学质量，并给出最佳裁剪框。
只返回一个 JSON 对象，不要使用 Markdown，不要添加 JSON 之外的文字。
字段必须严格为：
{
  "overview": "整体观察",
  "strengths": ["优点1", "优点2"],
  "issues": ["问题1", "问题2"],
  "crop_rationale": "裁剪理由",
  "shooting_tips": ["建议1", "建议2"],
  "crop_box": [x1, y1, x2, y2]
}
crop_box 使用 0 到 1000 的整数坐标，原图左上角为 [0, 0]，右下角为 [1000, 1000]。
不要给出美学分数或星级。使用简体中文。
""".strip()


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


class VenusBackend:
    def __init__(self, model_path: Path, load_in_8bit: bool = True):
        if not model_path.exists():
            raise FileNotFoundError(f"Venus 模型目录不存在: {model_path}")

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("Venus 后端需要安装 smartcrop[venus]") from exc

        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model_options: dict[str, Any] = {
            "device_map": "auto",
            "trust_remote_code": True,
            "torch_dtype": torch.float16,
        }
        if load_in_8bit:
            model_options["load_in_8bit"] = True
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
        response, _history = self.model.chat(
            self.tokenizer,
            query=query,
            history=None,
        )
        payload = _extract_json_object(str(response))
        raw_box = payload.pop("crop_box", None)
        if not isinstance(raw_box, list):
            raise ValueError("模型结果缺少 crop_box")
        crop = CropBox.from_xyxy_1000(raw_box)
        report = Report.model_validate(payload)
        return InferenceResult(crop=crop, report=report)
