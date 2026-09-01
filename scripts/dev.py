from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    environment.setdefault("SMARTCROP_WORKER_BACKEND", "mock")
    commands = [
        [sys.executable, "-m", "smartcrop_worker.cli", "--project-root", str(root)],
        [sys.executable, "-m", "smartcrop_api.cli", "--project-root", str(root)],
    ]
    processes = [subprocess.Popen(command, cwd=root, env=environment) for command in commands]
    print("SmartCrop mock demo: http://127.0.0.1:8000")
    try:
        while True:
            for process in processes:
                exit_code = process.poll()
                if exit_code is not None:
                    raise SystemExit(exit_code)
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                if os.name == "nt":
                    process.terminate()
                else:
                    process.send_signal(signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
