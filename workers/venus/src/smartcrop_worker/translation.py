from __future__ import annotations

import asyncio
import json
import logging
import math
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
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        if not api_key.strip():
            raise ValueError("SMARTCROP_DEEPSEEK_API_KEY is required")
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("DeepSeek translation timeout must be finite and positive")
        endpoint = httpx.URL(f"{base_url.strip().rstrip('/')}/chat/completions")
        if endpoint.scheme not in {"http", "https"} or not endpoint.host:
            raise ValueError("DeepSeek base URL must be an absolute HTTP(S) URL")
        if not model.strip():
            raise ValueError("DeepSeek translation model is required")
        self.model = model.strip()
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds
        self._headers = {"Authorization": f"Bearer {api_key.strip()}"}
        self._transport = transport

    async def _request(self, client: httpx.AsyncClient, report: Report) -> Report:
        source = report.model_dump(
            mode="json", exclude={"language", "translation_provider"}
        )
        response = await client.post(
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

    async def _translate(self, report: Report) -> Report:
        last_error: Exception | None = None
        attempts_used = 0
        # Create and close the client in the same event loop on every report. The
        # enclosing wait_for cancels in-flight I/O and waits for this cleanup.
        async with httpx.AsyncClient(
            headers=self._headers,
            timeout=self.timeout_seconds,
            transport=self._transport,
        ) as client:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                attempts_used = attempt
                try:
                    return await self._request(client, report)
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

    def translate(self, report: Report) -> Report:
        """Translate within one total time budget shared by all attempts."""
        started = time.monotonic()
        try:
            translated = asyncio.run(
                asyncio.wait_for(self._translate(report), timeout=self.timeout_seconds)
            )
        except asyncio.TimeoutError as exc:
            raise ReportTranslationError(
                "DeepSeek report translation exceeded its time budget"
            ) from exc
        except ReportTranslationError:
            raise
        except Exception as exc:
            raise ReportTranslationError(
                f"DeepSeek report translation failed ({type(exc).__name__})"
            ) from exc
        LOGGER.info(
            "Translated report with model %s in %.2fs",
            self.model,
            time.monotonic() - started,
        )
        return translated


def build_report_translator(settings: Settings) -> ReportTranslator | None:
    if settings.report_translator in {"", "none", "off", "disabled"}:
        return None
    if settings.report_translator == "deepseek":
        if not settings.deepseek_api_key.strip():
            LOGGER.warning(
                "DeepSeek translation disabled: API key is missing; using original reports"
            )
            return None
        try:
            return DeepSeekReportTranslator(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
                model=settings.deepseek_model,
                timeout_seconds=settings.deepseek_timeout_seconds,
            )
        except Exception as exc:
            LOGGER.warning(
                "DeepSeek translation disabled: initialization failed (%s); using original reports",
                type(exc).__name__,
            )
            return None
    raise RuntimeError(f"Unsupported report translator: {settings.report_translator}")
