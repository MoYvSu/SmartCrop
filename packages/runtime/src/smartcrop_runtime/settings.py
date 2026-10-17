from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_path: Path
    web_dist: Path
    access_code: str
    max_upload_bytes: int = 20 * 1024 * 1024
    queue_limit: int = 5
    retention_seconds: int = 3600
    task_timeout_seconds: int = 120
    worker_poll_seconds: float = 1.0
    image_decode_concurrency: int = 2
    worker_backend: str = "mock"
    model_path: Path | None = None
    load_in_8bit: bool = True
    report_translator: str = "none"
    deepseek_api_key: str = field(default="", repr=False)
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"
    deepseek_timeout_seconds: float = 12.0
    p0_capabilities_verified: bool = False

    def __post_init__(self) -> None:
        if self.image_decode_concurrency < 1:
            raise ValueError("image_decode_concurrency must be at least 1")

    @classmethod
    def from_env(cls, project_root: Path | None = None) -> Settings:
        root = (project_root or Path.cwd()).resolve()
        data_dir = Path(os.getenv("SMARTCROP_DATA_DIR", root / "var" / "smartcrop")).resolve()
        database_path = Path(
            os.getenv("SMARTCROP_DATABASE_PATH", data_dir / "smartcrop.sqlite3")
        ).resolve()
        web_dist = Path(os.getenv("SMARTCROP_WEB_DIST", root / "apps" / "web" / "dist")).resolve()
        model_value = os.getenv("SMARTCROP_MODEL_PATH")
        return cls(
            data_dir=data_dir,
            database_path=database_path,
            web_dist=web_dist,
            access_code=os.getenv("SMARTCROP_ACCESS_CODE", ""),
            max_upload_bytes=int(os.getenv("SMARTCROP_MAX_UPLOAD_BYTES", 20 * 1024 * 1024)),
            queue_limit=int(os.getenv("SMARTCROP_QUEUE_LIMIT", 5)),
            retention_seconds=int(os.getenv("SMARTCROP_RETENTION_SECONDS", 3600)),
            task_timeout_seconds=int(os.getenv("SMARTCROP_TASK_TIMEOUT_SECONDS", 120)),
            worker_poll_seconds=float(os.getenv("SMARTCROP_WORKER_POLL_SECONDS", 1.0)),
            image_decode_concurrency=int(os.getenv("SMARTCROP_DECODE_CONCURRENCY", 2)),
            worker_backend=os.getenv("SMARTCROP_WORKER_BACKEND", "mock").strip().lower(),
            model_path=Path(model_value).resolve() if model_value else None,
            load_in_8bit=_as_bool(os.getenv("SMARTCROP_LOAD_IN_8BIT"), True),
            report_translator=os.getenv("SMARTCROP_REPORT_TRANSLATOR", "none").strip().lower(),
            deepseek_api_key=os.getenv("SMARTCROP_DEEPSEEK_API_KEY", "").strip(),
            deepseek_base_url=os.getenv(
                "SMARTCROP_DEEPSEEK_BASE_URL", "https://api.deepseek.com"
            ).strip(),
            deepseek_model=os.getenv(
                "SMARTCROP_DEEPSEEK_MODEL", "deepseek-v4-flash"
            ).strip(),
            deepseek_timeout_seconds=float(
                os.getenv("SMARTCROP_DEEPSEEK_TIMEOUT_SECONDS", 12)
            ),
            p0_capabilities_verified=_as_bool(
                os.getenv("SMARTCROP_P0_CAPABILITIES_VERIFIED"), False
            ),
        )

    @property
    def postprocessing_timeout_seconds(self) -> float:
        """Translation has its own total budget, plus bounded artifact/DB finalization."""
        translation_budget = (
            self.deepseek_timeout_seconds if self.report_translator == "deepseek" else 0.0
        )
        if not math.isfinite(translation_budget) or translation_budget < 0:
            translation_budget = 0.0
        return 30.0 + translation_budget

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
