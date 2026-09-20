/**
 * Deterministic synthetic drop-tower CSVs for the first-run tour.
 *
 * The tour feeds these files through the real analyzer — the same decode,
 * column detection, load and filter pipeline a researcher's own CSV takes —
 * and determinism is load-bearing in two places:
 *
 *   - datasets are keyed by `sourceSha256`, so only byte-for-byte identical
 *     bytes make a replay (tour restart, StrictMode double-mount) replace the
 *     existing dataset instead of silently installing a duplicate;
 *   - the tour's steps narrate what the pipeline did with *this* data, which is
 *     only honest if the bytes cannot drift between calls.
 *
 * Determinism comes from a seeded mulberry32 PRNG and fixed-precision
 * formatting — no `Math.random`, no wall-clock input, ASCII only.
 */

import { datasetNameFromFilename } from '../app/dataset.ts'

export type DemoDataset = 'a' | 'b'

/**
 * The names the tour installs under. The driver uses them to find the demo
 * datasets again when it cleans up after the run.
 */
export const DEMO_DATASET_NAMES = ['sample-a.csv', 'sample-b.csv'] as const

const FILE_NAME: Readonly<Record<DemoDataset, (typeof DEMO_DATASET_NAMES)[number]>> = {
  a: DEMO_DATASET_NAMES[0],
  b: DEMO_DATASET_NAMES[1],
}

/** The name the demo lands under when a researcher's own file has the usual one. */
const FALLBACK_NAME: Readonly<Record<DemoDataset, string>> = {
  a: 'sample-a-tour.csv',
  b: 'sample-b-tour.csv',
}

/** Preferred filename, or the tour-suffixed fallback when `taken` names collide. */
export function demoFilename(which: DemoDataset, taken: ReadonlySet<string>): string {
  const preferred = FILE_NAME[which]
  return taken.has(datasetNameFromFilename(preferred)) ? FALLBACK_NAME[which] : preferred
}

/**
 * The canonical three-column AAT layout. `detectColumns` finds exactly one time
 * candidate and exactly two acceleration candidates in it, so `proposeMapping`
 * returns a confident mapping and no column-selection dialog interrupts the
 * tour.
 */
const HEADER = 'Time (s),Z-axis acceleration 1(m/s2),Z-axis acceleration 2(m/s2)'

const SAMPLE_HZ = 1000
const SAMPLE_COUNT = 3200
const TAU = Math.PI * 2

/** Release transient: the standstill level rings down to the plateau in ~0.1 s. */
const RELEASE_DECAY_S = 0.022
/** Recovery spike: rises in 7 ms, then rings down toward the rest level. */
const RISE_S = 0.007
const BRAKE_DECAY_S = 0.09
/** Asymmetry of the brake ring — a real catch overshoots but does not swing to -10 G. */
const BRAKE_RING = 0.55
const BRAKE_BASE = 1 - BRAKE_RING

const REST_NOISE = 0.04
const REST_VIBRATION = 0.045
const INNER_PLATEAU_NOISE = 0.012
const INNER_PLATEAU_WOBBLE = 0.008
const DRAG_PLATEAU_NOISE = 0.07
const DRAG_PLATEAU_WOBBLE = 0.06
const RECOVERY_NOISE = 0.12

/**
 * One dataset's physics knobs. Both files share the shape — standstill, release
 * transient, microgravity plateau, recovery spike — and differ in seed, levels
 * and timing, which is what makes 'a' and 'b' visibly distinct curves rather
 * than the same trace twice.
 */
interface DemoProfile {
  /** mulberry32 seed; the only entropy in the file. */
  readonly seed: number
  /** Raw Inner Capsule standstill level — negative because the sensor is mounted inverted. */
  readonly restInner: number
  /** Raw Drag Shield standstill level. */
  readonly restDrag: number
  /** Release instant, seconds. */
  readonly releaseAt: number
  /** Catch/brake contact, seconds — where the recovery spike starts. */
  readonly impactAt: number
  /** Recovery peak magnitude, m/s². Must clear the 8 G end level. */
  readonly peakAccel: number
  /** Inner Capsule residual during free fall — the quiet channel, near zero. */
  readonly innerPlateau: number
  /** Drag Shield residual during free fall — offset and noisier. */
  readonly dragPlateau: number
  /** Release ring-down frequency, Hz. */
  readonly ringHz: number
  /** Brake ring-down frequency, Hz. */
  readonly brakeHz: number
  /** Standstill vibration frequency, Hz. */
  readonly vibHz: number
  /** Plateau low-frequency drift frequency, Hz. */
  readonly wobbleHz: number
}

const PROFILES: Readonly<Record<DemoDataset, DemoProfile>> = {
  a: {
    seed: 0x51ab4f7c,
    restInner: -9.648,
    restDrag: 9.798,
    releaseAt: 0.415,
    impactAt: 2.562,
    peakAccel: 114,
    innerPlateau: 0.006,
    dragPlateau: -0.34,
    ringHz: 26,
    brakeHz: 15,
    vibHz: 14,
    wobbleHz: 2.7,
  },
  b: {
    seed: 0x9d3c21e8,
    restInner: -9.702,
    restDrag: 9.815,
    releaseAt: 0.548,
    impactAt: 2.438,
    peakAccel: 121,
    innerPlateau: -0.008,
    dragPlateau: -0.51,
    ringHz: 22,
    brakeHz: 17,
    vibHz: 17,
    wobbleHz: 3.4,
  },
}

/**
 * mulberry32 — a 32-bit seeded PRNG. Hand-rolled rather than imported so this
 * module stays dependency-free; good enough for sensor noise, small enough to
 * audit at a glance.
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let z = Math.imul(state ^ (state >>> 15), 1 | state)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

/** Roughly standard-normal noise from three uniforms (Irwin–Hall, σ ≈ 1). */
function gauss(next: () => number): number {
  return (next() + next() + next() - 1.5) * 2
}

/**
 * One sensor's raw acceleration at time `t`, pre-correction m/s².
 *
 * `level` is the standstill reading (the sensor's 1 G), `plateau` the free-fall
 * residual, `peak` the signed recovery magnitude. The ring constants are shared:
 * the release decays in ~0.1 s and the spike settles back to standstill.
 */
function sensorSample(
  t: number,
  profile: DemoProfile,
  level: number,
  plateau: number,
  peak: number,
  wobbleAmp: number,
  plateauNoise: number,
  wobblePhase: number,
  noise: number,
): number {
  const sinceRelease = t - profile.releaseAt
  if (sinceRelease < 0) {
    return level + REST_VIBRATION * Math.sin(TAU * profile.vibHz * t + wobblePhase) + REST_NOISE * noise
  }

  const sinceImpact = t - profile.impactAt
  if (sinceImpact < 0) {
    const ring = Math.exp(-sinceRelease / RELEASE_DECAY_S) * Math.cos(TAU * profile.ringHz * sinceRelease)
    const wobble = wobbleAmp * Math.sin(TAU * profile.wobbleHz * t + wobblePhase)
    return plateau + (level - plateau) * ring + wobble + plateauNoise * noise
  }

  if (sinceImpact < RISE_S) {
    return plateau + (peak - plateau) * (sinceImpact / RISE_S) + RECOVERY_NOISE * noise
  }

  const u = sinceImpact - RISE_S
  const ring = Math.exp(-u / BRAKE_DECAY_S) * (BRAKE_RING * Math.cos(TAU * profile.brakeHz * u) + BRAKE_BASE)
  return level + (peak - level) * ring + RECOVERY_NOISE * noise
}

/** Six decimals keeps the files compact and pins the bytes against fp noise. */
function formatAcceleration(value: number): string {
  return value.toFixed(6)
}

function buildCsv(profile: DemoProfile): string {
  const next = mulberry32(profile.seed)
  const innerPhase = next() * TAU
  const dragPhase = next() * TAU
  const lines: string[] = [HEADER]

  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const t = index / SAMPLE_HZ
    const inner = sensorSample(
      t,
      profile,
      profile.restInner,
      profile.innerPlateau,
      -profile.peakAccel,
      INNER_PLATEAU_WOBBLE,
      INNER_PLATEAU_NOISE,
      innerPhase,
      gauss(next),
    )
    const drag = sensorSample(
      t,
      profile,
      profile.restDrag,
      profile.dragPlateau,
      profile.peakAccel,
      DRAG_PLATEAU_WOBBLE,
      DRAG_PLATEAU_NOISE,
      dragPhase,
      gauss(next),
    )
    lines.push(`${t},${formatAcceleration(inner)},${formatAcceleration(drag)}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * The tour's input file. A fresh `File` every call — callers must be able to
 * hand it to `openFiles` independently — over bytes that never change for a
 * given `which`. `filename` exists for the collision fallback: the bytes are
 * identical either way, only the display name moves.
 */
export function demoCsvFile(which: DemoDataset, filename: string = FILE_NAME[which]): File {
  const bytes = new TextEncoder().encode(buildCsv(PROFILES[which]))
  return new File([bytes], filename, { type: 'text/csv' })
}
