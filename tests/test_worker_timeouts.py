from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import smartcrop_runtime.store as store_module
import smartcrop_worker.supervisor as supervisor_module
import smartcrop_worker.worker as worker_module
from PIL import Image
from smartcrop_contracts import CropBox, CropCandidate, JobMode, JobStatus, Report
from smartcrop_runtime import JobStore, Settings
from smartcrop_worker import Worker
from smartcrop_worker.backends.base import InferenceResult
from smartcrop_worker.supervisor import WorkerSupervisor


class Clock:
    def __init__(self) -> None:
        self.elapsed = 0.0
        self.origin = datetime(2026, 10, 17, tzinfo=timezone.utc)

    def now(self) -> datetime:
        return self.origin + timedelta(seconds=self.elapsed)

    def advance(self, seconds: float) -> None:
        self.elapsed += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    controlled = Clock()
    monkeypatch.setattr(store_module, "utc_now", controlled.now)

    def unexpected_sleep(_seconds: float) -> None:
        pytest.fail("a worker that lost its lease must stop rather than poll or claim again")

    monkeypatch.setattr(
        worker_module,
        "time",
        SimpleNamespace(monotonic=lambda: controlled.elapsed, sleep=unexpected_sleep),
    )

    class ControlledDateTime:
        @staticmethod
        def now(_timezone: object = None) -> datetime:
            return controlled.now()

    monkeypatch.setattr(supervisor_module, "datetime", ControlledDateTime)
    return controlled


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    options = {
        "data_dir": tmp_path / "data",
        "database_path": tmp_path / "data" / "jobs.sqlite3",
        "web_dist": tmp_path / "no-dist",
        "access_code": "test-code",
        "task_timeout_seconds": 120,
        "report_translator": "deepseek",
        "deepseek_api_key": "test-key",
        "deepseek_timeout_seconds": 12,
    }
    options.update(overrides)
    return Settings(**options)


def _store_with_job(settings: Settings, *, mode: JobMode = JobMode.CROP) -> JobStore:
    settings.ensure_directories()
    store = JobStore(settings.database_path)
    store.initialize()
    _create_job(store, settings, "job-1", mode=mode)
    return store


def _create_job(
    store: JobStore, settings: Settings, job_id: str, *, mode: JobMode = JobMode.CROP
) -> None:
    directory = settings.jobs_dir / job_id
    directory.mkdir(parents=True)
    image = directory / "original.jpg"
    Image.new("RGB", (80, 60), "green").save(image)
    store.create_job(
        job_id=job_id,
        input_path=image,
        preview_path=image,
        source_format="JPEG",
        image_width=80,
        image_height=60,
        retention_seconds=3600,
        mode=mode,
    )


def _report() -> Report:
    return Report(
        overview="A clear subject with a quiet background.",
        strengths=["The subject is clear."],
        issues=["The edge is distracting."],
        crop_rationale="Tighten the edges around the subject.",
        shooting_tips=["Check the frame edges."],
        language="en",
    )


def _result() -> InferenceResult:
    return InferenceResult(
        candidates=[
            CropCandidate(id="balanced", crop=CropBox(x=0.1, y=0.1, width=0.8, height=0.8))
        ],
        report=_report(),
    )


class TimedBackend:
    def __init__(self, clock: Clock, seconds: float = 0, after=None):
        self.clock = clock
        self.seconds = seconds
        self.after = after
        self.calls = 0

    def analyze(self, _path, _intent) -> InferenceResult:
        self.calls += 1
        self.clock.advance(self.seconds)
        if self.after:
            self.after()
        return _result()

    def review(self, _path, _intent) -> Report:
        return self.analyze(_path, _intent).report


class TimedTranslator:
    def __init__(self, clock: Clock, seconds: float = 0, after=None, fail: bool = False):
        self.clock = clock
        self.seconds = seconds
        self.after = after
        self.fail = fail
        self.calls = 0

    def translate(self, report: Report) -> Report:
        self.calls += 1
        self.clock.advance(self.seconds)
        if self.after:
            self.after()
        if self.fail:
            raise RuntimeError("translation service unavailable")
        return report.model_copy(
            update={"overview": "主体清楚，背景安静。", "language": "zh-CN"}
        )


@pytest.mark.parametrize(
    "translator,budget,expected",
    [("none", 12, 30), ("deepseek", 12, 42), ("deepseek", 2.5, 32.5)],
)
def test_postprocessing_budget_has_separate_fixed_artifact_allowance(
    tmp_path: Path, translator: str, budget: float, expected: float
) -> None:
    settings = _settings(tmp_path, report_translator=translator, deepseek_timeout_seconds=budget)
    assert settings.postprocessing_timeout_seconds == expected


@pytest.mark.parametrize("budget", [0, -1, float("inf"), float("nan")])
def test_translation_budget_cannot_disable_the_postprocessing_watchdog(
    tmp_path: Path, budget: float
) -> None:
    settings = _settings(tmp_path, deepseek_timeout_seconds=budget)
    assert settings.postprocessing_timeout_seconds == 30


def test_phase_marker_is_nullable_and_cannot_extend_an_already_marked_phase(
    tmp_path: Path, clock: Clock
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    assert store.get_job("job-1").inference_completed_at is None
    assert not store.mark_inference_completed("job-1")
    store.claim_next()
    clock.advance(119)
    assert store.mark_inference_completed("job-1")
    marked_at = store.get_job("job-1").inference_completed_at
    clock.advance(10)
    assert not store.mark_inference_completed("job-1")
    assert store.get_job("job-1").inference_completed_at == marked_at
    store.initialize()
    assert store.get_job("job-1").inference_completed_at == marked_at


@pytest.mark.parametrize("mode", [JobMode.CROP, JobMode.REVIEW])
def test_near_limit_inference_can_finish_translation_after_inference_deadline(
    tmp_path: Path, clock: Clock, mode: JobMode
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings, mode=mode)

    def observe_finalization() -> None:
        record = store.get_job("job-1")
        assert record.status == JobStatus.RUNNING
        assert record.inference_completed_at == clock.origin + timedelta(seconds=119)
        assert record.report is None
        assert not store.fail_timed_out_job("job-1", 120, 42)

    translator = TimedTranslator(clock, seconds=8, after=observe_finalization)
    assert Worker(settings, store, TimedBackend(clock, 119), translator).run_once()
    completed = store.get_job("job-1")
    assert clock.elapsed == 127
    assert completed.status == JobStatus.SUCCEEDED
    assert completed.report.language == "zh-CN"
    assert translator.calls == 1
    if mode == JobMode.CROP:
        assert completed.crop_path.name == "crop-initial.jpg"
        with Image.open(completed.crop_path) as image:
            assert image.size == (64, 48)


def test_genuine_inference_timeout_does_not_start_translation_or_publish_a_crop(
    tmp_path: Path, clock: Clock
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    translator = TimedTranslator(clock)
    assert Worker(settings, store, TimedBackend(clock, 121), translator).run_once()
    failed = store.get_job("job-1")
    assert failed.status == JobStatus.FAILED
    assert failed.error_code == "inference_timeout"
    assert failed.inference_completed_at is None
    assert translator.calls == 0
    assert failed.crop_path is None
    assert not (settings.jobs_dir / "job-1" / "crop-initial.jpg").exists()


def test_stale_running_cleanup_uses_the_new_phase_deadline(tmp_path: Path, clock: Clock) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    store.claim_next()
    clock.advance(119)
    assert store.mark_inference_completed("job-1")
    clock.advance(20)
    assert store.expire_stale_running(120, 42) == 0
    assert store.get_job("job-1").status == JobStatus.RUNNING
    clock.advance(23)
    assert store.expire_stale_running(120, 42) == 1
    assert store.get_job("job-1").error_code == "postprocessing_timeout"
    assert not store.mark_inference_completed("job-1")


def test_deadline_boundaries_use_each_phase_start_without_shortening_the_budget(
    tmp_path: Path, clock: Clock
) -> None:
    store = _store_with_job(_settings(tmp_path))
    store.claim_next()
    clock.advance(120)
    assert not store.fail_timed_out_job("job-1", 120, 42)
    assert store.mark_inference_completed("job-1")
    clock.advance(42)
    assert not store.fail_timed_out_job("job-1", 120, 42)
    clock.advance(0.001)
    assert store.fail_timed_out_job("job-1", 120, 42)
    assert store.get_job("job-1").error_code == "postprocessing_timeout"


@pytest.mark.parametrize("mode", [JobMode.CROP, JobMode.REVIEW])
def test_once_mode_does_not_commit_a_result_returned_after_its_postprocessing_budget(
    tmp_path: Path, clock: Clock, mode: JobMode
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings, mode=mode)
    translator = TimedTranslator(clock, seconds=43)
    assert Worker(settings, store, TimedBackend(clock, 119), translator).run_once()
    failed = store.get_job("job-1")
    assert failed.status == JobStatus.FAILED
    assert failed.error_code == "postprocessing_timeout"
    assert failed.report is None
    assert failed.crop_path is None
    assert not (settings.jobs_dir / "job-1" / "crop-initial.jpg").exists()


@pytest.mark.parametrize("already_completed", [False, True])
def test_supervisor_does_not_kill_a_new_phase_or_success_from_a_stale_snapshot(
    tmp_path: Path, clock: Clock, monkeypatch: pytest.MonkeyPatch, already_completed: bool
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    stale_snapshot = store.claim_next()
    clock.advance(119)
    assert store.mark_inference_completed("job-1")
    if already_completed:
        assert store.complete_job(
            "job-1", report=_report(), candidates=_result().candidates,
            crop_path=settings.jobs_dir / "job-1" / "crop-initial.jpg",
        )
    clock.advance(2)
    monkeypatch.setattr(store, "get_running", lambda: stale_snapshot)
    supervisor = WorkerSupervisor(settings, store)
    stop = Mock()
    monkeypatch.setattr(supervisor, "_stop_child", stop)
    assert not supervisor._timeout_running_job(SimpleNamespace(pid=1))
    stop.assert_not_called()
    expected = JobStatus.SUCCEEDED if already_completed else JobStatus.RUNNING
    assert store.get_job("job-1").status == expected


def test_supervisor_stops_a_process_that_exceeds_the_postprocessing_budget(
    tmp_path: Path, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    store.claim_next()
    clock.advance(119)
    assert store.mark_inference_completed("job-1")
    clock.advance(43)
    supervisor = WorkerSupervisor(settings, store)
    stop = Mock()
    monkeypatch.setattr(supervisor, "_stop_child", stop)
    process = SimpleNamespace(pid=1)
    assert supervisor._timeout_running_job(process)
    stop.assert_called_once_with(process)
    assert store.get_job("job-1").error_code == "postprocessing_timeout"


@pytest.mark.parametrize("fails", [False, True])
def test_translation_disabled_or_failed_preserves_the_successful_english_report(
    tmp_path: Path, clock: Clock, fails: bool
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    translator = TimedTranslator(clock, seconds=8, fail=True) if fails else None
    assert Worker(settings, store, TimedBackend(clock, 119), translator).run_once()
    completed = store.get_job("job-1")
    assert completed.status == JobStatus.SUCCEEDED
    assert completed.report == _report()
    assert completed.crop_path.exists()


def test_late_result_cleanup_cannot_delete_a_users_recovered_manual_crop(
    tmp_path: Path, clock: Clock
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    manual_path = settings.jobs_dir / "job-1" / "crop.jpg"
    manual_bytes = b""

    def recover_manually_while_old_work_is_in_flight() -> None:
        nonlocal manual_bytes
        assert store.fail_job("job-1", "postprocessing_timeout", "finalization timed out")
        Image.new("RGB", (23, 19), "red").save(manual_path)
        manual_bytes = manual_path.read_bytes()
        assert store.update_manual_crop(
            "job-1", CropBox(x=0.2, y=0.2, width=0.5, height=0.5), manual_path
        )

    translator = TimedTranslator(clock, after=recover_manually_while_old_work_is_in_flight)
    assert Worker(settings, store, TimedBackend(clock), translator).run_once()
    recovered = store.get_job("job-1")
    assert recovered.status == JobStatus.SUCCEEDED
    assert recovered.manual_only
    assert recovered.crop_path == manual_path
    assert manual_path.read_bytes() == manual_bytes
    assert not (manual_path.parent / "crop-initial.jpg").exists()


def test_a_worker_that_loses_its_lease_exits_without_claiming_the_next_job(
    tmp_path: Path, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(tmp_path)
    store = _store_with_job(settings)
    clock.advance(0.1)
    _create_job(store, settings, "job-2")
    claim = Mock(wraps=store.claim_next)
    monkeypatch.setattr(store, "claim_next", claim)

    def revoke_lease() -> None:
        assert claim.call_count == 1, "a late worker must not process a second queued job"
        assert store.fail_job("job-1", "inference_timeout", "lease revoked")

    worker = Worker(settings, store, TimedBackend(clock, after=revoke_lease))
    worker.run_forever()
    assert claim.call_count == 1
    assert store.get_job("job-1").status == JobStatus.FAILED
    assert store.get_job("job-2").status == JobStatus.QUEUED
