from __future__ import annotations

import argparse
import logging
from pathlib import Path

from smartcrop_runtime import JobStore, Settings

from .factory import build_backend
from .supervisor import WorkerSupervisor
from .translation import build_report_translator
from .worker import Worker


def main() -> None:
    parser = argparse.ArgumentParser(description="SmartCrop serialized GPU worker")
    parser.add_argument("--once", action="store_true", help="process at most one queued job")
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = Settings.from_env(args.project_root)
    settings.ensure_directories()
    store = JobStore(settings.database_path)
    store.initialize()
    if args.once:
        Worker(
            settings,
            store,
            build_backend(settings),
            build_report_translator(settings),
        ).run_once()
    else:
        WorkerSupervisor(settings, store).run_forever()


if __name__ == "__main__":
    main()
