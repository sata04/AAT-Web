/**
 * Interactions with the application, expressed once.
 *
 * These are deliberately thin: they name the things a researcher does — open a CSV, wait for the
 * analysis, drag a range, sign in with a passkey — and every wait in them is a wait on a condition
 * the application actually reaches. There are no timeouts-as-synchronisation here, because a sleep
 * long enough to be reliable on a loaded machine is a sleep that makes the whole suite slow, and a
 * sleep short enough to be quick is a flake.
 *
 * Selectors prefer roles and accessible names, which is also a small accessibility test in itself:
 * a control that cannot be found by its name is a control a screen-reader user cannot find either.
 * The few class selectors that remain (`.status-bar`, `.selection-overlay`) name structural
 * elements that carry no role by design.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { APP_ROOT, REPO_ROOT } from './stack.ts'

/** The shared CSV fixtures the numerical suites use. */
export function repoCsv(name: string): string {
  return path.join(REPO_ROOT, 'tests/fixtures/csv', name)
}

/** The suite's own fixture, named to the `YYMMDD[a-z]_data.csv` run-code convention. */
export const RUN_FIXTURE = path.join(APP_ROOT, 'test/fixtures/e2e/260811a_data.csv')

/**
 * Open a CSV in the analyzer.
 *
 * `as` renames the upload without touching the file on disk, which is how a second test gets its
 * own run code from the same bytes — `POST /runs` refuses a duplicate run code per owner, and two
 * tests sharing one would be testing each other's leftovers.
 */
export async function openCsv(page: Page, file: string, as?: string): Promise<void> {
  // Two inputs exist while the drop zone is showing — the command bar's and the drop zone's. They
  // call the same handler; the first is the one that is present on every screen state.
  const input = page.locator('input[type="file"]').first()
  if (as === undefined) {
    await input.setInputFiles(file)
    return
  }
  await input.setInputFiles({ name: as, mimeType: 'text/csv', buffer: readFileSync(file) })
}

/** One of the three status lanes in the footer: 解析, クラウド同期, ポスター図. */
export function statusLane(page: Page, name: string): Locator {
  return page.locator('.status-bar > .status-lane', { hasText: name }).locator('.status-lane__value')
}

/** Wait until the local analysis has finished. Nothing cloud-related is implied by this. */
export async function waitForAnalysis(page: Page, timeout = 60_000): Promise<void> {
  await expect(statusLane(page, '解析')).toHaveText(/完了/, { timeout })
}

/** Drag a range across the graph, the way the desktop's SpanSelector was used. */
export async function dragRange(page: Page, fromFraction = 0.35, toFraction = 0.65): Promise<void> {
  const overlay = page.locator('.selection-overlay')
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (box === null) throw new Error('the selection overlay has no box; the chart did not lay out')

  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * fromFraction, y)
  await page.mouse.down()
  // Two moves: one is enough for the maths, but a real drag is a sequence and the overlay's
  // pointermove handler is what turns a press into a drag rather than a click.
  await page.mouse.move(box.x + box.width * ((fromFraction + toFraction) / 2), y, { steps: 4 })
  await page.mouse.move(box.x + box.width * toFraction, y, { steps: 4 })
  await page.mouse.up()
}

/**
 * Type an exact range into the selection panel — the span a method section would quote.
 *
 * The end is filled before the start, which looks backwards and is not. Both inputs commit on blur,
 * and `RangeStatisticsPanel.commit` reads the *other* field as it stands: filling the start first
 * and then tabbing away commits `(0.5, '')`, which `Number('')` turns into 0, so the panel
 * normalises it to 0 – 0.5 and its `useEffect` writes that back over what was typed. Filling the
 * end first means the intermediate commit is 0 – end, and the second one is the range that was
 * wanted. A researcher hits the same thing and works around it the same way; it is noted in the
 * suite's report as a usability defect rather than fixed here.
 */
export async function setRange(page: Page, xMin: number, xMax: number): Promise<void> {
  const panel = page.getByRole('region', { name: '選択範囲の統計情報' })
  await panel.getByLabel('終了 (s)').fill(String(xMax))
  await panel.getByLabel('開始 (s)').fill(String(xMin))
  await panel.getByLabel('開始 (s)').press('Enter')
}

/** Redeem an invitation and complete a passkey registration. Leaves the browser signed in. */
export async function registerWithInvitation(
  page: Page,
  token: string,
  mode: 'register' | 'recover' = 'register',
): Promise<void> {
  await page.goto(`/${mode}?token=${encodeURIComponent(token)}`)
  const action = mode === 'register' ? 'パスキーを作成' : 'パスキーを登録'
  await expect(page.getByRole('button', { name: action })).toBeEnabled({ timeout: 20_000 })
  await page.getByRole('button', { name: action }).click()
  // The screen replaces the spent invitation URL with the analyzer once the session opens.
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'サインアウト' })).toBeVisible()
}

export async function signInWithPasskey(page: Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'パスキーでサインイン' }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'サインアウト' })).toBeVisible()
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'サインアウト' }).first().click()
  await expect(page.getByRole('link', { name: 'サインイン' }).first()).toBeVisible()
}
