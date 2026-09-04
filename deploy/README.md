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
```

配置完成后运行 `chmod 600 /root/autodl-tmp/smartcrop.env`。模型、授权数据集和运行数据
均不提交仓库。

## 启动进程

```bash
source /root/miniconda3/etc/profile.d/conda.sh
conda activate /root/autodl-tmp/envs/smartcrop
cd /root/autodl-tmp/SmartCrop
set -a
source /root/autodl-tmp/smartcrop.env
set +a
smartcrop-worker
```

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

不要使用多个 worker；V1 的单 GPU 序列化保证依赖这一约束。`smartcrop-worker` 本身是看门狗，模型在子进程中常驻，任务硬超时后会重建子进程。

## HTTPS 与公网入口

API 只监听 `127.0.0.1`。使用平台 HTTPS 网关，或用 Caddy/Nginx 把域名反代到 `127.0.0.1:8000`。入口至少应强制 HTTPS、限制 20 MB 请求体、限制上传速率、不缓存 `/v1`，且不得记录访问码请求头。

如果 AutoDL 只提供临时隧道，仍需在应用侧设置访问码；临时公网 URL 不能视为认证。

## 运行检查

```bash
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
SMARTCROP_ACCESS_CODE='<code>' python scripts/run_regression.py \
  --base-url https://your-domain
```

发布演示前必须完整跑 30 图回归并人工抽查裁剪与报告。Mock 后端只用于本地连通性，不是 GPU 或模型验收证据。

## 运维注意

- 将 API 与 worker 分别交给 systemd、supervisord 或平台进程守护；
- 监控 GPU OOM、worker 重启次数、任务失败率、排队深度和运行 P95；
- 模型重新加载期间 API 仍可接受最多 5 个等待任务；
- 修改保留时间或清理承诺前，先更新测试和产品文档。
