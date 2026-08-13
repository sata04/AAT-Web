/**
 * What is genuinely a setting, and what only looks like one.
 *
 * A settings screen is where an admin console does the most damage, because every constant in the
 * system is a candidate control and each one added is a way for a tired operator at 02:00 to change
 * something whose consequences are not local. So this module states the rule the screen is built
 * from, as data:
 *
 * **A control belongs here only if there is a route that changes it at runtime, and only if
 * changing it is an operational decision rather than a deployment one.**
 *
 * Two routes pass that test. `PUT /api/v1/admin/renderer` opens and closes the poster renderer's
 * circuit breaker, which is precisely the lever you need *now* when spend or the container is
 * misbehaving and waiting for a deploy is the wrong shape. `PUT /api/v1/admin/quotas/:userId` moves
 * one member's storage ceiling, which is a judgement about a person's work rather than about the
 * system.
 *
 * Everything in {@link DEPLOY_TIME_SETTINGS} fails the test, and the screen lists it *as refused*
 * rather than silently omitting it — an operator who cannot find the concurrency cap should be told
 * it is a deploy-time var, not left to conclude the console is incomplete. Several of those would
 * be actively dangerous as buttons: raising `AAT_MAX_SNAPSHOT_BYTES` at runtime changes what a
 * Worker isolate will hold in memory, and `AAT_MAX_CONCURRENT_RENDERS` is matched to
 * `max_instances: 1` in `wrangler.jsonc` — a console that let them drift would be a console that
 * queues renders inside a container while a Worker bills wall-clock waiting for them.
 */

export interface SettingDescription {
  label: string
  /** What it does, in one sentence an operator can act on. */
  meaning: string
  /** Where it actually lives, so the reader knows what to change instead. */
  location: string
}

/** Settings this console can change, with the route that changes them. */
export const OPERATIONAL_SETTINGS: readonly SettingDescription[] = [
  {
    label: 'ポスターレンダラーのサーキットブレーカー',
    meaning:
      'ポスター生成を今すぐ停止・再開します。停止中はコンテナを一切呼び出さず、生成要求は POSTER_BUSY で拒否されます。',
    location:
      'PUT /api/v1/admin/renderer（system_flags）。この画面と「ポスターレンダラー」画面の両方から操作できます。',
  },
  {
    label: '利用者ごとの保存容量の上限',
    meaning:
      '1人分の保存容量の上限（bytes_limit）を変更します。現在の使用量を下回る値は拒否されます。既定値は初回利用時に適用されるデプロイ設定です。',
    location: 'PUT /api/v1/admin/quotas/:userId（quota_usage）。操作は「利用者」画面から行います。',
  },
]

/**
 * Settings that exist, matter, and are deliberately not controls here.
 *
 * Each entry names where the value actually lives. "Not in this console" is only a useful answer
 * when it comes with "change it in `wrangler.jsonc` and deploy".
 */
export const DEPLOY_TIME_SETTINGS: readonly SettingDescription[] = [
  {
    label: '既定の保存容量（AAT_DEFAULT_QUOTA_BYTES）',
    meaning:
      '新しい利用者が初めて保存したときに作られる quota_usage 行の上限。既存の利用者には影響しません。',
    location: 'wrangler.jsonc の vars。実行時に読み出す管理APIはありません。',
  },
  {
    label: 'スナップショット・元CSV・ポスターの最大バイト数',
    meaning:
      'アップロードの上限（AAT_MAX_SNAPSHOT_BYTES / AAT_MAX_SOURCE_BYTES / AAT_MAX_POSTER_BYTES）。Workerのメモリ上限でもあります。',
    location: 'wrangler.jsonc の vars。実行時に変更できる設計にはなっていません。',
  },
  {
    label: '同時レンダリング数（AAT_MAX_CONCURRENT_RENDERS）',
    meaning:
      'デプロイ全体で同時に実行できるポスター生成の数。wrangler.jsonc の containers.max_instances と対になっており、片方だけ変えるとコンテナ内でレンダリングが待ち行列になります。',
    location: 'wrangler.jsonc。コスト設計そのものなので、管理画面の操作にはしていません。',
  },
  {
    label:
      '予約の有効期限（AAT_RESERVATION_TTL_SECONDS）とレンダリングの失効秒数（AAT_RENDER_STALE_SECONDS）',
    meaning:
      '中断したアップロードの容量が戻るまでの時間と、停止したレンダリングを再試行可能とみなすまでの時間。',
    location: 'wrangler.jsonc の vars。',
  },
  {
    label: 'ポスターのプリセット（aat-poster-v1）',
    meaning:
      '出力される図の色・線幅・余白。デスクトップ版の書き出しに一致させて凍結されており、変更すると過去に公開したすべての図と食い違います。',
    location:
      'packages/plot-spec/src/presets.ts と poster-renderer/src/poster_renderer/preset.py。リリースで変更するものであり、設定項目ではありません。',
  },
]

/**
 * The original-CSV backup policy, which is a policy but not a switch.
 *
 * Worth its own entry because "the raw-source backup policy if already supported" is the obvious
 * thing to look for on this screen, and the honest answer is specific: the backup is opt-in *per
 * request*, enforced by a header the client must send deliberately
 * (`x-aat-source-backup: requested-by-user`), and there is no stored flag anywhere that a console
 * could flip. A deployment-wide "always back up the source" toggle would be exactly the behaviour
 * that header exists to make impossible to write by accident.
 */
export const SOURCE_BACKUP_POLICY: SettingDescription = {
  label: '元CSVのバックアップ',
  meaning:
    'アップロードは要求ごとの明示的な同意で行われます（x-aat-source-backup: requested-by-user ヘッダー）。サインインしていること自体は同意ではないため、デプロイ全体で有効化する設定は存在しません。削除は run の所有者と管理者のみ、ダウンロードはメンバーなら誰でも可能です。',
  location: 'PUT/DELETE /api/v1/runs/:runId/source。切り替え可能な保存された設定はありません。',
}
