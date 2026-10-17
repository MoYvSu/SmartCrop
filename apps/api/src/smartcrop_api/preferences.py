from __future__ import annotations

import asyncio

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError
from smartcrop_runtime import Settings
from smartcrop_runtime.preferences import PreferenceConflict, PreferenceStore, PreferenceUpdate


def register_preference_routes(app: FastAPI, settings: Settings) -> PreferenceStore:
    preferences = PreferenceStore(settings.database_path)
    preferences.initialize()
    app.state.preferences = preferences

    async def run(operation, *args):
        try:
            return await asyncio.to_thread(operation, *args)
        except PreferenceConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (ValidationError, ValueError) as exc:
            raise HTTPException(422, "创作偏好格式不正确，请检查后重试") from exc

    @app.get("/v1/preferences", tags=["preferences"])
    async def get_preferences(request: Request) -> dict:
        actor = app.state.auth.require_user(request)
        return await run(preferences.get, actor.id)

    @app.put("/v1/preferences", tags=["preferences"])
    async def save_preferences(request: Request, body: PreferenceUpdate) -> dict:
        actor = app.state.auth.require_user(request, write=True)
        return await run(preferences.save, actor.id, body.model_dump(mode="json"))

    return preferences
