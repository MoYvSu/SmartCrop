# GPU deployment guide

以下方案面向带一张 RTX 4090 的 Linux / AutoDL 演示主机。Venus 基于旧版 Qwen-VL
自定义代码，真实模型环境固定使用 Python 3.10 和 Transformers 4.32.0。先按主机 CUDA
版本安装 PyTorch，再安装项目依赖。

## 数据盘布局

模型、Conda 环境、源码、前端依赖和运行数据都放在高速数据盘，避免占用系统盘：

```text
/root/autodl-tmp/
├── SmartCrop/                 # 项目源码
├── envs/smartcrop/            # Python + Node.js 环境
├── models/Venus-Q-Stage2/     # Hugging Face 模型
├── smartcrop-data/            # 上传、裁剪和 SQLite
├── .cache/                    # Conda、pip、HF、Corepack、pnpm 缓存与临时文件
└── smartcrop.env              # 私有运行配置，不进入 Git
```

## 安装与构建

```bash
mkdir -p /root/autodl-tmp/.cache/{conda/pkgs,pip,huggingface,corepack,pnpm/store,npm,tmp}
export CONDA_PKGS_DIRS=/root/autodl-tmp/.cache/conda/pkgs
export PIP_CACHE_DIR=/root/autodl-tmp/.cache/pip
export HF_HOME=/root/autodl-tmp/.cache/huggingface
export COREPACK_HOME=/root/autodl-tmp/.cache/corepack
export npm_config_cache=/root/autodl-tmp/.cache/npm
export TMPDIR=/root/autodl-tmp/.cache/tmp

source /root/miniconda3/etc/profile.d/conda.sh
conda create -p /root/autodl-tmp/envs/smartcrop python=3.10 nodejs=22 -c conda-forge -y
conda activate /root/autodl-tmp/envs/smartcrop

python -m pip install --upgrade pip
python -m pip install torch==2.8.0 torchvision==0.23.0 \
  --index-url https://download.pytorch.org/whl/cu128

cd /root/autodl-tmp/SmartCrop
python -m pip install -e '.[venus]'
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm --dir apps/web --store-dir /root/autodl-tmp/.cache/pnpm/store install --frozen-lockfile
pnpm --dir apps/web build
```

下载模型：

```bash
hf download popo28/Venus-Q-Stage2 \
  --local-dir /root/autodl-tmp/models/Venus-Q-Stage2
```

`hf` 由 `huggingface-hub` 提供；如命令不存在，先运行
`python -m pip install -U huggingface-hub`。公开模型通常无需令牌；遇到访问限制时再运行
`hf auth login`。AutoDL 的 `/etc/network_turbo` 只用于 GitHub/Hugging Face 下载，不用于
pip：它可能把 NVIDIA wheel 改写到更慢的代理。需要模型加速时，在运行 `hf download` 的
同一个 shell 中先执行 `source /etc/network_turbo`。

复制 `.env.example` 到 `/root/autodl-tmp/smartcrop.env`，至少修改访问码，并将路径设置为：

```dotenv
SMARTCROP_DATA_DIR=/root/autodl-tmp/smartcrop-data
SMARTCROP_DATABASE_PATH=/root/autodl-tmp/smartcrop-data/smartcrop.sqlite3
SMARTCROP_WEB_DIST=/root/autodl-tmp/SmartCrop/apps/web/dist
SMARTCROP_WORKER_BACKEND=venus
SMARTCROP_MODEL_PATH=/root/autodl-tmp/models/Venus-Q-Stage2
SMARTCROP_LOAD_IN_8BIT=true
SMARTCROP_DEMO_USERNAME=demo
SMARTCROP_DEMO_DISPLAY_NAME=演示摄影师
SMARTCROP_DEMO_PASSWORD=123456
SMARTCROP_SESSION_COOKIE_SECURE=true
SMARTCROP_SESSION_TTL_SECONDS=604800
SMARTCROP_REPORT_TRANSLATOR=deepseek
SMARTCROP_DEEPSEEK_API_KEY=replace-with-your-private-api-key
SMARTCROP_DEEPSEEK_BASE_URL=https://api.deepseek.com
SMARTCROP_DEEPSEEK_MODEL=deepseek-v4-flash
SMARTCROP_DEEPSEEK_TIMEOUT_SECONDS=12
```

配置完成后运行 `chmod 600 /root/autodl-tmp/smartcrop.env`。模型、授权数据集和运行数据
均不提交仓库。DeepSeek 只接收 Venus 已生成的英文 JSON 报告，不接收用户图片、访问码或
任务元数据；翻译请求失败时系统保留英文报告，裁剪任务不会因此失败。

翻译为可选增强：设置 `SMARTCROP_REPORT_TRANSLATOR=none` 可关闭；即使设为 `deepseek`，
缺少密钥或翻译器初始化失败也只记录脱敏警告，并继续使用原报告。
`SMARTCROP_DEEPSEEK_TIMEOUT_SECONDS=12` 现为每份报告的**总翻译预算**，包含全部重试，
超时即取消网络等待并回退原报告。模型推理仍受 `SMARTCROP_TASK_TIMEOUT_SECONDS` 独立保护；
推理完成后的结果整理另有翻译预算加 30 秒制品/数据库余量的看门狗，不会因翻译跨过原推理
截止时间而误杀任务。模型、文件写入或数据库本身的故障仍可能导致任务失败。

升级此版本后应同时重启 API 和 worker。SQLite 自动创建账号、会话、作品与版本表，保留旧任务；
不要删库升级。旧临时任务不会自动成为持久作品，已过期任务的图片不能找回。`--once` 会检查返回结果是否
超时，但只有常驻 supervisor 能强制终止真正卡死的模型或制品处理进程。

## 启动进程

```bash
source /root/miniconda3/etc/profile.d/conda.sh
conda activate /root/autodl-tmp/envs/smartcrop
cd /root/autodl-tmp/models/Venus-Q-Stage2
set -a
source /root/autodl-tmp/smartcrop.env
set +a
smartcrop-worker
```

worker 从模型目录启动是有意为之：上游 Qwen tokenizer 首次加载时会把 `SimSun.ttf`
写到当前目录。这样运行期模型资产不会污染项目 Git 工作区。

另一个进程：

```bash
source /root/miniconda3/etc/profile.d/conda.sh
conda activate /root/autodl-tmp/envs/smartcrop
cd /root/autodl-tmp/SmartCrop
set -a
source /root/autodl-tmp/smartcrop.env
set +a
smartcrop-api --host 127.0.0.1 --port 8000
```

部署采用一个 API 进程、一个 worker；不要使用多 API 进程或多个 worker。SQLite 与文件资源按单主机协调，尚未验收多 API 实例的资源并发操作。单 GPU 推理串行化依赖单 worker；`smartcrop-worker` 本身是看门狗，模型在子进程中常驻，任务硬超时后会重建子进程。

## 演示账号与持久作品

演示账号默认 `demo / 123456`，仅适用于受控展示，公网部署请覆盖为独立强密码。
非空的 `SMARTCROP_DEMO_PASSWORD` 优先于默认值；重启 API 会更新同一账号密码并撤销旧会话，作品不丢失。
只有显式设置空字符串时，新数据库才随机生成密码到数据目录的 `demo-credentials.txt`，已有账号则保留当前密码。
移除环境变量会恢复默认 `123456` 并在下次启动时生效；普通重启不重复撤销会话。不要把私有密码写进日志。

同一演示账号的所有访问者共用作品库，不具备不同人员隔离。仅供受控展示，请使用授权素材，
勿上传敏感照片。图像保存为去除全部元数据的规范化图像，不是原始文件的无损字节备份。
新导入时另存相机、镜头和曝光参数白名单，GPS、日期、序列号等不保留；旧作品不回填参数。
草稿、归档成片、历史版本位于数据目录 `projects/`，编辑快照和 AI 参考在 SQLite 中，保留至主动删除。
`SMARTCROP_RETENTION_SECONDS` 只影响临时 `jobs/`，不能用它清理作品库。
删除项目会清除专属持久资源并阻断关联任务读取；分析任务临时副本仍按原有到期策略清理，
不承诺备份被同步擦除，也不要把清缓存等同删除作品。

备份或迁移必须保持 **SQLite 与 projects/ 的同一时刻状态**：先停止 API 和 worker，
确认进程已退出，再完整复制数据目录及实际 `SMARTCROP_DATABASE_PATH` 所在目录（包括残留的 WAL/SHM 文件），
保留权限；不能只拷贝正在写入的 `.sqlite3` 或单独保存图片。恢复后校验登录、作品打开、编辑和版本下载。
数据目录若与数据库分开放置，也必须同时备份。不要将运行数据放在 Git 管理的源码目录中。

Linux 限制目录访问权限；Windows 开发机还需检查 NTFS ACL，Python 文件模式不等同 Windows 私有权限。
首次运行不要在未知凭据文件旁创建新库；初始化遇到不可信文件会拒绝继续，请核实部署路径而非随意删除。

## HTTPS 与公网入口

API 只监听 `127.0.0.1`。使用平台 HTTPS 网关，或用 Caddy/Nginx 把域名反代到 `127.0.0.1:8000`。入口至少应强制 HTTPS、限制 20 MB 请求体、限制上传速率、不缓存 `/v1`，且不得记录访问码请求头。

公网入口必须使用 HTTPS，并设置 `SMARTCROP_SESSION_COOKIE_SECURE=true`。仅本机 HTTP 或 SSH 本地转发
使用 `false`，否则浏览器不会在 HTTP 请求中携带登录 Cookie。账号通过同源 Cookie 会话验证，
写入还校验防伪请求令牌（CSRF）；前端与 API 应放在同一个域名下，不新增跨域放行。
共享访问码只保留旧任务工具链兼容，不能替代作品账号登录；临时公网 URL 也不能视为认证。

## 运行检查

```bash
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
SMARTCROP_ACCESS_CODE='<code>' python scripts/run_regression.py \
  --base-url https://your-domain \
  --expected-report-language zh-CN
```

发布演示前必须完整跑 30 图回归并人工抽查裁剪与报告。Mock 后端只用于本地连通性，不是 GPU 或模型验收证据。

## 运维注意

- 将 API 与 worker 分别交给 systemd、supervisord 或平台进程守护；
- 监控 GPU OOM、worker 重启次数、任务失败率、排队深度和运行 P95；
- 模型重新加载期间 API 仍可接受最多 5 个等待任务；
- 修改保留时间或清理承诺前，先更新测试和产品文档。
