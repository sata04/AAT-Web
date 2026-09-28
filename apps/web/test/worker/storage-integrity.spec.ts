/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { getDatabase } from '../../worker/db/client.ts'
import { createUser } from './helpers/client.ts'
import { storageApp } from './helpers/storage-app.ts'
import { storageIntegrityCases } from './storage-integrity-cases.ts'

storageIntegrityCases(async () => {
  const user = await createUser()
  const bindings = { ...env }
  const app = storageApp()
  return {
    env: bindings,
    db: getDatabase(bindings),
    userId: user.userId,
    fetch: (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', user.cookie)
      headers.set('origin', 'https://aat.test')
      return app.request(path, { ...init, headers }, { ...bindings })
    },
  }
})
