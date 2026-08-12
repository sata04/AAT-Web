#!/usr/bin/env python3
"""
ロガーモジュール

アプリケーション全体で使用する統一的なロギング機能を提供します。
各モジュールは専用のロガーインスタンスを取得して使用できます。
"""

import logging
import os
import sys

_ROOT_LOGGER_NAME = "AAT"


def _is_aat_entry_point() -> bool:
    """AAT自身がコマンドラインから起動されたかを判定する

    このモジュールは pytest や他のツールからもインポートされる。argv を
    無条件に読むと、たとえば `pytest -v` の -v をAATの詳細モード指定と
    誤解し、AAT_LOG_LEVEL の指定まで上書きしてしまう。
    """
    entry = os.path.basename(sys.argv[0]) if sys.argv else ""
    return entry in ("main.py", "AAT", "aat", "AAT.exe") or entry.startswith("AAT")


def _resolve_log_level() -> int:
    """環境変数と（AAT起動時のみ）コマンドライン引数からログレベルを決める"""
    log_level = logging.WARNING

    log_level_env = os.environ.get("AAT_LOG_LEVEL")
    if log_level_env:
        log_level = getattr(logging, log_level_env.strip().upper(), logging.WARNING)

    if os.environ.get("AAT_DEBUG"):
        return logging.DEBUG

    if _is_aat_entry_point():
        if "--debug" in sys.argv:
            return logging.DEBUG
        if "--verbose" in sys.argv or "-v" in sys.argv:
            return logging.INFO

    return log_level


def _setup_logging() -> None:
    """ロギングシステムの初期化

    レベルとハンドラは "AAT" ロガーにだけ設定する。root へ設定すると
    AAT_DEBUG=1 のときに matplotlib や PIL の DEBUG ログまで流れ込み、
    アプリのログが埋もれてしまう。
    """
    aat_logger = logging.getLogger(_ROOT_LOGGER_NAME)
    aat_logger.setLevel(_resolve_log_level())

    if not aat_logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        aat_logger.addHandler(handler)

    # root へ伝播させない（呼び出し側がrootに独自ハンドラを持つ場合の二重出力を防ぐ）
    aat_logger.propagate = False


# ロギングシステムを初期化
_setup_logging()

# グローバルロガーインスタンス
logger: logging.Logger = logging.getLogger(_ROOT_LOGGER_NAME)


def get_logger(module_name: str) -> logging.Logger:
    """
    指定したモジュール名のロガーを取得する

    モジュールごとに名前空間が分離されたロガーを提供し、
    ログの発生源を明確に識別できるようにします。

    Args:
        module_name: モジュール名

    Returns:
        モジュール専用のロガーインスタンス
    """
    return logging.getLogger(f"AAT.{module_name}")


def log_exception(e: Exception, message: str = "エラーが発生しました") -> None:
    """
    例外情報をログに記録する

    統一的な形式で例外情報をエラーレベルでログに記録します。

    Args:
        e: 発生した例外
        message: 追加のエラーメッセージ。デフォルトは「エラーが発生しました」。
    """
    logger.error(f"{message}: {str(e)}", exc_info=True)
