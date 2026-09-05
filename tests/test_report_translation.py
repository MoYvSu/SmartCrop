from __future__ import annotations

import json

import httpx
import pytest
from smartcrop_contracts import Report
from smartcrop_worker.translation import DeepSeekReportTranslator, ReportTranslationError


def _english_report() -> Report:
    return Report(
        overview="A quiet portrait with a clear subject.",
        strengths=["The light separates the subject from the background."],
        issues=["The bright edge competes for attention."],
        crop_rationale="A tighter crop removes the distracting edge.",
        shooting_tips=["Check the frame edges before releasing the shutter."],
    )


def test_deepseek_translator_sends_only_report_json_and_marks_provenance() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["body"] = body
        captured["authorization"] = request.headers.get("authorization")
        translated = {
            "overview": "这是一幅主体明确、氛围安静的人像。",
            "strengths": ["光线使主体与背景形成清晰分离。"],
            "issues": ["明亮的画面边缘分散了注意力。"],
            "crop_rationale": "收紧裁剪可移除干扰性的边缘。",
            "shooting_tips": ["按下快门前检查画面边缘。"],
        }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(translated)}}]},
        )

    translator = DeepSeekReportTranslator(
        api_key="private-test-key",
        transport=httpx.MockTransport(handler),
    )
    result = translator.translate(_english_report())

    assert result.language == "zh-CN"
    assert result.translation_provider == "deepseek"
    assert result.overview.startswith("这是一幅")
    assert captured["authorization"] == "Bearer private-test-key"
    request_text = json.dumps(captured["body"], ensure_ascii=False)
    assert "A quiet portrait" in request_text
    assert "image" not in request_text.lower()
    assert "thinking" in captured["body"]


def test_deepseek_translator_rejects_non_chinese_response() -> None:
    report = _english_report()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": report.model_dump_json(
                                exclude={"language", "translation_provider"}
                            )
                        }
                    }
                ]
            },
        )

    translator = DeepSeekReportTranslator(
        api_key="private-test-key",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ReportTranslationError):
        translator.translate(report)
