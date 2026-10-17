from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
import stat
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from smartcrop_runtime import Settings

SESSION_COOKIE = "smartcrop_session"
CSRF_HEADER = "X-SmartCrop-CSRF"
_PASSWORD_ITERATIONS = 600_000
_LOGIN_ATTEMPT_LIMIT = 10
_LOGIN_WINDOW_SECONDS = 15 * 60
_MAX_LOGIN_BODY_BYTES = 8192
_CREDENTIALS_HEADER = "# 仅首次生成；如配置 SMARTCROP_DEMO_PASSWORD，则以环境变量为准。\n"
_RETIRED_CREDENTIALS = (
    "# 此账号的密码已由 SMARTCROP_DEMO_PASSWORD 环境变量管理。\n"
    "# 本文件不再包含有效密码；移除环境变量不会重置数据库中的现有密码。\n"
)


@dataclass(frozen=True)
class AuthActor:
    id: str
    username: str
    display_name: str
    csrf_token: str = field(repr=False)

    def public_user(self) -> dict[str, str]:
        return {"id": self.id, "username": self.username, "display_name": self.display_name}


def _password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${_PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_hex, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256" or not 100_000 <= int(iterations) <= 2_000_000:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _csrf_token(token: str) -> str:
    return hmac.new(token.encode(), b"smartcrop-csrf-v1", hashlib.sha256).hexdigest()


def _origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username or parsed.password:
            return None
        return (
            parsed.scheme,
            parsed.hostname.lower(),
            parsed.port or (443 if parsed.scheme == "https" else 80),
        )
    except ValueError:
        return None


def _require_same_origin(request: Request) -> None:
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site in {"cross-site", "same-site"}:
        raise HTTPException(status_code=403, detail="请从当前站点发起操作")
    expected = _origin(str(request.base_url))
    claimed = request.headers.get("origin")
    if claimed is not None:
        actual = _origin(claimed)
        if not actual or actual != expected:
            raise HTTPException(status_code=403, detail="请从当前站点发起操作")
        return
    referer = request.headers.get("referer")
    if referer:
        if _origin(referer) != expected:
            raise HTTPException(status_code=403, detail="请从当前站点发起操作")
        return
    if fetch_site != "same-origin":
        raise HTTPException(status_code=403, detail="无法确认操作来源，请刷新页面后重试")


def _session_payload(actor: AuthActor | None) -> dict:
    return {
        "user": actor.public_user() if actor else None,
        "csrf_token": actor.csrf_token if actor else None,
    }


def _private_response(actor: AuthActor | None) -> JSONResponse:
    return JSONResponse(
        _session_payload(actor), headers={"Cache-Control": "no-store", "Pragma": "no-cache"}
    )


class AuthService:
    """One configured demo identity, backed by persistent password/session records."""

    def __init__(self, settings: Settings):
        self.settings = settings

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.settings.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initial_password(self) -> str:
        path = self.settings.data_dir / "demo-credentials.txt"
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # Never import an untrusted old file (or follow a link) into a new
            # database. A missing/replaced database needs an explicit password.
            raise RuntimeError(
                "已有演示凭据文件，但数据库中没有对应账号；请检查数据目录或配置演示密码"
            ) from None
        password = secrets.token_urlsafe(24)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as credentials:
            credentials.write(
                _CREDENTIALS_HEADER
                + f"username={self.settings.demo_username}\npassword={password}\n"
            )
            credentials.flush()
            os.fsync(credentials.fileno())
        return password

    def _protect_credentials_file(self, *, retire: bool = False) -> None:
        path = self.settings.data_dir / "demo-credentials.txt"
        try:
            before = path.lstat()
        except FileNotFoundError:
            return
        reparse = getattr(before, "st_file_attributes", 0) & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
        )
        if not stat.S_ISREG(before.st_mode) or reparse or before.st_nlink != 1:
            raise RuntimeError("演示凭据路径必须是无链接的常规私有文件")
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
            ):
                raise RuntimeError("演示凭据文件在检查期间发生变化")
            if os.name != "nt":
                if opened.st_uid != os.getuid():
                    raise RuntimeError("演示凭据文件必须由当前服务用户拥有")
                os.fchmod(descriptor, 0o600)
            # Windows file mode bits do not define NTFS ACLs. Its data directory
            # must remain private to the service user, as with the .env file.
            if retire:
                with os.fdopen(descriptor, "r+", encoding="utf-8", newline="\n") as credentials:
                    descriptor = -1
                    content = credentials.read(_MAX_LOGIN_BODY_BYTES + 1)
                    if content.startswith(_CREDENTIALS_HEADER) and "\npassword=" in content:
                        credentials.seek(0)
                        credentials.truncate()
                        credentials.write(_RETIRED_CREDENTIALS)
                        credentials.flush()
                        os.fsync(credentials.fileno())
        finally:
            if descriptor != -1:
                os.close(descriptor)

    def initialize(self) -> None:
        self.settings.ensure_directories()
        self._protect_credentials_file()
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS auth_users (
                    id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES auth_users(id),
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
                CREATE TABLE IF NOT EXISTS auth_login_attempts (
                    client_hash TEXT PRIMARY KEY,
                    window_started REAL NOT NULL,
                    attempts INTEGER NOT NULL
                );
            """)
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM auth_users WHERE username = ?", (self.settings.demo_username,)
            ).fetchone()
            if row is None:
                password = self.settings.demo_password or self._initial_password()
                connection.execute(
                    "INSERT INTO auth_users VALUES (?, ?, ?, ?, 1)",
                    (
                        uuid.uuid4().hex,
                        self.settings.demo_username,
                        self.settings.demo_display_name,
                        _password_hash(password),
                    ),
                )
            else:
                if self.settings.demo_password and not _password_matches(
                    self.settings.demo_password, row["password_hash"]
                ):
                    connection.execute(
                        "UPDATE auth_users SET password_hash = ? WHERE id = ?",
                        (_password_hash(self.settings.demo_password), row["id"]),
                    )
                    connection.execute("DELETE FROM auth_sessions WHERE user_id = ?", (row["id"],))
                connection.execute(
                    "UPDATE auth_users SET display_name = ?, active = 1 WHERE id = ?",
                    (self.settings.demo_display_name, row["id"]),
                )
            # Changing the configured demo name never opens an additional login identity.
            connection.execute(
                "UPDATE auth_users SET active = 0 WHERE username != ?",
                (self.settings.demo_username,),
            )
            connection.execute(
                "DELETE FROM auth_sessions WHERE user_id IN "
                "(SELECT id FROM auth_users WHERE active=0)"
            )
            now = time.time()
            connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "DELETE FROM auth_login_attempts WHERE window_started <= ?",
                (now - _LOGIN_WINDOW_SECONDS,),
            )
        # Only after the new password hash commits may an obsolete initial
        # password be removed. No configured plaintext password is written.
        if self.settings.demo_password:
            self._protect_credentials_file(retire=True)

    def current_session(self, request: Request) -> AuthActor | None:
        token = request.cookies.get(SESSION_COOKIE, "")
        if not 32 <= len(token) <= 256 or not token.isascii():
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT u.id, u.username, u.display_name FROM auth_sessions s "
                "JOIN auth_users u ON s.user_id = u.id "
                "WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
                (_token_hash(token), time.time()),
            ).fetchone()
        if row is None:
            return None
        return AuthActor(row["id"], row["username"], row["display_name"], _csrf_token(token))

    def require_user(self, request: Request, write: bool = False) -> AuthActor:
        actor = self.current_session(request)
        if actor is None:
            raise HTTPException(status_code=401, detail="请先登录演示账号")
        if write:
            _require_same_origin(request)
            supplied = request.headers.get(CSRF_HEADER, "")
            if (
                not supplied.isascii()
                or not supplied
                or not hmac.compare_digest(supplied, actor.csrf_token)
            ):
                raise HTTPException(status_code=403, detail="操作验证已失效，请刷新页面后重试")
        return actor

    def _reserve_login_attempt(self, request: Request) -> None:
        # Use the actual peer, not an untrusted X-Forwarded-For header. A trusted
        # reverse proxy must configure its server's forwarded-header handling.
        peer = request.client.host if request.client else "unknown"
        key = _token_hash(f"login:{peer}")
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM auth_login_attempts WHERE client_hash = ?", (key,)
            ).fetchone()
            if row is None or now - row["window_started"] >= _LOGIN_WINDOW_SECONDS:
                connection.execute(
                    "INSERT OR REPLACE INTO auth_login_attempts VALUES (?, ?, 1)", (key, now)
                )
            elif row["attempts"] >= _LOGIN_ATTEMPT_LIMIT:
                retry_after = max(
                    1, math.ceil(_LOGIN_WINDOW_SECONDS - (now - row["window_started"]))
                )
                raise HTTPException(
                    status_code=429,
                    detail="登录尝试过于频繁，请稍后重试",
                    headers={"Retry-After": str(retry_after)},
                )
            else:
                connection.execute(
                    "UPDATE auth_login_attempts SET attempts = attempts + 1 WHERE client_hash = ?",
                    (key,),
                )

    def login(self, request: Request, username: str, password: str) -> tuple[AuthActor, str]:
        self._reserve_login_attempt(request)
        with self._connect() as connection:
            # Password verification and session creation share the write lock,
            # so a concurrent password reset cannot leave an old-password session.
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM auth_users WHERE active = 1").fetchone()
            # Always verify the same stored hash, including an unknown username.
            matches = row is not None and _password_matches(password, row["password_hash"])
            if not matches or row["username"] != username:
                raise HTTPException(status_code=401, detail="账号或密码不正确")
            token = secrets.token_urlsafe(32)
            previous = request.cookies.get(SESSION_COOKIE, "")
            if previous:
                connection.execute(
                    "DELETE FROM auth_sessions WHERE token_hash = ?", (_token_hash(previous),)
                )
            now = time.time()
            connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO auth_sessions VALUES (?, ?, ?, ?)",
                (_token_hash(token), row["id"], now, now + self.settings.session_ttl_seconds),
            )
        actor = AuthActor(row["id"], row["username"], row["display_name"], _csrf_token(token))
        return actor, token

    def logout(self, request: Request) -> None:
        self.require_user(request, write=True)
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE token_hash = ?",
                (_token_hash(request.cookies[SESSION_COOKIE]),),
            )


async def _login_body(request: Request) -> tuple[str, str]:
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise HTTPException(status_code=415, detail="登录请求必须使用 JSON")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > _MAX_LOGIN_BODY_BYTES:
            raise HTTPException(status_code=413, detail="登录请求过大")
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(status_code=400, detail="登录请求格式不正确") from None
    if not isinstance(payload, dict) or set(payload) != {"username", "password"}:
        raise HTTPException(status_code=400, detail="请填写账号与密码")
    username, password = payload["username"], payload["password"]
    if not isinstance(username, str) or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="请填写账号与密码")
    if not 1 <= len(username) <= 128 or not 1 <= len(password) <= 1024:
        raise HTTPException(status_code=400, detail="账号或密码长度不正确")
    return username, password


def register_auth_routes(app: FastAPI, auth: AuthService) -> None:
    @app.get("/v1/auth/session")
    def session(request: Request) -> JSONResponse:
        actor = auth.current_session(request)
        response = _private_response(actor)
        if actor is None and request.cookies.get(SESSION_COOKIE):
            response.delete_cookie(
                SESSION_COOKIE,
                path="/",
                httponly=True,
                secure=auth.settings.session_cookie_secure,
                samesite="lax",
            )
        return response

    @app.post("/v1/auth/login")
    async def login(request: Request) -> JSONResponse:
        _require_same_origin(request)
        username, password = await _login_body(request)
        actor, token = await asyncio.to_thread(auth.login, request, username, password)
        response = _private_response(actor)
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=auth.settings.session_ttl_seconds,
            httponly=True,
            secure=auth.settings.session_cookie_secure,
            samesite="lax",
            path="/",
        )
        return response

    @app.post("/v1/auth/logout")
    def logout(request: Request) -> JSONResponse:
        auth.logout(request)
        response = _private_response(None)
        response.delete_cookie(
            SESSION_COOKIE,
            path="/",
            httponly=True,
            secure=auth.settings.session_cookie_secure,
            samesite="lax",
        )
        return response
