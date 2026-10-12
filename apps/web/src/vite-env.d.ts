/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * `'false'` compiles the cloud half out: no auth screens, no run history, no
   * admin console, no session probe. Unset or any other value keeps it on. See
   * `src/cloud/enabled.ts`.
   */
  readonly VITE_AAT_CLOUD_ENABLED?: string
}
