from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest
from smartcrop_contracts import Report
from smartcrop_runtime import Settings
from smartcrop_worker.translation import (
    DeepSeekReportTranslator,
    ReportTranslationError,
    build_report_translator,
)


def _english_report() -> Report:
    return Report(
        overview="A quiet portrait with a clear subject.",
        strengths=["The light separates the subject from the background."],
        issues=["The bright edge competes for attention."],
        crop_rationale="A tighter crop removes the distracting edge.",
        shooting_tips=["Check the frame edges before releasing the shutter."],
    )


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    values = {
        "data_dir": tmp_path / "data",
        "database_path": tmp_path / "data" / "jobs.sqlite3",
        "web_dist": tmp_path / "dist",
        "access_code": "",
        **overrides,
    }
    return Settings(**values)


def _translated_response() -> httpx.Response:
    report = {
        "overview": "这是一幅主体明确、氛围安静的人像。",
        "strengths": ["光线使主体与背景形成清晰分离。"],
        "issues": ["明亮的画面边缘分散了注意力。"],
        "crop_rationale": "收紧裁剪可移除干扰性的边缘。",
        "shooting_tips": ["按下快门前检查画面边缘。"],
    }
    return httpx.Response(
        200, json={"choices": [{"message": {"content": json.dumps(report)}}]}
    )


class ClosingMockTransport(httpx.MockTransport):
    closes = 0

    async def aclose(self) -> None:
        self.closes += 1


@pytest.mark.parametrize("provider", ["", "none", "off", "disabled"])
def test_disabled_translation_needs_no_key(tmp_path: Path, provider: str) -> None:
    assert build_report_translator(_settings(tmp_path, report_translator=provider)) is None


@pytest.mark.parametrize("key", ["", " \t\n "])
def test_missing_key_disables_optional_translation(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, key: str
) -> None:
    translator = build_report_translator(
        _settings(tmp_path, report_translator="deepseek", deepseek_api_key=key)
    )

    assert translator is None
    assert "API key is missing" in caplog.text
    assert "using original reports" in caplog.text


def test_enabled_translation_can_initialize_without_making_requests(tmp_path: Path) -> None:
    translator = build_report_translator(
        _settings(tmp_path, report_translator="deepseek", deepseek_api_key="private-test-key")
    )

    assert isinstance(translator, DeepSeekReportTranslator)


@pytest.mark.parametrize(
    "overrides",
    [
        {"deepseek_timeout_seconds": 0},
        {"deepseek_timeout_seconds": -1},
        {"deepseek_timeout_seconds": float("nan")},
        {"deepseek_timeout_seconds": float("inf")},
        {"deepseek_base_url": ""},
        {"deepseek_base_url": "ftp://example.com"},
        {"deepseek_base_url": "https://example.com:invalid-private-port"},
        {"deepseek_model": "  "},
    ],
)
def test_invalid_deepseek_initialization_falls_back_without_logging_secrets(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    overrides: dict[str, object],
) -> None:
    translator = build_report_translator(
        _settings(
            tmp_path,
            report_translator="deepseek",
            deepseek_api_key="private-test-key",
            **overrides,
        )
    )

    assert translator is None
    assert "initialization failed" in caplog.text
    assert "private-test-key" not in caplog.text
    assert "invalid-private-port" not in caplog.text


def test_unknown_translator_still_reports_configuration_error(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="Unsupported report translator"):
        build_report_translator(_settings(tmp_path, report_translator="unknown"))


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


def test_unauthorized_translation_does_not_retry_or_expose_response_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(401, json={"error": "private-test-key invalid"})

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(api_key="private-test-key", transport=transport)

    with pytest.raises(ReportTranslationError, match="1 attempts") as caught:
        translator.translate(_english_report())

    assert attempts == 1
    assert transport.closes == 1
    assert "private-test-key" not in str(caught.value)
    assert "private-test-key" not in caplog.text


@pytest.mark.parametrize("status", [429, 503])
def test_transient_translation_failure_retries_then_closes_transport(status: int) -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(status)

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(api_key="private-test-key", transport=transport)

    with pytest.raises(ReportTranslationError, match="2 attempts"):
        translator.translate(_english_report())

    assert attempts == 2
    assert transport.closes == 1


def test_translation_can_succeed_on_second_attempt() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503) if attempts == 1 else _translated_response()

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(api_key="private-test-key", transport=transport)

    result = translator.translate(_english_report())

    assert attempts == 2
    assert result.language == "zh-CN"
    assert result.translation_provider == "deepseek"
    assert transport.closes == 1


@pytest.mark.parametrize("content", ["not-json", "{}"])
def test_invalid_translation_payload_is_retried_and_sanitized(content: str) -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(api_key="private-test-key", transport=transport)

    with pytest.raises(ReportTranslationError, match="2 attempts"):
        translator.translate(_english_report())

    assert attempts == 2
    assert transport.closes == 1


def test_total_translation_deadline_cancels_pending_request_and_closes_transport() -> None:
    cancelled = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return _translated_response()

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(
        api_key="private-test-key", timeout_seconds=0.04, transport=transport
    )

    started = time.monotonic()
    with pytest.raises(ReportTranslationError, match="time budget"):
        translator.translate(_english_report())

    assert time.monotonic() - started < 0.5
    assert cancelled
    assert transport.closes == 1


def test_translation_retries_share_one_total_time_budget(monkeypatch) -> None:
    attempts = 0
    cancelled = False
    budgets: list[float] = []
    wait_for = asyncio.wait_for

    async def observe_budget(awaitable, timeout):
        budgets.append(timeout)
        return await wait_for(awaitable, timeout=timeout)

    monkeypatch.setattr("smartcrop_worker.translation.asyncio.wait_for", observe_budget)

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts, cancelled
        attempts += 1
        if attempts == 1:
            await asyncio.sleep(0.01)
            return httpx.Response(503)
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return _translated_response()

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(
        api_key="private-test-key", timeout_seconds=0.2, transport=transport
    )

    started = time.monotonic()
    with pytest.raises(ReportTranslationError, match="time budget"):
        translator.translate(_english_report())
    elapsed = time.monotonic() - started

    # One outer deadline spans BOTH attempts; avoid relying on a narrow timing
    # difference between two sleeps on a loaded CI runner.
    assert budgets == [0.2]
    assert elapsed < 0.8
    assert attempts == 2
    assert cancelled
    assert transport.closes == 1


def test_translation_deadline_also_cancels_response_body_read() -> None:
    closed = False

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(10)
            yield b"{}"

        async def aclose(self) -> None:
            nonlocal closed
            closed = True

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=SlowStream())

    transport = ClosingMockTransport(handler)
    translator = DeepSeekReportTranslator(
        api_key="private-test-key", timeout_seconds=0.04, transport=transport
    )

    with pytest.raises(ReportTranslationError, match="time budget"):
        translator.translate(_english_report())

    assert closed
    assert transport.closes == 1
