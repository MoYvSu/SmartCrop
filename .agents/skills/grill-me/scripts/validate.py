#!/usr/bin/env python3
"""Validate the Grill Me skill repository without third-party dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PORTABLE_SKILL = ROOT / "SKILL.md"
CLAUDE_SKILL = ROOT / "claude-code" / "SKILL.md"
PORTABLE_EVALS = ROOT / "evals" / "evals.json"
PORTABLE_QUERIES = ROOT / "evals" / "eval_queries.json"
CLAUDE_EVALS = ROOT / "claude-code" / "evals" / "evals.json"
CLAUDE_QUERIES = ROOT / "claude-code" / "evals" / "eval_queries.json"
EXPECTED_NAME = "grill-me"
EXPECTED_VERSION = "2.0.0"


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def read_text(path: Path, errors: list[str]) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        fail(errors, f"missing required file: {path.relative_to(ROOT)}")
    except OSError as exc:
        fail(errors, f"cannot read {path.relative_to(ROOT)}: {exc}")
    return ""


def read_json(path: Path, errors: list[str]) -> Any:
    text = read_text(path, errors)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        fail(errors, f"invalid JSON in {path.relative_to(ROOT)}: {exc}")
        return None


def split_frontmatter(text: str, path: Path, errors: list[str]) -> tuple[str, str]:
    match = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, flags=re.DOTALL)
    if not match:
        fail(errors, f"invalid or missing YAML frontmatter: {path.relative_to(ROOT)}")
        return "", text
    return match.group(1), match.group(2)


def scalar(frontmatter: str, key: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*[\"']?([^\n\"']+)[\"']?\s*$", frontmatter)
    return match.group(1).strip() if match else None


def validate_skill_files(errors: list[str]) -> None:
    portable_text = read_text(PORTABLE_SKILL, errors)
    claude_text = read_text(CLAUDE_SKILL, errors)
    if not portable_text or not claude_text:
        return

    portable_frontmatter, portable_body = split_frontmatter(portable_text, PORTABLE_SKILL, errors)
    claude_frontmatter, claude_body = split_frontmatter(claude_text, CLAUDE_SKILL, errors)

    for path, frontmatter in (
        (PORTABLE_SKILL, portable_frontmatter),
        (CLAUDE_SKILL, claude_frontmatter),
    ):
        if scalar(frontmatter, "name") != EXPECTED_NAME:
            fail(errors, f"{path.relative_to(ROOT)} must declare name: {EXPECTED_NAME}")
        if scalar(frontmatter, "description") is None:
            fail(errors, f"{path.relative_to(ROOT)} must declare a description")
        version_match = re.search(
            r'(?ms)^metadata:\s*\n(?:^[ \t]+.*\n)*?^[ \t]+version:\s*["\']?([^\n"\']+)',
            frontmatter + "\n",
        )
        version = version_match.group(1).strip() if version_match else None
        if version != EXPECTED_VERSION:
            fail(
                errors,
                f"{path.relative_to(ROOT)} must declare metadata.version: {EXPECTED_VERSION}",
            )

    if re.search(r"(?m)^disable-model-invocation:", portable_frontmatter):
        fail(errors, "portable SKILL.md must not include disable-model-invocation")
    if re.search(r"(?m)^argument-hint:", portable_frontmatter):
        fail(errors, "portable SKILL.md must not include argument-hint")

    if scalar(claude_frontmatter, "disable-model-invocation") != "true":
        fail(errors, "claude-code/SKILL.md must set disable-model-invocation: true")
    if scalar(claude_frontmatter, "argument-hint") is None:
        fail(errors, "claude-code/SKILL.md must declare argument-hint")

    if portable_body != claude_body:
        fail(errors, "portable and Claude Code skill bodies must remain identical")


def validate_evals(data: Any, path: Path, errors: list[str]) -> None:
    if not isinstance(data, dict):
        fail(errors, f"{path.relative_to(ROOT)} must contain a JSON object")
        return
    if data.get("skill_name") != EXPECTED_NAME:
        fail(errors, f"{path.relative_to(ROOT)} must use skill_name={EXPECTED_NAME!r}")

    cases = data.get("evals")
    if not isinstance(cases, list) or not cases:
        fail(errors, f"{path.relative_to(ROOT)} must contain a non-empty evals array")
        return

    seen_ids: set[int] = set()
    for index, case in enumerate(cases):
        location = f"{path.relative_to(ROOT)} evals[{index}]"
        if not isinstance(case, dict):
            fail(errors, f"{location} must be an object")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, int):
            fail(errors, f"{location}.id must be an integer")
        elif case_id in seen_ids:
            fail(errors, f"{location}.id duplicates {case_id}")
        else:
            seen_ids.add(case_id)
        for key in ("prompt", "expected_output"):
            if not isinstance(case.get(key), str) or not case[key].strip():
                fail(errors, f"{location}.{key} must be a non-empty string")
        assertions = case.get("assertions")
        if not isinstance(assertions, list) or not assertions:
            fail(errors, f"{location}.assertions must be a non-empty array")
        elif not all(isinstance(item, str) and item.strip() for item in assertions):
            fail(errors, f"{location}.assertions must contain only non-empty strings")


def validate_queries(data: Any, path: Path, errors: list[str]) -> None:
    if not isinstance(data, list) or not data:
        fail(errors, f"{path.relative_to(ROOT)} must contain a non-empty JSON array")
        return

    trigger_values: set[bool] = set()
    seen_queries: set[str] = set()
    for index, item in enumerate(data):
        location = f"{path.relative_to(ROOT)}[{index}]"
        if not isinstance(item, dict):
            fail(errors, f"{location} must be an object")
            continue
        query = item.get("query")
        should_trigger = item.get("should_trigger")
        if not isinstance(query, str) or not query.strip():
            fail(errors, f"{location}.query must be a non-empty string")
        elif query in seen_queries:
            fail(errors, f"{location}.query is duplicated")
        else:
            seen_queries.add(query)
        if not isinstance(should_trigger, bool):
            fail(errors, f"{location}.should_trigger must be a boolean")
        else:
            trigger_values.add(should_trigger)

    if trigger_values != {True, False}:
        fail(errors, f"{path.relative_to(ROOT)} must include trigger and non-trigger cases")


def main() -> int:
    errors: list[str] = []
    validate_skill_files(errors)

    portable_evals = read_json(PORTABLE_EVALS, errors)
    portable_queries = read_json(PORTABLE_QUERIES, errors)
    claude_evals = read_json(CLAUDE_EVALS, errors)
    claude_queries = read_json(CLAUDE_QUERIES, errors)

    if portable_evals is not None:
        validate_evals(portable_evals, PORTABLE_EVALS, errors)
    if portable_queries is not None:
        validate_queries(portable_queries, PORTABLE_QUERIES, errors)

    if portable_evals != claude_evals:
        fail(errors, "portable and Claude Code evals.json files must stay synchronized")
    if portable_queries != claude_queries:
        fail(errors, "portable and Claude Code eval_queries.json files must stay synchronized")

    if errors:
        print("Validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("Validation passed: Grill Me skill v2.0.0 is internally consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
