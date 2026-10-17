from __future__ import annotations

import logging
import time

from smartcrop_contracts import JobMode, Report
from smartcrop_image_core import crop_original
from smartcrop_runtime import JobStore, Settings, cleanup_expired_jobs

from .backends import InferenceBackend
from .translation import ReportTranslator

LOGGER = logging.getLogger("smartcrop.worker")


class Worker:
    def __init__(
        self,
        settings: Settings,
        store: JobStore,
        backend: InferenceBackend,
        report_translator: ReportTranslator | None = None,
    ):
        self.settings = settings
        self.store = store
        self.backend = backend
        self.report_translator = report_translator
        self._lease_lost = False

    def _finish_inference(self, job_id: str, started: float) -> bool:
        if time.monotonic() - started > self.settings.task_timeout_seconds:
            raise TimeoutError("模型推理超过允许时间")
        if self.store.mark_inference_completed(job_id):
            return True
        self._lease_lost = True
        LOGGER.warning("Discarding result for job %s after losing its running lease", job_id)
        return False

    def _translate_report(self, report: Report, job_id: str) -> Report:
        if self.report_translator is None:
            return report
        try:
            return self.report_translator.translate(report)
        except Exception as exc:  # noqa: BLE001 - translation must fail open
            LOGGER.warning(
                "Report translation failed for job %s; preserving original report (%s)",
                job_id,
                type(exc).__name__,
            )
            return report

    def _finish_postprocessing(self, job_id: str, started: float) -> bool:
        if time.monotonic() - started <= self.settings.postprocessing_timeout_seconds:
            return True
        if not self.store.fail_job(
            job_id, "postprocessing_timeout", "结果整理超过允许时间，请稍后重试",
        ):
            self._lease_lost = True
        return False

    def run_once(self) -> bool:
        self.store.expire_stale_running(
            self.settings.task_timeout_seconds,
            self.settings.postprocessing_timeout_seconds,
        )
        cleanup_expired_jobs(self.store, self.settings.jobs_dir)
        job = self.store.claim_next()
        if job is None:
            return False

        LOGGER.info("Processing job %s", job.id)
        started = time.monotonic()
        try:
            if job.mode == JobMode.REVIEW:
                report = self.backend.review(job.input_path, job.intent)
                if not self._finish_inference(job.id, started):
                    return True
                postprocessing_started = time.monotonic()
                report = self._translate_report(report, job.id)
                if not self._finish_postprocessing(job.id, postprocessing_started):
                    return True
                if not self.store.complete_review_job(job.id, report=report):
                    self._lease_lost = True
                return True

            result = self.backend.analyze(job.input_path, job.intent)
            if not self._finish_inference(job.id, started):
                return True
            postprocessing_started = time.monotonic()
            suffix = ".png" if job.input_path.suffix.lower() == ".png" else ".jpg"
            # Never share the manual endpoint's crop.jpg: a late discarded
            # inference result must not overwrite or delete a user's saved crop.
            crop_path = job.input_path.parent / f"crop-initial{suffix}"
            crop_original(job.input_path, result.crop, crop_path)
            report = self._translate_report(result.report, job.id)
            if not self._finish_postprocessing(job.id, postprocessing_started):
                crop_path.unlink(missing_ok=True)
                return True
            committed = self.store.complete_job(
                job.id,
                report=report,
                candidates=result.candidates,
                crop_path=crop_path,
            )
            if committed:
                LOGGER.info("Completed job %s in %.2fs", job.id, time.monotonic() - started)
            else:
                self._lease_lost = True
                crop_path.unlink(missing_ok=True)
                LOGGER.warning("Discarded late result for job %s", job.id)
        except TimeoutError as exc:
            LOGGER.exception("Timed out job %s", job.id)
            if not self.store.fail_job(job.id, "inference_timeout", str(exc)):
                self._lease_lost = True
        except Exception:  # noqa: BLE001 - worker must persist all failures
            LOGGER.exception("Failed job %s", job.id)
            if not self.store.fail_job(
                job.id,
                "inference_failed",
                "模型分析失败，请稍后重试；也可继续使用手动裁剪",
            ):
                self._lease_lost = True
        return True

    def run_forever(self) -> None:
        translation_name = (
            type(self.report_translator).__name__ if self.report_translator else "disabled"
        )
        LOGGER.info(
            "SmartCrop worker started with %s backend; report translation=%s",
            type(self.backend).__name__,
            translation_name,
        )
        while not self._lease_lost:
            processed = self.run_once()
            if not processed:
                time.sleep(self.settings.worker_poll_seconds)
