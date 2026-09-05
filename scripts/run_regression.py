from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

TERMINAL = {"succeeded", "failed", "cancelled", "expired"}


def report_language(report: dict) -> str:
    declared = report.get("language")
    if declared in {"zh-CN", "en"}:
        return declared
    values = [
        report["overview"],
        *report["strengths"],
        *report["issues"],
        report["crop_rationale"],
        *report["shooting_tips"],
    ]
    text = "".join(value for value in values if isinstance(value, str))
    letters = [character for character in text if character.isalpha()]
    chinese_count = sum("\u4e00" <= character <= "\u9fff" for character in letters)
    return "zh-CN" if chinese_count and chinese_count / len(letters) >= 0.4 else "other"


def wait_for_job(
    client: httpx.Client,
    job_id: str,
    headers: dict[str, str],
    timeout_seconds: int,
) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        response.raise_for_status()
        result = response.json()
        if result["status"] in TERMINAL:
            return result
        time.sleep(2)
    raise TimeoutError(f"job {job_id} did not reach a terminal state")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the 30-image deployed regression suite")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--manifest", type=Path, default=Path("tests/regression/manifest.json"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--job-timeout", type=int, default=900)
    parser.add_argument("--expected-report-language", choices=("zh-CN", "en"))
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    manifest_path = (
        (root / args.manifest).resolve()
        if not args.manifest.is_absolute()
        else args.manifest
    )
    cases = json.loads(manifest_path.read_text(encoding="utf-8"))["cases"]
    if args.limit:
        cases = cases[: args.limit]
    access_code = os.getenv("SMARTCROP_ACCESS_CODE", "")
    headers = {"X-SmartCrop-Access": access_code} if access_code else {}
    results: list[dict] = []

    with httpx.Client(base_url=args.base_url, timeout=120) as client:
        for index, case in enumerate(cases, start=1):
            image_path = (root / case["path"]).resolve()
            started = time.monotonic()
            entry = {"id": case["id"], "path": case["path"]}
            try:
                with image_path.open("rb") as image_file:
                    submitted = client.post(
                        "/v1/jobs",
                        headers=headers,
                        files={"file": (image_path.name, image_file, "image/jpeg")},
                    )
                submitted.raise_for_status()
                job = wait_for_job(
                    client,
                    submitted.json()["id"],
                    headers,
                    args.job_timeout,
                )
                if job["status"] != "succeeded" or not job["report"]:
                    raise RuntimeError(job.get("error") or f"unexpected status {job['status']}")
                artifact = client.get(job["artifacts"]["crop"], headers=headers)
                artifact.raise_for_status()
                with Image.open(BytesIO(artifact.content)) as crop:
                    crop.verify()
                language = report_language(job["report"])
                if args.expected_report_language and language != args.expected_report_language:
                    raise RuntimeError(
                        f"expected report language {args.expected_report_language}, got {language}"
                    )
                entry.update(
                    status="passed",
                    duration_seconds=round(time.monotonic() - started, 2),
                    crop=job["final_crop"],
                    report_language=language,
                    translation_provider=job["report"].get("translation_provider"),
                )
            except Exception as exc:  # noqa: BLE001 - every case must be recorded
                entry.update(
                    status="failed",
                    duration_seconds=round(time.monotonic() - started, 2),
                    error=str(exc),
                )
            results.append(entry)
            print(f"[{index}/{len(cases)}] {case['id']}: {entry['status']}")

    output_dir = root / "var" / "regression"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_path = output_dir / f"regression-{timestamp}.json"
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_url": args.base_url,
        "passed": sum(item["status"] == "passed" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "report_languages": {
            "zh-CN": sum(item.get("report_language") == "zh-CN" for item in results),
            "other": sum(item.get("report_language") == "other" for item in results),
        },
        "results": results,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Result: {output_path}")
    if payload["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
