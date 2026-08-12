#!/usr/bin/env python3
"""
データ処理モジュール

CSVファイルからのデータ読み込み、列の自動検出、重力レベルの計算、
およびデータのフィルタリング機能を提供します。
"""

import re
from typing import Any

import numpy as np
import pandas as pd

from core.exceptions import ColumnNotFoundError, DataLoadError, DataProcessingError
from core.logger import get_logger, log_exception

# モジュール用のロガーを初期化
logger = get_logger("data_processor")


def detect_columns(file_path: str, raw_data: pd.DataFrame | None = None) -> tuple[list[str], list[str]]:
    """
    CSVファイルから時間列と加速度列の候補を検出する

    カラム名に基づいて時間データと加速度データの候補となる列を特定します。
    カラム名に明示的な情報がない場合は数値データ型の列を候補とします。

    Args:
        file_path (str): CSVファイルのパス
        raw_data (pd.DataFrame, optional): 事前に読み込んだCSVデータ。
            指定した場合はファイルの再読み込みを省略します。

    Returns:
        tuple: 以下の2つのリストを含むタプル
            - list: 時間列の候補リスト
            - list: 加速度列の候補リスト

    Raises:
        ValueError: 列検出中にエラーが発生した場合
    """
    try:
        if raw_data is not None:
            data = raw_data  # Alias — do NOT mutate in-place
        else:
            try:
                data = pd.read_csv(file_path)
            except UnicodeDecodeError:
                logger.warning(f"UTF-8での読み込みに失敗しました。cp932で再試行します: {file_path}")
                data = pd.read_csv(file_path, encoding="cp932")

        logger.debug(f"読み込んだCSVのカラム: {data.columns.tolist()}")

        time_columns: list[str] = []
        acceleration_columns: list[str] = []

        # カラム名に基づいて候補を検出（単語境界マッチング）
        _time_pattern = re.compile(r"\btime|\bsec\b|\bt\b|\bs\b|時間|秒", re.IGNORECASE)
        _accel_pattern = re.compile(r"\bacc|\bacceleration|\ba\b|\bg\b|加速度", re.IGNORECASE)

        for column in data.columns:
            col_lower = column.lower().strip()

            # 時間列の候補を検出（単語境界マッチング）
            if _time_pattern.search(col_lower):
                time_columns.append(column)

            # 加速度列の候補を検出（単語境界マッチング）
            if _accel_pattern.search(col_lower):
                acceleration_columns.append(column)

        # 名前ベースの検出で候補がない場合は、数値データ型のカラムを候補に追加
        named_time_columns = list(time_columns)
        numeric_columns = [column for column in data.columns if pd.api.types.is_numeric_dtype(data[column])]

        if not time_columns:
            time_columns = [column for column in numeric_columns if column not in acceleration_columns]
            if not time_columns:
                time_columns = list(numeric_columns)

        if not acceleration_columns:
            # 名前で時間列と判定された列だけを除外する。数値フォールバックで
            # 埋めた time_columns まで除外すると、キーワードに一致しない
            # ヘッダー（例: X1,X2,X3）のCSVで加速度列候補が空になり、
            # 列選択ダイアログにも進めずファイルを一切読み込めなくなる。
            acceleration_columns = [column for column in numeric_columns if column not in named_time_columns]
            if len(acceleration_columns) > 1:
                # 先頭列を時間軸とみなす一般的なレイアウトを前提に候補から外す
                acceleration_columns = acceleration_columns[1:]

        logger.debug(f"検出された時間列候補: {time_columns}")
        logger.debug(f"検出された加速度列候補: {acceleration_columns}")

        return time_columns, acceleration_columns

    except Exception as e:
        log_exception(e, "列候補の検出中にエラーが発生しました")
        raise DataLoadError(file_path, "列候補の検出に失敗しました", e) from e


def _to_numeric_series(column: pd.Series, column_name: str, file_path: str) -> pd.Series:
    """列を数値Seriesへ変換する

    文字列と数値が混在した列をそのまま計算に流すと、符号反転や除算が
    TypeErrorになったり object dtype のまま比較されて誤った同期点を選ぶ。
    変換できない値は欠損として扱い、その件数をログに残す。全件変換できない
    場合は、ユーザーが列選択をやり直せるようにエラーとして通知する。
    """
    if isinstance(column, pd.DataFrame):
        # 同名列が複数ある場合、pandasは列名の重複を解消するため通常は起きない
        raise DataLoadError(file_path, f"列名 '{column_name}' が重複しています。CSVのヘッダーを確認してください。")

    numeric = pd.to_numeric(column, errors="coerce")
    coerced = int(numeric.isna().sum() - pd.isna(column).sum())
    if coerced > 0:
        logger.warning(f"列 '{column_name}' の {coerced} 件を数値に変換できなかったため欠損として扱います")
    if len(numeric) > 0 and bool(numeric.isna().all()):
        raise DataProcessingError(
            f"列 '{column_name}' に数値データが含まれていません。",
            f"CSVファイル: {file_path}",
        )
    return numeric.astype(float)


def _validate_time_axis(time: pd.Series, config: dict[str, Any], file_path: str) -> None:
    """時間列の妥当性を検査し、疑わしい点を警告する

    ここでは処理を止めず警告に留める。時間軸の乱れは実測データでも起こり、
    下流（開始点検出・np.interp）が誤った結果を出す前に痕跡を残すことが目的。
    """
    if time.empty:
        raise DataProcessingError("時間データが空です。CSVの内容を確認してください。")

    values = time.to_numpy(dtype=float)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        raise DataProcessingError(
            "時間列に有効な数値がありません。",
            f"CSVファイル: {file_path}",
        )
    if finite.size < values.size:
        logger.warning(f"時間列に欠損値が {values.size - finite.size} 件あります: {file_path}")

    diffs = np.diff(finite)
    if diffs.size == 0:
        return

    if np.any(diffs < 0):
        logger.warning(
            f"時間列が単調増加していません（減少 {int(np.sum(diffs < 0))} 箇所）。"
            "開始点検出や補間が意図しない結果になる可能性があります。"
        )
    duplicates = int(np.sum(diffs == 0))
    if duplicates:
        logger.warning(f"時間列に重複するタイムスタンプが {duplicates} 件あります。")

    positive = diffs[diffs > 0]
    if positive.size == 0:
        return

    median_dt = float(np.median(positive))
    configured_rate = config.get("sampling_rate")
    try:
        configured_rate = float(configured_rate)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        configured_rate = 0.0
    if configured_rate > 0 and median_dt > 0:
        observed_rate = 1.0 / median_dt
        # 10%以上ずれていれば、窓幅（秒）の解釈がデータと合わない
        if abs(observed_rate - configured_rate) / configured_rate > 0.1:
            logger.warning(
                f"設定のサンプリングレート({configured_rate:.6g} Hz)と実データの推定値"
                f"({observed_rate:.6g} Hz)が一致しません。解析窓の秒数が実際とずれます。"
            )

    spread = float(np.percentile(positive, 95) - np.percentile(positive, 5))
    if median_dt > 0 and spread / median_dt > 0.5:
        logger.warning("サンプリング間隔が不均一です。時間窓ベースの統計は目安として扱ってください。")


def load_and_process_data(
    file_path: str, config: dict[str, Any], raw_data: pd.DataFrame | None = None
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """
    CSVファイルからデータを読み込み、処理する

    CSVファイルから時間と加速度のデータを読み込み、重力レベルに変換します。
    また、Drag Shieldの同期点を検出し、時間を調整します。

    Args:
        file_path (str): CSVファイルのパス
        config (dict): 設定情報
        raw_data (pd.DataFrame, optional): 事前に読み込んだCSVデータ。
            指定した場合はファイルの再読み込みを省略します。

    Returns:
        tuple: 以下の4つの要素を含むタプル
            - pandas.Series: Inner Capsuleの調整済み時間データ
            - pandas.Series: Inner Capsuleの重力レベル
            - pandas.Series: Drag Shieldの重力レベル
            - pandas.Series: Drag Shieldの調整済み時間データ

    Raises:
        ValueError: データ読み込み中にエラーが発生した場合
    """
    logger.info(f"ファイルからデータを読み込み: {file_path}")
    try:
        if raw_data is not None:
            data = raw_data  # Alias — do NOT mutate in-place
        else:
            try:
                data = pd.read_csv(file_path)
            except UnicodeDecodeError:
                logger.warning(f"UTF-8での読み込みに失敗しました。cp932で再試行します: {file_path}")
                data = pd.read_csv(file_path, encoding="cp932")

        logger.debug(f"読み込んだCSVのカラム: {data.columns.tolist()}")

        use_inner = config.get("use_inner_acceleration", True)
        use_drag = config.get("use_drag_acceleration", True)

        if not use_inner and not use_drag:
            raise DataProcessingError(
                "Inner CapsuleとDrag Shieldの両方の加速度計が無効です。いずれかを有効にしてください。"
            )

        # 設定から列名を取得
        time_column = config["time_column"]
        acceleration_inner_column = config["acceleration_column_inner_capsule"]
        acceleration_drag_column = config["acceleration_column_drag_shield"]

        # 列が存在するか確認
        missing_columns: list[str] = []
        if time_column not in data.columns:
            missing_columns.append(time_column)
        if use_inner and acceleration_inner_column not in data.columns:
            missing_columns.append(acceleration_inner_column)
        if use_drag and acceleration_drag_column not in data.columns:
            missing_columns.append(acceleration_drag_column)

        if missing_columns:
            # 呼び出し元で列選択ダイアログを表示するためにエラーを送出
            raise ColumnNotFoundError(file_path, missing_columns, data.columns.tolist())

        time = _to_numeric_series(data[time_column], time_column, file_path)
        _validate_time_axis(time, config, file_path)

        acceleration_inner_capsule = (
            _to_numeric_series(data[acceleration_inner_column], acceleration_inner_column, file_path)
            if use_inner and acceleration_inner_column in data
            else pd.Series(dtype=float)
        )
        acceleration_drag_shield = (
            _to_numeric_series(data[acceleration_drag_column], acceleration_drag_column, file_path)
            if use_drag and acceleration_drag_column in data
            else pd.Series(dtype=float)
        )

        # 時刻が無効な行は時間軸上に位置づけられないため、加速度側も欠損として扱う。
        # 行を削除すると隣接サンプル間隔が変わって窓幅（秒）の意味が崩れるので、
        # 位置合わせは保ったまま値だけ無効化する。これにより
        #   (a) |NaN| < threshold が偽になり同期点に選ばれない
        #       （選ばれると time - time.iloc[sync] で時間軸全体がNaNになる）
        #   (b) その行を含む窓は不完全となり最小標準偏差窓の候補から外れる
        #       （外れないと開始時刻 NaN・標準偏差 0.0 という偽の結果を報告する）
        time_invalid = ~np.isfinite(time.to_numpy(dtype=float))
        if time_invalid.any():
            logger.warning(
                f"時刻が無効な {int(time_invalid.sum())} 行を解析対象から除外します（加速度値も欠損として扱います）"
            )
            if not acceleration_inner_capsule.empty:
                acceleration_inner_capsule = acceleration_inner_capsule.mask(time_invalid)
            if not acceleration_drag_shield.empty:
                acceleration_drag_shield = acceleration_drag_shield.mask(time_invalid)

        # Inner加速度計の上下反転補正
        if use_inner and config.get("invert_inner_acceleration", False):
            logger.info("Inner加速度計の上下反転補正を適用します")
            acceleration_inner_capsule = -acceleration_inner_capsule

        # 加速度の閾値（デフォルト1m/s^2）を設定
        acceleration_threshold = config.get("acceleration_threshold", 1.0)
        logger.debug(f"加速度閾値: {acceleration_threshold}")

        # Drag ShieldとInner Capsuleの同期点を見つける
        sync_indices_drag = (
            np.where(np.abs(acceleration_drag_shield) < acceleration_threshold)[0]
            if use_drag and not acceleration_drag_shield.empty
            else np.array([])
        )
        sync_indices_inner = (
            np.where(np.abs(acceleration_inner_capsule) < acceleration_threshold)[0]
            if use_inner and not acceleration_inner_capsule.empty
            else np.array([])
        )
        logger.debug(
            f"Drag Shield同期点候補数: {len(sync_indices_drag)}, Inner Capsule同期点候補数: {len(sync_indices_inner)}"
        )

        if len(time) == 0:
            raise DataProcessingError("時間データが空です。CSVの内容を確認してください。")

        # 同期点は可能な限り検出し、検出できない場合は先頭を使用する
        sync_index_drag = int(sync_indices_drag[0]) if len(sync_indices_drag) > 0 else 0
        sync_index_inner = int(sync_indices_inner[0]) if len(sync_indices_inner) > 0 else 0

        if use_drag and len(sync_indices_drag) == 0:
            logger.warning("Drag Shieldの同期点が見つからず、先頭サンプルを同期点として使用します")
        if use_inner and len(sync_indices_inner) == 0 and len(sync_indices_drag) > 0:
            sync_index_inner = sync_index_drag
            logger.info("Inner Capsuleの同期点が見つからなかったため、Drag Shieldの同期点を流用します")
        elif use_inner and len(sync_indices_inner) == 0:
            logger.warning("Inner Capsuleの同期点が見つからず、先頭サンプルを同期点として使用します")

        logger.info(f"同期点を検出: inner_index={sync_index_inner}, drag_index={sync_index_drag}")

        # 各系列の時間を同期点基準で調整（利用しない系列は空を返す）
        adjusted_time_inner = pd.Series(time - time.iloc[sync_index_inner]) if use_inner else pd.Series(dtype=float)
        adjusted_time_drag = pd.Series(time - time.iloc[sync_index_drag]) if use_drag else pd.Series(dtype=float)

        gravity_constant = config["gravity_constant"]
        if gravity_constant == 0:
            raise DataProcessingError("重力定数が0に設定されています。設定を確認してください。")

        gravity_level_inner_capsule = (
            acceleration_inner_capsule / gravity_constant if use_inner else pd.Series(dtype=float)
        )
        gravity_level_drag_shield = acceleration_drag_shield / gravity_constant if use_drag else pd.Series(dtype=float)

        # 処理結果のサンプル値をログに記録
        logger.debug(
            f"重力レベル計算 (先頭5件): inner_capsule={gravity_level_inner_capsule.head(5).tolist()}, "
            f"drag_shield={gravity_level_drag_shield.head(5).tolist()}"
        )

        # 調整済み時間を返却（inner, drag）
        return (
            adjusted_time_inner,
            gravity_level_inner_capsule,
            gravity_level_drag_shield,
            adjusted_time_drag,
        )
    except (ColumnNotFoundError, DataProcessingError):
        # GUI側で分岐するカスタム例外はそのまま再送出
        raise
    except Exception as e:
        log_exception(e, "データの読み込み中にエラーが発生しました")
        raise DataLoadError(file_path, "データの読み込みに失敗しました", e) from e


def _find_start_indices(time: pd.Series | None, adjusted_time: pd.Series | None) -> tuple[int, int]:
    """
    時間データから開始インデックスを検出する

    Args:
        time: Inner Capsuleの時間データ
        adjusted_time: Drag Shieldの調整済み時間データ

    Returns:
        Inner CapsuleとDrag Shieldの開始インデックス
    """
    # 開始点は0秒から - インデックスエラーを防止するためのチェックを追加
    if time is not None and not time.empty:
        start_indices_inner = np.where(time >= 0)[0]
        if len(start_indices_inner) > 0:
            start_index_inner = int(start_indices_inner[0])
        else:
            logger.warning("Inner capsuleの開始点が見つかりませんでした。最初のインデックスを使用します。")
            start_index_inner = 0
    else:
        start_index_inner = 0
        logger.debug("Inner capsuleの時間データが空のため開始インデックスを0に設定します。")

    if adjusted_time is not None and not adjusted_time.empty:
        start_indices_drag = np.where(adjusted_time >= 0)[0]
        if len(start_indices_drag) > 0:
            start_index_drag = int(start_indices_drag[0])
        else:
            logger.warning("Drag shieldの開始点が見つかりませんでした。最初のインデックスを使用します。")
            start_index_drag = 0
    else:
        start_index_drag = 0
        logger.debug("Drag shieldの調整時間データが空のため開始インデックスを0に設定します。")

    return start_index_inner, start_index_drag


def _find_end_indices(
    gravity_level_inner_capsule: pd.Series | None,
    gravity_level_drag_shield: pd.Series | None,
    min_index_inner: int,
    min_index_drag: int,
    end_gravity_level: float,
) -> tuple[int, int]:
    """
    終了重力レベルに基づいて終了インデックスを検出する

    Args:
        gravity_level_inner_capsule: Inner Capsuleの重力レベル
        gravity_level_drag_shield: Drag Shieldの重力レベル
        min_index_inner: Inner Capsuleの最小インデックス
        min_index_drag: Drag Shieldの最小インデックス
        end_gravity_level: 終了重力レベル闾値

    Returns:
        Inner CapsuleとDrag Shieldの終了インデックス
    """
    # 最小インデックス以降で終了インデックスを計算
    if gravity_level_inner_capsule is not None and not gravity_level_inner_capsule.empty:
        end_index_inner_candidates = np.where(gravity_level_inner_capsule >= end_gravity_level)[0]
        end_index_inner_candidates = np.array([i for i in end_index_inner_candidates if i >= min_index_inner])
        if len(end_index_inner_candidates) > 0:
            end_index_inner = int(end_index_inner_candidates[0])
            logger.debug(f"Inner capsuleの終了インデックス: {end_index_inner}")
        else:
            end_index_inner = len(gravity_level_inner_capsule) - 1
            logger.warning(f"Inner capsuleの終了点が見つからず、データの最後を使用: {end_index_inner}")
    else:
        end_index_inner = -1
        logger.debug("Inner capsuleの重力データがないため終了インデックスは-1になります。")

    if gravity_level_drag_shield is not None and not gravity_level_drag_shield.empty:
        end_index_drag_candidates = np.where(gravity_level_drag_shield >= end_gravity_level)[0]
        end_index_drag_candidates = np.array([i for i in end_index_drag_candidates if i >= min_index_drag])
        if len(end_index_drag_candidates) > 0:
            end_index_drag = int(end_index_drag_candidates[0])
            logger.debug(f"Drag shieldの終了インデックス: {end_index_drag}")
        else:
            end_index_drag = len(gravity_level_drag_shield) - 1
            logger.warning(f"Drag shieldの終了点が見つからず、データの最後を使用: {end_index_drag}")
    else:
        end_index_drag = -1
        logger.debug("Drag shieldの重力データがないため終了インデックスは-1になります。")

    return end_index_inner, end_index_drag


def filter_data(
    time: pd.Series,
    gravity_level_inner_capsule: pd.Series,
    gravity_level_drag_shield: pd.Series,
    adjusted_time: pd.Series,
    config: dict[str, Any],
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series, int]:
    """
    データをフィルタリングする

    時間=0を基準にデータをトリミングし、終了重力レベル（end_gravity_level）
    に達するまでのデータを抽出します。Inner CapsuleとDrag Shieldのデータは
    独立してフィルタリングされます。

    Args:
        time (pandas.Series): 時間データ
        gravity_level_inner_capsule (pandas.Series): Inner Capsuleの重力レベル
        gravity_level_drag_shield (pandas.Series): Drag Shieldの重力レベル
        adjusted_time (pandas.Series): 調整された時間データ
        config (dict): 設定情報

    Returns:
        tuple: 以下の5つの要素を含むタプル
            - pandas.Series: フィルタリングされた時間データ
            - pandas.Series: フィルタリングされたInner Capsuleの重力レベル
            - pandas.Series: フィルタリングされたDrag Shieldの重力レベル
            - pandas.Series: フィルタリングされた調整時間データ
            - int: 終了インデックス
    """
    logger.info("データのフィルタリングを開始")

    has_inner = gravity_level_inner_capsule is not None and not gravity_level_inner_capsule.empty
    has_drag = gravity_level_drag_shield is not None and not gravity_level_drag_shield.empty

    data_lengths: list[int] = []
    if has_inner:
        data_lengths.append(len(gravity_level_inner_capsule))
    if has_drag:
        data_lengths.append(len(gravity_level_drag_shield))

    if not data_lengths:
        raise DataProcessingError("Inner Capsule/Drag Shieldの加速度データが見つかりませんでした。")

    logger.info(
        f"データサイズ: inner_capsule={len(gravity_level_inner_capsule)}, "
        f"drag_shield={len(gravity_level_drag_shield)}, "
        f"time={len(time)}, adjusted_time={len(adjusted_time)}"
    )

    # データが不足している場合の警告
    required_min_length = config.get("sampling_rate", 1000) * config.get("window_size", 0.1)
    min_data_length = min(data_lengths)
    if min_data_length < required_min_length:
        logger.warning(
            f"データ長が不足しています。最小データ長: {min_data_length}, 必要な最小長: {required_min_length}"
        )

    try:
        # 開始インデックスを検出
        start_index_inner, start_index_drag = _find_start_indices(
            time if has_inner else None, adjusted_time if has_drag else None
        )
        logger.debug(f"開始インデックス: inner={start_index_inner}, drag={start_index_drag}")

        # 開始点からの最小秒数を取得
        min_seconds_after_start = config.get("min_seconds_after_start", 0.0)
        logger.debug(f"開始点からの最小秒数: {min_seconds_after_start}")

        # Inner capsuleのデータで、開始点からmin_seconds_after_start秒後以降のインデックスを計算
        if has_inner:
            min_time_inner = time.iloc[start_index_inner] + min_seconds_after_start
            min_indices_inner = np.where(time >= min_time_inner)[0]
            if len(min_indices_inner) > 0:
                min_index_inner = int(min_indices_inner[0])
            else:
                logger.warning("Inner capsuleの最小時間点が見つかりませんでした。開始インデックスを使用します。")
                min_index_inner = start_index_inner
            logger.debug(f"Inner capsuleの最小時間インデックス: {min_index_inner}, 時間: {time.iloc[min_index_inner]}")
        else:
            min_index_inner = start_index_inner
            logger.debug("Inner capsuleデータがないため最小時間インデックスは開始インデックスを使用します。")

        # Drag shieldのデータで、開始点からmin_seconds_after_start秒後以降のインデックスを計算
        if has_drag:
            min_time_drag = adjusted_time.iloc[start_index_drag] + min_seconds_after_start
            min_indices_drag = np.where(adjusted_time >= min_time_drag)[0]
            if len(min_indices_drag) > 0:
                min_index_drag = int(min_indices_drag[0])
            else:
                logger.warning("Drag shieldの最小時間点が見つかりませんでした。開始インデックスを使用します。")
                min_index_drag = start_index_drag
            logger.debug(
                f"Drag shieldの最小時間インデックス: {min_index_drag}, 時間: {adjusted_time.iloc[min_index_drag]}"
            )
        else:
            min_index_drag = start_index_drag
            logger.debug("Drag shieldデータがないため最小時間インデックスは開始インデックスを使用します。")

        # 終了インデックスを検出
        end_index_inner, end_index_drag = _find_end_indices(
            gravity_level_inner_capsule if has_inner else None,
            gravity_level_drag_shield if has_drag else None,
            min_index_inner,
            min_index_drag,
            config["end_gravity_level"],
        )

        # データセットごとに個別にフィルタリング
        filtered_time = (
            time[start_index_inner : end_index_inner + 1]
            if has_inner and end_index_inner >= start_index_inner
            else pd.Series(dtype=float)
        )
        filtered_gravity_level_inner_capsule = (
            gravity_level_inner_capsule[start_index_inner : end_index_inner + 1]
            if has_inner and end_index_inner >= start_index_inner
            else pd.Series(dtype=float)
        )

        filtered_adjusted_time = (
            adjusted_time[start_index_drag : end_index_drag + 1]
            if has_drag and end_index_drag >= start_index_drag
            else pd.Series(dtype=float)
        )
        filtered_gravity_level_drag_shield = (
            gravity_level_drag_shield[start_index_drag : end_index_drag + 1]
            if has_drag and end_index_drag >= start_index_drag
            else pd.Series(dtype=float)
        )

        # データサイズをログに記録
        logger.debug(
            f"フィルタリング結果のサイズ: inner={len(filtered_gravity_level_inner_capsule)}, "
            f"drag={len(filtered_gravity_level_drag_shield)}"
        )

        # 統計情報の計算のために全体の終了インデックスを保持
        valid_end_indices = [idx for idx in [end_index_inner, end_index_drag] if idx >= 0]
        end_index = max(valid_end_indices) if valid_end_indices else -1

        return (
            filtered_time,
            filtered_gravity_level_inner_capsule,
            filtered_gravity_level_drag_shield,
            filtered_adjusted_time,
            end_index,
        )

    except DataProcessingError:
        raise
    except Exception as e:
        log_exception(e, "フィルタリング中にエラーが発生しました")

        # データ長の違いに起因するエラーの場合、より詳細な情報を提供。
        # ここで len(None) を呼ぶと元の例外を隠す TypeError になるため、
        # 長さの取得自体も失敗しても構わない補助情報として扱う。
        details = _describe_series_lengths(
            time=time,
            adjusted_time=adjusted_time,
            gravity_level_inner_capsule=gravity_level_inner_capsule,
            gravity_level_drag_shield=gravity_level_drag_shield,
        )
        if "index" in str(e).lower() or "length" in str(e).lower():
            raise DataProcessingError("データ長の不一致によりフィルタリングに失敗しました", details) from e

        raise DataProcessingError(
            "フィルタリング中に予期しないエラーが発生しました", f"{type(e).__name__}: {e}\n{details}"
        ) from e


def _describe_series_lengths(**series: pd.Series | None) -> str:
    """デバッグ用にSeriesの長さを列挙する（Noneや未定義でも失敗しない）"""
    parts = []
    for name, value in series.items():
        try:
            parts.append(f"{name}: {len(value) if value is not None else 'None'}")
        except TypeError:
            parts.append(f"{name}: 不明")
    return ", ".join(parts)
