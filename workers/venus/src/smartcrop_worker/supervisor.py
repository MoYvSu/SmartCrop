from __future__ import annotations

import logging
import multiprocessing
import time
from datetime import datetime, timezone

from smartcrop_runtime import JobStore, Settings

LOGGER = logging.getLogger("smartcrop.worker.supervisor")


def _worker_child(settings: Settings) -> None:
    from .factory import build_backend
    from .translation import build_report_translator
    from .worker import Worker

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    store = JobStore(settings.database_path)
    store.initialize()
    Worker(
        settings,
        store,
        build_backend(settings),
        build_report_translator(settings),
    ).run_forever()


class WorkerSupervisor:
    """Keep one model process alive and replace it when a job exceeds the hard timeout."""

    def __init__(self, settings: Settings, store: JobStore):
        self.settings = settings
        self.store = store
        self.context = multiprocessing.get_context("spawn")

    def _start_child(self) -> multiprocessing.Process:
        process = self.context.Process(
            target=_worker_child,
            args=(self.settings,),
            name="smartcrop-inference",
        )
        process.start()
        LOGGER.info("Started inference process pid=%s", process.pid)
        return process

    @staticmethod
    def _stop_child(process: multiprocessing.Process) -> None:
        if not process.is_alive():
            process.join(timeout=1)
            return
        process.terminate()
        process.join(timeout=10)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)

    def run_forever(self) -> None:
        process = self._start_child()
        try:
            while True:
                if not process.is_alive():
                    exit_code = process.exitcode
                    running = self.store.get_running()
                    if running:
                        self.store.fail_job(
                            running.id,
                            "worker_crashed",
                            "模型工作进程异常退出，请稍后重试",
                        )
                    LOGGER.error("Inference process exited with code %s; restarting", exit_code)
                    process.join(timeout=1)
                    time.sleep(2)
                    process = self._start_child()

                running = self.store.get_running()
                if running and running.started_at:
                    elapsed = (datetime.now(timezone.utc) - running.started_at).total_seconds()
                    if elapsed > self.settings.task_timeout_seconds:
                        LOGGER.error(
                            "Hard timeout for job %s after %.1fs; replacing inference process",
                            running.id,
                            elapsed,
                        )
                        self._stop_child(process)
                        self.store.fail_job(
                            running.id,
                            "inference_timeout",
                            f"模型推理超过 {self.settings.task_timeout_seconds} 秒，"
                            "已终止任务，请稍后重试",
                        )
                        process = self._start_child()

                time.sleep(min(max(self.settings.worker_poll_seconds / 2, 0.2), 1.0))
        except KeyboardInterrupt:
            LOGGER.info("Stopping worker supervisor")
        finally:
            self._stop_child(process)
