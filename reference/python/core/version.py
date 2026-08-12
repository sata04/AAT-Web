#!/usr/bin/env python3
"""
バージョン管理ユーティリティ

AATのバージョンを単一のソースから取得するためのヘルパー。
"""

from __future__ import annotations

import sys
from importlib import metadata
from pathlib import Path

try:  # Python 3.11+ 標準ライブラリ
    import tomllib  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover - Python <3.11環境
    tomllib = None  # type: ignore

_PACKAGE_NAME = "AAT"
_FALLBACK_VERSION = "0.0.0"


def _read_from_distribution() -> str | None:
    try:
        return metadata.version(_PACKAGE_NAME)
    except metadata.PackageNotFoundError:
        return None
    except Exception:
        return None


def _read_from_pyproject() -> str | None:
    candidates = [Path(__file__).resolve().parent.parent / "pyproject.toml"]
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.insert(0, Path(sys._MEIPASS) / "pyproject.toml")  # type: ignore[attr-defined]

    pyproject_path: Path | None = None
    for candidate in candidates:
        if candidate.exists():
            pyproject_path = candidate
            break
    if pyproject_path is None:
        return None

    try:
        content = pyproject_path.read_text(encoding="utf-8")
    except Exception:
        return None

    if tomllib:
        try:
            return tomllib.loads(content).get("project", {}).get("version")
        except Exception:
            pass

    in_project_section = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project_section = stripped.strip("[]") == "project"
            continue

        if in_project_section and stripped.startswith("version"):
            parts = stripped.split("=", maxsplit=1)
            if len(parts) == 2:
                return parts[1].strip().strip('"').strip("'")

    return None


def _resolve_version() -> str:
    """Prefer the checked-out pyproject version over any installed package metadata."""
    pyproject_version = _read_from_pyproject()
    distribution_version = _read_from_distribution()

    if pyproject_version:
        return pyproject_version

    if distribution_version:
        return distribution_version

    return _FALLBACK_VERSION


APP_VERSION: str = _resolve_version()
