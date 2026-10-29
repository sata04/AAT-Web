import { openCsv, repoCsv, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

test('the generated service worker reloads and analyzes a local file offline', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'サインイン' })).toBeVisible()
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated')
  const cachedAssets = await page.evaluate(async () => {
    const names = await caches.keys()
    const precache = names.find((name) => name.includes('precache'))
    if (!precache) return []
    return (await (await caches.open(precache)).keys()).map((request) => new URL(request.url).pathname)
  })
  expect(cachedAssets).toContain('/index.html')
  expect(cachedAssets.some((asset) => asset.startsWith('/assets/') && asset.endsWith('.js'))).toBe(true)

  await context.setOffline(true)
  try {
    await page.reload()
    await expect(page.locator('.command-bar')).toBeVisible()
    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)
    await expect(page.getByRole('region', { name: /^The Gravity Level/ })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'データセット' }).getByText('normal_two_sensor_utf8'),
    ).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})
