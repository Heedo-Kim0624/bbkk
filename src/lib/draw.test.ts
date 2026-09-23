import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ITEMS, MAX_HISTORY, MAX_ITEMS, MAX_LABEL_LENGTH, PALETTE, STORAGE_KEY, TIERS,
  chooseSpread, createPendingEgg, createPendingSpread, getEligibleItems, getMissingTiers, openEgg, parseSavedState,
  pickTier, preparePendingSpread, probabilities, resultFromSpread,
  type DrawItem, type DrawResult, type PendingEgg, type PendingSpread, type SavedState, type TierId,
} from './draw'

const item = (id: string, tier: TierId = 'high', label = id): DrawItem => ({
  id, label, tier, color: TIERS.find(entry => entry.id === tier)!.color,
})
const result = (id: string): DrawResult => ({
  id, itemId: 'removed-item', label: '지난 선택', color: PALETTE[1], probability: 25,
  drawnAt: 1_700_000_000_000,
})
const pending = (tier: TierId = 'high'): PendingEgg => ({
  id: 'egg-1', tier, candidates: [item('first', tier), item('second', tier)],
  createdAt: 1_700_000_000_000,
})
const saved = (items: DrawItem[] = DEFAULT_ITEMS): SavedState => ({
  items: items.map(entry => ({ ...entry })), history: [], excludedIds: [],
  excludeWinners: false, soundEnabled: false, pending: null,
})
const legacyLunch = () => [
  { id: 'lunch-1', label: '김치찌개', weight: 30, color: '#96dac6' },
  { id: 'lunch-2', label: '파스타', weight: 25, color: '#f2b99e' },
  { id: 'lunch-3', label: '초밥', weight: 20, color: '#bfb4ed' },
  { id: 'lunch-4', label: '쌀국수', weight: 15, color: '#a5c9ed' },
  { id: 'lunch-5', label: '샌드위치', weight: 10, color: '#e8d798' },
]
const legacyPenalties = () => [
  { id: 'penalty-1', label: '청소 20분', weight: 20, color: '#96dac6' },
  { id: 'penalty-2', label: '설거지 전담', weight: 20, color: '#f2b99e' },
  { id: 'penalty-3', label: '친구에게 커피 사기', weight: 20, color: '#bfb4ed' },
  { id: 'penalty-4', label: '배달 대신 직접 요리', weight: 20, color: '#a5c9ed' },
  { id: 'penalty-5', label: '미뤄둔 일 30분', weight: 20, color: '#e8d798' },
]
const restore = (value: unknown) => parseSavedState(JSON.stringify(value))

afterEach(() => vi.restoreAllMocks())

describe('fixed tier probabilities', () => {
  it('maps the complete 10,000-slot distribution to exactly 6000/3500/490/10 slots', () => {
    const counts = { high: 0, medium: 0, low: 0, ultra: 0 }
    for (let slot = 0; slot < 10_000; slot += 1) counts[pickTier(() => (slot + 0.5) / 10_000)] += 1
    expect(counts).toEqual({ high: 6000, medium: 3500, low: 490, ultra: 10 })
    expect(TIERS.map(tier => tier.probability)).toEqual([60, 35, 4.9, 0.1])
  })

  it.each<[number, TierId]>([
    [0, 'high'], [0.6 - Number.EPSILON, 'high'], [0.6, 'medium'],
    [0.95 - Number.EPSILON, 'medium'], [0.95, 'low'],
    [0.999 - Number.EPSILON, 'low'], [0.999, 'ultra'], [1 - Number.EPSILON, 'ultra'],
  ])('uses half-open tier boundaries at %s', (sample, expected) => {
    expect(pickTier(() => sample)).toBe(expected)
  })

  it.each([-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid random sample %s', sample => {
    expect(() => pickTier(() => sample)).toThrow(RangeError)
    expect(() => createPendingEgg(DEFAULT_ITEMS, [], () => sample)).toThrow(RangeError)
    expect(() => openEgg(pending(), () => sample)).toThrow(RangeError)
  })

  it('uses crypto.getRandomValues by default', () => {
    const rng = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementationOnce(array => {
      const words = array as Uint32Array
      words[0] = 0xffffffff
      return array
    })
    expect(pickTier()).toBe('ultra')
    expect(rng).toHaveBeenCalledOnce()
  })

  it('keeps the five penalty identities and prepares every tier', () => {
    expect(DEFAULT_ITEMS.map(entry => entry.id)).toEqual(['penalty-1', 'penalty-2', 'penalty-3', 'penalty-4', 'penalty-5'])
    expect(DEFAULT_ITEMS.map(entry => entry.label)).toEqual(['청소 20분', '설거지 전담', '친구에게 커피 사기', '배달 대신 직접 요리', '미뤄둔 일 30분'])
    expect(DEFAULT_ITEMS.map(entry => entry.tier)).toEqual(['high', 'high', 'medium', 'low', 'ultra'])
    expect(Object.values(probabilities(DEFAULT_ITEMS))).toEqual([30, 30, 35, 4.9, 0.1])
  })

  it('filters blank, disabled, excluded entries and trims snapshots without mutating inputs', () => {
    const items = [item('valid', 'high', '  청소  '), item('blank', 'high', ' '),
      { ...item('disabled'), enabled: false }, item('excluded')]
    expect(getEligibleItems(items, ['excluded'])).toEqual([item('valid', 'high', '청소')])
    expect(items[0].label).toBe('  청소  ')
  })

  it('never renormalizes fixed tier odds when any tier is unavailable', () => {
    expect(getMissingTiers(DEFAULT_ITEMS, ['penalty-5'])).toEqual(['ultra'])
    expect(Object.values(probabilities(DEFAULT_ITEMS, ['penalty-5']))).toEqual([0, 0, 0, 0, 0])
    expect(getMissingTiers([])).toEqual(['high', 'medium', 'low', 'ultra'])
    expect(getMissingTiers(DEFAULT_ITEMS.filter(entry => entry.tier !== 'medium'))).toEqual(['medium'])
    expect(probabilities(DEFAULT_ITEMS, ['penalty-1'])).toEqual({
      'penalty-1': 0, 'penalty-2': 60, 'penalty-3': 35, 'penalty-4': 4.9, 'penalty-5': 0.1,
    })
  })

  it('handles arbitrary item IDs without prototype collisions', () => {
    const items = DEFAULT_ITEMS.map((entry, index) => ({ ...entry, id: index === 0 ? '__proto__' : entry.id }))
    expect(probabilities(items)['__proto__']).toBe(30)
    expect(Object.hasOwn(probabilities(items), '__proto__')).toBe(true)
  })
})

describe('two-step egg draws', () => {
  it('stores only the selected tier as independent snapshots until opened', () => {
    const items = saved().items
    const rng = vi.fn(() => 0)
    const egg = createPendingEgg(items, [], rng)!
    expect(egg.tier).toBe('high')
    expect(egg.candidates.map(entry => entry.id)).toEqual(['penalty-1', 'penalty-2'])
    expect(rng).toHaveBeenCalledOnce()
    expect(egg).not.toHaveProperty('itemId')
    expect(egg.createdAt).toBeGreaterThan(0)
    items[0].label = '변경한 항목'
    expect(openEgg(egg, () => 0)?.label).toBe('청소 20분')
  })

  it('cannot create an egg with a missing tier and does not consume randomness', () => {
    const rng = vi.fn(() => 0)
    expect(createPendingEgg(DEFAULT_ITEMS, ['penalty-5'], rng)).toBeNull()
    expect(createPendingEgg([], [], rng)).toBeNull()
    expect(rng).not.toHaveBeenCalled()
  })

  it('selects uniformly within the egg and records the opening time and original overall odds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const egg = pending()
    expect(openEgg(egg, () => 0)).toEqual({
      id: egg.id, itemId: 'first', label: 'first', tier: 'high', color: TIERS[0].color,
      probability: 30, drawnAt: 1_800_000_000_000,
    })
    expect(openEgg(egg, () => 0.5 - Number.EPSILON)?.itemId).toBe('first')
    expect(openEgg(egg, () => 0.5)?.itemId).toBe('second')
    expect(openEgg(egg, () => 1 - Number.EPSILON)?.itemId).toBe('second')
    const five = { ...egg, candidates: Array.from({ length: 5 }, (_, i) => item(String(i))) }
    const counts = [0, 0, 0, 0, 0]
    for (let sample = 0; sample < 100; sample += 1) counts[Number(openEgg(five, () => (sample + 0.5) / 100)?.itemId)] += 1
    expect(counts).toEqual([20, 20, 20, 20, 20])
  })

  it('returns null for malformed eggs instead of silently changing their candidate pool', () => {
    const invalid = [null, {}, { ...pending(), tier: 'unknown' }, { ...pending(), candidates: [] },
      { ...pending(), createdAt: -1 }, { ...pending(), candidates: [item('wrong', 'medium')] },
      { ...pending(), candidates: [item('duplicate'), item('duplicate')] },
      { ...pending(), candidates: [item('blank', 'high', ' ')] },
      { ...pending(), candidates: [{ ...item('disabled'), enabled: false }] },
      { ...pending(), candidates: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item(String(i))) }]
    for (const egg of invalid) expect(openEgg(egg as PendingEgg, () => 0)).toBeNull()
  })
})

describe('saved state and pending restoration', () => {
  it.each([null, '', '{', 'null', '[]', '42', '{}', '{"items":{}}'])(
    'rejects malformed settings: %s', raw => expect(parseSavedState(raw)).toBeNull(),
  )

  it('round-trips current state and a pending egg without drawing or recording a result', () => {
    const state = { ...saved(), pending: pending(), history: [result('older')], excludeWinners: true, soundEnabled: true }
    expect(restore(state)).toEqual(state)
    expect(restore(state)?.history).toHaveLength(1)
    expect(openEgg(restore(state)!.pending as PendingEgg, () => 0.5)?.itemId).toBe('second')
  })

  it('keeps pending snapshots after their source choices change or are removed', () => {
    const state = { ...saved([]), pending: pending('ultra') }
    expect(restore(state)?.pending).toEqual(state.pending)
    expect(openEgg(restore(state)!.pending as PendingEgg, () => 0)?.probability).toBe(0.05)
  })

  it('does not restore an egg already represented in history', () => {
    const state = { ...saved(), pending: pending(), history: [result('egg-1')] }
    expect(restore(state)?.pending).toBeNull()
    expect(restore(state)?.history).toEqual(state.history)
  })

  it('discards invalid pending data while preserving valid editable state and history', () => {
    for (const bad of [{}, { ...pending(), candidates: [item('x', 'low')] }, { ...pending(), createdAt: Number.MAX_SAFE_INTEGER }]) {
      const state = { ...saved(), history: [result('old')], pending: bad }
      const restored = restore(state)!
      expect(restored.pending).toBeNull()
      expect(restored.items).toEqual(DEFAULT_ITEMS)
      expect(restored.history).toEqual(state.history)
    }
  })

  it('preserves empty lists and unfinished blank inputs', () => {
    expect(restore({ items: [] })).toEqual(saved([]))
    const state = saved([item('blank', 'low', ''), item('spaces', 'high', '  ')])
    expect(restore(state)?.items).toEqual(state.items)
    expect(getEligibleItems(restore(state)!.items)).toEqual([])
  })

  it('bounds lists and labels, deduplicates IDs, and sanitizes unknown fields', () => {
    const restored = restore({ items: [null, { id: '', label: 'invalid' }, item('a'), item('a'),
      { ...item('b'), label: '가'.repeat(MAX_LABEL_LENGTH + 10), color: 'url(invalid)', unexpected: true },
      ...Array.from({ length: MAX_ITEMS }, (_, i) => item(`extra-${i}`))],
    history: [{ ...result('invalid'), drawnAt: -1 }, ...Array.from({ length: MAX_HISTORY + 1 }, (_, i) => result(`draw-${i}`))],
    excludedIds: ['a', 'a', 'unknown'], excludeWinners: 'true', soundEnabled: 1 })!
    expect(restored.items).toHaveLength(MAX_ITEMS)
    expect(restored.items[1].label).toHaveLength(MAX_LABEL_LENGTH)
    expect(restored.items[1].color).toBe(TIERS[0].color)
    expect(restored.items[1]).not.toHaveProperty('unexpected')
    expect(restored.history).toHaveLength(MAX_HISTORY)
    expect(restored.history[0].id).toBe('draw-0')
    expect(restored.excludedIds).toEqual(['a'])
    expect(restored.excludeWinners).toBe(false)
    expect(restored.soundEnabled).toBe(false)
  })

  it('retains legacy history without a tier and preserves valid new history tiers', () => {
    const entries = [result('old'), { ...result('new'), tier: 'ultra' }]
    expect(restore({ items: [], history: entries })?.history).toEqual(entries)
  })
})

describe('five preassigned cards', () => {
  function mixedSpread(): PendingSpread {
    const samples = [0, 0, 0.6, 0, 0.95, 0, 0.999, 0, 0, 0.75]
    return createPendingSpread(DEFAULT_ITEMS, [], () => samples.shift()!)!
  }

  it('assigns every position before selection using a separate tier and item sample', () => {
    const samples = [0, 0, 0.6, 0, 0.95, 0, 0.999, 0, 0, 0.75]
    const rng = vi.fn(() => samples.shift()!)
    const spread = createPendingSpread(DEFAULT_ITEMS, [], rng)!
    expect(rng).toHaveBeenCalledTimes(10)
    expect(spread.kind).toBe('cards')
    expect(spread.cards.map(card => card.itemId)).toEqual(['penalty-1', 'penalty-3', 'penalty-4', 'penalty-5', 'penalty-2'])
    expect(spread.cards.map(card => card.tier)).toEqual(['high', 'medium', 'low', 'ultra', 'high'])
    expect(spread.cards.map(card => card.probability)).toEqual([30, 35, 4.9, 0.1, 30])
  })

  it('preserves the fixed 6000/3500/490/10 distribution at every card position', () => {
    const counts = Array.from({ length: 5 }, () => ({ high: 0, medium: 0, low: 0, ultra: 0 }))
    for (let slot = 0; slot < 10_000; slot += 1) {
      let call = 0
      const spread = createPendingSpread(DEFAULT_ITEMS, [], () => call++ % 2 === 0 ? (slot + 0.5) / 10_000 : 0.5)!
      spread.cards.forEach((card, index) => { counts[index][card.tier] += 1 })
    }
    for (const count of counts) expect(count).toEqual({ high: 6000, medium: 3500, low: 490, ultra: 10 })
  })

  it('samples with replacement while preserving round-start exclusions', () => {
    const spread = createPendingSpread(DEFAULT_ITEMS, ['penalty-1'], () => 0)!
    expect(spread.cards).toHaveLength(5)
    expect(spread.cards.every(card => card.itemId === 'penalty-2' && card.probability === 60)).toBe(true)
    expect(spread.cards[0]).not.toBe(spread.cards[1])
  })

  it('rejects missing tiers, duplicate eligible IDs and oversized pools before consuming randomness', () => {
    const rng = vi.fn(() => 0)
    expect(createPendingSpread(DEFAULT_ITEMS, ['penalty-5'], rng)).toBeNull()
    expect(createPendingSpread([...DEFAULT_ITEMS, { ...DEFAULT_ITEMS[0] }], [], rng)).toBeNull()
    const many = [...DEFAULT_ITEMS, ...Array.from({ length: 26 }, (_, index) => item(`extra-${index}`))]
    expect(createPendingSpread(many, [], rng)).toBeNull()
    expect(rng).not.toHaveBeenCalled()
  })

  it('rejects invalid tier and item samples without producing a partly assigned deck', () => {
    expect(() => createPendingSpread(DEFAULT_ITEMS, [], () => Number.NaN)).toThrow(RangeError)
    let call = 0
    expect(() => createPendingSpread(DEFAULT_ITEMS, [], () => call++ === 0 ? 0 : 1)).toThrow(RangeError)
  })

  it('chooses the saved position without drawing any new randomness and restores its result exactly', () => {
    const spread = mixedSpread()
    const original = structuredClone(spread)
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const rng = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('Selection must not draw again')
    })
    const selected = chooseSpread(spread, 3)!
    expect(selected.result).toEqual({ id: spread.id, ...spread.cards[3], drawnAt: 1_800_000_000_000 })
    expect(selected.revealed).toEqual({ id: spread.id, cards: spread.cards, drawnAt: 1_800_000_000_000, selectedIndex: 3 })
    expect(resultFromSpread(selected.revealed)).toEqual(selected.result)
    expect(rng).not.toHaveBeenCalled()
    expect(spread).toEqual(original)
    selected.revealed.cards[0].label = '독립 복사'
    expect(spread.cards[0].label).toBe(original.cards[0].label)
  })

  it.each([-1, 5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid selected index %s', index => {
    expect(chooseSpread(mixedSpread(), index)).toBeNull()
  })

  it('round-trips all five pending cards and never regenerates their contents on preparation', () => {
    const spread = mixedSpread()
    const state = { ...saved(), pending: spread }
    const restored = restore(state)!
    expect(restored).toEqual(state)
    const rng = vi.fn(() => 0.999)
    const prepared = preparePendingSpread(restored.pending, rng)!
    expect(prepared).toEqual(spread)
    expect(prepared).not.toBe(restored.pending)
    expect(prepared.cards).not.toBe(spread.cards)
    expect(rng).not.toHaveBeenCalled()
  })

  it('restores the complete revealed spread only alongside its one selected history entry', () => {
    const selected = chooseSpread(mixedSpread(), 4)!
    const state = { ...saved([]), revealed: selected.revealed, history: [selected.result, result('older')] }
    expect(restore(state)).toEqual(state)
    expect(resultFromSpread(restore(state)!.revealed!)).toEqual(selected.result)
    expect(restore({ ...state, history: [] })?.revealed).toBeNull()
    expect(restore({ ...saved(), revealed: null })).toEqual({ ...saved(), revealed: null })
  })

  it.each<Partial<DrawResult>>([
    { id: 'different-round' }, { itemId: 'other-item' }, { label: '다른 내용' },
    { color: '#123456' }, { tier: 'medium' }, { probability: 31 }, { drawnAt: 1 },
  ])('rejects a revealed spread whose selected history entry differs: %o', change => {
    const selected = chooseSpread(mixedSpread(), 0)!
    const history = [{ ...selected.result, ...change }]
    const restored = restore({ ...saved(), revealed: selected.revealed, history })!
    expect(restored.revealed).toBeNull()
    expect(restored.history).toEqual(history)
  })

  it('rejects malformed pending cards without dropping other personal data', () => {
    const spread = mixedSpread()
    const badCards = [
      { ...spread.cards[0], itemId: '' }, { ...spread.cards[0], label: ' ' },
      { ...spread.cards[0], label: '가'.repeat(61) }, { ...spread.cards[0], color: 'url(invalid)' },
      { ...spread.cards[0], tier: 'unknown' }, { ...spread.cards[0], probability: 0 },
      { ...spread.cards[0], probability: 101 }, { ...spread.cards[0], probability: Number.NaN },
    ]
    const malformed = [
      { ...spread, id: '' }, { ...spread, createdAt: -1 }, { ...spread, cards: spread.cards.slice(0, 4) },
      { ...spread, cards: [...spread.cards, spread.cards[0]] },
      ...badCards.map(card => ({ ...spread, cards: [card, ...spread.cards.slice(1)] })),
    ]
    for (const pending of malformed) {
      const restored = restore({ ...saved(), pending, history: [result('older')] })!
      expect(restored.pending).toBeNull()
      expect(restored.history).toEqual([result('older')])
      expect(preparePendingSpread(pending as PendingSpread)).toBeNull()
      expect(chooseSpread(pending as PendingSpread, 0)).toBeNull()
    }
  })

  it('drops corrupted revealed metadata while retaining the valid chosen history', () => {
    const selected = chooseSpread(mixedSpread(), 2)!
    for (const revealed of [
      { ...selected.revealed, selectedIndex: 5 }, { ...selected.revealed, selectedIndex: 0.5 },
      { ...selected.revealed, cards: selected.revealed.cards.slice(0, 4) },
      { ...selected.revealed, drawnAt: -1 },
    ]) {
      const restored = restore({ ...saved(), revealed, history: [selected.result] })!
      expect(restored.revealed).toBeNull()
      expect(restored.history).toEqual([selected.result])
    }
  })

  it('prefers an unfinished spread over a previous revealed round and rejects an already completed pending ID', () => {
    const old = chooseSpread(mixedSpread(), 1)!
    const next = mixedSpread()
    const state = { ...saved(), pending: next, revealed: old.revealed, history: [old.result] }
    expect(restore(state)?.pending).toEqual(next)
    expect(restore(state)?.revealed).toBeNull()
    const completed = { ...next, id: old.result.id }
    expect(restore({ ...state, pending: completed })?.pending).toBeNull()
    expect(restore({ ...state, pending: completed })?.revealed).toEqual(old.revealed)
  })

  it('migrates a legacy egg using its original tier, candidates, round ID and creation time', () => {
    const egg = pending('ultra')
    const samples = [0, 0.5, 0.99, 0.49, 0]
    const rng = vi.fn(() => samples.shift()!)
    const spread = preparePendingSpread(egg, rng)!
    expect(rng).toHaveBeenCalledTimes(5)
    expect(spread.id).toBe(egg.id)
    expect(spread.createdAt).toBe(egg.createdAt)
    expect(spread.cards.map(card => card.itemId)).toEqual(['first', 'second', 'second', 'first', 'first'])
    expect(spread.cards.every(card => card.tier === 'ultra' && card.probability === 0.05)).toBe(true)
    expect(preparePendingSpread(null)).toBeNull()
  })
})

describe('legacy migrations under the same storage key', () => {
  it('keeps the storage key and replaces only the unused exact lunch starter list', () => {
    expect(STORAGE_KEY).toBe('bbob-studio-v1')
    expect(restore({ items: legacyLunch(), soundEnabled: true })?.items).toEqual(DEFAULT_ITEMS)
    expect(restore({ items: legacyLunch(), soundEnabled: true })?.soundEnabled).toBe(true)
  })

  it('classifies the unchanged penalty preset without losing history, exclusions, or preferences', () => {
    const state = { items: legacyPenalties(), history: [result('old')], excludedIds: ['penalty-1'], excludeWinners: true, soundEnabled: true }
    expect(restore(state)).toEqual({ ...state, items: DEFAULT_ITEMS, pending: null })
  })

  it.each(['label', 'weight', 'color', 'id', 'order', 'history', 'exclusions'])(
    'preserves customized or used lunch data: %s', change => {
      const items = legacyLunch()
      const history: DrawResult[] = []
      const excludedIds: string[] = []
      if (change === 'label') items[0].label = '내가 정한 벌칙'
      if (change === 'weight') items[0].weight = 31
      if (change === 'color') items[0].color = '#123456'
      if (change === 'id') items[0].id = 'my-choice'
      if (change === 'order') items.reverse()
      if (change === 'history') history.push(result('old'))
      if (change === 'exclusions') excludedIds.push(items[0].id)
      const restored = restore({ items, history, excludedIds })!
      expect(restored.items.map(entry => entry.label)).toEqual(items.map(entry => entry.label))
      expect(restored.items.map(entry => entry.id)).toEqual(items.map(entry => entry.id))
      expect(restored.items.every(entry => entry.tier === 'high')).toBe(true)
      expect(restored.history).toEqual(history)
      expect(restored.excludedIds).toEqual(excludedIds)
    },
  )

  it('keeps custom text and colors and does not reactivate old zero weights', () => {
    const state = { items: [
      { id: 'a', label: '내 벌칙', weight: 70, color: '#123456' },
      { id: 'b', label: '꺼둔 벌칙', weight: 0, color: '#abcdef' },
      { id: 'c', label: '', weight: 20, color: '#123456' },
    ], history: [result('old')], excludedIds: ['a'] }
    const restored = restore(state)!
    expect(restored.items[0]).toEqual({ id: 'a', label: '내 벌칙', tier: 'high', color: '#123456' })
    expect(restored.items[1]).toEqual({ id: 'b', label: '꺼둔 벌칙', tier: 'high', color: '#abcdef', enabled: false })
    expect(restored.items[2].label).toBe('')
    expect(getEligibleItems(restored.items, restored.excludedIds)).toEqual([])
    expect(restored.history).toEqual(state.history)
    expect(restore(restored)).toEqual(restored)
  })
})
