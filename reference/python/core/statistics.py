#!/usr/bin/env python3
"""
統計計算モジュール

重力レベルデータの統計分析のための機能を提供します。
特定のウィンドウサイズにおける標準偏差が最小となる区間を検出し、
その区間の平均重力レベルや開始時間を計算します。
また、ユーザーが選択した特定範囲の統計情報も計算します。
"""

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from core.logger import get_logger

logger = get_logger("statistics")

# E[dX²]-E[dX]² の丸め誤差を吸収する係数。累積和の差分で数サンプル分の
# 丸めが積み上がるため、eps の数倍を許容する。
_VARIANCE_NOISE_FACTOR = 16.0

# ウィンドウごとの直接計算に使う要素数の上限（num_windows × window_samples）。
# 実データのトリミング区間は数千サンプル、窓は最大でも1秒分なので通常はこの
# 範囲に収まり、常に厳密な二段計算が使われる。
_EXACT_ELEMENT_BUDGET = 20_000_000
# 一度に確保する要素数（約16MB）。上限内でもメモリを一気に使わないよう分割する。
_EXACT_CHUNK_ELEMENTS = 2_000_000


def _rolling_window_stats(
    values: np.ndarray, valid_mask: np.ndarray, w: int, num_windows: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """各ウィンドウの |x| 平均・標準偏差・完全観測フラグを返す

    既定では窓ごとに直接（二段階で）計算する。大域的な累積和の差分に頼ると、
    系列中に1つでも極端な外れ値があると Σx² にその二乗が乗り続け、外れ値より
    後ろの静かなウィンドウで桁落ちが起きる。落下開始直後（min_seconds_after_start
    より前）の解放衝撃や負方向の衝撃は end_gravity_level による打ち切りを
    すり抜けて解析区間に残るため、これは実データで起こり得る。実測では
    100 G の尖頭で相対誤差 54%、1000 G では std=0.0 の別ウィンドウが選ばれた。

    データが極端に大きい場合のみ累積和にフォールバックし、精度が落ちる
    可能性を警告として残す。
    """
    safe = np.where(valid_mask, values, 0.0)
    valid_f = valid_mask.astype(np.float64)

    if num_windows * w <= _EXACT_ELEMENT_BUDGET:
        means = np.empty(num_windows, dtype=np.float64)
        std_devs = np.empty(num_windows, dtype=np.float64)
        count = np.empty(num_windows, dtype=np.float64)

        value_windows = sliding_window_view(safe, w)
        valid_windows = sliding_window_view(valid_f, w)
        rows = max(1, _EXACT_CHUNK_ELEMENTS // w)
        for start in range(0, num_windows, rows):
            stop = min(start + rows, num_windows)
            block = value_windows[start:stop]
            count[start:stop] = valid_windows[start:stop].sum(axis=1)
            # numpy の std は平均を求めてから偏差二乗を平均する二段階計算なので、
            # 大きな平均値があっても桁落ちしない。
            std_devs[start:stop] = block.std(axis=1)
            means[start:stop] = np.abs(block).mean(axis=1)

        complete = count >= w
        # 不完全なウィンドウは 0 埋めした値で計算されているため選択対象から外す
        means = np.where(complete, means, np.nan)
        std_devs = np.where(complete, std_devs, np.nan)
        return means, std_devs, complete

    logger.warning(
        "データが大きいため累積和による近似計算を使用します（%d ウィンドウ × %d サンプル）。"
        "系列に極端な外れ値がある場合、標準偏差の精度が落ちる可能性があります。",
        num_windows,
        w,
    )

    # 中心化してから累積和を取る。標準偏差は平行移動で不変なので定義は変わらず、
    # 誤差だけが |平均|/標準偏差 の比だけ小さくなる。
    offset = float(values[valid_mask].mean())
    centered = np.where(valid_mask, values - offset, 0.0)
    abs_vals = np.where(valid_mask, np.abs(values), 0.0)

    def _rolling_sum(arr: np.ndarray) -> np.ndarray:
        cs = np.empty(len(arr) + 1, dtype=np.float64)
        cs[0] = 0.0
        np.cumsum(arr, out=cs[1:])
        return cs[w:] - cs[:-w]

    count = _rolling_sum(valid_f)
    sum_dx = _rolling_sum(centered)
    sum_dx2 = _rolling_sum(centered * centered)
    sum_abs = _rolling_sum(abs_vals)

    complete = count >= w
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_centered = np.where(complete, sum_dx / w, np.nan)
        mean_sq_centered = np.where(complete, sum_dx2 / w, np.nan)
        means = np.where(complete, sum_abs / w, np.nan)
        variance = np.maximum(mean_sq_centered - mean_centered**2, 0.0)
        # 差の丸め誤差は E[dX²] に比例する。この水準未満の残差を0に丸めることで、
        # 数学的に等しい（分散0の）ウィンドウが必ず同じ値になり、同値のときは
        # nanargmin が最も早いウィンドウを選ぶという決定的な挙動を保つ。
        noise_floor = _VARIANCE_NOISE_FACTOR * np.finfo(np.float64).eps * np.abs(mean_sq_centered)
        variance = np.where(variance <= noise_floor, 0.0, variance)
        std_devs = np.where(complete, np.sqrt(variance), np.nan)

    return means, std_devs, complete


def _positive_float(value: object, name: str) -> float:
    """解析パラメータを正の実数として検証する

    0や負値を黙って1サンプル窓に丸めると、std=0の「完璧な」結果を返して
    誤った解析結果を返すため、呼び出し元が対処できるエラーにする。
    """
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} は数値で指定してください: {value!r}") from exc
    if not np.isfinite(number) or number <= 0:
        raise ValueError(f"{name} は0より大きい有限の数値で指定してください: {value!r}")
    return number


def calculate_statistics(
    gravity_level: pd.Series, time: pd.Series, config: dict[str, float | int]
) -> tuple[float | None, float | None, float | None]:
    """
    重力レベルデータの統計情報を計算する

    指定されたウィンドウサイズで重力レベルデータをスキャンし、
    標準偏差が最小となる時間窓を特定します。その窓内の絶対値の平均値、
    開始時間、および標準偏差を返します。

    Args:
        gravity_level: 重力レベルデータ
        time: 時間データ
        config: 設定パラメータ辞書。以下のキーが使用されます：
            - window_size (float): 解析窓のサイズ（秒単位）、デフォルトは0.1
            - sampling_rate (int): サンプリングレート（Hz単位）、デフォルトは1000

    Returns:
        以下の3つの値を含むタプル
            - 最小標準偏差ウィンドウの絶対値の平均値
            - 最小標準偏差ウィンドウの開始時間
            - 最小標準偏差値
            データが不十分な場合はすべてNone
    """
    window_size = _positive_float(config.get("window_size", 0.1), "window_size")
    sampling_rate = _positive_float(config.get("sampling_rate", 1000), "sampling_rate")
    window_size_samples: int = max(1, round(window_size * sampling_rate))

    # データ長の一致を確認
    if len(gravity_level) != len(time):
        raise ValueError(
            f"時間配列とデータ配列の長さが一致しません: gravity_level={len(gravity_level)}, time={len(time)}"
        )

    # データがウィンドウサイズに満たない場合
    if len(gravity_level) < window_size_samples:
        return None, None, None

    # numpy配列に変換
    gravity_array: np.ndarray = np.asarray(gravity_level.values, dtype=np.float64)
    time_array: np.ndarray = np.asarray(time.values, dtype=np.float64)

    w = window_size_samples
    num_windows = len(gravity_array) - w + 1
    if num_windows <= 0:
        return None, None, None

    # ±Infは測定値ではないため欠損として扱う。有効値として扱うと累積和が
    # Inf/NaNに汚染され、そのチャンネル全体の統計が失われる。
    valid_mask = np.isfinite(gravity_array)
    if not valid_mask.any():
        return None, None, None

    means, std_devs, complete = _rolling_window_stats(gravity_array, valid_mask, w, num_windows)
    if not complete.any():
        # 標準偏差はウィンドウが完全に観測されている場合にのみ定義できる。
        # 欠損を含むウィンドウを許すと、有効値がわずかなウィンドウが std≒0 として
        # 最小標準偏差窓に選ばれ、しかもその平均値は他のウィンドウと異なる
        # サンプル数で算出されるため比較できない値になる。
        return None, None, None

    times = time_array[:num_windows]

    # 最小標準偏差のインデックスを見つける（NaNを無視）
    # complete.any() が真なので nanargmin は必ず値を返す
    min_std_index: int = int(np.nanargmin(std_devs))
    return float(means[min_std_index]), float(times[min_std_index]), float(std_devs[min_std_index])


def calculate_range_statistics(data_array: np.ndarray) -> dict[str, float | None]:
    """
    選択された範囲のデータに対して統計情報を計算する

    欠損値（NaN/±Inf）は統計量から除外し、除外した点数を ``missing`` として
    報告する。除外せずに素の numpy 集約を使うと、範囲内に1点欠損があるだけで
    すべての統計量が NaN になり、ユーザーには理由が分からない空欄になる。

    Args:
        data_array: 統計情報を計算するデータ配列

    Returns:
        以下の統計情報を含む辞書
            - mean: 平均値
            - abs_mean: 絶対値の平均
            - std: 標準偏差
            - min: 最小値
            - max: 最大値
            - range: 最大値と最小値の差
            - count: 統計量の算出に使用した有効データ点数
            - missing: 欠損として除外した点数
    """
    empty_result: dict[str, float | None] = {
        "mean": None,
        "abs_mean": None,
        "std": None,
        "min": None,
        "max": None,
        "range": None,
        "count": 0,
        "missing": 0,
    }

    values = np.asarray(data_array, dtype=np.float64).ravel()
    if values.size == 0:
        return empty_result

    finite = values[np.isfinite(values)]
    missing = int(values.size - finite.size)
    if finite.size == 0:
        return {**empty_result, "missing": missing}

    return {
        "mean": float(np.mean(finite)),
        "abs_mean": float(np.mean(np.abs(finite))),
        "std": float(np.std(finite)),
        "min": float(np.min(finite)),
        "max": float(np.max(finite)),
        "range": float(np.max(finite) - np.min(finite)),
        "count": int(finite.size),
        "missing": missing,
    }
