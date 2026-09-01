# SmartCrop repository guidance

## Product boundary

- This repository turns the authorized Venus research model into an internal, non-commercial image-cropping product.
- The user-facing outcome is one uploaded image, one asynchronous analysis job, a downloadable crop, and a structured aesthetic report.
- Do not claim that uploads are deleted unless the implemented retention policy and tests prove it.

## Repository boundary

- Treat `Venus_CVPR2026/` as an independently versioned upstream research checkout. Preserve its dirty worktree and do not move, reset, clean, or rewrite it without explicit authorization.
- Treat root `index.html` and `image_process.py` as legacy migration inputs. New product code belongs under the target structure documented in `docs/architecture/repository-layout.md`.
- Runtime uploads, generated crops, reports, model weights, caches, and secrets must stay outside Git.

## Decision workflow

- Use `$grill-me` when the user explicitly asks to pressure-test a product, scope, architecture, rollout, or policy decision. While that skill is active, remain read-only until its decision brief is approved and a separate implementation request is given.
- Use `$ui-ux-pro-max` for any new or materially changed interface. Generate or read the project design system before implementing pages, and finish with accessibility and responsive checks.
- Record durable product decisions in `docs/product/` and architectural decisions in `docs/decisions/`.

## Engineering priorities

1. Preserve user images and model outputs correctly and privately.
2. Keep the browser/API/worker contract explicit and versioned.
3. Serialize GPU inference until measured capacity supports higher concurrency.
4. Return structured model output; do not depend on fragile free-text regex parsing.
5. Validate final downloadable artifacts and reports, not only intermediate model responses.
6. Prefer a simple single-host deployment first, while preserving clean process boundaries.
