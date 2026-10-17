from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from smartcrop_contracts import AnalysisIntent

CompositionGuide = Literal["thirds", "center", "diagonal", "safe"]


class GuideSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    guides: list[CompositionGuide] = Field(default_factory=lambda: ["thirds"], max_length=4)

    @field_validator("guides")
    @classmethod
    def unique_guides(cls, value: list[CompositionGuide]) -> list[CompositionGuide]:
        if len(value) != len(set(value)):
            raise ValueError("辅助线不能重复")
        return value


class PreferenceDocument(GuideSettings):
    revision: int = Field(default=1, ge=1, strict=True)
    intent: AnalysisIntent = Field(default_factory=AnalysisIntent)


class PreferenceUpdate(PreferenceDocument):
    revision: int = Field(ge=1, strict=True)
    intent: AnalysisIntent
    guides: list[CompositionGuide] = Field(max_length=4)


class PreferenceConflict(ValueError):
    pass


class PreferenceStore:
    """Account defaults; existing projects keep their own creation snapshot."""

    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS account_preferences (
                    owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL CHECK (revision >= 1),
                    preferences_json TEXT NOT NULL
                )
            """)

    @staticmethod
    def _document(row: sqlite3.Row | None) -> PreferenceDocument:
        if row is None:
            return PreferenceDocument()
        payload = json.loads(row["preferences_json"])
        if not isinstance(payload, dict):
            raise ValueError("保存的创作偏好格式不正确")
        # Validate stored data as well as incoming writes. No partial fallback
        # should silently replace an account's saved choices.
        return PreferenceUpdate.model_validate({**payload, "revision": row["revision"]})

    def get(self, owner_id: str) -> dict:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT revision,preferences_json FROM account_preferences WHERE owner_id=?",
                (owner_id,),
            ).fetchone()
        return self._document(row).model_dump(mode="json")

    def save(self, owner_id: str, update: dict) -> dict:
        parsed = PreferenceUpdate.model_validate(update)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT revision,preferences_json FROM account_preferences WHERE owner_id=?",
                (owner_id,),
            ).fetchone()
            current = self._document(row)
            if current.revision != parsed.revision:
                raise PreferenceConflict("创作偏好已在其他页面更新，请重新读取后再保存")
            result = PreferenceDocument(
                revision=current.revision + 1, intent=parsed.intent, guides=parsed.guides,
            )
            payload = result.model_dump(mode="json", exclude={"revision"})
            connection.execute(
                "INSERT INTO account_preferences (owner_id,revision,preferences_json) "
                "VALUES (?,?,?) ON CONFLICT(owner_id) DO UPDATE SET "
                "revision=excluded.revision,preferences_json=excluded.preferences_json",
                (owner_id, result.revision, json.dumps(payload, ensure_ascii=False)),
            )
            return result.model_dump(mode="json")
