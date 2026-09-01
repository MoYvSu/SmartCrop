from __future__ import annotations

from smartcrop_runtime import Settings

from .backends import InferenceBackend, MockBackend, VenusBackend


def build_backend(settings: Settings) -> InferenceBackend:
    if settings.worker_backend == "mock":
        return MockBackend()
    if settings.worker_backend == "venus":
        if settings.model_path is None:
            raise RuntimeError("SMARTCROP_MODEL_PATH is required for the Venus backend")
        return VenusBackend(settings.model_path, load_in_8bit=settings.load_in_8bit)
    raise RuntimeError(f"Unsupported worker backend: {settings.worker_backend}")
