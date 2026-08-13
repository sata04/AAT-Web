/**
 * Accessibility scanning, and what the suite does with the result.
 *
 * axe-core finds a subset of accessibility problems — the machine-checkable ones. It cannot tell
 * whether a label is *meaningful*, and it will not notice that a range readout announces nothing
 * when the selection changes. So a clean scan is a floor, not a certificate.
 *
 * ## Why there is a recorded list rather than a hard zero
 *
 * The scans below find real violations in `src/`, and fixing them is a change to application code
 * that this suite deliberately does not make. Two ways to hold that: fail the suite permanently, or
 * record exactly what is wrong and fail on anything new. The second is what is done here, and the
 * difference from an allowlist is the point —
 *
 *  - the register is per screen, per rule, per selector, written out in `specs/accessibility.spec.ts`
 *    where a reader sees it, not hidden in a config;
 *  - a violation that is fixed makes the run fail ("recorded but no longer found"), so the register
 *    cannot rot into a list of things nobody remembers;
 *  - every violation, recorded or not, is attached to the report in full.
 *
 * The rule tags are WCAG 2.1 A and AA plus axe's own best-practice set. AAT is a research tool used
 * in a university, which in most jurisdictions makes AA the applicable standard rather than an
 * aspiration.
 */

import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, type TestInfo } from '@playwright/test'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/** One finding, flattened to `rule@selector` so it can be compared and read at a glance. */
export interface Finding {
  screen: string
  rule: string
  impact: string
  target: string
  help: string
}

/** Scan the current page, attach the full result, and return the findings. */
export async function scanAccessibility(page: Page, testInfo: TestInfo, screen: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()

  const findings = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      screen,
      rule: violation.id,
      impact: violation.impact ?? 'unknown',
      target: node.target.join(' '),
      help: violation.help,
    })),
  )

  await testInfo.attach(`axe-${screen}`, {
    body: JSON.stringify(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      })),
      null,
      2,
    ),
    contentType: 'application/json',
  })

  return findings
}

/**
 * Summarise the findings as `screen · rule ×count`.
 *
 * Deliberately not keyed on the CSS selector. axe generates a minimal unique selector, so the same
 * element is `a[href$="runs"]` on one screen and `a[aria-current="page"]` on another, and an
 * unrelated change to a sibling rewrites it — a register keyed on that would churn without anything
 * having got better or worse. The count is what carries the signal instead: one more element
 * failing the same rule on the same screen is a regression and shows up as `×2`. The exact
 * selectors and failure summaries are in the `axe-*` attachment either way.
 */
export function summarise(found: readonly Finding[]): string[] {
  const counts = new Map<string, number>()
  for (const finding of found) {
    const entry = `${finding.screen} · ${finding.rule}`
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }
  return [...counts.entries()].map(([entry, count]) => `${entry} ×${count}`).sort()
}

/**
 * Compare what was found against what is recorded.
 *
 * Fails in both directions: a new violation is a regression, and a recorded one that has gone is a
 * fix the register has not caught up with.
 */
export function expectOnlyRecordedViolations(found: Finding[], recorded: readonly string[]): void {
  const foundKeys = summarise(found)
  const unexpected = foundKeys.filter((entry) => !recorded.includes(entry))
  const gone = [...recorded].filter((entry) => !foundKeys.includes(entry)).sort()

  expect(
    unexpected,
    'new accessibility violations — see the axe-* attachments for the failure summaries',
  ).toEqual([])
  expect(
    gone,
    'accessibility violations that are recorded as known but no longer occur; delete them from the register',
  ).toEqual([])
}
