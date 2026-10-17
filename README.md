# SmartCrop

SmartCrop 是把 CVPR 2026 研究成果 Venus 落成可演示产品的摄影工作室：登录演示账号、导入照片后直接精修取景、保存草稿、归档和下载成片，也可按需获取三种构图偏好的 AI 参考。报告可由 DeepSeek 只翻译文本；翻译不可用时保留英文原文，不影响裁剪结果。

本仓库仅用于研究、内部展示和受控演示，不用于发布或商业化。数据集已获得使用授权，但数据、模型权重和用户上传均不进入 Git。

## 摄影工作室 V2（分阶段实现）

已接入五页宽屏导航、真实演示账号、独立作品库、自动草稿与不可变归档版本。刷新或重新登录后可继续编辑，不依赖一小时临时任务。新照片无需运行模型即可完成保存、归档与下载。

演示账号共用作品库和偏好：使用相同账号的人能查看、修改和删除其中作品，请勿上传敏感照片。草稿及归档作品保留至主动删除；固定使用样例不进入作品库。工作台支持浏览器端亮度、色相与主色分析，摄影洞察展示每项目最新归档成片的真实统计。摄影档案可保存常用用途、裁剪比例与辅助线，新建自动采用，已有作品保持原设置；主色卡提供预设色彩描述。这些功能不调用模型；拍摄参数与设备档案仍待接入。范围见 [V2 产品记录](docs/product/photography-workspace-v2.md)、[第二阶段](docs/design/desktop-workspace-v2-phase-2.md)、[第三阶段](docs/design/desktop-workspace-v2-phase-3.md)与[第四阶段交付](docs/design/desktop-workspace-v2-phase-4.md)。

像素图表采用缩小采样，透明度加权、灰阶不强归色相，主色为近似聚类；作品集按每件可见成片等权，不用图像尺寸、下载次数或历史版本重复加权。只描述画面，不给审美分或判断曝光正确性。新增计算不将图像发送给模型或第三方，也不改变原有照片服务器保存策略；口径见 [ADR-0011](docs/decisions/0011-browser-pixel-analysis-and-archive-statistics.md)。

## P0.5 基础能力（仍保留临时任务 API）

- React + TypeScript + Vite 摄影创作工作台，适配电脑、平板和手机浏览器；
- FastAPI 上传、任务轮询、访问码保护和图片制品接口；
- SQLite + 文件系统任务存储，最多 5 个排队任务；
- 独立串行 GPU worker，长驻加载 Venus；
- 可选的 DeepSeek 结构化报告翻译，不向第三方发送用户图片；
- 120 秒进程级硬超时，超时后终止并重建模型进程；
- JPEG / PNG / WebP，单图最大 20 MB、50 MP；
- AI 裁剪框可拖动、四角缩放及键盘微调；
- 场景与成片比例意图、三种策略候选及裁剪比例锁定；
- 头像、社交封面、商品主图、演示文稿配图和自定义比例发布目标；
- 当前方案突出显示，其他构图方向按需展开；
- 三分线、中心线、对角线和安全区域构图辅助；
- 保留面积、原始尺寸、预计输出、比例状态和处理耗时客观面板；
- 系统默认建议与人工确认分开记录，工作室选择依据随作品保存，旧任务 API 仍为临时记录；
- 单一、低干扰的“查看使用样例”入口，固定样例明确标注没有调用当前模型；
- 用户界面只下载裁剪图；schema `1.2` API 制品仅为兼容工具和契约测试保留；
- 当前任务不进入模型训练或长期偏好数据集；
- 最终裁剪由服务器基于规范化原图生成；
- AI 失败时可进入明确标注的纯手动模式，不伪造报告；
- 旧临时任务及其专属图片仍在 1 小时后清理；工作室保存的照片、草稿和归档版本独立保留；
- 固定 30 图部署回归清单。

当前产品范围见 [P0.5 人机协同构图助手](docs/product/p0-5-human-guided-composition.md)，未来自愿数据参与边界见 [模型改进计划](docs/product/model-improvement-participation.md)，进程边界见 [ADR-0001](docs/decisions/0001-process-boundaries.md)，人工选择决策见 [ADR-0006](docs/decisions/0006-human-selection-over-final-review.md)。

## 仓库结构

```text
apps/web/          React 响应式网页前端
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
pnpm --dir apps/web install --force
pnpm --dir apps/web build
Copy-Item .env.example .env
.\.venv\Scripts\python.exe scripts/dev.py
```

项目将 pnpm 内容寻址存储固定在仓库根目录的 `.pnpm-store`（pnpm 会在其中创建版本目录）。
后续安装直接运行 `pnpm --dir apps/web install` 即可。如果已有 `node_modules` 仍链接到默认的
`D:\.pnpm-store`，先删除或移走 `apps/web/node_modules`，再重新安装；旧的根目录存储不会自动删除，
并且可能被 D 盘上的其他项目共用，确认没有其他项目依赖后再手动清理。

打开 `http://127.0.0.1:8000`。默认 Mock 后端只用于 UI、契约和部署冒烟测试，不能作为真实 Venus 模型验收证据。

演示用户名默认为 `demo`。未配置 `SMARTCROP_DEMO_PASSWORD` 时，首次启动 API 会随机生成密码，写入 `SMARTCROP_DATA_DIR/demo-credentials.txt`（默认 `var/smartcrop/demo-credentials.txt`，已忽略，不上传 Git）。只在本机私下查看该文件，勿把凭据贴到公开日志；登录页不会展示密码。重新启动沿用原账号及作品，不自动重置。设置私有环境变量密码可轮换账号密码，并使旧会话失效。登录尝试（含成功）按来源地址限制为十五分钟十次；频繁退出测试遇到 429 时请按提示等待，不要反复重试。

本地 HTTP 或 SSH 转发保持 `SMARTCROP_SESSION_COOKIE_SECURE=false`；公网部署必须使用 HTTPS 并设置为 `true`。作品目录和数据库需一起备份，不要只备份一个 SQLite 文件；Windows 上文件模式不能代替 NTFS 权限，应限制数据目录的访问者。旧版未保存的临时任务不会自动转成作品，已过期照片需重新导入。完整说明见 [部署指南](deploy/README.md)。

程序读取进程环境变量，`scripts/dev.py` 不会自动加载 `.env`。仅复制配置文件不会启用
DeepSeek；新机器默认使用 Mock 且关闭翻译，因此没有密钥也可以正常运行。若主动启用
`SMARTCROP_REPORT_TRANSLATOR=deepseek` 但没有密钥，现在也会警告后继续输出原报告。
翻译成功时显示中文；调用失败或超过 `SMARTCROP_DEEPSEEK_TIMEOUT_SECONDS` 的报告级总预算
（默认 12 秒，包含重试）时保留原报告，不占用模型推理时限。详情见
[翻译故障隔离决策](docs/decisions/0008-optional-translation-failure-isolation.md)。

## GPU 主机运行

在 Linux / AutoDL 主机使用 Python 3.10，安装 CUDA 对应的 PyTorch 和项目 Venus 依赖，设置：

```bash
export SMARTCROP_WORKER_BACKEND=venus
export SMARTCROP_MODEL_PATH=/absolute/path/to/model
export SMARTCROP_ACCESS_CODE='replace-with-a-long-random-code'
export SMARTCROP_REPORT_TRANSLATOR=deepseek
export SMARTCROP_DEEPSEEK_API_KEY='set-this-privately'
# 真实 P0 验收通过前保持 false
export SMARTCROP_P0_CAPABILITIES_VERIFIED=false
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
.\.venv\Scripts\python.exe scripts/run_regression.py `
  --base-url https://your-host `
  --expected-report-language zh-CN
```

回归结果写入被忽略的 `var/regression/`。它检查上传、排队、真实模型结果、结构化报告和可解码裁剪制品；模型质量仍需人工复核。
