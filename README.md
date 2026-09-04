# SmartCrop

SmartCrop 是把 CVPR 2026 研究成果 Venus 落成可演示产品的桌面端应用：用户上传一张图片，系统异步生成一个最佳裁剪、可下载的原分辨率裁剪图，以及页面内的简体中文美学分析。

本仓库仅用于研究、内部展示和受控演示，不用于发布或商业化。数据集已获得使用授权，但数据、模型权重和用户上传均不进入 Git。

## V1 已实现

- React + TypeScript + Vite 桌面工作台，手机端明确提示暂不支持；
- FastAPI 上传、任务轮询、访问码保护和图片制品接口；
- SQLite + 文件系统任务存储，最多 5 个排队任务；
- 独立串行 GPU worker，长驻加载 Venus；
- 120 秒进程级硬超时，超时后终止并重建模型进程；
- JPEG / PNG / WebP，单图最大 20 MB、50 MP；
- AI 裁剪框可拖动、四角缩放及键盘微调；
- 最终裁剪由服务器基于规范化原图生成；
- AI 失败时可进入明确标注的纯手动模式，不伪造报告；
- 任务与图片 1 小时后清理，无历史页、无报告下载；
- 固定 30 图部署回归清单。

产品范围见 [V1 决策简报](docs/product/v1-decision-brief.md)，进程边界见 [ADR-0001](docs/decisions/0001-process-boundaries.md)。

## 仓库结构

```text
apps/web/          React 桌面前端
apps/api/          FastAPI HTTP 服务
workers/venus/     Venus 模型适配、串行 worker 与超时看门狗
packages/          Python 契约、图像处理、任务运行时
tests/             单元、集成和 30 图回归清单
deploy/            AutoDL / Linux GPU 主机部署说明
docs/              产品、架构、设计与 ADR
```

`Venus_CVPR2026/` 是独立版本管理且当前有本地修改的研究资产；根仓库忽略它，并且产品实现不会修改它。旧版根 `index.html` 和 `image_process.py` 仅保留为迁移参考。

## 本地运行（Mock 模型）

要求 Python 3.10+、Node.js 20+ 和 pnpm 9+。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
pnpm --dir apps/web install
pnpm --dir apps/web build
Copy-Item .env.example .env
.\.venv\Scripts\python.exe scripts/dev.py
```

打开 `http://127.0.0.1:8000`。默认 Mock 后端只用于 UI、契约和部署冒烟测试，不能作为真实 Venus 模型验收证据。

## GPU 主机运行

在 Linux / AutoDL 主机使用 Python 3.10，安装 CUDA 对应的 PyTorch 和项目 Venus 依赖，设置：

```bash
export SMARTCROP_WORKER_BACKEND=venus
export SMARTCROP_MODEL_PATH=/absolute/path/to/model
export SMARTCROP_ACCESS_CODE='replace-with-a-long-random-code'
smartcrop-worker
```

另一个进程运行 `smartcrop-api --host 127.0.0.1 --port 8000`，外层使用 Caddy 或平台网关提供 HTTPS。完整步骤见 [部署指南](deploy/README.md)。

## 验证

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pytest --cov
pnpm --dir apps/web test
pnpm --dir apps/web build
```

真实服务器启动后运行 30 图完整链路回归：

```powershell
$env:SMARTCROP_ACCESS_CODE = "your-code"
.\.venv\Scripts\python.exe scripts/run_regression.py --base-url https://your-host
```

回归结果写入被忽略的 `var/regression/`。它检查上传、排队、真实模型结果、结构化报告和可解码裁剪制品；模型质量仍需人工复核。
