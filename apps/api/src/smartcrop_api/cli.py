from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn
from smartcrop_runtime import Settings

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="SmartCrop FastAPI service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    if args.reload:
        uvicorn.run(
            "smartcrop_api.app:create_app",
            host=args.host,
            port=args.port,
            reload=True,
            factory=True,
        )
        return

    settings = Settings.from_env(args.project_root)
    uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
