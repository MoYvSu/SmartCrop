from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from smartcrop_image_core import crop_original
from smartcrop_runtime import JobRecord, JobStore, Settings

from .backends import InferenceBackend

LOGGER = logging.getLogger("smartcrop.worker")


def remove_expired_job_files(records: list[JobRecord], jobs_root: Path) -> None:
    root = jobs_root.resolve()
    for record in records:
        job_dir = record.input_path.parent.resolve()
        if job_dir.parent != root:
            LOGGER.error("Refusing to remove unexpected job directory: %s", job_dir)
            continue
        shutil.rmtree(job_dir, ignore_errors=True)


class Worker:
    def __init__(self, settings: Settings, store: JobStore, backend: InferenceBackend):
        self.settings = settings
        self.store = store
        self.backend = backend

    def run_once(self) -> bool:
        self.store.expire_stale_running(self.settings.task_timeout_seconds)
        remove_expired_job_files(self.store.pop_expired(), self.settings.jobs_dir)
        job = self.store.claim_next()
        if job is None:
            return False

        LOGGER.info("Processing job %s", job.id)
        started = time.monotonic()
        try:
            result = self.backend.analyze(job.input_path)
            elapsed = time.monotonic() - started
            if elapsed > self.settings.task_timeout_seconds:
                raise TimeoutError("模型推理超过允许时间")
            suffix = ".png" if job.input_path.suffix.lower() == ".png" else ".jpg"
            crop_path = job.input_path.parent / f"crop{suffix}"
            crop_original(job.input_path, result.crop, crop_path)
            committed = self.store.complete_job(
                job.id,
                report=result.report,
                ai_crop=result.crop,
                crop_path=crop_path,
            )
            if committed:
                LOGGER.info("Completed job %s in %.2fs", job.id, elapsed)
            else:
                crop_path.unlink(missing_ok=True)
                LOGGER.warning("Discarded late result for job %s", job.id)
        except TimeoutError as exc:
            LOGGER.exception("Timed out job %s", job.id)
            self.store.fail_job(job.id, "inference_timeout", str(exc))
        except Exception:  # noqa: BLE001 - worker must persist all failures
            LOGGER.exception("Failed job %s", job.id)
            self.store.fail_job(
                job.id,
                "inference_failed",
                "模型分析失败，请稍后重试；也可继续使用手动裁剪",
            )
        return True

    def run_forever(self) -> None:
        LOGGER.info("SmartCrop worker started with %s backend", type(self.backend).__name__)
        while True:
            processed = self.run_once()
            if not processed:
                time.sleep(self.settings.worker_poll_seconds)
