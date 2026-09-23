export type DrawItem = {
  id: string
  label: string
  weight: number
  color: string
}

export type DrawResult = {
  id: string
  itemId: string
  label: string
  color: string
  probability: number
  drawnAt: number
}

export type SavedState = {
  items: DrawItem[]
  history: DrawResult[]
  excludeWinners: boolean
  excludedIds: string[]
  soundEnabled: boolean
}

export const STORAGE_KEY = 'bbob-studio-v1'
export const MAX_ITEMS = 30
export const MAX_LABEL_LENGTH = 60
export const MAX_HISTORY = 30

export const PALETTE = ['#96dac6', '#f2b99e', '#bfb4ed', '#a5c9ed', '#e8d798']

export const DEFAULT_ITEMS: DrawItem[] = [
  { id: 'penalty-1', label: '청소 20분', weight: 20, color: PALETTE[0] },
  { id: 'penalty-2', label: '설거지 전담', weight: 20, color: PALETTE[1] },
  { id: 'penalty-3', label: '친구에게 커피 사기', weight: 20, color: PALETTE[2] },
  { id: 'penalty-4', label: '배달 대신 직접 요리', weight: 20, color: PALETTE[3] },
  { id: 'penalty-5', label: '미뤄둔 일 30분', weight: 20, color: PALETTE[4] },
]

// Keep the historic seed literal so later palette changes cannot broaden this migration.
const LEGACY_LUNCH_ITEMS: DrawItem[] = [
  { id: 'lunch-1', label: '김치찌개', weight: 30, color: '#96dac6' },
  { id: 'lunch-2', label: '파스타', weight: 25, color: '#f2b99e' },
  { id: 'lunch-3', label: '초밥', weight: 20, color: '#bfb4ed' },
  { id: 'lunch-4', label: '쌀국수', weight: 15, color: '#a5c9ed' },
  { id: 'lunch-5', label: '샌드위치', weight: 10, color: '#e8d798' },
]

/** Updates only the exact unused starter list; edited lists and past draws remain untouched. */
export function migrateRunningDefaults(state: SavedState): SavedState {
  if (state.history.length > 0
    || state.excludedIds.length > 0
    || state.items.length !== LEGACY_LUNCH_ITEMS.length) return state

  const untouchedSeed = state.items.every((item, index) => {
    const original = LEGACY_LUNCH_ITEMS[index]
    return item.id === original.id
      && item.label === original.label
      && item.weight === original.weight
      && item.color === original.color
  })
  return untouchedSeed
    ? { ...state, items: DEFAULT_ITEMS.map((item) => ({ ...item })) }
    : state
}

export function getEligibleItems(items: DrawItem[], excludedIds: string[] = []): DrawItem[] {
  const excluded = new Set(excludedIds)
  return items
    .filter((item) => item.label.trim().length > 0
      && Number.isFinite(item.weight)
      && item.weight > 0
      && !excluded.has(item.id))
    .map((item) => ({ ...item, label: item.label.trim() }))
}

function weightedEntries(items: DrawItem[]) {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  if (Number.isFinite(total)) {
    return { weights: items.map((item) => item.weight), total }
  }

  // Scaling also keeps this utility safe for finite weights beyond the UI's 0..100 range.
  const largest = Math.max(...items.map((item) => item.weight))
  const weights = items.map((item) => item.weight / largest)
  return { weights, total: weights.reduce((sum, weight) => sum + weight, 0) }
}

export function probabilities(items: DrawItem[], excludedIds: string[] = []): Record<string, number> {
  const eligible = getEligibleItems(items, excludedIds)
  const { weights, total } = weightedEntries(eligible)
  const entries = new Map(items.map((item) => [item.id, 0]))
  eligible.forEach((item, index) => {
    entries.set(item.id, (weights[index] / total) * 100)
  })
  return Object.fromEntries(entries)
}

function secureRandom(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] / 0x100000000
}

/** Selects from half-open weight intervals. An injected random source must return [0, 1). */
export function pickWeighted(
  items: DrawItem[],
  excludedIds: string[] = [],
  random: () => number = secureRandom,
): DrawItem | null {
  const eligible = getEligibleItems(items, excludedIds)
  if (eligible.length === 0) return null

  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('The random source must return a finite value in [0, 1).')
  }

  const { weights, total } = weightedEntries(eligible)
  const target = sample * total
  let cumulative = 0
  for (let index = 0; index < eligible.length; index += 1) {
    cumulative += weights[index]
    if (target < cumulative) return eligible[index]
  }
  // Multiplication can round a sample just below 1 up to the total.
  return eligible[eligible.length - 1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim().slice(0, MAX_LABEL_LENGTH)
  return label.length > 0 ? label : null
}

function cleanColor(value: unknown, index: number): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : PALETTE[index % PALETTE.length]
}

function restoreItems(values: unknown[]): DrawItem[] {
  const items: DrawItem[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isRecord(value) || !validId(value.id) || seen.has(value.id)) continue
    const label = cleanLabel(value.label)
    if (!label || typeof value.weight !== 'number' || !Number.isFinite(value.weight)) continue

    items.push({
      id: value.id,
      label,
      // Storage migration policy: round finite fractions, then clamp to the UI range.
      weight: Math.max(0, Math.min(100, Math.round(value.weight))),
      color: cleanColor(value.color, items.length),
    })
    seen.add(value.id)
    if (items.length === MAX_ITEMS) break
  }
  return items
}

function restoreHistory(values: unknown[]): DrawResult[] {
  const history: DrawResult[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isRecord(value) || !validId(value.id) || !validId(value.itemId) || seen.has(value.id)) continue
    const label = cleanLabel(value.label)
    if (!label
      || typeof value.probability !== 'number'
      || !Number.isFinite(value.probability)
      || value.probability < 0
      || value.probability > 100
      || typeof value.drawnAt !== 'number'
      || !Number.isSafeInteger(value.drawnAt)
      || value.drawnAt < 0
      || value.drawnAt > 8_640_000_000_000_000) continue

    history.push({
      id: value.id,
      itemId: value.itemId,
      label,
      probability: value.probability,
      color: cleanColor(value.color, history.length),
      drawnAt: value.drawnAt,
    })
    seen.add(value.id)
    if (history.length === MAX_HISTORY) break
  }
  return history
}

/** Restores only known fields. Invalid entries are dropped; numeric weights are rounded and clamped. */
export function parseSavedState(raw: string | null): SavedState | null {
  if (!raw || raw.length > 500_000) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return null
    const items = restoreItems(parsed.items)
    const itemIds = new Set(items.map((item) => item.id))
    const excludedIds = Array.isArray(parsed.excludedIds)
      ? [...new Set(parsed.excludedIds.filter((id): id is string => typeof id === 'string' && itemIds.has(id)))]
      : []

    return {
      items,
      history: Array.isArray(parsed.history) ? restoreHistory(parsed.history) : [],
      excludedIds,
      excludeWinners: parsed.excludeWinners === true,
      soundEnabled: parsed.soundEnabled === true,
    }
  } catch {
    return null
  }
}
