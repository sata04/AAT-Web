#!/usr/bin/env python3
"""
カスタム例外クラス

AATアプリケーションで使用される特定の例外クラスを定義します。
より詳細なエラー情報とエラーハンドリングを提供します。
"""


class AATException(Exception):
    """AAT アプリケーションの基本例外クラス"""


class DataLoadError(AATException):
    """データ読み込み時のエラー"""

    def __init__(self, file_path: str, message: str, original_error: Exception | None = None):
        self.file_path = file_path
        self.original_error = original_error
        super().__init__(f"データ読み込みエラー ({file_path}): {message}")


class ColumnNotFoundError(DataLoadError):
    """必要な列が見つからない場合のエラー"""

    def __init__(self, file_path: str, missing_columns: list[str], available_columns: list[str]):
        self.missing_columns = missing_columns
        self.available_columns = available_columns
        message = f"必要な列が見つかりません: {', '.join(missing_columns)}"
        super().__init__(file_path, message)


class DataProcessingError(AATException):
    """データ処理中のエラー"""

    def __init__(self, message: str, details: str | None = None):
        self.details = details
        full_message = message
        if details:
            full_message += f"\n詳細: {details}"
        super().__init__(full_message)


class SyncPointNotFoundError(DataProcessingError):
    """同期点が見つからない場合のエラー"""

    def __init__(self, sensor_type: str):
        self.sensor_type = sensor_type
        super().__init__(f"{sensor_type}の同期点が見つかりませんでした")


class InsufficientDataError(DataProcessingError):
    """データが不十分な場合のエラー"""

    def __init__(self, required_length: int, actual_length: int, context: str = ""):
        self.required_length = required_length
        self.actual_length = actual_length
        message = f"データが不十分です。必要: {required_length}, 実際: {actual_length}"
        if context:
            message += f" ({context})"
        super().__init__(message)


class ConfigurationError(AATException):
    """設定関連のエラー"""

    def __init__(self, message: str, config_key: str | None = None):
        self.config_key = config_key
        if config_key:
            message = f"設定エラー [{config_key}]: {message}"
        super().__init__(message)


class ExportError(AATException):
    """データエクスポート時のエラー"""

    def __init__(self, message: str, file_path: str | None = None):
        self.file_path = file_path
        if file_path:
            message = f"エクスポートエラー ({file_path}): {message}"
        super().__init__(message)


class CacheError(AATException):
    """キャッシュ操作時のエラー"""

    def __init__(self, message: str, cache_path: str | None = None):
        self.cache_path = cache_path
        if cache_path:
            message = f"キャッシュエラー ({cache_path}): {message}"
        super().__init__(message)
