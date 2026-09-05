from __future__ import annotations

import json
import logging
import re
import time
from typing import Protocol

import httpx
from smartcrop_contracts import Report
from smartcrop_runtime import Settings

LOGGER = logging.getLogger("smartcrop.worker.translation")
MAX_ATTEMPTS = 2


class ReportTranslationError(RuntimeError):
    """A sanitized translation failure that is safe to write to application logs."""


class ReportTranslator(Protocol):
    def translate(self, report: Report) -> Report: ...


class DeepSeekReportTranslator:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        model: str = "deepseek-v4-flash",
        timeout_seconds: float = 12.0,
        transport: httpx.BaseTransport | None = None,
    ):
        if not api_key:
            raise ValueError("SMARTCROP_DEEPSEEK_API_KEY is required")
        self.model = model
        self.endpoint = f"{base_url.rstrip('/')}/chat/completions"
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
            transport=transport,
        )

    def _request(self, report: Report) -> Report:
        source = report.model_dump(
            mode="json", exclude={"language", "translation_provider"}
        )
        response = self.client.post(
            self.endpoint,
            json={
                "model": self.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a professional English-to-Simplified-Chinese translator "
                            "for photography critique. Translate faithfully and concisely."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Translate the values in the following JSON report into natural, "
                            "professional Simplified Chinese. Return exactly one valid JSON "
                            "object with the same five keys and preserve every array's length "
                            "and item order. Do not add, remove, summarize, explain, score, or "
                            "translate key names. JSON input:\n"
                            + json.dumps(source, ensure_ascii=False)
                        ),
                    },
                ],
                "thinking": {"type": "disabled"},
                "response_format": {"type": "json_object"},
                "max_tokens": 1536,
                "stream": False,
            },
        )
        response.raise_for_status()
        try:
            content = response.json()["choices"][0]["message"]["content"]
            payload = json.loads(content)
            translated = Report.model_validate(payload)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValueError) as exc:
            raise ReportTranslationError("DeepSeek returned an invalid report payload") from exc

        for field_name in ("strengths", "issues", "shooting_tips"):
            if len(getattr(translated, field_name)) != len(getattr(report, field_name)):
                raise ReportTranslationError("DeepSeek changed the report structure")
        translated_text = " ".join(
            [translated.overview, translated.crop_rationale]
            + translated.strengths
            + translated.issues
            + translated.shooting_tips
        )
        if not re.search(r"[\u4e00-\u9fff]", translated_text):
            raise ReportTranslationError("DeepSeek response did not contain Chinese text")
        return translated.model_copy(
            update={"language": "zh-CN", "translation_provider": "deepseek"}
        )

    def translate(self, report: Report) -> Report:
        started = time.monotonic()
        last_error: Exception | None = None
        attempts_used = 0
        for attempt in range(1, MAX_ATTEMPTS + 1):
            attempts_used = attempt
            try:
                translated = self._request(report)
                LOGGER.info(
                    "Translated report with model %s in %.2fs",
                    self.model,
                    time.monotonic() - started,
                )
                return translated
            except httpx.HTTPStatusError as exc:
                last_error = exc
                if exc.response.status_code < 500 and exc.response.status_code != 429:
                    break
            except (httpx.HTTPError, ReportTranslationError) as exc:
                last_error = exc
        error_name = type(last_error).__name__ if last_error else "UnknownError"
        raise ReportTranslationError(
            f"DeepSeek report translation failed after {attempts_used} attempts ({error_name})"
        ) from last_error


def build_report_translator(settings: Settings) -> ReportTranslator | None:
    if settings.report_translator in {"", "none", "off", "disabled"}:
        return None
    if settings.report_translator == "deepseek":
        return DeepSeekReportTranslator(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            model=settings.deepseek_model,
            timeout_seconds=settings.deepseek_timeout_seconds,
        )
    raise RuntimeError(f"Unsupported report translator: {settings.report_translator}")
