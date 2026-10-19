from pathlib import Path

import pytest
from smartcrop_runtime import Settings


def _settings(tmp_path: Path, *, image_decode_concurrency: int) -> Settings:
    data_dir = tmp_path / "data"
    return Settings(
        data_dir=data_dir,
        database_path=data_dir / "smartcrop.sqlite3",
        web_dist=tmp_path / "dist",
        access_code="",
        image_decode_concurrency=image_decode_concurrency,
    )


@pytest.mark.parametrize("value", [0, -1])
def test_image_decode_concurrency_must_be_positive(tmp_path: Path, value: int) -> None:
    with pytest.raises(ValueError, match="image_decode_concurrency must be at least 1"):
        _settings(tmp_path, image_decode_concurrency=value)


def test_image_decode_concurrency_reads_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SMARTCROP_DECODE_CONCURRENCY", "3")

    settings = Settings.from_env(tmp_path)

    assert settings.image_decode_concurrency == 3


def test_demo_password_defaults_to_the_presentation_password(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("SMARTCROP_DEMO_PASSWORD", raising=False)

    assert _settings(tmp_path, image_decode_concurrency=2).demo_password == "123456"
    assert Settings.from_env(tmp_path).demo_password == "123456"


@pytest.mark.parametrize("password", ["private-deployment-password", ""])
def test_explicit_demo_password_environment_is_preserved(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    password: str,
) -> None:
    monkeypatch.setenv("SMARTCROP_DEMO_PASSWORD", password)

    assert Settings.from_env(tmp_path).demo_password == password
