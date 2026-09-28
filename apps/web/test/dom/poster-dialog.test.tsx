import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { SensorDataset } from '../../src/app/dataset.ts'
import { PosterDialog } from '../../src/poster/PosterDialog.tsx'
import type { PosterContext } from '../../src/poster/requests.ts'
import { installNetwork, json } from './harness.tsx'

const time = asFullResolution(Float64Array.from([0, 1, 2]))
const values = asFullResolution(Float64Array.from([0, 0.1, 0]))
const sensor: SensorDataset = {
  present: true,
  time,
  gravity: values,
  filteredTime: time,
  filteredGravity: values,
  acceleration: values,
  startIndex: 0,
  endIndex: 2,
}
const context: PosterContext = {
  revisionId: 'rev-test',
  runCode: '260811a',
  dataset: {
    name: '260811a',
    filename: '260811a_data.csv',
    sourceSha256: 'a'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'inner', 'drag'],
    mapping: { timeColumn: 't', innerColumn: 'inner', dragColumn: 'drag', useInner: true, useDrag: true },
    inner: sensor,
    drag: sensor,
    sync: {
      innerIndex: 0,
      dragIndex: 0,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 1,
    },
    filterEndIndex: 2,
    statistics: {
      inner: { mean: 0, std: 0, startTime: 0 },
      drag: { mean: 0, std: 0, startTime: 0 },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: 3,
    analysisTimestamp: '2026-08-11T00:00:00.000Z',
    fromCache: false,
    config: DEFAULT_ANALYSIS_CONFIG,
  },
}

function openDialog(yRange = { min: -1, max: 1 }) {
  const network = installNetwork({
    'POST /api/v1/revisions/rev-test/posters': () =>
      json({
        poster: {
          posterId: 'poster-test',
          analysisRevisionId: context.revisionId,
          kind: 'custom',
          presetVersion: 'aat-poster-v1',
          specHash: 'd'.repeat(64),
          status: 'ready',
          rendererVersion: 'test',
          failureCode: null,
          attemptCount: 1,
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      }),
  })
  render(
    <PosterDialog
      context={context}
      selection={{ xMin: 0, xMax: 1 }}
      yRange={yRange}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  )
  return network
}

describe('poster Y bounds', () => {
  it.each(['下限 (G)', '上限 (G)'])(
    'rejects malformed numeric input in %s even when the browser exposes an empty value',
    (label) => {
      const network = openDialog()
      const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement
      fireEvent.change(input, { target: { value: '' } })
      // jsdom cannot type an incomplete exponent. Model the native validity state
      // a browser exposes for `1e`/overflow while its value property is empty.
      vi.spyOn(input.validity, 'badInput', 'get').mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: '作成', exact: true }))
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByRole('alert').textContent).toContain('有限の数値')
      expect(network.requests).toHaveLength(0)
    },
  )

  it.each([
    { min: -1, max: Number('1e309'), label: '上限 (G)' },
    { min: Number('-1e309'), max: 1, label: '下限 (G)' },
  ])('rejects a non-finite bound in the form state: $label', ({ min, max, label }) => {
    const network = openDialog({ min, max })
    const input = screen.getByRole('spinbutton', { name: label })
    fireEvent.click(screen.getByRole('button', { name: '作成', exact: true }))
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('有限の数値')
    expect(network.requests).toHaveLength(0)
  })

  it('uses preset defaults for intentionally blank optional bounds', async () => {
    const network = openDialog()
    fireEvent.change(screen.getByRole('spinbutton', { name: '下限 (G)' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '上限 (G)' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '作成', exact: true }))
    await waitFor(() => expect(network.requests).toHaveLength(1))
    const body = JSON.parse(network.requests[0]?.body ?? '{}') as { spec: { yMin: number; yMax: number } }
    expect(body.spec).toMatchObject({ yMin: -1, yMax: 1 })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('poster resolution cap', () => {
  it('disables 600 dpi for every figure size while keeping 150/300 selectable', () => {
    openDialog()
    const sizeSelect = screen.getByRole('combobox', { name: '図のサイズ' })
    const dpi600 = screen.getByRole('option', { name: /600 dpi/ }) as HTMLOptionElement
    const dpi300 = screen.getByRole('option', { name: /300 dpi/ }) as HTMLOptionElement
    expect(dpi600.disabled).toBe(true)
    expect(dpi300.disabled).toBe(false)
    for (const size of Array.from(sizeSelect.querySelectorAll('option'))) {
      fireEvent.change(sizeSelect, { target: { value: (size as HTMLOptionElement).value } })
      expect((screen.getByRole('option', { name: /600 dpi/ }) as HTMLOptionElement).disabled).toBe(true)
    }
  })
})
