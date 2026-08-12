#!/usr/bin/env python3
"""
設定管理モジュール

アプリケーション全体の設定を管理します。JSONファイルからの読み込み、
デフォルト値の提供、および設定の保存機能を提供します。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from core.logger import get_logger, log_exception
from core.version import APP_VERSION

# ロガーの初期化
logger = get_logger("config")


def _get_app_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def _default_user_config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AAT"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / "AAT"
    return Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "AAT"


def get_user_config_dir() -> Path:
    override_dir = os.environ.get("AAT_CONFIG_DIR")
    base_dir = Path(override_dir).expanduser() if override_dir else _default_user_config_dir()
    if override_dir:
        logger.debug("環境変数AAT_CONFIG_DIRでユーザー設定ディレクトリを指定: %s", base_dir)

    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # pragma: no cover - 予期しないパスや権限のためのフォールバック
        logger.warning("ユーザー設定ディレクトリの作成に失敗しました (%s)。ホーム直下に退避します。", exc)
        fallback_dir = Path.home() / ".AAT"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        return fallback_dir

    return base_dir


def _migrate_legacy_config(user_config_path: Path, backup_path: Path) -> None:
    legacy_dir = _get_app_root()
    legacy_config_path = legacy_dir / "config.json"
    legacy_backup_path = legacy_dir / "config.json.bak"

    if user_config_path.exists() or not legacy_config_path.exists():
        return

    logger.info("旧形式の設定ファイルが見つかりました。新しい保存場所へ移動します: %s", legacy_config_path)
    try:
        user_config_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy_config_path), user_config_path)
        logger.info("設定ファイルを移動しました: %s -> %s", legacy_config_path, user_config_path)

        if legacy_backup_path.exists() and not backup_path.exists():
            shutil.move(str(legacy_backup_path), backup_path)
            logger.info("バックアップファイルも移動しました: %s -> %s", legacy_backup_path, backup_path)
    except Exception as exc:  # pragma: no cover
        logger.warning("旧設定ファイルの移行に失敗しました: %s", exc)


class _Spec:
    """1つの設定キーに対する型と許容範囲の定義"""

    __slots__ = ("kind", "minimum", "maximum", "choices")

    def __init__(self, kind: str, minimum: float | None = None, maximum: float | None = None, choices=None):
        self.kind = kind
        self.minimum = minimum
        self.maximum = maximum
        self.choices = choices


# 解析結果・出力に影響する設定の型と範囲。破損した設定ファイルや手編集で
# 範囲外の値が入ると、黙って誤った解析結果を返したり（sampling_rate=0）、
# 例外で落ちたり（g_quality_step=0 の ZeroDivisionError）、巨大な画像を
# 生成してメモリを食い潰したりする（export_dpi=100000）。
# エクスポート画像の見た目に関わる既定値（figure幅・高さ・DPI・bbox）は
# 現状維持が要件なので、上限は常識的な範囲に留め既定値には触れない。
_CONFIG_SPECS: dict[str, _Spec] = {
    "time_column": _Spec("nonempty_str"),
    "acceleration_column_inner_capsule": _Spec("nonempty_str"),
    "acceleration_column_drag_shield": _Spec("nonempty_str"),
    "use_inner_acceleration": _Spec("bool"),
    "use_drag_acceleration": _Spec("bool"),
    "sampling_rate": _Spec("int", minimum=1, maximum=10_000_000),
    "gravity_constant": _Spec("float", minimum=1e-9),
    "ylim_min": _Spec("float", minimum=-1e6, maximum=1e6),
    "ylim_max": _Spec("float", minimum=-1e6, maximum=1e6),
    "acceleration_threshold": _Spec("float", minimum=1e-9),
    "end_gravity_level": _Spec("float", minimum=1e-9),
    "window_size": _Spec("float", minimum=1e-9),
    "g_quality_start": _Spec("float", minimum=1e-9),
    "g_quality_end": _Spec("float", minimum=1e-9),
    "g_quality_step": _Spec("float", minimum=1e-9),
    "min_seconds_after_start": _Spec("float", minimum=0.0),
    "auto_calculate_g_quality": _Spec("bool"),
    "use_cache": _Spec("bool"),
    "default_graph_duration": _Spec("float", minimum=1e-9),
    "graph_sensor_mode": _Spec("choice", choices=("both", "inner_only", "drag_only")),
    "theme": _Spec("choice", choices=("system", "light", "dark")),
    "export_figure_width": _Spec("float", minimum=1.0, maximum=100.0),
    "export_figure_height": _Spec("float", minimum=1.0, maximum=100.0),
    "export_dpi": _Spec("int", minimum=50, maximum=1200),
    "export_bbox_inches": _Spec("bbox"),
}


def _coerce_value(value: Any, spec: _Spec) -> Any:
    """仕様に従って値を変換する。変換できない場合は ValueError を送出する。"""
    if spec.kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, int | float) and not isinstance(value, bool):
            return bool(value)
        if isinstance(value, str) and value.strip().lower() in ("true", "false"):
            return value.strip().lower() == "true"
        raise ValueError("真偽値ではありません")

    if spec.kind == "nonempty_str":
        if not isinstance(value, str) or not value.strip():
            raise ValueError("空でない文字列ではありません")
        return value

    if spec.kind == "choice":
        normalized = str(value).strip().lower()
        if normalized not in (spec.choices or ()):
            raise ValueError(f"許可されていない値です（{', '.join(spec.choices or ())} のいずれか）")
        return normalized

    if spec.kind == "bbox":
        # None（固定サイズ）または "tight" のみ
        if value is None:
            return None
        if isinstance(value, str) and value.strip().lower() == "tight":
            return "tight"
        raise ValueError('null または "tight" のみ指定できます')

    if isinstance(value, bool):
        # True/False が数値として通ってしまうのを防ぐ
        raise ValueError("数値ではありません")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        # float() の英語メッセージをそのまま見せず、対処の分かる文にする
        raise ValueError(f"数値として解釈できません（{value!r}）") from exc
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError("有限の数値ではありません")
    if spec.minimum is not None and number < spec.minimum:
        raise ValueError(f"{spec.minimum} 以上である必要があります")
    if spec.maximum is not None and number > spec.maximum:
        raise ValueError(f"{spec.maximum} 以下である必要があります")
    return int(round(number)) if spec.kind == "int" else number


def validate_config(config: dict[str, Any], defaults: dict[str, Any]) -> list[str]:
    """設定値を検証し、不正な値をデフォルトへ差し戻す

    config はその場で修正される。戻り値は利用者に示すための修正内容の一覧。
    """
    problems: list[str] = []

    for key, spec in _CONFIG_SPECS.items():
        if key not in config:
            continue
        try:
            config[key] = _coerce_value(config[key], spec)
        except (TypeError, ValueError) as exc:
            fallback = defaults.get(key)
            problems.append(f"{key}: {exc} → 既定値 {fallback!r} を使用します")
            if fallback is not None or spec.kind == "bbox":
                config[key] = fallback
            else:
                config.pop(key, None)

    # 単独では妥当でも、組み合わせとして成立しない設定を整える
    if _both_numeric(config, "ylim_min", "ylim_max") and config["ylim_min"] >= config["ylim_max"]:
        problems.append("ylim_min が ylim_max 以上です → 既定のY軸範囲に戻します")
        config["ylim_min"] = defaults.get("ylim_min", -1.0)
        config["ylim_max"] = defaults.get("ylim_max", 1.0)

    if (
        _both_numeric(config, "g_quality_start", "g_quality_end")
        and config["g_quality_start"] > config["g_quality_end"]
    ):
        problems.append("g_quality_start が g_quality_end を超えています → 既定のG-quality範囲に戻します")
        config["g_quality_start"] = defaults.get("g_quality_start", 0.1)
        config["g_quality_end"] = defaults.get("g_quality_end", 1.0)

    if _both_numeric(config, "g_quality_start", "g_quality_end") and isinstance(
        config.get("g_quality_step"), int | float
    ):
        span = config["g_quality_end"] - config["g_quality_start"]
        if span > 0 and config["g_quality_step"] > span:
            problems.append("g_quality_step が走査範囲より大きいです → 走査範囲に合わせます")
            config["g_quality_step"] = span

    for problem in problems:
        logger.warning("設定値を補正しました: %s", problem)
    return problems


def _both_numeric(config: dict[str, Any], first: str, second: str) -> bool:
    return isinstance(config.get(first), int | float) and isinstance(config.get(second), int | float)


def load_default_config() -> dict[str, Any]:
    """ユーザー設定を反映しない、素のデフォルト設定を返す

    設定ダイアログの「デフォルトに戻す」で使用する。load_config() は
    ユーザー設定を重ねた結果を返すため、リセット用途には使えない。
    """
    default_config_path = _get_app_root() / "config" / "config.default.json"
    try:
        with default_config_path.open("r", encoding="utf-8") as f:
            defaults = json.load(f)
        if not isinstance(defaults, dict):
            raise ValueError("デフォルト設定がオブジェクトではありません")
    except Exception as exc:
        logger.warning("デフォルト設定ファイルを読み込めませんでした (%s)。組み込みの既定値を使用します。", exc)
        defaults = dict(_FALLBACK_DEFAULT_CONFIG)
    defaults["app_version"] = APP_VERSION
    return defaults


_FALLBACK_DEFAULT_CONFIG: dict[str, Any] = {
    "time_column": "データセット1:時間(s)",
    "acceleration_column_inner_capsule": "データセット1:Z-axis acceleration 1(m/s²)",
    "acceleration_column_drag_shield": "データセット1:Z-axis acceleration 2(m/s²)",
    "use_inner_acceleration": True,
    "use_drag_acceleration": True,
    "sampling_rate": 1000,
    "gravity_constant": 9.797578,
    "ylim_min": -1.0,
    "ylim_max": 1.0,
    "acceleration_threshold": 5.0,
    "end_gravity_level": 8.0,
    "window_size": 0.1,
    "g_quality_start": 0.1,
    "g_quality_end": 1.0,
    "g_quality_step": 0.05,
    "min_seconds_after_start": 0.7,
    "auto_calculate_g_quality": True,
    "use_cache": True,
    "default_graph_duration": 1.45,
    "graph_sensor_mode": "both",
    "theme": "system",
    "export_figure_width": 10.6,
    "export_figure_height": 3.4,
    "export_dpi": 300,
    "export_bbox_inches": None,
    "invert_inner_acceleration": True,
    "app_version": APP_VERSION,
}


def load_config(on_warning: Callable[[str], None] | None = None) -> dict[str, Any]:
    """
    設定ファイルを読み込む

    1. config/config.default.jsonからデフォルト設定を読み込み
    2. ユーザー設定ディレクトリ（環境変数AAT_CONFIG_DIRで上書き可）のconfig.jsonを読み込み
    3. ユーザー設定が存在しない場合は、デフォルト設定をコピーして作成
       旧仕様のconfig.jsonがアプリケーションルートにある場合は自動で移行

    Returns:
        dict: 設定情報を含む辞書
    """
    warn = on_warning or (lambda msg: logger.warning("%s", msg))

    app_root = _get_app_root()
    default_config_path = app_root / "config" / "config.default.json"

    user_config_dir = get_user_config_dir()
    user_config_path = user_config_dir / "config.json"
    backup_path = user_config_dir / "config.json.bak"

    _migrate_legacy_config(user_config_path, backup_path)

    logger.debug(f"デフォルト設定ファイルのパス: {default_config_path}")
    logger.debug(f"ユーザー設定ファイルのパス: {user_config_path}")

    # デフォルト設定を読み込み
    try:
        with default_config_path.open("r", encoding="utf-8") as f:
            logger.info("デフォルト設定ファイルを読み込んでいます")
            default_config = json.load(f)
            logger.debug(f"読み込まれたデフォルト設定: {default_config}")
    except FileNotFoundError:
        logger.error(f"デフォルト設定ファイルが見つかりません: {default_config_path}")
        # フォールバック用のハードコードされたデフォルト設定
        default_config = dict(_FALLBACK_DEFAULT_CONFIG)
    except json.JSONDecodeError as e:
        logger.error(f"デフォルト設定ファイルの解析に失敗しました: {e}")
        raise

    if not isinstance(default_config, dict):
        logger.error("デフォルト設定ファイルがオブジェクトではありません。組み込みの既定値を使用します。")
        default_config = dict(_FALLBACK_DEFAULT_CONFIG)

    # バージョン情報は常に最新を使用
    default_config["app_version"] = APP_VERSION
    pristine_defaults = dict(default_config)

    # ユーザー設定ファイルが存在するかチェック
    if not user_config_path.exists():
        logger.info("ユーザー設定ファイルが存在しません。デフォルト設定をコピーします")
        try:
            user_config_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(default_config_path, user_config_path)
            logger.info(f"デフォルト設定をユーザー設定としてコピーしました: {user_config_path}")
        except Exception as e:
            logger.warning(f"ユーザー設定ファイルの作成に失敗しました: {e}")

    # ユーザー設定を読み込み
    try:
        with user_config_path.open("r", encoding="utf-8") as f:
            logger.info("ユーザー設定ファイルを読み込んでいます")
            user_config = json.load(f)
            logger.debug(f"読み込まれたユーザー設定: {user_config}")

        # ユーザー設定でデフォルト設定を上書き
        _merge_user_config(default_config, user_config, user_config_path)

        # バージョン情報は常に最新を使用
        default_config["app_version"] = APP_VERSION

        logger.info("設定ファイルの読み込みに成功しました")
    except FileNotFoundError:
        logger.warning(f"ユーザー設定ファイルが見つかりません: {user_config_path}")
        logger.info("デフォルト設定を使用します")
    except json.JSONDecodeError as e:
        logger.error(f"ユーザー設定ファイルの解析に失敗しました: {e}")
        # バックアップからの復元を試みる
        restored = False
        if backup_path.exists():
            try:
                with backup_path.open("r", encoding="utf-8") as bf:
                    user_config = json.load(bf)
                logger.info("バックアップから設定を復元しました: %s", backup_path)
                shutil.copy2(backup_path, user_config_path)
                _merge_user_config(default_config, user_config, backup_path)
                default_config["app_version"] = APP_VERSION
                restored = True
            except Exception as backup_error:
                logger.warning("バックアップからの復元にも失敗しました: %s", backup_error)
        if not restored:
            warn(f"ユーザー設定ファイルの解析に失敗しました: {user_config_path}\nデフォルト設定を使用します。")

    # 型・範囲を検証し、不正な値はデフォルトへ差し戻す。ここで弾かないと
    # 解析パラメータとして下流に流れ、誤った結果や例外の原因になる。
    problems = validate_config(default_config, pristine_defaults)
    if problems:
        detail = "\n".join(f"・{problem}" for problem in problems[:8])
        if len(problems) > 8:
            detail += f"\n…ほか {len(problems) - 8} 件"
        warn(f"設定ファイルに使用できない値があったため既定値に戻しました:\n{detail}")

    logger.debug(f"最終的な設定: {default_config}")
    return default_config


def _merge_user_config(target: dict[str, Any], user_config: Any, source: Path) -> None:
    """ユーザー設定を既知のキーだけマージする

    JSONのトップレベルがオブジェクト以外（配列や文字列）の場合、`key in obj` が
    値に対する曖昧な包含判定になってしまうため、辞書であることを明示的に確認する。
    """
    if not isinstance(user_config, dict):
        logger.warning("設定ファイルの形式が不正です（オブジェクトではありません）: %s", source)
        return

    unknown = [key for key in user_config if key not in target]
    if unknown:
        # 旧バージョンのキーやユーザーのメモが残っていても壊さず、無視した事実だけ残す
        logger.info("未知の設定キーを無視します: %s", ", ".join(sorted(map(str, unknown))))

    for key in target:
        if key in user_config:
            target[key] = user_config[key]


def save_config(config: dict[str, Any], on_error: Callable[[str], None] | None = None) -> bool:
    """
    設定ファイルを保存する

    指定された設定情報をJSONファイルに保存します。
    エラー時は既存の設定を保護するためにバックアップを作成します。

    Args:
        config (dict): 保存する設定情報

    Returns:
        bool: 保存に成功した場合はTrue、失敗した場合はFalse
    """
    notify_error = on_error or (lambda msg: logger.warning("%s", msg))

    user_config_dir = get_user_config_dir()
    config_path = user_config_dir / "config.json"
    backup_path = user_config_dir / "config.json.bak"

    user_config_dir.mkdir(parents=True, exist_ok=True)

    logger.debug(f"設定を保存します: {config}")

    try:
        # 既存の設定ファイルがあればバックアップ
        if config_path.exists():
            shutil.copy2(config_path, backup_path)
            logger.debug(f"設定ファイルをバックアップしました: {backup_path}")

        # 浮動小数点精度問題を修正してからシリアライズ
        def _clean_floats(obj):
            if isinstance(obj, dict):
                return {k: _clean_floats(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_clean_floats(item) for item in obj]
            if isinstance(obj, float):
                return round(obj, 10)
            return obj

        config_str = json.dumps(_clean_floats(config), indent=4, ensure_ascii=False)

        # 同じディレクトリの一時ファイルへ書き切ってから置き換える。設定ファイルへ
        # 直接書くと、途中で中断されたときに切り詰められたJSONが残り、次回起動時に
        # 解析エラーになる。
        fd, temp_name = tempfile.mkstemp(prefix=".config_", suffix=".json", dir=str(user_config_dir))
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(config_str)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, config_path)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

        logger.info(f"設定ファイルを正常に保存しました: {config_path}")
        return True
    except Exception as e:
        log_exception(e, "設定の保存中にエラーが発生しました")

        # バックアップから復元を試みる
        if backup_path.exists():
            try:
                shutil.copy2(backup_path, config_path)
                logger.info(f"バックアップから設定を復元しました: {backup_path}")
            except Exception as e2:
                log_exception(e2, "バックアップからの復元に失敗しました")

        notify_error(f"設定の保存中にエラーが発生しました: {e}")
        return False
