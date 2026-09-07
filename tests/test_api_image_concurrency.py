from __future__ import annotations

import asyncio
import importlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from smartcrop_api import create_app
from smartcrop_runtime import JobStore, Settings

api_module = importlib.import_module("smartcrop_api.app")


def _settings(tmp_path: Path, *, concurrency: int = 1) -> Settings:
    data_dir = tmp_path / "data"
    return Settings(
        data_dir=data_dir,
        database_path=data_dir / "smartcrop.sqlite3",
        web_dist=tmp_path / "missing-dist",
        access_code="demo-code",
        image_decode_concurrency=concurrency,
    )


def test_concurrent_uploads_share_one_image_processing_slot(
    jpeg_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    original_prepare = api_module._prepare_image
    lock = threading.Lock()
    active = 0
    peak = 0

    def tracked_prepare(*args: object):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.05)
            return original_prepare(*args)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(api_module, "_prepare_image", tracked_prepare)
    app = create_app(_settings(tmp_path), serve_web=False)

    with TestClient(app) as client:
        def submit(index: int):
            return client.post(
                "/v1/jobs",
                headers={"X-SmartCrop-Access": "demo-code"},
                files={"file": (f"sample-{index}.jpg", jpeg_bytes, "image/jpeg")},
                data={"scene": "general", "aspect_ratio": "free"},
            )

        with ThreadPoolExecutor(max_workers=3) as executor:
            responses = list(executor.map(submit, range(3)))

    assert [response.status_code for response in responses] == [202, 202, 202]
    assert peak == 1


def test_cancelled_request_keeps_slot_until_blocking_work_finishes() -> None:
    started = threading.Event()
    release = threading.Event()

    def blocking_operation() -> None:
        started.set()
        assert release.wait(timeout=2)

    async def scenario() -> None:
        slot = asyncio.Semaphore(1)

        async def run() -> None:
            async with slot:
                await api_module._await_blocking_operation(blocking_operation)

        task = asyncio.create_task(run())
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0.05)
        assert slot.locked()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not slot.locked()

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_failed_preview_creation_leaves_no_job_or_files(
    jpeg_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def fail_preview(*_args: object, **_kwargs: object) -> Path:
        raise RuntimeError("preview failed")

    monkeypatch.setattr(api_module, "save_preview", fail_preview)
    settings = _settings(tmp_path)
    app = create_app(settings, serve_web=False)

    with TestClient(app) as client, pytest.raises(RuntimeError, match="preview failed"):
        client.post(
            "/v1/jobs",
            headers={"X-SmartCrop-Access": "demo-code"},
            files={"file": ("sample.jpg", jpeg_bytes, "image/jpeg")},
            data={"scene": "general", "aspect_ratio": "free"},
        )

    assert not any(settings.jobs_dir.iterdir())
    assert JobStore(settings.database_path).count_queued() == 0
