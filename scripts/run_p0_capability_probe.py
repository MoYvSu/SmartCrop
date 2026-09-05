from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

TERMINAL = {"succeeded", "failed", "cancelled", "expired"}
SCENES = ("general", "portrait", "landscape", "product", "social")
RATIOS = ("free", "1:1", "4:5", "3:4", "16:9")
PIXEL_RATIOS = {"1:1": 1.0, "4:5": 4 / 5, "3:4": 3 / 4, "16:9": 16 / 9}


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


def crop_signature(candidate: dict) -> tuple[float, ...]:
    crop = candidate["crop"]
    return tuple(round(crop[key], 4) for key in ("x", "y", "width", "height"))


def ratio_error(candidate: dict, image_width: int, image_height: int, ratio: str) -> float:
    crop = candidate["crop"]
    actual = crop["width"] * image_width / (crop["height"] * image_height)
    return abs(actual - PIXEL_RATIOS[ratio])


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe the deployed P0 composition workflow")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--manifest", type=Path, default=Path("tests/regression/manifest.json"))
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--job-timeout", type=int, default=900)
    parser.add_argument("--ratio-tolerance", type=float, default=0.002)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    manifest_path = args.manifest if args.manifest.is_absolute() else root / args.manifest
    cases = json.loads(manifest_path.read_text(encoding="utf-8"))["cases"][: args.limit]
    access_code = os.getenv("SMARTCROP_ACCESS_CODE", "")
    headers = {"X-SmartCrop-Access": access_code} if access_code else {}
    results = []

    with httpx.Client(base_url=args.base_url, timeout=120) as client:
        for index, case in enumerate(cases):
            scene = SCENES[index % len(SCENES)]
            ratio = RATIOS[index % len(RATIOS)]
            image_path = (root / case["path"]).resolve()
            entry = {"id": case["id"], "scene": scene, "aspect_ratio": ratio}
            try:
                with image_path.open("rb") as image_file:
                    response = client.post(
                        "/v1/jobs",
                        headers=headers,
                        data={"scene": scene, "aspect_ratio": ratio},
                        files={"file": (image_path.name, image_file, "image/jpeg")},
                    )
                response.raise_for_status()
                job = wait_for_job(client, response.json()["id"], headers, args.job_timeout)
                if job["status"] != "succeeded":
                    raise RuntimeError(job.get("error") or f"unexpected status {job['status']}")
                candidates = job["candidates"]
                if [item["id"] for item in candidates] != ["balanced", "subject", "story"]:
                    raise RuntimeError("expected balanced, subject, and story candidates")
                signatures = {crop_signature(candidate) for candidate in candidates}
                if len(signatures) != 3:
                    raise RuntimeError("candidate crops are exact duplicates")
                errors = []
                if ratio != "free":
                    errors = [
                        ratio_error(candidate, job["image_width"], job["image_height"], ratio)
                        for candidate in candidates
                    ]
                    if max(errors) > args.ratio_tolerance:
                        raise RuntimeError(f"ratio error exceeds tolerance: {max(errors):.6f}")

                review_response = client.post(
                    f"/v1/jobs/{job['id']}/review",
                    headers=headers,
                )
                review_response.raise_for_status()
                review = wait_for_job(
                    client,
                    review_response.json()["id"],
                    headers,
                    args.job_timeout,
                )
                if review["status"] != "succeeded" or not review["report"]:
                    raise RuntimeError(review.get("error") or "final review did not succeed")
                entry.update(
                    status="passed",
                    capability_status=job["capability_status"],
                    candidate_signatures=sorted(signatures),
                    max_ratio_error=max(errors, default=0.0),
                    strategy_difference_review="pending_human_review",
                    final_review_grounding="pending_human_review",
                )
            except Exception as exc:  # noqa: BLE001 - record every deployed failure
                entry.update(status="failed", error=str(exc))
            results.append(entry)
            print(f"[{index + 1}/{len(cases)}] {case['id']}: {entry['status']}")

    output_dir = root / "var" / "p0-capability"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_path = output_dir / f"probe-{timestamp}.json"
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_url": args.base_url,
        "passed": sum(item["status"] == "passed" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "note": "Structural checks do not replace human review of aesthetic differences.",
        "results": results,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Result: {output_path}")
    if payload["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
