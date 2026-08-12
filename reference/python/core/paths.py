#!/usr/bin/env python3
"""
パス管理ユーティリティ

結果出力やキャッシュ用のディレクトリ構造を一元的に扱います。
"""

from __future__ import annotations

from pathlib import Path

from core.logger import get_logger

logger = get_logger("paths")


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _normalize_base_dir(base: Path) -> Path:
    # ファイルパスが渡された場合はディレクトリ部分を使用
    if base.is_file():
        return base.parent
    return base


def resolve_base_dir(csv_dir: str | Path | None) -> Path:
    """
    CSVディレクトリが未指定の場合はプロジェクトルートを返し、指定されていれば正規化して返す。
    """
    if not csv_dir:
        logger.debug("csv_dirが指定されていないためプロジェクトルートを使用します")
        return _project_root()

    base = Path(csv_dir).expanduser()
    try:
        base = base.resolve()
    except OSError:
        # 存在しないパスでも処理を続ける
        base = base.absolute()
    return _normalize_base_dir(base)


def ensure_results_dir(csv_dir: str | Path | None) -> Path:
    """
    結果出力用のディレクトリ（results_AAT）を作成して返す。
    """
    base_dir = resolve_base_dir(csv_dir)
    results_dir = base_dir / "results_AAT"
    results_dir.mkdir(parents=True, exist_ok=True)
    return results_dir


def ensure_graphs_dir(csv_dir: str | Path | None) -> Path:
    """
    グラフ出力用のディレクトリ（results_AAT/graphs）を作成して返す。
    """
    results_dir = ensure_results_dir(csv_dir)
    graphs_dir = results_dir / "graphs"
    graphs_dir.mkdir(parents=True, exist_ok=True)
    return graphs_dir


def ensure_cache_dir(csv_dir: str | Path | None) -> Path:
    """
    キャッシュ用のディレクトリ（results_AAT/cache）を作成して返す。
    """
    results_dir = ensure_results_dir(csv_dir)
    cache_dir = results_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir
