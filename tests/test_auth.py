from __future__ import annotations

import hashlib
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from smartcrop_api.auth import AuthService, register_auth_routes
from smartcrop_runtime import Settings

ORIGIN = {"Origin": "http://testserver"}
PASSWORD = "test-only-demo-passphrase"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        database_path=tmp_path / "data" / "smartcrop.sqlite3",
        web_dist=tmp_path / "web",
        access_code="legacy-access-is-not-user-identity",
        demo_password=PASSWORD,
    )


def make_client(settings: Settings) -> tuple[TestClient, AuthService]:
    auth = AuthService(settings)
    auth.initialize()
    app = FastAPI()
    register_auth_routes(app, auth)

    @app.get("/protected")
    def protected(request: Request):
        return auth.require_user(request).public_user()

    @app.post("/protected")
    def write(request: Request):
        return auth.require_user(request, write=True).public_user()

    scheme = "https" if settings.session_cookie_secure else "http"
    return TestClient(app, base_url=f"{scheme}://testserver"), auth


def login(client: TestClient, password: str = PASSWORD, username: str = "demo"):
    return client.post(
        "/v1/auth/login",
        json={"username": username, "password": password},
        headers={"Origin": str(client.base_url).rstrip("/")},
    )


def db_row(settings: Settings, query: str, parameters: tuple = ()) -> sqlite3.Row:
    with sqlite3.connect(settings.database_path) as connection:
        connection.row_factory = sqlite3.Row
        result = connection.execute(query, parameters).fetchone()
        assert result is not None
        return result


def test_guest_response_is_private_and_access_code_is_not_an_account(settings: Settings):
    client, _ = make_client(settings)
    response = client.get("/v1/auth/session")
    assert response.json() == {"user": None, "csrf_token": None}
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/protected").status_code == 401
    assert (
        client.get("/protected", headers={"X-SmartCrop-Access": settings.access_code}).status_code
        == 401
    )
    assert client.get("/protected", cookies={"smartcrop_session": "forged" * 8}).status_code == 401


def test_login_exposes_only_public_identity_and_a_separate_csrf_token(settings: Settings, caplog):
    client, _ = make_client(settings)
    response = login(client)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"user", "csrf_token"}
    assert set(body["user"]) == {"id", "username", "display_name"}
    assert body["user"]["username"] == "demo"
    assert body["user"]["display_name"] == "演示摄影师"
    assert len(body["csrf_token"]) == 64
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    assert "max-age=604800" in cookie
    assert "secure" not in cookie
    token = client.cookies["smartcrop_session"]
    assert token != body["csrf_token"]
    assert token not in response.text and PASSWORD not in response.text
    assert PASSWORD not in caplog.text and token not in caplog.text
    assert PASSWORD not in repr(settings)
    stored = db_row(settings, "SELECT * FROM auth_sessions")
    assert stored["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(dict(stored))
    user = db_row(settings, "SELECT * FROM auth_users")
    assert user["password_hash"].startswith("pbkdf2_sha256$600000$")
    assert PASSWORD not in user["password_hash"]
    assert not (settings.data_dir / "demo-credentials.txt").exists()
    assert client.get("/v1/auth/session").json() == body


def test_session_is_not_shared_between_clients_or_injected_through_headers(settings: Settings):
    client, _ = make_client(settings)
    assert login(client).status_code == 200
    other = TestClient(client.app)
    assert other.get("/v1/auth/session").json()["user"] is None
    assert (
        other.get(
            "/protected",
            headers={
                "Authorization": f"Bearer {client.cookies['smartcrop_session']}",
                "X-SmartCrop-Access": settings.access_code,
            },
        ).status_code
        == 401
    )


def test_unknown_user_and_wrong_password_have_identical_safe_errors(settings: Settings):
    client, _ = make_client(settings)
    unknown = login(client, username="not-the-demo-user")
    wrong = login(client, password="wrong-secret-never-echo")
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() == {"detail": "账号或密码不正确"}
    assert "wrong-secret-never-echo" not in wrong.text
    assert "set-cookie" not in wrong.headers


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Origin": "http://evil.test"},
        {"Origin": "null"},
        {"Origin": "https://testserver"},
        {"Origin": "http://testserver.evil.test"},
        {"Origin": "http://testserver", "Sec-Fetch-Site": "cross-site"},
        {"Referer": "http://evil.test/page"},
        {"Sec-Fetch-Site": "same-site"},
    ],
)
def test_login_rejects_missing_cross_site_or_wrong_scheme_origins(settings: Settings, headers):
    client, _ = make_client(settings)
    response = client.post(
        "/v1/auth/login",
        json={
            "username": "demo",
            "password": PASSWORD,
        },
        headers=headers,
    )
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "headers",
    [
        {"Referer": "http://testserver/workspace"},
        {"Sec-Fetch-Site": "same-origin"},
        {"Origin": "http://testserver:80"},
    ],
)
def test_same_origin_referer_fetch_metadata_and_default_port_are_supported(
    settings: Settings, headers
):
    client, _ = make_client(settings)
    response = client.post(
        "/v1/auth/login",
        json={
            "username": "demo",
            "password": PASSWORD,
        },
        headers=headers,
    )
    assert response.status_code == 200


def test_login_requires_json_and_never_echoes_invalid_credentials(settings: Settings):
    client, _ = make_client(settings)
    response = client.post(
        "/v1/auth/login",
        data={
            "username": "demo",
            "password": PASSWORD,
        },
        headers=ORIGIN,
    )
    assert response.status_code == 415
    for payload in [
        {"username": "demo", "password": [PASSWORD]},
        {"username": "demo", "password": PASSWORD, "unexpected": PASSWORD},
        {"username": "demo", "password": PASSWORD * 100},
        [PASSWORD],
    ]:
        response = client.post("/v1/auth/login", json=payload, headers=ORIGIN)
        assert response.status_code == 400
        assert PASSWORD not in response.text
    response = client.post(
        "/v1/auth/login",
        content=b"{" + b"x" * 9000,
        headers={**ORIGIN, "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    response = client.post(
        "/v1/auth/login",
        content="{bad-json",
        headers={**ORIGIN, "Content-Type": "application/json"},
    )
    assert response.status_code == 400


def test_authenticated_writes_need_both_csrf_and_same_origin(settings: Settings):
    client, _ = make_client(settings)
    csrf = login(client).json()["csrf_token"]
    assert client.get("/protected").status_code == 200
    assert client.post("/protected", headers=ORIGIN).status_code == 403
    assert client.post("/protected", headers={"X-SmartCrop-CSRF": csrf}).status_code == 403
    assert (
        client.post("/protected", headers={**ORIGIN, "X-SmartCrop-CSRF": "wrong"}).status_code
        == 403
    )
    assert (
        client.post(
            "/protected",
            headers={
                "Origin": "http://evil.test",
                "X-SmartCrop-CSRF": csrf,
            },
        ).status_code
        == 403
    )
    assert (
        client.post("/protected", headers={**ORIGIN, "X-SmartCrop-CSRF": csrf}).status_code == 200
    )


def test_logout_revokes_the_database_session_and_removes_cookie(settings: Settings):
    client, _ = make_client(settings)
    csrf = login(client).json()["csrf_token"]
    token = client.cookies["smartcrop_session"]
    assert client.post("/v1/auth/logout", headers=ORIGIN).status_code == 403
    response = client.post("/v1/auth/logout", headers={**ORIGIN, "X-SmartCrop-CSRF": csrf})
    assert response.status_code == 200
    assert response.json() == {"user": None, "csrf_token": None}
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert db_row(settings, "SELECT COUNT(*) AS n FROM auth_sessions")["n"] == 0
    assert client.get("/protected", cookies={"smartcrop_session": token}).status_code == 401


def test_login_rotates_cookie_and_rejects_previous_token(settings: Settings):
    client, _ = make_client(settings)
    first = login(client).json()
    old_token = client.cookies["smartcrop_session"]
    second = login(client).json()
    assert client.cookies["smartcrop_session"] != old_token
    assert second["user"] == first["user"]
    assert second["csrf_token"] != first["csrf_token"]
    stranger = TestClient(client.app)
    assert stranger.get("/protected", cookies={"smartcrop_session": old_token}).status_code == 401
    assert db_row(settings, "SELECT COUNT(*) AS n FROM auth_sessions")["n"] == 1


def test_absolute_expiry_is_not_extended_by_session_reads(settings: Settings, monkeypatch):
    now = 1_800_000_000.0
    monkeypatch.setattr("smartcrop_api.auth.time.time", lambda: now)
    client, _ = make_client(replace(settings, session_ttl_seconds=10))
    assert login(client).status_code == 200
    now += 9
    assert client.get("/protected").status_code == 200
    now += 1
    assert client.get("/protected").status_code == 401
    assert client.get("/v1/auth/session").json() == {"user": None, "csrf_token": None}


def test_restart_keeps_identity_hash_and_session(settings: Settings):
    first, _ = make_client(settings)
    identity = login(first).json()["user"]
    token = first.cookies["smartcrop_session"]
    before = db_row(settings, "SELECT password_hash FROM auth_users")["password_hash"]
    second, _ = make_client(settings)
    second.cookies.set("smartcrop_session", token)
    assert second.get("/v1/auth/session").json()["user"] == identity
    assert db_row(settings, "SELECT password_hash FROM auth_users")["password_hash"] == before


def test_environment_password_change_revokes_existing_sessions(settings: Settings):
    old, _ = make_client(settings)
    user = login(old).json()["user"]
    token = old.cookies["smartcrop_session"]
    changed, _ = make_client(replace(settings, demo_password="replacement-test-password"))
    changed.cookies.set("smartcrop_session", token)
    assert changed.get("/protected").status_code == 401
    assert login(changed).status_code == 401
    assert login(changed, password="replacement-test-password").json()["user"] == user


def test_generated_credentials_are_private_stable_and_not_regenerated_when_file_is_deleted(
    settings: Settings,
    caplog,
):
    generated_settings = replace(settings, demo_password="")
    client, _ = make_client(generated_settings)
    path = settings.data_dir / "demo-credentials.txt"
    content = path.read_text(encoding="utf-8")
    password = dict(
        line.split("=", 1)
        for line in content.splitlines()
        if "=" in line and not line.startswith("#")
    )["password"]
    assert len(password) >= 24
    assert password not in caplog.text
    assert password not in client.get("/v1/auth/session").text
    assert login(client, password=password).status_code == 200
    make_client(generated_settings)
    assert path.read_text(encoding="utf-8") == content
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    before = db_row(settings, "SELECT password_hash FROM auth_users")["password_hash"]
    path.unlink()
    restarted, _ = make_client(generated_settings)
    assert not path.exists()
    assert db_row(settings, "SELECT password_hash FROM auth_users")["password_hash"] == before
    assert login(restarted, password=password).status_code == 200


def test_existing_file_is_not_imported_as_the_password_for_a_new_database(settings: Settings):
    settings.ensure_directories()
    path = settings.data_dir / "demo-credentials.txt"
    path.write_text("username=demo\npassword=untrusted-file-password\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="数据库中没有对应账号"):
        AuthService(replace(settings, demo_password="")).initialize()
    assert path.read_text(encoding="utf-8").endswith("password=untrusted-file-password\n")


def test_credentials_path_cannot_follow_a_symbolic_link(settings: Settings, tmp_path: Path):
    settings.ensure_directories()
    target = tmp_path / "untouched-private-file.txt"
    target.write_text("must-not-read-or-change", encoding="utf-8")
    path = settings.data_dir / "demo-credentials.txt"
    try:
        path.symlink_to(target)
    except OSError:
        pytest.skip("Creating a symbolic link requires privileges on this host")
    with pytest.raises(RuntimeError, match="无链接"):
        AuthService(settings).initialize()
    assert target.read_text(encoding="utf-8") == "must-not-read-or-change"


def test_credentials_path_cannot_modify_a_hard_link(settings: Settings, tmp_path: Path):
    settings.ensure_directories()
    target = tmp_path / "untouched-private-file.txt"
    target.write_text("must-not-read-or-change", encoding="utf-8")
    path = settings.data_dir / "demo-credentials.txt"
    try:
        path.hardlink_to(target)
    except OSError:
        pytest.skip("Creating a hard link is unavailable on this host")
    with pytest.raises(RuntimeError, match="无链接"):
        AuthService(settings).initialize()
    assert target.read_text(encoding="utf-8") == "must-not-read-or-change"


def test_environment_password_retires_the_obsolete_initial_password_file(settings: Settings):
    generated = replace(settings, demo_password="")
    client, _ = make_client(generated)
    path = settings.data_dir / "demo-credentials.txt"
    old = dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
    )["password"]
    original_id = login(client, password=old).json()["user"]["id"]
    updated, _ = make_client(settings)
    retired = path.read_text(encoding="utf-8")
    assert old not in retired and PASSWORD not in retired
    assert "不再包含有效密码" in retired
    assert login(updated, password=old).status_code == 401
    assert login(updated).json()["user"]["id"] == original_id
    # Removing the environment override is not an implicit password reset.
    restarted, _ = make_client(generated)
    assert login(restarted).json()["user"]["id"] == original_id
    assert path.read_text(encoding="utf-8") == retired


@pytest.mark.skipif(os.name == "nt", reason="Windows mode bits do not define NTFS permissions")
def test_restart_tightens_existing_credentials_permissions(settings: Settings):
    generated = replace(settings, demo_password="")
    make_client(generated)
    path = settings.data_dir / "demo-credentials.txt"
    path.chmod(0o644)
    AuthService(generated).initialize()
    assert path.stat().st_mode & 0o777 == 0o600


def test_only_the_current_configured_demo_identity_can_log_in(settings: Settings):
    previous, _ = make_client(settings)
    old_token = login(previous).cookies["smartcrop_session"]
    current, _ = make_client(replace(settings, demo_username="new-demo"))
    current.cookies.set("smartcrop_session", old_token)
    assert current.get("/protected").status_code == 401
    assert login(current, username="demo").status_code == 401
    assert login(current, username="new-demo").status_code == 200
    assert db_row(settings, "SELECT COUNT(*) AS n FROM auth_users WHERE active=1")["n"] == 1


def test_concurrent_first_start_creates_one_stable_demo_identity(settings: Settings):
    generated = replace(settings, demo_password="")
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(lambda _: AuthService(generated).initialize(), range(2)))
    assert db_row(settings, "SELECT COUNT(*) AS n FROM auth_users")["n"] == 1
    content = (settings.data_dir / "demo-credentials.txt").read_text(encoding="utf-8")
    password = dict(
        line.split("=", 1)
        for line in content.splitlines()
        if "=" in line and not line.startswith("#")
    )["password"]
    client, _ = make_client(generated)
    assert login(client, password=password).status_code == 200


def test_login_rate_limit_survives_restart(settings: Settings):
    client, _ = make_client(settings)
    for _ in range(10):
        assert login(client, password="wrong").status_code == 401
    restarted, _ = make_client(settings)
    limited = login(restarted)
    assert limited.status_code == 429
    assert 0 < int(limited.headers["retry-after"]) <= 900


def test_concurrent_login_requests_cannot_bypass_the_shared_limit(settings: Settings):
    client, _ = make_client(settings)
    with ThreadPoolExecutor(max_workers=6) as executor:
        statuses = list(
            executor.map(
                lambda _: login(TestClient(client.app), password="wrong").status_code, range(14)
            )
        )
    assert statuses.count(401) == 10
    assert statuses.count(429) == 4


def test_untrusted_forwarded_headers_do_not_change_the_origin_check(settings: Settings):
    client, _ = make_client(settings)
    response = client.post(
        "/v1/auth/login",
        json={"username": "demo", "password": PASSWORD},
        headers={
            "Origin": "https://testserver",
            "X-Forwarded-Proto": "https",
            "Forwarded": "proto=https;host=testserver",
        },
    )
    assert response.status_code == 403


def test_deeply_nested_json_is_a_safe_bad_request(settings: Settings):
    client, _ = make_client(settings)
    response = client.post(
        "/v1/auth/login",
        content="[" * 1100 + "]" * 1100,
        headers={**ORIGIN, "Content-Type": "application/json"},
    )
    assert response.status_code == 400


def test_secure_cookie_is_explicitly_enabled_for_https(settings: Settings):
    client, _ = make_client(replace(settings, session_cookie_secure=True))
    response = login(client)
    assert response.status_code == 200
    assert "; secure" in response.headers["set-cookie"].lower()
    assert client.get("/protected").status_code == 200


def test_auth_settings_load_from_environment_and_hide_password(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SMARTCROP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SMARTCROP_DEMO_USERNAME", "configured-demo")
    monkeypatch.setenv("SMARTCROP_DEMO_DISPLAY_NAME", "配置摄影师")
    monkeypatch.setenv("SMARTCROP_DEMO_PASSWORD", "environment-only-secret")
    monkeypatch.setenv("SMARTCROP_SESSION_TTL_SECONDS", "600")
    monkeypatch.setenv("SMARTCROP_SESSION_COOKIE_SECURE", "true")
    loaded = Settings.from_env(tmp_path)
    assert loaded.demo_username == "configured-demo"
    assert loaded.demo_display_name == "配置摄影师"
    assert loaded.demo_password == "environment-only-secret"
    assert "environment-only-secret" not in repr(loaded)
    assert loaded.session_ttl_seconds == 600
    assert loaded.session_cookie_secure


def test_private_project_job_cannot_spawn_an_unprotected_legacy_review(
    settings: Settings,
    jpeg_bytes: bytes,
):
    from smartcrop_api import create_app
    from smartcrop_worker import Worker
    from smartcrop_worker.backends import MockBackend

    configured = replace(settings, access_code="")
    app = create_app(configured, serve_web=False)
    with TestClient(app) as client:
        csrf = login(client).json()["csrf_token"]
        client.headers.update({**ORIGIN, "X-SmartCrop-CSRF": csrf})
        created = client.post(
            "/v1/projects",
            files={
                "file": ("private-photo.jpg", jpeg_bytes, "image/jpeg"),
            },
        )
        assert created.status_code == 201
        project_id = created.json()["id"]
        submitted = client.post(f"/v1/projects/{project_id}/analyze")
        assert submitted.status_code == 202
        job_id = submitted.json()["id"]
        assert Worker(configured, app.state.store, MockBackend()).run_once()
        assert client.get(f"/v1/jobs/{job_id}").json()["status"] == "succeeded"
        before = db_row(configured, "SELECT COUNT(*) AS n FROM jobs")["n"]
        denied = client.post(f"/v1/jobs/{job_id}/review")
        assert denied.status_code == 409
        assert "不支持终稿复评" in denied.json()["detail"]
        assert db_row(configured, "SELECT COUNT(*) AS n FROM jobs")["n"] == before
        guest = TestClient(app)
        assert guest.get(f"/v1/jobs/{job_id}/artifacts/preview").status_code == 401


@pytest.mark.parametrize(
    "changes",
    [
        {"session_ttl_seconds": 0},
        {"demo_username": " "},
        {"demo_username": "demo\npassword=injected"},
        {"demo_password": "x" * 1025},
    ],
)
def test_invalid_auth_settings_fail_early(settings: Settings, changes):
    with pytest.raises(ValueError):
        replace(settings, **changes)
