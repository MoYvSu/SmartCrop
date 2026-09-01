# Repository layout

Status: implemented V1 baseline

Last updated: 2026-09-01

## Goals

The repository must make four boundaries obvious:

1. browser experience;
2. HTTP and task lifecycle;
3. GPU model inference;
4. research/upstream assets.

The first deployment may run on one server, but these boundaries should remain explicit so model failures, web releases, and GPU scheduling can evolve independently.

## Target tree

```text
SmartCrop/
├── .agents/
│   ├── skills/
│   └── skills.lock.json
├── apps/
│   ├── web/                 # browser application
│   └── api/                 # HTTP API and job lifecycle
├── workers/
│   └── venus/               # serialized GPU inference worker
├── packages/
│   ├── contracts/           # versioned request/result schemas
│   ├── image-core/          # crop validation and artifact generation
│   └── runtime/             # settings and SQLite task state
├── Venus_CVPR2026/          # ignored, independently versioned research checkout
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── design/
│   └── decisions/
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
├── deploy/
├── scripts/
└── var/                     # ignored runtime data only
```

## Component responsibilities

### `apps/web`

- select or capture an image;
- validate and preview before upload;
- submit one job and display truthful progress;
- render a structured report without injecting model HTML;
- preview and download server-produced artifacts;
- support keyboard crop adjustment and reduced motion;
- show an explicit unsupported notice on mobile widths.

The implemented stack is React, TypeScript, and Vite.

### `apps/api`

- enforce media type, size, dimensions, and decode validation;
- own the versioned public API and task state machine;
- assign opaque job and artifact identifiers;
- expose health/readiness separately;
- enforce retention and cleanup policy;
- never load the GPU model in the web-server process.

### `workers/venus`

- load the Venus model once;
- consume jobs serially by default;
- request structured analysis and crop coordinates;
- validate coordinates and return a typed result;
- record model/runtime metadata needed to reproduce a result;
- isolate CUDA failures from the API process.

### `packages/contracts`

Own schemas such as `JobStatus`, `AestheticReport`, `CropBox`, `Artifact`, and error codes. Generate or verify matching frontend types instead of maintaining unrelated JSON shapes by hand.

### `packages/image-core`

Own coordinate normalization, crop-box validation, image decoding, orientation handling, crop encoding, thumbnails, and report artifact generation. Model adapters may propose a crop but may not bypass these checks.

### `packages/runtime`

Own environment settings, SQLite queue state, terminal-state guards, and retention selection.

### `Venus_CVPR2026`

Keep this dirty, independently versioned research checkout untouched until a separate reconciliation task is explicitly authorized. Do not mix product server code into it.

## Product flow

```text
Web -> POST /v1/jobs -> API -> pending job
                              |
                              v
                       Venus GPU worker
                              |
                              v
                    validated report + crop
                              |
Web <- GET /v1/jobs/{id} <- API artifact metadata
Web <- authenticated artifact URL <- generated crop image
```

The API contract should distinguish `queued`, `running`, `succeeded`, `failed`, `expired`, and `cancelled`. HTTP success must not be used to hide a failed inference state.

## Migration map

| Current asset | Target | Rule |
| --- | --- | --- |
| root `index.html` | `apps/web` | Preserve as visual/reference input; do not continue patching it as the final app. |
| `Venus_CVPR2026/worker.py` | `apps/api` + `workers/venus` | Split HTTP lifecycle from CUDA inference. |
| `Venus_CVPR2026/predict_flow.py` | research reference | Keep benchmark logic out of production imports. |
| root `image_process.py` | `packages/image-core` | Replace the empty placeholder with tested domain functions. |
| `venus_uploads/` and hard-coded data drives | `var/` or configured external storage | Never use source directories as runtime storage. |

## Migration sequence

1. Resolve product scope and success criteria with `$grill-me`.
2. Decide frontend stack, report format, retention policy, deployment topology, and expected concurrency.
3. Reconcile the dirty `Venus_CVPR2026` checkout in a separate task before considering a submodule.
4. Define API schemas and fixture-based contract tests.
5. Extract the Venus adapter and validate one end-to-end job on the GPU host.
6. Generate the product design system with `$ui-ux-pro-max`, then build the new web app.
7. Add integration/E2E tests, packaging, observability, cleanup, and deployment docs.

## Post-V1 decisions

Redis/object storage, account history, a formal mobile UI, and research-checkout pinning remain deferred until their triggering requirements exist.
