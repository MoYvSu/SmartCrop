from __future__ import annotations

import logging
import shutil
import sqlite3
from pathlib import Path

from .store import JobRecord, JobStore

LOGGER = logging.getLogger(__name__)


def remove_job_directory(record: JobRecord, jobs_root: Path) -> bool:
    root = jobs_root.resolve()
    job_dir = record.input_path.parent.resolve()
    if job_dir.parent != root:
        LOGGER.error("Refusing to remove expired job outside jobs root: %s", record.id)
        return False
    try:
        shutil.rmtree(job_dir)
    except FileNotFoundError:
        return True
    return not job_dir.exists()


def cleanup_expired_jobs(store: JobStore, jobs_root: Path) -> int:
    """Remove expired files before their records so failed cleanup can be retried."""
    removed = 0
    try:
        expired = store.list_expired()
    except sqlite3.Error:
        LOGGER.exception("Failed to list expired jobs; cleanup will retry")
        return removed

    for record in expired:
        try:
            directory_removed = remove_job_directory(record, jobs_root)
        except OSError:
            LOGGER.exception("Failed to remove files for expired job %s", record.id)
            continue
        if not directory_removed:
            continue
        try:
            if store.delete_job(record.id):
                removed += 1
        except sqlite3.Error:
            LOGGER.exception("Failed to remove record for expired job %s", record.id)
    return removed
