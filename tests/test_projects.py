from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
import smartcrop_runtime.projects as project_module
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import ExifTags, Image, PngImagePlugin
from PIL.TiffImagePlugin import IFDRational
from smartcrop_api.app import _job_response
from smartcrop_api.projects import _blocking, register_project_routes
from smartcrop_contracts import AnalysisIntent
from smartcrop_runtime import JobStore, Settings, cleanup_expired_jobs
from smartcrop_runtime.projects import ProjectConflict, ProjectNotFound
from smartcrop_runtime.store import to_iso, utc_now
from smartcrop_worker import Worker
from smartcrop_worker.backends import MockBackend


class TestAuth:
    __test__ = False

    def require_user(self, request, *, write=False):
        owner_id = request.cookies.get("test-session")
        if owner_id not in {"owner-a", "owner-b"}:
            raise HTTPException(401, "请先登录")
        if write and request.headers.get("X-SmartCrop-CSRF") != "test-csrf":
            raise HTTPException(403, "请求校验失败")
        return SimpleNamespace(id=owner_id)


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "photos",
        database_path=tmp_path / "database" / "state.sqlite3",
        web_dist=tmp_path / "no-dist",
        access_code="",
        worker_backend="mock",
    )


def _app(settings: Settings):
    settings.ensure_directories()
    jobs = JobStore(settings.database_path)
    jobs.initialize()
    app = FastAPI()
    app.state.auth = TestAuth()
    projects = register_project_routes(
        app,
        settings,
        jobs,
        job_to_response=lambda job: _job_response(jobs, job, settings),
    )
    return app, jobs, projects


@pytest.fixture
def project_app(tmp_path: Path):
    settings = _settings(tmp_path)
    app, jobs, projects = _app(settings)
    with TestClient(app) as client:
        client.cookies.set("test-session", "owner-a")
        client.headers["X-SmartCrop-CSRF"] = "test-csrf"
        yield client, settings, jobs, projects


def _create(client: TestClient, payload: bytes, **intent: str) -> dict:
    response = client.post(
        "/v1/projects",
        files={"file": ("旅行照片.jpg", payload, "image/jpeg")},
        data=intent,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _decode(content: bytes) -> Image.Image:
    with Image.open(BytesIO(content)) as image:
        image.load()
        return image.copy()


def test_manual_project_is_persistent_without_creating_an_ai_job(project_app, jpeg_bytes):
    client, settings, jobs, _projects = project_app
    project = _create(client, jpeg_bytes, aspect_ratio="4:5", output_template="product_main")
    assert project["revision"] == 1
    assert project["state"] == "draft"
    assert project["reference"] is None and project["active_job_id"] is None
    assert project["published"] is None and project["archived_at"] is None
    assert project["draft"]["selected_candidate_id"] is None
    assert not project["draft"]["selection_explicit"]
    assert jobs.count_queued() == 0
    directory = settings.data_dir / "projects" / project["id"]
    assert directory.is_dir()
    assert all(path.is_relative_to(directory) for path in directory.iterdir())
    assert not list(settings.jobs_dir.glob("*"))
    crop = client.get(project["crop_url"])
    assert crop.status_code == 200
    assert crop.headers["cache-control"] == "private, no-store"
    with _decode(crop.content) as image:
        assert image.size == (480, 600)


def test_project_guides_survive_draft_archive_reload_and_restart(project_app, jpeg_bytes):
    client, settings, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes, guides='["center","safe"]')
    assert project["draft"]["guides"] == ["center", "safe"]
    saved = client.patch(
        f"/v1/projects/{project['id']}", json={"revision": 1, "guides": []},
    )
    assert saved.status_code == 200
    assert saved.json()["draft"]["guides"] == []
    archived = client.post(
        f"/v1/projects/{project['id']}/archive", json={"revision": saved.json()["revision"]},
    ).json()
    assert archived["published"]["guides"] == []
    assert archived["published"]["draft"]["guides"] == []
    assert not archived["has_draft_changes"]
    assert client.get(f"/v1/projects/{project['id']}/versions").json()["items"][0]["guides"] == []
    _new_app, _jobs, restarted = _app(settings)
    assert restarted.get_project(project["id"], "owner-a") == archived


@pytest.mark.parametrize("guides", [None, ["thirds", "thirds"], ["golden"], "safe"])
def test_project_guide_patch_rejects_invalid_values(project_app, jpeg_bytes, guides):
    client, _settings, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    response = client.patch(
        f"/v1/projects/{project['id']}", json={"revision": 1, "guides": guides},
    )
    assert response.status_code == 422
    assert client.get(f"/v1/projects/{project['id']}").json() == project


def test_project_patch_rejects_unknown_fields_without_mutating(project_app, jpeg_bytes):
    client, _settings, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    response = client.patch(
        f"/v1/projects/{project['id']}",
        json={"revision": 1, "guides": [], "unknown_setting": True},
    )
    assert response.status_code == 422
    assert client.get(f"/v1/projects/{project['id']}").json() == project


def test_legacy_drafts_and_archives_get_fixed_guides_without_false_unsaved_changes(
    project_app, jpeg_bytes,
):
    client, _settings, _jobs, projects = project_app
    project = _create(client, jpeg_bytes)
    archived = client.post(
        f"/v1/projects/{project['id']}/archive", json={"revision": 1},
    ).json()
    legacy_draft = {key: value for key, value in archived["draft"].items() if key != "guides"}
    with projects._connect() as connection:
        row = connection.execute(
            "SELECT published_json FROM projects WHERE id=?", (project["id"],),
        ).fetchone()
        legacy_archive = json.loads(row[0])
        legacy_archive.pop("guides")
        legacy_archive["draft"].pop("guides")
        connection.execute(
            "UPDATE projects SET draft_json=?,published_json=? WHERE id=?",
            (json.dumps(legacy_draft), json.dumps(legacy_archive), project["id"]),
        )
        connection.execute(
            "UPDATE project_versions SET snapshot_json=? WHERE project_id=?",
            (json.dumps(legacy_archive), project["id"]),
        )
    reopened = client.get(f"/v1/projects/{project['id']}").json()
    assert reopened["draft"]["guides"] == ["thirds"]
    assert reopened["published"]["draft"]["guides"] == ["thirds"]
    assert not reopened["has_draft_changes"]
    assert client.get(f"/v1/projects/{project['id']}/versions").json()["items"][0]["guides"] == [
        "thirds",
    ]
    assert client.patch(
        f"/v1/projects/{project['id']}", json={"revision": reopened["revision"], "guides": []},
    ).json()["draft"]["guides"] == []


def test_project_pagination_reads_more_than_one_hundred_without_losing_tied_rows(
    project_app,
    jpeg_bytes,
):
    client, _settings_value, _jobs, projects = project_app
    created = [_create(client, jpeg_bytes, title=f"照片-{index:03}") for index in range(105)]
    with projects._connect() as connection:
        connection.execute("UPDATE projects SET updated_at=?", ("2026-10-17T00:00:00+00:00",))
    first = client.get("/v1/projects").json()
    assert len(first["items"]) == 100 and first["next_offset"] == 100
    second = client.get("/v1/projects", params={"offset": first["next_offset"]}).json()
    assert len(second["items"]) == 5 and second["next_offset"] is None
    expected = sorted((project["id"] for project in created), reverse=True)
    assert [item["id"] for item in first["items"] + second["items"]] == expected
    offset, all_ids = 0, []
    while offset is not None:
        page = client.get("/v1/projects", params={"limit": 17, "offset": offset}).json()
        all_ids.extend(item["id"] for item in page["items"])
        offset = page["next_offset"]
    assert all_ids == expected
    assert client.get("/v1/projects", params={"offset": 999}).json() == {
        "items": [],
        "next_offset": None,
    }
    assert client.get("/v1/projects", params={"offset": -1}).status_code == 422


def test_project_pagination_offsets_apply_after_state_and_search_filters(project_app, jpeg_bytes):
    client, _settings_value, _jobs, _projects = project_app
    archived_ids = []
    for index in range(7):
        project = _create(
            client, jpeg_bytes, title=f"{'归档' if index % 2 == 0 else '草稿'}-{index}"
        )
        if index % 2 == 0:
            assert (
                client.post(
                    f"/v1/projects/{project['id']}/archive",
                    json={
                        "revision": project["revision"],
                    },
                ).status_code
                == 200
            )
            archived_ids.append(project["id"])
    first = client.get(
        "/v1/projects",
        params={
            "state": "archived",
            "search": "归档",
            "limit": 3,
        },
    ).json()
    assert len(first["items"]) == 3 and first["next_offset"] == 3
    second = client.get(
        "/v1/projects",
        params={
            "state": "archived",
            "search": "归档",
            "limit": 3,
            "offset": first["next_offset"],
        },
    ).json()
    assert len(second["items"]) == 1 and second["next_offset"] is None
    assert {item["id"] for item in first["items"] + second["items"]} == set(archived_ids)


def test_project_assets_strip_all_exif_and_png_text_metadata(project_app):
    client, _settings_value, _jobs, _projects = project_app
    exif = Image.Exif()
    exif[42033] = "private-camera-serial"
    exif[270] = "private-location-description"
    jpeg = BytesIO()
    Image.new("RGB", (160, 120), "green").save(jpeg, format="JPEG", exif=exif)
    project = _create(client, jpeg.getvalue())
    with _decode(client.get(project["original_url"]).content) as image:
        assert not image.getexif()
        assert "exif" not in image.info
    text = PngImagePlugin.PngInfo()
    text.add_text("GPSLatitude", "private-coordinate")
    png = BytesIO()
    Image.new("RGBA", (160, 120), (10, 20, 30, 100)).save(png, format="PNG", pnginfo=text)
    response = client.post(
        "/v1/projects",
        files={"file": ("transparent.png", png.getvalue(), "image/png")},
    )
    assert response.status_code == 201
    with _decode(client.get(response.json()["original_url"]).content) as image:
        assert image.mode == "RGBA"
        assert "GPSLatitude" not in image.info
    assert response.json()["exif"] == {}


@pytest.mark.parametrize("source_format", ["JPEG", "PNG", "WEBP"])
def test_camera_exif_survives_project_reload_but_not_persistent_image_assets(
    project_app, source_format,
):
    client, settings, _jobs, _projects = project_app
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "Canon"
    exif[ExifTags.Base.Model] = "Canon EOS R6"
    exif[ExifTags.IFD.Exif] = {
        ExifTags.Base.LensModel: "RF 24-105mm F4",
        ExifTags.Base.FocalLength: IFDRational(35, 1),
        ExifTags.Base.FNumber: IFDRational(28, 10),
        ExifTags.Base.ExposureTime: IFDRational(1, 125),
        ExifTags.Base.ISOSpeedRatings: 400,
        ExifTags.Base.DateTimeOriginal: "2026:10:19 18:30:00",
        ExifTags.Base.BodySerialNumber: "private-camera-serial",
        ExifTags.Base.MakerNote: b"private-maker-note",
    }
    exif[ExifTags.Base.Artist] = "private-author"
    exif[ExifTags.IFD.GPSInfo] = {
        1: "N", 2: (IFDRational(39), IFDRational(1), IFDRational(2)),
    }
    payload = BytesIO()
    # Alpha exercises the PNG normalized-original branch as well as JPEG.
    mode, color = ("RGBA", (10, 20, 30, 100)) if source_format == "PNG" else ("RGB", "green")
    Image.new(mode, (160, 120), color).save(payload, format=source_format, exif=exif)
    mime = "image/jpeg" if source_format == "JPEG" else f"image/{source_format.lower()}"
    response = client.post(
        "/v1/projects",
        files={"file": (f"camera.{source_format.lower()}", payload.getvalue(), mime)},
    )
    assert response.status_code == 201
    project = response.json()
    expected = {
        "camera_make": "Canon", "camera_model": "Canon EOS R6", "lens_model": "RF 24-105mm F4",
        "focal_length_mm": 35, "aperture": 2.8, "exposure_seconds": 0.008, "iso": 400,
    }
    assert project["exif"] == expected
    assert client.get(f"/v1/projects/{project['id']}").json()["exif"] == expected
    assert client.get("/v1/projects").json()["items"][0]["exif"] == expected
    archived = client.post(
        f"/v1/projects/{project['id']}/archive", json={"revision": 1},
    ).json()
    assert archived["exif"] == expected
    _new_app, _new_jobs, restarted = _app(settings)
    assert restarted.get_project(project["id"], "owner-a")["exif"] == expected
    with sqlite3.connect(settings.database_path) as connection:
        stored = connection.execute("SELECT exif_json FROM projects").fetchone()[0]
        assert json.loads(stored) == expected
        assert "private" not in stored and "2026:" not in stored
    for asset in ("original_url", "preview_url", "crop_url", "published_url"):
        image_bytes = client.get(archived[asset]).content
        with _decode(image_bytes) as image:
            assert not image.getexif()
            assert "exif" not in image.info
        assert b"private-camera-serial" not in image_bytes
        assert b"private-author" not in image_bytes


def test_project_import_keeps_valid_camera_fields_when_numeric_exif_is_malformed(project_app):
    client, _settings_value, _jobs, _projects = project_app
    exif = Image.Exif()
    exif[ExifTags.Base.Model] = "Camera with damaged measurements"
    exif[ExifTags.IFD.Exif] = {
        ExifTags.Base.FocalLength: IFDRational(0, 0),
        ExifTags.Base.FNumber: IFDRational(1, 0),
        ExifTags.Base.ExposureTime: IFDRational(0, 1),
        ExifTags.Base.ISOSpeedRatings: 0,
    }
    payload = BytesIO()
    Image.new("RGB", (160, 120), "green").save(payload, format="JPEG", exif=exif)
    project = _create(client, payload.getvalue())
    assert project["exif"] == {"camera_model": "Camera with damaged measurements"}
    assert client.get(project["crop_url"]).status_code == 200


def test_project_exif_schema_migration_preserves_legacy_work_and_assets(project_app, jpeg_bytes):
    client, settings, _jobs, projects = project_app
    legacy = _create(client, jpeg_bytes, title="已有作品")
    original = client.get(legacy["original_url"]).content
    with projects._connect() as connection:
        connection.execute("ALTER TABLE projects DROP COLUMN exif_json")
    _new_app, _new_jobs, migrated = _app(settings)
    restored = migrated.get_project(legacy["id"], "owner-a")
    assert restored == legacy
    assert restored["exif"] == {}
    assert migrated.asset_path(legacy["id"], "owner-a", "original").read_bytes() == original
    # Repeated initialization is harmless and later uploads still succeed.
    migrated.initialize()
    assert migrated.create_project(
        "owner-a", "新作品", jpeg_bytes, "image/jpeg", settings.max_upload_bytes, AnalysisIntent(),
    )["exif"] == {}


def test_revision_conflict_does_not_overwrite_draft(project_app, jpeg_bytes):
    client, _settings_value, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    edited = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "crop": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.6},
            "selection_note": "为标题保留空间",
            "selection_reasons": ["platform_fit"],
            "title": "已重命名的作品",
        },
    )
    assert edited.status_code == 200
    assert edited.json()["revision"] == 2
    conflict = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "selection_note": "迟到的说明",
        },
    )
    assert conflict.status_code == 409
    current = client.get(f"/v1/projects/{project['id']}").json()
    assert current["draft"]["selection_note"] == "为标题保留空间"
    assert current["draft"]["selected_candidate_id"] is None
    assert (
        client.get("/v1/projects", params={"search": "已重命名"}).json()["items"][0]["id"]
        == project["id"]
    )


def test_archive_is_immutable_and_new_draft_does_not_replace_it(project_app, jpeg_bytes):
    client, settings, _jobs, projects = project_app
    project = _create(client, jpeg_bytes)
    first = client.post(f"/v1/projects/{project['id']}/archive", json={"revision": 1}).json()
    assert first["state"] == "archived" and first["published"]["version"] == 1
    assert first["published"]["selected_candidate_id"] is None
    assert not first["has_draft_changes"]
    original_published = client.get(first["published_url"]).content
    changed = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": first["revision"],
            "crop": {"x": 0.2, "y": 0.2, "width": 0.5, "height": 0.5},
        },
    ).json()
    assert changed["state"] == "archived" and changed["has_draft_changes"]
    assert client.get(first["published_url"]).content == original_published
    stale = client.post(
        f"/v1/projects/{project['id']}/archive", json={"revision": first["revision"]}
    )
    assert stale.status_code == 409
    directory = settings.data_dir / "projects" / project["id"]
    assert len(list(directory.glob("published-*"))) == 1
    second = client.post(
        f"/v1/projects/{project['id']}/archive", json={"revision": changed["revision"]}
    ).json()
    assert second["published"]["version"] == 2
    assert second["published"]["width"] == 400 and second["published"]["height"] == 300
    assert len(client.get("/v1/projects").json()["items"]) == 1
    assert [v["version"] for v in projects.versions(project["id"], "owner-a")] == [2, 1]
    assert len(list(directory.glob("published-*"))) == 2
    assert first["published_url"].endswith("?version=1")
    assert second["published_url"].endswith("?version=2")
    assert client.get(first["published_url"]).content == original_published
    with _decode(client.get(second["published_url"]).content) as image:
        assert image.size == (400, 300)
    assert (
        client.get(f"/v1/projects/{project['id']}/assets/published?version=99").status_code == 404
    )


def test_crop_download_checks_revision_instead_of_returning_another_sessions_edit(
    project_app,
    jpeg_bytes,
):
    client, _settings_value, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    assert client.get(project["crop_url"] + "?revision=1").status_code == 200
    changed = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "crop": {"x": 0, "y": 0, "width": 0.5, "height": 0.5},
        },
    ).json()
    assert client.get(project["crop_url"] + "?revision=1").status_code == 409
    response = client.get(changed["crop_url"] + f"?revision={changed['revision']}")
    assert response.status_code == 200
    with _decode(response.content) as image:
        assert image.size == (400, 300)


def test_invalid_crop_and_upload_ratio_leave_project_unchanged(project_app, jpeg_bytes):
    client, _settings_value, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes, aspect_ratio="1:1", output_template="avatar")
    bad = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "crop": {"x": 0, "y": 0, "width": 1, "height": 1},
        },
    )
    assert bad.status_code == 422
    assert client.get(f"/v1/projects/{project['id']}").json()["revision"] == 1
    missing = client.post(
        "/v1/projects",
        files={"file": ("x.jpg", jpeg_bytes, "image/jpeg")},
        data={
            "aspect_ratio": "custom",
            "custom_ratio_width": "3",
        },
    )
    assert missing.status_code == 422
    assert len(client.get("/v1/projects").json()["items"]) == 1


def test_project_routes_enforce_cookie_csrf_and_owner(project_app, jpeg_bytes):
    client, _settings_value, _jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    client.cookies.clear()
    assert client.get("/v1/projects").status_code == 401
    assert client.get(project["original_url"]).status_code == 401
    client.cookies.set("test-session", "owner-b")
    assert client.get("/v1/projects").json()["items"] == []
    assert client.get(f"/v1/projects/{project['id']}").status_code == 404
    assert client.get(project["crop_url"]).status_code == 404
    assert client.delete(f"/v1/projects/{project['id']}").status_code == 404
    client.cookies.clear()
    client.cookies.set("test-session", "owner-a")
    del client.headers["X-SmartCrop-CSRF"]
    assert (
        client.patch(
            f"/v1/projects/{project['id']}", json={"revision": 1, "title": "changed"}
        ).status_code
        == 403
    )
    assert client.post(f"/v1/projects/{project['id']}/analyze").status_code == 403
    assert client.get(project["preview_url"]).status_code == 200


def test_ai_reference_survives_temporary_cleanup_and_store_api_restart(project_app, jpeg_bytes):
    client, settings, jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    job = client.post(f"/v1/projects/{project['id']}/analyze").json()
    duplicate = client.post(f"/v1/projects/{project['id']}/analyze").json()
    assert duplicate["id"] == job["id"]
    assert jobs.get_job(job["id"]).input_path.parent.parent == settings.jobs_dir
    assert Worker(settings, jobs, MockBackend()).run_once()
    finished = client.get(f"/v1/projects/{project['id']}").json()
    assert finished["reference"]["status"] == "succeeded"
    assert finished["reference"]["report"]["overview"]
    assert finished["reference"]["capability_status"] == "mock"
    assert finished["revision"] == project["revision"]
    assert finished["draft"] == project["draft"]
    archived = client.post(f"/v1/projects/{project['id']}/archive", json={"revision": 1}).json()
    with jobs._connect() as connection:
        connection.execute(
            "UPDATE jobs SET expires_at=? WHERE id=?",
            (to_iso(utc_now() - timedelta(seconds=1)), job["id"]),
        )
    assert cleanup_expired_jobs(jobs, settings.jobs_dir) == 1
    assert jobs.get_job(job["id"]) is None
    assert not (settings.jobs_dir / job["id"]).exists()
    restarted_app, _new_jobs, restarted_projects = _app(settings)
    with TestClient(restarted_app) as restarted:
        restarted.cookies.set("test-session", "owner-a")
        restored = restarted.get(f"/v1/projects/{project['id']}").json()
        assert restored["reference"] == finished["reference"]
        assert restarted_projects.get_job_link(job["id"])["owner_id"] == "owner-a"
        for url in (
            restored["original_url"],
            restored["preview_url"],
            restored["crop_url"],
            archived["published_url"],
        ):
            response = restarted.get(url)
            assert response.status_code == 200
            with _decode(response.content) as image:
                assert image.width > 0


def test_failed_and_timed_out_ai_never_block_manual_archive(project_app, jpeg_bytes):
    client, _settings_value, jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    job = client.post(f"/v1/projects/{project['id']}/analyze").json()
    assert jobs.fail_job(job["id"], "inference_failed", "测试分析失败")
    failed = client.get(f"/v1/projects/{project['id']}").json()
    assert failed["reference"]["status"] == "failed"
    assert failed["reference"]["error"]["code"] == "inference_failed"
    assert failed["draft"] == project["draft"]
    assert (
        client.post(f"/v1/projects/{project['id']}/archive", json={"revision": 1}).status_code
        == 200
    )
    again = client.post(f"/v1/projects/{project['id']}/analyze").json()
    jobs.claim_next()
    with jobs._connect() as connection:
        connection.execute(
            "UPDATE jobs SET started_at=? WHERE id=?",
            (to_iso(utc_now() - timedelta(seconds=121)), again["id"]),
        )
    assert jobs.fail_timed_out_job(again["id"], 120)
    assert (
        client.get(f"/v1/projects/{project['id']}").json()["reference"]["error"]["code"]
        == "inference_timeout"
    )


def test_project_deletion_only_removes_owned_files_and_preserves_job_tombstone(
    project_app, jpeg_bytes, tmp_path
):
    client, settings, _jobs, projects = project_app
    first = _create(client, jpeg_bytes)
    second = _create(client, jpeg_bytes)
    job = client.post(f"/v1/projects/{first['id']}/analyze").json()
    outside = tmp_path / "untouched.txt"
    outside.write_text("keep", encoding="utf-8")
    assert client.delete(f"/v1/projects/{first['id']}").status_code == 204
    assert not (settings.data_dir / "projects" / first["id"]).exists()
    assert (settings.data_dir / "projects" / second["id"]).is_dir()
    assert outside.read_text(encoding="utf-8") == "keep"
    assert projects.get_job_link(job["id"])["deleted"] is True
    assert client.get(first["original_url"]).status_code == 404
    with pytest.raises(ProjectNotFound):
        projects.delete_project("../untouched", "owner-a")


def test_concurrent_draft_writes_use_compare_and_swap(project_app, jpeg_bytes):
    client, _settings_value, _jobs, projects = project_app
    project = _create(client, jpeg_bytes)

    def save(note: str):
        try:
            return projects.save_draft(project["id"], "owner-a", 1, {"selection_note": note})
        except ProjectConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ["first", "second"]))
    assert sum(result is not None for result in results) == 1
    assert projects.get_project(project["id"], "owner-a")["revision"] == 2


@pytest.mark.parametrize("operation", ["create", "save", "archive"])
def test_mutation_response_keeps_its_transaction_snapshot_when_another_writer_updates(
    project_app,
    jpeg_bytes,
    monkeypatch,
    operation,
):
    client, settings, _jobs, projects = project_app
    project = _create(client, jpeg_bytes)
    original_connect = projects._connect
    committed, release_response = threading.Event(), threading.Event()

    @contextmanager
    def pause_after_commit():
        with original_connect() as connection:
            yield connection
            changed = connection.total_changes > 0
        if changed and threading.current_thread().name.startswith("snapshot-writer"):
            committed.set()
            assert release_response.wait(timeout=5)

    monkeypatch.setattr(projects, "_connect", pause_after_commit)

    def first_write():
        if operation == "create":
            return projects.create_project(
                "owner-a",
                "snapshot-created",
                jpeg_bytes,
                "image/jpeg",
                settings.max_upload_bytes,
                AnalysisIntent(),
            )
        if operation == "save":
            return projects.save_draft(project["id"], "owner-a", 1, {"selection_note": "A"})
        return projects.archive(project["id"], "owner-a", 1)

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="snapshot-writer") as pool:
        first = pool.submit(first_write)
        try:
            assert committed.wait(timeout=5)
            # A separate SQL connection stands for another API process: the
            # process-local Python lock cannot serialize this competing write.
            with sqlite3.connect(settings.database_path) as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute(
                    "SELECT * FROM projects ORDER BY created_at DESC LIMIT 1",
                ).fetchone()
                next_draft = json.loads(row["draft_json"])
                next_draft["selection_note"] = "B"
                next_draft["crop"] = {"x": 0, "y": 0, "width": 0.5, "height": 0.5}
                connection.execute(
                    "UPDATE projects SET title='B',draft_json=?,revision=revision+1 WHERE id=?",
                    (json.dumps(next_draft), row["id"]),
                )
        finally:
            release_response.set()
        response = first.result(timeout=5)
    expected_revision = 1 if operation == "create" else 2
    assert response["revision"] == expected_revision
    assert response["title"] != "B"
    assert response["draft"]["selection_note"] == ("A" if operation == "save" else None)
    assert response["draft"]["crop"]["width"] == 1
    if operation == "archive":
        assert response["published"]["version"] == 1
        assert not response["has_draft_changes"]
    current = projects.get_project(response["id"], "owner-a")
    assert current["revision"] == expected_revision + 1
    assert current["draft"]["selection_note"] == "B"


def test_failed_archive_never_publishes_a_bad_file(project_app, jpeg_bytes, monkeypatch):
    client, settings, _jobs, projects = project_app
    project = _create(client, jpeg_bytes)

    def invalid_crop(_source, _crop, target):
        target.write_bytes(b"not an image")
        return target

    monkeypatch.setattr(project_module, "crop_original", invalid_crop)
    with pytest.raises(OSError):
        projects.archive(project["id"], "owner-a", 1)
    assert projects.get_project(project["id"], "owner-a")["published"] is None
    assert not list((settings.data_dir / "projects" / project["id"]).glob("published-*"))


@pytest.mark.parametrize("clean_job", [True, False])
def test_expired_analysis_stops_polling_and_preserves_manual_project(
    project_app,
    jpeg_bytes,
    clean_job,
):
    client, settings, jobs, _projects = project_app
    project = _create(client, jpeg_bytes)
    job = client.post(f"/v1/projects/{project['id']}/analyze").json()
    with jobs._connect() as connection:
        connection.execute(
            "UPDATE jobs SET expires_at=? WHERE id=?",
            (to_iso(utc_now() - timedelta(seconds=1)), job["id"]),
        )
    if clean_job:
        assert cleanup_expired_jobs(jobs, settings.jobs_dir) == 1
    current = client.get(f"/v1/projects/{project['id']}").json()
    assert current["reference"]["job_id"] == job["id"]
    assert current["reference"]["status"] == "expired"
    assert current["active_job_id"] is None
    assert current["revision"] == project["revision"]
    assert current["draft"] == project["draft"]
    assert client.get(current["crop_url"]).status_code == 200
    retry = client.post(f"/v1/projects/{project['id']}/analyze")
    assert retry.status_code == 202
    assert retry.json()["id"] != job["id"]


def test_candidate_provenance_survives_cleanup_and_rerunning_ai(project_app, jpeg_bytes):
    client, settings, jobs, projects = project_app
    project = _create(client, jpeg_bytes)
    first = client.post(f"/v1/projects/{project['id']}/analyze").json()
    assert Worker(settings, jobs, MockBackend()).run_once()
    detail = client.get(f"/v1/projects/{project['id']}").json()
    candidate = detail["reference"]["candidates"][0]
    chosen = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "crop": candidate["crop"],
            "selected_candidate_id": candidate["id"],
            "reference_job_id": first["id"],
            "selection_explicit": True,
        },
    )
    assert chosen.status_code == 200
    with jobs._connect() as connection:
        connection.execute(
            "UPDATE jobs SET expires_at=? WHERE id=?",
            (to_iso(utc_now() - timedelta(seconds=1)), first["id"]),
        )
    assert cleanup_expired_jobs(jobs, settings.jobs_dir) == 1
    second = client.post(f"/v1/projects/{project['id']}/analyze").json()
    assert Worker(settings, jobs, MockBackend()).run_once()
    current = client.get(f"/v1/projects/{project['id']}").json()
    assert current["reference"]["job_id"] == second["id"]
    assert current["draft"]["reference_job_id"] == first["id"]
    archived = client.post(
        f"/v1/projects/{project['id']}/archive",
        json={
            "revision": chosen.json()["revision"],
        },
    ).json()
    assert archived["published"]["reference"]["job_id"] == first["id"]
    other = _create(client, jpeg_bytes)
    foreign = client.patch(
        f"/v1/projects/{other['id']}",
        json={
            "revision": 1,
            "selected_candidate_id": candidate["id"],
            "reference_job_id": first["id"],
        },
    )
    assert foreign.status_code == 422
    assert projects.get_job_link(first["id"])["deleted"] is False


def test_cleanup_keeps_result_record_when_project_snapshot_temporarily_fails(
    project_app,
    jpeg_bytes,
    monkeypatch,
):
    client, settings, jobs, projects = project_app
    project = _create(client, jpeg_bytes)
    job = client.post(f"/v1/projects/{project['id']}/analyze").json()
    assert Worker(settings, jobs, MockBackend()).run_once()
    capture = project_module.capture_project_job

    def unavailable_snapshot(_database_path, _job_id):
        raise sqlite3.OperationalError("temporarily unavailable")

    monkeypatch.setattr(project_module, "capture_project_job", unavailable_snapshot)
    manual = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "revision": 1,
            "selection_note": "AI快照故障不阻止手动保存",
        },
    )
    assert manual.status_code == 200
    archived = client.post(
        f"/v1/projects/{project['id']}/archive",
        json={
            "revision": manual.json()["revision"],
        },
    )
    assert archived.status_code == 200
    assert client.get(archived.json()["published_url"]).status_code == 200
    with jobs._connect() as connection:
        connection.execute(
            "UPDATE jobs SET expires_at=? WHERE id=?",
            (to_iso(utc_now() - timedelta(seconds=1)), job["id"]),
        )
    assert cleanup_expired_jobs(jobs, settings.jobs_dir) == 0
    assert jobs.get_job(job["id"]).report is not None
    monkeypatch.setattr(project_module, "capture_project_job", capture)
    assert cleanup_expired_jobs(jobs, settings.jobs_dir) == 1
    assert projects.get_project(project["id"], "owner-a")["reference"]["report"]


def test_blocking_image_work_finishes_before_cancellation_is_propagated():
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def operation():
        started.set()
        release.wait(timeout=5)
        finished.set()

    async def scenario():
        task = asyncio.create_task(_blocking(operation))
        while not started.is_set():
            await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()

    asyncio.run(scenario())
