# GPU deployment guide

以下方案面向带一张 RTX 4090 的 Linux / AutoDL 演示主机。推荐 Python 3.10 或 3.11；先按主机 CUDA 版本安装 PyTorch，再安装项目依赖。

## 安装与构建

```bash
python -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e '.[dev,venus]'
corepack enable
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web build
```

复制 `.env.example` 到服务器私有位置（例如 `/etc/smartcrop.env`），至少修改访问码、模型路径、数据目录和前端构建目录。模型、授权数据集和运行数据均应放在持久数据盘，不提交仓库。

## 启动进程

```bash
set -a
source /etc/smartcrop.env
set +a
.venv/bin/smartcrop-worker
```

另一个进程：

```bash
set -a
source /etc/smartcrop.env
set +a
.venv/bin/smartcrop-api --host 127.0.0.1 --port 8000
```

不要使用多个 worker；V1 的单 GPU 序列化保证依赖这一约束。`smartcrop-worker` 本身是看门狗，模型在子进程中常驻，任务硬超时后会重建子进程。

## HTTPS 与公网入口

API 只监听 `127.0.0.1`。使用平台 HTTPS 网关，或用 Caddy/Nginx 把域名反代到 `127.0.0.1:8000`。入口至少应强制 HTTPS、限制 20 MB 请求体、限制上传速率、不缓存 `/v1`，且不得记录访问码请求头。

如果 AutoDL 只提供临时隧道，仍需在应用侧设置访问码；临时公网 URL 不能视为认证。

## 运行检查

```bash
curl -fsS http://127.0.0.1:8000/health/live
curl -fsS http://127.0.0.1:8000/health/ready
SMARTCROP_ACCESS_CODE='<code>' .venv/bin/python scripts/run_regression.py \
  --base-url https://your-domain
```

发布演示前必须完整跑 30 图回归并人工抽查裁剪与报告。Mock 后端只用于本地连通性，不是 GPU 或模型验收证据。

## 运维注意

- 将 API 与 worker 分别交给 systemd、supervisord 或平台进程守护；
- 监控 GPU OOM、worker 重启次数、任务失败率、排队深度和运行 P95；
- 模型重新加载期间 API 仍可接受最多 5 个等待任务；
- 修改保留时间或清理承诺前，先更新测试和产品文档。
