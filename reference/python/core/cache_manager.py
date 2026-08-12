#!/usr/bin/env python3
"""
キャッシュ管理モジュール

処理されたデータのキャッシュを管理します。
同じ設定・同じバージョンのアプリケーションで処理済みのファイルを
再利用できるようにします。
"""

import copy
import hashlib
import json
import os
import pickle
import re
import tempfile
from datetime import datetime
from pathlib import Path

import pandas as pd

from core.logger import get_logger, log_exception
from core.paths import ensure_cache_dir, resolve_base_dir
from core.version import APP_VERSION

# ロガーの初期化
logger = get_logger("cache_manager")


class _RestrictedUnpickler(pickle.Unpickler):
    """pickle.load の安全なラッパー。許可されたモジュールのみロードを許可する。"""

    _ALLOWED_MODULES = frozenset(
        {
            "builtins",
            "collections",
            "datetime",
            "numpy",
            "numpy.core.multiarray",
            "numpy.core.numeric",
            "numpy.dtypes",
            "numpy._core.multiarray",
            "numpy._core.numeric",
            "pandas",
            "pandas.core.frame",
            "pandas.core.indexes.base",
            "pandas.core.indexes.range",
            "pandas.core.internals.blocks",
            "pandas.core.internals.managers",
            "pandas.core.series",
            "pandas._libs.internals",
            "pandas._libs.lib",
            "pandas._libs.tslibs.timestamps",
            "pandas.compat.pickle_compat",
            "pandas.core.arrays.numpy_",
        }
    )

    def find_class(self, module: str, name: str):
        if module in self._ALLOWED_MODULES:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(
            f"セキュリティ: 許可されていないモジュールのロードをブロックしました: {module}.{name}"
        )


def _safe_pickle_load(f):
    """pickle.load の安全な代替。RestrictedUnpickler を使用する。"""
    return _RestrictedUnpickler(f).load()


# キャッシュされた内容に影響するすべての設定キー。
# ここに載っていない設定を変更しても既存キャッシュが再利用されるため、
# キャッシュに保存される値（統計・G-quality結果を含む）を左右する設定は
# 必ず追加すること。
CACHE_RELEVANT_KEYS = (
    "time_column",
    "acceleration_column_inner_capsule",
    "acceleration_column_drag_shield",
    "use_inner_acceleration",
    "use_drag_acceleration",
    "sampling_rate",
    "gravity_constant",
    "acceleration_threshold",
    "end_gravity_level",
    "min_seconds_after_start",
    "invert_inner_acceleration",
    "window_size",
    # G-quality解析のパラメータ。キャッシュには g_quality_data が含まれるため、
    # これらを外すと走査範囲を変えても古い結果が返る。
    "g_quality_start",
    "g_quality_end",
    "g_quality_step",
    "app_version",
)

# 復元したキャッシュがGUIから使えるために必須のキー。
# 欠けたまま返すと呼び出し側が KeyError で落ちるため、再計算に回す。
REQUIRED_CACHE_KEYS = (
    "time",
    "adjusted_time",
    "gravity_level_inner_capsule",
    "gravity_level_drag_shield",
    "filtered_time",
    "filtered_adjusted_time",
    "filtered_gravity_level_inner_capsule",
    "filtered_gravity_level_drag_shield",
)


_HASH_CHUNK_SIZE = 1 << 20  # 1 MiB


def _file_identity(file_path):
    """キャッシュキー用にファイルの同一性を表す指紋を返す

    更新時刻とサイズだけでは、時刻粒度内の書き換えや、編集後に mtime を
    復元されたケース（同じ長さに書き換えた場合を含む）を見逃して古い解析結果を
    返してしまう。内容のハッシュまで取ることで取り違えを原理的になくす。
    読み込みコストはこの後の pandas によるCSVパースに比べれば小さい。
    """
    stat_result = os.stat(file_path)
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return f"{stat_result.st_mtime_ns}:{stat_result.st_size}:{digest.hexdigest()}"


def generate_cache_id(file_path, config):
    """
    CSVファイルと設定に基づいてキャッシュIDを生成する

    Args:
        file_path (str): 元のCSVファイルのパス
        config (dict): 現在の設定情報

    Returns:
        str: 一意のキャッシュID
    """
    # 設定情報のサブセットを作成
    config_subset = {key: config.get(key) for key in CACHE_RELEVANT_KEYS}

    # ファイルパス、ファイル指紋、設定情報を結合
    cache_data = f"{file_path}:{_file_identity(file_path)}:{json.dumps(config_subset, sort_keys=True, default=str)}"

    # SHA-256ハッシュを計算
    cache_id = hashlib.sha256(cache_data.encode()).hexdigest()

    logger.debug(f"ファイル {os.path.basename(file_path)} のキャッシュID: {cache_id}")
    return cache_id


def get_cache_path(file_path, cache_id):
    """
    キャッシュファイルのパスを生成する

    Args:
        file_path (str): 元のCSVファイルのパス
        cache_id (str): キャッシュID

    Returns:
        str: キャッシュファイルのパス
    """
    # CSVファイルのディレクトリを取得
    csv_dir = os.path.dirname(file_path)
    base_name = os.path.splitext(os.path.basename(file_path))[0]

    # キャッシュディレクトリのパスを生成
    cache_dir = ensure_cache_dir(csv_dir)

    # キャッシュファイルのパスを生成
    cache_file = f"{base_name}_{cache_id}.pickle"
    cache_path = os.path.join(cache_dir, cache_file)

    return cache_path


def save_to_cache(processed_data, file_path, cache_id, config):
    """
    処理済みデータをキャッシュとして保存する

    Args:
        processed_data (dict): 処理済みのデータ
        file_path (str): 元のCSVファイルのパス
        cache_id (str): キャッシュID
        config (dict): 現在の設定情報

    Returns:
        bool: 保存に成功した場合はTrue、失敗した場合はFalse
    """
    raw_data_cache_path = None
    temp_pickle_path = None
    temp_h5_path = None
    try:
        cache_path = get_cache_path(file_path, cache_id)
        cache_path_obj = Path(cache_path)

        # キャッシュメタデータを準備
        cache_metadata = {
            "created_at": datetime.now().isoformat(),
            "file_path": file_path,
            "file_mtime": os.path.getmtime(file_path),
            "file_identity": _file_identity(file_path),
            "app_version": APP_VERSION,
            "config": {key: config.get(key) for key in CACHE_RELEVANT_KEYS},
        }

        # 保存する前に大きなデータをコピー（raw_dataは別途HDF5へ書くため除外）
        raw_data = processed_data.get("raw_data")
        data_to_save = {key: copy.deepcopy(value) for key, value in processed_data.items() if key != "raw_data"}

        if "raw_data" in processed_data:
            # rawデータはサイズが大きいため、サイズ削減のためにhdfで保存。
            # 最終パスへ mode="w" で直接書くと、同じcache_idの既存キャッシュを
            # 先に壊してしまう（強制再処理でファイルと設定が同一の場合に起こる）。
            # 一時ファイルへ書き、pickleを確定できた後で差し替える。
            raw_data_cache_path = cache_path_obj.with_name(cache_path_obj.stem + "_raw.h5")
            if raw_data is not None:
                fd, temp_h5_name = tempfile.mkstemp(
                    prefix=f".{cache_path_obj.stem}_raw_", suffix=".h5", dir=str(cache_path_obj.parent)
                )
                os.close(fd)
                temp_h5_path = Path(temp_h5_name)
                raw_data.to_hdf(temp_h5_path, key="raw_data", mode="w")
            data_to_save["raw_data"] = None  # pickleには保存しないよう置き換え

        # HDFコンパニオンを書いたかどうかを記録する。raw_data が本当に None で
        # 保存された場合と、HDFが失われた場合を読み込み側で区別するために必要。
        cache_metadata["has_raw_data_file"] = temp_h5_path is not None

        # メタデータを追加
        data_to_save["_metadata"] = cache_metadata

        # 一時ファイルへ書き切ってから置き換える。直接書くと、書き込み中に
        # 中断された場合に切り詰められたpickleが残り、次回起動時に毎回
        # 読み込みエラーを起こす。
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{cache_path_obj.stem}_", suffix=".tmp", dir=str(cache_path_obj.parent)
        )
        temp_pickle_path = Path(temp_name)
        with os.fdopen(fd, "wb") as f:
            pickle.dump(data_to_save, f, protocol=pickle.HIGHEST_PROTOCOL)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_pickle_path, cache_path_obj)
        temp_pickle_path = None

        # pickleを確定できた後にHDFを差し替える。ここまで来れば、既存の
        # キャッシュを壊しても新しい完全なキャッシュが残る。
        if temp_h5_path is not None:
            os.replace(temp_h5_path, raw_data_cache_path)
            temp_h5_path = None
        elif raw_data_cache_path is not None and raw_data_cache_path.exists():
            # raw_data が None で保存された場合、古い世代のHDFが残ると
            # 新しいpickleと対応しない中身を復元してしまう
            raw_data_cache_path.unlink()

        # 新しいキャッシュが確定してから、同じファイルの古い世代を掃除する。
        # 先に削除すると、保存に失敗したときにキャッシュが1つも残らない。
        delete_cache(file_path, keep_cache_id=cache_id)

        logger.info(f"データをキャッシュに保存しました: {cache_path}")
        return True

    except Exception as e:
        log_exception(e, "キャッシュへの保存中にエラーが発生しました")
        # 中途半端な生成物だけを消す。既存の raw_data_cache_path は差し替え前なので
        # まだ古い（有効な）キャッシュの一部であり、消してはいけない。
        for leftover in (temp_pickle_path, temp_h5_path):
            if leftover is not None and leftover.exists():
                try:
                    leftover.unlink()
                    logger.warning(f"保存失敗のため中間ファイルを削除: {leftover}")
                except OSError:
                    logger.error(f"中間ファイルの削除に失敗: {leftover}")
        return False


def load_from_cache(file_path, cache_id):
    """
    キャッシュからデータを読み込む

    Args:
        file_path (str): 元のCSVファイルのパス
        cache_id (str): キャッシュID

    Returns:
        dict or None: 処理済みのデータ、またはキャッシュが存在しない場合はNone
    """
    try:
        cache_path = get_cache_path(file_path, cache_id)

        # キャッシュファイルが存在するか確認
        if not os.path.exists(cache_path):
            logger.debug(f"キャッシュファイルが見つかりません: {cache_path}")
            return None

        # キャッシュからデータを読み込み
        with open(cache_path, "rb") as f:
            data = _safe_pickle_load(f)

        # メタデータを確認
        metadata = data.get("_metadata", {})
        if metadata.get("app_version") != APP_VERSION:
            logger.warning(
                f"キャッシュのバージョン({metadata.get('app_version')})が現在のバージョン({APP_VERSION})と一致しません"
            )
            return None

        logger.info(f"キャッシュからデータを読み込みました: {cache_path}")

        # raw_dataがあれば復元
        if "raw_data" in data and data["raw_data"] is None:
            cache_path_obj = Path(cache_path)
            raw_data_cache_path = cache_path_obj.with_name(cache_path_obj.stem + "_raw.h5")
            if os.path.exists(raw_data_cache_path):
                try:
                    data["raw_data"] = pd.read_hdf(raw_data_cache_path, key="raw_data")
                    logger.debug(f"raw_dataを復元しました: {raw_data_cache_path}")
                except Exception as e:
                    log_exception(e, "raw_dataの復元中にエラーが発生しました")
                    # raw_dataの読み込みに失敗した場合、データの整合性が保証されないため、キャッシュ全体を無効化
                    logger.warning("raw_dataの読み込みに失敗したため、キャッシュを無効化します")
                    return None
            elif metadata.get("has_raw_data_file"):
                # HDFを書いたはずのキャッシュでファイルが失われている。黙って
                # raw_data=None を返すと加速度シートのないExcelが出力されるため、
                # 再計算に回す（メタデータに印がない古い形式は従来どおり許容）。
                logger.warning(
                    f"raw_dataのHDFファイルが見つからないため、キャッシュを無効化します: {raw_data_cache_path}"
                )
                return None

        # メタデータを削除してデータを返す
        if "_metadata" in data:
            del data["_metadata"]

        # 旧形式や書き込み途中のキャッシュで必須キーが欠けていると、
        # 呼び出し側が KeyError で落ちる。欠損を検出したら再計算に回す。
        missing = [key for key in REQUIRED_CACHE_KEYS if key not in data]
        if missing:
            logger.warning(f"キャッシュに必要なキーがありません{missing}。再計算します: {cache_path}")
            return None

        return data

    except (pickle.UnpicklingError, EOFError, ValueError) as e:
        # 壊れた/書き込み途中のキャッシュは想定内の復旧可能な状態。
        # スタックトレースはデバッグログに留め、呼び出し側は再計算に回す。
        logger.warning(f"キャッシュを読み込めなかったため再計算します: {e}")
        logger.debug("キャッシュ読み込み失敗の詳細", exc_info=True)
        return None
    except Exception as e:
        log_exception(e, "キャッシュからの読み込み中にエラーが発生しました")
        return None


def delete_cache(file_path, cache_id=None, keep_cache_id=None):
    """
    キャッシュを削除する

    Args:
        file_path (str): 元のCSVファイルのパス
        cache_id (str, optional): 削除するキャッシュのID。指定しない場合は全てのキャッシュを削除
        keep_cache_id (str, optional): 一括削除時に残すキャッシュID。新しいキャッシュを
            書いた直後に古い世代だけを掃除するために使う。

    Returns:
        bool: 削除に成功した場合はTrue、失敗した場合はFalse
    """
    try:
        csv_dir = os.path.dirname(file_path)
        base_name = os.path.splitext(os.path.basename(file_path))[0]
        cache_dir = resolve_base_dir(csv_dir) / "results_AAT" / "cache"

        # キャッシュディレクトリが存在するか確認
        if not cache_dir.exists():
            logger.debug(f"キャッシュディレクトリが見つかりません: {cache_dir}")
            return False

        if cache_id:
            # 特定のキャッシュだけを削除
            cache_path = get_cache_path(file_path, cache_id)
            cache_path_obj = Path(cache_path)
            raw_data_cache_path = cache_path_obj.with_name(cache_path_obj.stem + "_raw.h5")

            if cache_path_obj.exists():
                cache_path_obj.unlink()
                logger.info(f"キャッシュを削除しました: {cache_path}")

            if raw_data_cache_path.exists():
                raw_data_cache_path.unlink()
                logger.info(f"raw_dataキャッシュを削除しました: {raw_data_cache_path}")
        else:
            # このファイルの全てのキャッシュを削除
            # キャッシュIDはSHA-256の16進数64桁。単純な前方一致だと
            # "test" のキャッシュ削除で "test_2" のキャッシュまで消えるため、厳密に照合する
            cache_pattern = re.compile(re.escape(base_name) + r"_([0-9a-f]{64})(\.pickle|_raw\.h5)$")
            for filename in sorted(os.listdir(cache_dir)):
                match = cache_pattern.fullmatch(filename)
                if not match:
                    continue
                if keep_cache_id and match.group(1) == keep_cache_id:
                    continue
                target_path = cache_dir / filename
                try:
                    target_path.unlink()
                    logger.info(f"キャッシュを削除しました: {target_path}")
                except OSError as e:
                    # 1件消せなくても残りの掃除は続ける
                    logger.warning(f"キャッシュの削除に失敗しました ({target_path}): {e}")

        return True

    except Exception as e:
        log_exception(e, "キャッシュの削除中にエラーが発生しました")
        return False


def has_valid_cache(file_path, config):
    """
    有効なキャッシュが存在するか確認する

    Args:
        file_path (str): 元のCSVファイルのパス
        config (dict): 現在の設定情報

    Returns:
        tuple: (キャッシュが存在する場合はTrue、キャッシュID)
    """
    try:
        if not config.get("use_cache", True):
            return False, None

        cache_id = generate_cache_id(file_path, config)
        cache_path = get_cache_path(file_path, cache_id)

        # キャッシュIDにはアプリバージョン、解析に影響する全設定、そして
        # 元ファイルの指紋（mtime_ns + サイズ）が含まれる。どれかが変われば
        # 別のパスになるため、ここではファイルの存在確認だけで足りる。
        # 中身の検証（バージョン・必須キー・HDF5の復元）は load_from_cache が
        # 行い、失敗時は None を返して呼び出し側が再計算に回す。数十MBの
        # pickleを有効性判定のために毎回読み込むのは避ける。
        if os.path.exists(cache_path):
            logger.info(f"有効なキャッシュが見つかりました: {cache_path}")
            return True, cache_id

        logger.debug(f"キャッシュが見つかりません: {cache_path}")
        return False, cache_id

    except Exception as e:
        log_exception(e, "キャッシュの確認中にエラーが発生しました")
        return False, None
