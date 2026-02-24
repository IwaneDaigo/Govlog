"""
childcare_similarity パッケージ

子育て施策を対象とした多軸自治体類似度モデル。
単純なコサイン類似度ではなく、以下を統合:
  - 課題軸 / 支援供給軸 / 財政実現可能性軸 ごとの類似度
  - 財政制約フィルタ
  - KMeans クラスタリング
  - 寄与度（特徴量ごとの差分）による説明可能な出力

Public API:
    from app.childcare_similarity import run_similarity
"""

from .engine import run_similarity

__all__ = ["run_similarity"]
