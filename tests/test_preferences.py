from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from smartcrop_api.app import create_app
from smartcrop_runtime import Settings
from smartcrop_runtime.preferences import PreferenceConflict, PreferenceStore

PASSWORD = "preferences-test-only-passphrase"
ORIGIN = {"Origin": "http://testserver"}
DEFAULT_INTENT = {
    "scene": "general", "aspect_ratio": "free", "output_template": None, "custom_ratio": None,
}
CUSTOM_INTENT = {
    "scene": "landscape", "aspect_ratio": "custom", "output_template": "custom",
    "custom_ratio": {"width": 7, "height": 5},
}


@pytest.fixture
def preference_app(tmp_path: Path):
    settings = Settings(
        data_dir=tmp_path / "photos", database_path=tmp_path / "state.sqlite3",
        web_dist=tmp_path / "no-web", access_code="", demo_password=PASSWORD,
        worker_backend="mock",
    )
    app = create_app(settings, serve_web=False)
    with TestClient(app) as client:
        response = client.post(
            "/v1/auth/login", json={"username": "demo", "password": PASSWORD}, headers=ORIGIN,
        )
        assert response.status_code == 200
        client.headers.update({**ORIGIN, "X-SmartCrop-CSRF": response.json()["csrf_token"]})
        yield client, app, settings, response.json()["user"]["id"]


def _update(client: TestClient, **values):
    body = client.get("/v1/preferences").json()
    return client.put("/v1/preferences", json={**body, **values})


def _project(client: TestClient, image: bytes, **values):
    return client.post(
        "/v1/projects", files={"file": ("test.jpg", image, "image/jpeg")}, data=values,
    )


def test_preferences_default_read_does_not_write_or_create_images(preference_app):
    client, app, settings, _owner = preference_app
    response = client.get("/v1/preferences")
    assert response.json() == {"revision": 1, "intent": DEFAULT_INTENT, "guides": ["thirds"]}
    assert response.headers["cache-control"] == "private, no-store"
    with app.state.preferences._connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM account_preferences").fetchone()[0] == 0
    assert not list((settings.data_dir / "projects").iterdir())


def test_preferences_persist_through_refresh_logout_and_server_restart(preference_app):
    client, _app, settings, _owner = preference_app
    saved = _update(client, intent=CUSTOM_INTENT, guides=["center", "safe"])
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"revision": 2, "intent": CUSTOM_INTENT, "guides": ["center", "safe"]}
    assert client.get("/v1/preferences").json() == saved.json()
    assert client.post("/v1/auth/logout").status_code == 200
    assert client.get("/v1/preferences").status_code == 401
    with TestClient(create_app(settings, serve_web=False)) as restarted:
        response = restarted.post(
            "/v1/auth/login", json={"username": "demo", "password": PASSWORD}, headers=ORIGIN,
        )
        assert response.status_code == 200
        assert restarted.get("/v1/preferences").json() == saved.json()


def test_preferences_require_session_csrf_and_same_origin(preference_app):
    client, app, _settings, _owner = preference_app
    body = client.get("/v1/preferences").json()
    with TestClient(app) as guest:
        assert guest.get("/v1/preferences").status_code == 401
        assert guest.put("/v1/preferences", json=body, headers=ORIGIN).status_code == 401
    csrf = client.headers.pop("X-SmartCrop-CSRF")
    assert client.put("/v1/preferences", json=body).status_code == 403
    client.headers["X-SmartCrop-CSRF"] = csrf
    assert client.put(
        "/v1/preferences", json=body, headers={"Origin": "https://untrusted.example"},
    ).status_code == 403
    assert client.get("/v1/preferences").json() == body


@pytest.mark.parametrize("invalid", [
    {"guides": ["golden"]}, {"guides": ["thirds", "thirds"]}, {"guides": None},
    {"guides": "thirds"}, {"guides": ["thirds", "center", "diagonal", "safe", "thirds"]},
    {"revision": 0}, {"revision": True}, {"revision": "1"}, {"unexpected": "field"},
    {"intent": {"scene": "unknown"}},
    {"intent": {"aspect_ratio": "custom"}},
    {"intent": {"aspect_ratio": "1:1", "output_template": "social_cover"}},
    {"intent": {**CUSTOM_INTENT, "custom_ratio": {"width": 100, "height": 1}}},
])
def test_preferences_reject_invalid_updates_without_mutating(preference_app, invalid):
    client, _app, _settings, _owner = preference_app
    initial = client.get("/v1/preferences").json()
    response = client.put("/v1/preferences", json={**initial, **invalid})
    assert response.status_code == 422
    assert client.get("/v1/preferences").json() == initial


@pytest.mark.parametrize("missing", ["revision", "intent", "guides"])
def test_preference_put_requires_complete_document(preference_app, missing):
    client, _app, _settings, _owner = preference_app
    body = client.get("/v1/preferences").json()
    del body[missing]
    assert client.put("/v1/preferences", json=body).status_code == 422


def test_empty_guides_and_all_guides_are_supported(preference_app):
    client, _app, _settings, _owner = preference_app
    assert _update(client, guides=[]).json()["guides"] == []
    all_guides = ["thirds", "center", "diagonal", "safe"]
    assert _update(client, guides=all_guides).json()["guides"] == all_guides


def test_preferences_compare_and_swap_rejects_stale_tab(preference_app):
    client, _app, _settings, _owner = preference_app
    stale = client.get("/v1/preferences").json()
    saved = client.put("/v1/preferences", json={**stale, "guides": []}).json()
    conflict = client.put("/v1/preferences", json={**stale, "guides": ["center"]})
    assert conflict.status_code == 409
    assert client.get("/v1/preferences").json() == saved


def test_preference_updates_are_isolated_by_owner_and_have_foreign_key(preference_app):
    client, app, _settings, owner = preference_app
    assert _update(client, guides=["safe"]).status_code == 200
    store = app.state.preferences
    with store._connect() as connection:
        connection.execute(
            "INSERT INTO auth_users SELECT 'another-owner','another-user','Another',"
            "password_hash,1 FROM auth_users WHERE id=?", (owner,),
        )
    other = store.get("another-owner")
    assert other["revision"] == 1 and other["guides"] == ["thirds"]
    assert store.save("another-owner", {**other, "guides": []})["guides"] == []
    assert client.get("/v1/preferences").json()["guides"] == ["safe"]
    with pytest.raises(sqlite3.IntegrityError):
        store.save("nonexistent-owner", {"revision": 1, "intent": DEFAULT_INTENT, "guides": []})
    with store._connect() as connection:
        connection.execute("DELETE FROM auth_users WHERE id='another-owner'")
        assert connection.execute(
            "SELECT COUNT(*) FROM account_preferences WHERE owner_id='another-owner'",
        ).fetchone()[0] == 0


def test_preference_concurrent_first_writes_have_one_winner(preference_app):
    _client, app, settings, owner = preference_app
    initial = app.state.preferences.get(owner)

    def write(index):
        store = PreferenceStore(settings.database_path)
        try:
            return store.save(owner, {**initial, "guides": [] if index % 2 else ["safe"]})
        except PreferenceConflict:
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(write, range(6)))
    winners = [result for result in results if result]
    assert len(winners) == 1
    assert app.state.preferences.get(owner) == winners[0]


def test_stored_preferences_are_validated_instead_of_silently_reset(preference_app, jpeg_bytes):
    client, app, _settings, owner = preference_app
    valid = _update(client, guides=["safe"]).json()
    with app.state.preferences._connect() as connection:
        connection.execute(
            "UPDATE account_preferences SET preferences_json=? WHERE owner_id=?",
            (json.dumps({"intent": DEFAULT_INTENT, "guides": ["unsupported"]}), owner),
        )
    assert client.get("/v1/preferences").status_code == 422
    assert client.put("/v1/preferences", json=valid).status_code == 422
    assert _project(client, jpeg_bytes).status_code == 422
    assert client.get("/v1/projects").json()["items"] == []
    explicit = _project(client, jpeg_bytes, scene="general", aspect_ratio="free", guides="[]")
    assert explicit.status_code == 201
    with app.state.preferences._connect() as connection:
        assert "unsupported" in connection.execute(
            "SELECT preferences_json FROM account_preferences WHERE owner_id=?", (owner,),
        ).fetchone()[0]


def test_new_projects_snapshot_preferences_and_existing_projects_do_not_change(
    preference_app, jpeg_bytes,
):
    client, _app, _settings, _owner = preference_app
    old = _project(client, jpeg_bytes).json()
    assert old["draft"]["guides"] == ["thirds"]
    assert _update(client, intent=CUSTOM_INTENT, guides=["center", "safe"]).status_code == 200
    created = _project(client, jpeg_bytes)
    assert created.status_code == 201, created.text
    created = created.json()
    assert created["intent"] == CUSTOM_INTENT
    assert created["draft"]["guides"] == ["center", "safe"]
    overridden = _project(
        client, jpeg_bytes, scene="portrait", aspect_ratio="1:1", output_template="avatar",
        guides="[]",
    ).json()
    assert overridden["intent"]["scene"] == "portrait"
    assert overridden["intent"]["aspect_ratio"] == "1:1"
    assert overridden["draft"]["guides"] == []
    partial = _project(client, jpeg_bytes, scene="portrait").json()
    assert partial["intent"] == {**DEFAULT_INTENT, "scene": "portrait"}
    assert partial["draft"]["guides"] == ["center", "safe"]
    assert _update(client, intent=DEFAULT_INTENT, guides=[]).status_code == 200
    assert client.get(f"/v1/projects/{created['id']}").json() == created
    assert client.get(f"/v1/projects/{old['id']}").json() == old


@pytest.mark.parametrize("guides", ["not-json", "null", '"thirds"', '["golden"]',
                                     '["safe","safe"]', '{}'])
def test_project_creation_rejects_malformed_guide_overrides(preference_app, jpeg_bytes, guides):
    client, _app, _settings, _owner = preference_app
    response = _project(client, jpeg_bytes, guides=guides)
    assert response.status_code == 422
    assert client.get("/v1/projects").json()["items"] == []
