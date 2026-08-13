import { describe, expect, it } from 'vitest'
import { buildAutoPosterPlotSpec, buildPosterPlotSpec } from '../src/builder.ts'
import {
  DEFAULT_POSTER_FIGURE_SIZE_ID,
  findPosterFigureSize,
  POSTER_SERIES_OPTIONS,
  posterDisplayName,
  posterDpiOptions,
  posterFigureSizeOptions,
  posterFormDefaults,
  posterTitleLine,
} from '../src/poster-form.ts'
import { AAT_POSTER_V1_PRESET, POSTER_PRESET_VERSIONS } from '../src/presets.ts'
import {
  DPI_MAX,
  DPI_MIN,
  FIGURE_DIMENSION_MAX_INCHES,
  FIGURE_DIMENSION_MIN_INCHES,
  safeParsePosterPlotSpec,
} from '../src/spec.ts'
import { fullResolutionSeries } from './helpers.ts'

describe('posterFigureSizeOptions', () => {
  it('offers the frozen preset’s geometry first, derived rather than restated', () => {
    const [first] = posterFigureSizeOptions()
    expect(first?.id).toBe(DEFAULT_POSTER_FIGURE_SIZE_ID)
    expect(first?.widthInches).toBe(AAT_POSTER_V1_PRESET.defaults.figureWidth)
    expect(first?.heightInches).toBe(AAT_POSTER_V1_PRESET.defaults.figureHeight)
  })

  it('keeps every offered size inside the schema’s dimension bounds', () => {
    for (const version of POSTER_PRESET_VERSIONS) {
      for (const option of posterFigureSizeOptions(version)) {
        expect(option.widthInches).toBeGreaterThanOrEqual(FIGURE_DIMENSION_MIN_INCHES)
        expect(option.widthInches).toBeLessThanOrEqual(FIGURE_DIMENSION_MAX_INCHES)
        expect(option.heightInches).toBeGreaterThanOrEqual(FIGURE_DIMENSION_MIN_INCHES)
        expect(option.heightInches).toBeLessThanOrEqual(FIGURE_DIMENSION_MAX_INCHES)
      }
    }
  })

  it('uses distinct ids and labels both locales', () => {
    const options = posterFigureSizeOptions()
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length)
    for (const option of options) {
      expect(option.label.ja.length).toBeGreaterThan(0)
      expect(option.label.en.length).toBeGreaterThan(0)
    }
  })

  it('looks a size up by id, and returns undefined for one it no longer offers', () => {
    expect(findPosterFigureSize('a4-landscape')?.widthInches).toBe(11.69)
    expect(findPosterFigureSize('poster-of-the-month')).toBeUndefined()
  })
})

describe('posterDpiOptions', () => {
  it('always offers the preset’s own DPI', () => {
    for (const version of POSTER_PRESET_VERSIONS) {
      const options = posterDpiOptions(version)
      expect(options.some((option) => option.dpi === AAT_POSTER_V1_PRESET.defaults.dpi)).toBe(true)
    }
  })

  it('stays inside the schema’s DPI bounds and is ascending', () => {
    const options = posterDpiOptions()
    for (const option of options) {
      expect(option.dpi).toBeGreaterThanOrEqual(DPI_MIN)
      expect(option.dpi).toBeLessThanOrEqual(DPI_MAX)
      expect(Number.isInteger(option.dpi)).toBe(true)
    }
    const values = options.map((option) => option.dpi)
    expect([...values].sort((left, right) => left - right)).toEqual(values)
  })
})

describe('POSTER_SERIES_OPTIONS', () => {
  it('covers exactly the schema’s three selections', () => {
    expect(POSTER_SERIES_OPTIONS.map((option) => option.value)).toEqual(['both', 'inner', 'drag'])
  })
})

describe('posterFormDefaults', () => {
  it('starts the form on the frozen preset, so an untouched form matches the automatic poster', () => {
    const defaults = posterFormDefaults()
    const auto = buildAutoPosterPlotSpec({
      analysisRevisionId: 'rev-260811a-1',
      runCode: '260811a',
      source: { inner: fullResolutionSeries([0, 0.1, 0.2], [1, 2, 3]) },
    })
    expect(defaults.figureWidth).toBe(auto.figureWidth)
    expect(defaults.figureHeight).toBe(auto.figureHeight)
    expect(defaults.dpi).toBe(auto.dpi)
    expect(defaults.showLegend).toBe(auto.showLegend)
    expect(defaults.title).toBe(auto.title)
  })

  it('produces a valid spec when fed straight into the builder', () => {
    const defaults = posterFormDefaults()
    const spec = buildPosterPlotSpec({
      analysisRevisionId: 'rev-260811a-1',
      runCode: '260811a',
      series: defaults.series,
      source: {
        inner: fullResolutionSeries([0, 0.1, 0.2], [1, 2, 3]),
        drag: fullResolutionSeries([0, 0.1, 0.2], [4, 5, 6]),
      },
      xMin: 0,
      xMax: 0.2,
      title: defaults.title,
      showLegend: defaults.showLegend,
      figureWidth: defaults.figureWidth,
      figureHeight: defaults.figureHeight,
      dpi: defaults.dpi,
      posterPresetVersion: defaults.posterPresetVersion,
    })
    expect(safeParsePosterPlotSpec(spec).success).toBe(true)
  })

  it('offers every figure size the form can select, including its own default', () => {
    const defaults = posterFormDefaults()
    const option = findPosterFigureSize(defaults.figureSizeId)
    expect(option?.widthInches).toBe(defaults.figureWidth)
    expect(option?.heightInches).toBe(defaults.figureHeight)
  })
})

describe('posterDisplayName / posterTitleLine', () => {
  it('falls back to the run code when no name override is given', () => {
    expect(posterDisplayName('260811a')).toBe('260811a')
    expect(posterDisplayName('260811a', '')).toBe('260811a')
  })

  it('uses the override as the figure’s name when one is given', () => {
    expect(posterDisplayName('260811a', 'Drop 3')).toBe('Drop 3')
  })

  it('previews the title the renderer will actually draw, template and all', () => {
    // `title` replaces the {name}, never the template — the same rule the Python renderer applies.
    expect(posterTitleLine('260811a')).toBe('The Gravity Level 260811a')
    expect(posterTitleLine('260811a', 'Drop 3')).toBe('The Gravity Level Drop 3')
  })

  it('takes the template from the preset rather than restating it', () => {
    const expected = AAT_POSTER_V1_PRESET.labels.titleTemplate.replace('{name}', '260811')
    expect(posterTitleLine('260811')).toBe(expected)
  })

  it('does not let a name containing braces alter the template', () => {
    expect(posterTitleLine('260811a', '{name}')).toBe('The Gravity Level {name}')
  })

  it('treats a name containing replacement syntax literally', () => {
    expect(posterTitleLine('260811a', "$& $' $`")).toBe("The Gravity Level $& $' $`")
  })
})
