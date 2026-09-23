export type TierId = 'high' | 'medium' | 'low' | 'ultra'

export type DrawItem = {
  id: string
  label: string
  tier: TierId
  color: string
  enabled?: boolean
}

export type DrawResult = {
  id: string
  itemId: string
  label: string
  color: string
  probability: number
  drawnAt: number
  tier?: TierId
}

export type PendingEgg = {
  id: string
  tier: TierId
  candidates: DrawItem[]
  createdAt: number
}

export type SavedState = {
  items: DrawItem[]
  history: DrawResult[]
  excludeWinners: boolean
  excludedIds: string[]
  soundEnabled: boolean
  pending: PendingEgg | null
}

export const STORAGE_KEY = 'bbob-studio-v1'
export const MAX_ITEMS = 30
export const MAX_LABEL_LENGTH = 60
export const MAX_HISTORY = 30
export const PALETTE = ['#96dac6', '#f2b99e', '#bfb4ed', '#a5c9ed', '#e8d798']

export const TIERS: readonly {
  id: TierId
  label: string
  probability: number
  color: string
  eggLabel: string
}[] = [
  { id: 'high', label: '상', probability: 60, color: '#edf1f4', eggLabel: '흰색' },
  { id: 'medium', label: '중', probability: 35, color: '#639be9', eggLabel: '파란색' },
  { id: 'low', label: '하', probability: 4.9, color: '#dfb956', eggLabel: '금색' },
  { id: 'ultra', label: '극하', probability: 0.1, color: '#f5c331', eggLabel: '빛나는 황금색' },
]

export const DEFAULT_ITEMS: DrawItem[] = [
  { id: 'penalty-1', label: '청소 20분', tier: 'high', color: TIERS[0].color },
  { id: 'penalty-2', label: '설거지 전담', tier: 'high', color: TIERS[0].color },
  { id: 'penalty-3', label: '친구에게 커피 사기', tier: 'medium', color: TIERS[1].color },
  { id: 'penalty-4', label: '배달 대신 직접 요리', tier: 'low', color: TIERS[2].color },
  { id: 'penalty-5', label: '미뤄둔 일 30분', tier: 'ultra', color: TIERS[3].color },
]

const LEGACY_LUNCH_ITEMS = [
  { id: 'lunch-1', label: '김치찌개', weight: 30, color: '#96dac6' },
  { id: 'lunch-2', label: '파스타', weight: 25, color: '#f2b99e' },
  { id: 'lunch-3', label: '초밥', weight: 20, color: '#bfb4ed' },
  { id: 'lunch-4', label: '쌀국수', weight: 15, color: '#a5c9ed' },
  { id: 'lunch-5', label: '샌드위치', weight: 10, color: '#e8d798' },
]
const LEGACY_PENALTY_ITEMS = [
  { id: 'penalty-1', label: '청소 20분', weight: 20, color: '#96dac6' },
  { id: 'penalty-2', label: '설거지 전담', weight: 20, color: '#f2b99e' },
  { id: 'penalty-3', label: '친구에게 커피 사기', weight: 20, color: '#bfb4ed' },
  { id: 'penalty-4', label: '배달 대신 직접 요리', weight: 20, color: '#a5c9ed' },
  { id: 'penalty-5', label: '미뤄둔 일 30분', weight: 20, color: '#e8d798' },
]

function isTier(value: unknown): value is TierId {
  return TIERS.some(tier => tier.id === value)
}

export function getEligibleItems(items: DrawItem[], excludedIds: string[] = []): DrawItem[] {
  const excluded = new Set(excludedIds)
  return items.filter(item => item.label.trim().length > 0
    && item.enabled !== false && isTier(item.tier) && !excluded.has(item.id))
    .map(item => ({ ...item, label: item.label.trim() }))
}

export function getMissingTiers(items: DrawItem[], excludedIds: string[] = []): TierId[] {
  const available = new Set(getEligibleItems(items, excludedIds).map(item => item.tier))
  return TIERS.filter(tier => !available.has(tier.id)).map(tier => tier.id)
}

/** Every tier must be available; fixed tier chances are never redistributed. */
export function probabilities(items: DrawItem[], excludedIds: string[] = []): Record<string, number> {
  const entries = new Map(items.map(item => [item.id, 0]))
  const eligible = getEligibleItems(items, excludedIds)
  if (getMissingTiers(eligible).length > 0) return Object.fromEntries(entries)
  for (const tier of TIERS) {
    const candidates = eligible.filter(item => item.tier === tier.id)
    for (const item of candidates) entries.set(item.id, tier.probability / candidates.length)
  }
  return Object.fromEntries(entries)
}

function secureRandom(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] / 0x100000000
}

function randomSample(random: () => number): number {
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('The random source must return a finite value in [0, 1).')
  }
  return sample
}

/** Fixed half-open intervals contain 6000, 3500, 490 and 10 of 10,000 slots. */
export function pickTier(random: () => number = secureRandom): TierId {
  const target = randomSample(random) * 10_000
  let cumulative = 0
  for (const tier of TIERS) {
    cumulative += Math.round(tier.probability * 100)
    if (target < cumulative) return tier.id
  }
  return 'ultra'
}

export function createPendingEgg(
  items: DrawItem[], excludedIds: string[] = [], random: () => number = secureRandom,
): PendingEgg | null {
  const eligible = getEligibleItems(items, excludedIds)
  if (getMissingTiers(eligible).length > 0 || eligible.length > MAX_ITEMS
    || new Set(eligible.map(item => item.id)).size !== eligible.length) return null
  const tier = pickTier(random)
  return {
    id: globalThis.crypto.randomUUID(), tier,
    candidates: eligible.filter(item => item.tier === tier), createdAt: Date.now(),
  }
}

/** Opening chooses one item uniformly from the saved pool, independently of the tier draw. */
export function openEgg(pending: PendingEgg, random: () => number = secureRandom): DrawResult | null {
  const egg = restorePending(pending)
  if (!egg) return null
  const winner = egg.candidates[Math.floor(randomSample(random) * egg.candidates.length)]
  const tier = TIERS.find(tier => tier.id === egg.tier)!
  return {
    id: egg.id, itemId: winner.id, label: winner.label, color: winner.color, tier: egg.tier,
    probability: tier.probability / egg.candidates.length, drawnAt: Date.now(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 8_640_000_000_000_000
}

function cleanColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function restoreItem(value: unknown): DrawItem | null {
  if (!isRecord(value) || !validId(value.id) || typeof value.label !== 'string') return null
  const hasTier = isTier(value.tier)
  const tier = hasTier ? value.tier as TierId : 'high'
  const entry: DrawItem = {
    id: value.id, label: value.label.slice(0, MAX_LABEL_LENGTH), tier,
    color: cleanColor(value.color, TIERS.find(entry => entry.id === tier)!.color),
  }
  if (typeof value.enabled === 'boolean') entry.enabled = value.enabled
  // Legacy zero, negative, invalid or rounded-to-zero weights must not become active choices.
  if (!hasTier && (typeof value.weight !== 'number' || !Number.isFinite(value.weight)
    || Math.round(value.weight) <= 0)) entry.enabled = false
  return entry
}

function restoreItems(values: unknown[]): DrawItem[] {
  const items: DrawItem[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const item = restoreItem(value)
    if (!item || seen.has(item.id)) continue
    items.push(item)
    seen.add(item.id)
    if (items.length === MAX_ITEMS) break
  }
  return items
}

function restoreHistory(values: unknown[]): DrawResult[] {
  const history: DrawResult[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isRecord(value) || !validId(value.id) || !validId(value.itemId) || seen.has(value.id)
      || typeof value.label !== 'string' || !value.label.trim()
      || typeof value.probability !== 'number' || !Number.isFinite(value.probability)
      || value.probability < 0 || value.probability > 100 || !validTime(value.drawnAt)) continue
    const result: DrawResult = {
      id: value.id, itemId: value.itemId, label: value.label.trim().slice(0, MAX_LABEL_LENGTH),
      probability: value.probability, color: cleanColor(value.color, PALETTE[history.length % PALETTE.length]),
      drawnAt: value.drawnAt,
    }
    if (isTier(value.tier)) result.tier = value.tier
    history.push(result)
    seen.add(value.id)
    if (history.length === MAX_HISTORY) break
  }
  return history
}

/** Reject the entire pool if any candidate is invalid, so restoration cannot change its odds. */
function restorePending(value: unknown): PendingEgg | null {
  if (!isRecord(value) || !validId(value.id) || !isTier(value.tier) || !validTime(value.createdAt)
    || !Array.isArray(value.candidates) || value.candidates.length === 0
    || value.candidates.length > MAX_ITEMS) return null
  const candidates: DrawItem[] = []
  const seen = new Set<string>()
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || candidate.tier !== value.tier) return null
    const item = restoreItem(candidate)
    if (!item || !item.label.trim() || item.enabled === false || seen.has(item.id)) return null
    candidates.push({ ...item, label: item.label.trim() })
    seen.add(item.id)
  }
  return { id: value.id, tier: value.tier, candidates, createdAt: value.createdAt }
}

function matchesLegacySeed(values: unknown[], seed: typeof LEGACY_LUNCH_ITEMS): boolean {
  return values.length === seed.length && values.every((value, index) => {
    const original = seed[index]
    return isRecord(value) && value.tier === undefined && value.enabled !== false
      && value.id === original.id && value.label === original.label
      && value.weight === original.weight && value.color === original.color
  })
}

function absentOrEmpty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}

/** Keeps one storage key across versions and migrates only recognized, unchanged presets. */
export function parseSavedState(raw: string | null): SavedState | null {
  if (!raw || raw.length > 500_000) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return null
    const migrateLunch = matchesLegacySeed(parsed.items, LEGACY_LUNCH_ITEMS)
      && absentOrEmpty(parsed.history) && absentOrEmpty(parsed.excludedIds) && parsed.pending == null
    const migratePenalties = matchesLegacySeed(parsed.items, LEGACY_PENALTY_ITEMS)
    const items = migrateLunch || migratePenalties
      ? DEFAULT_ITEMS.map(item => ({ ...item })) : restoreItems(parsed.items)
    const itemIds = new Set(items.map(item => item.id))
    const excludedIds = Array.isArray(parsed.excludedIds)
      ? [...new Set(parsed.excludedIds.filter((id): id is string => typeof id === 'string' && itemIds.has(id)))]
      : []
    const history = Array.isArray(parsed.history) ? restoreHistory(parsed.history) : []
    const pending = restorePending(parsed.pending)
    return {
      items, history, excludedIds,
      excludeWinners: parsed.excludeWinners === true, soundEnabled: parsed.soundEnabled === true,
      pending: pending && !history.some(result => result.id === pending.id) ? pending : null,
    }
  } catch {
    return null
  }
}
