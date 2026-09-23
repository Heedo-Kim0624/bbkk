import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ITEMS,
  MAX_HISTORY,
  MAX_ITEMS,
  MAX_LABEL_LENGTH,
  PALETTE,
  getEligibleItems,
  migrateRunningDefaults,
  parseSavedState,
  pickWeighted,
  probabilities,
  type DrawItem,
  type DrawResult,
  type SavedState,
} from './draw'

const item = (id: string, weight = 1, label = id): DrawItem => ({
  id,
  label,
  weight,
  color: PALETTE[0],
})

const result = (id: string): DrawResult => ({
  id,
  itemId: 'removed-item',
  label: '지난 선택',
  color: PALETTE[1],
  probability: 25,
  drawnAt: 1_700_000_000_000,
})

describe('weighted selection', () => {
  it('excludes blank, zero, negative, non-finite, and already drawn items', () => {
    const source = [
      item('valid', 20, '  김치찌개  '),
      item('blank', 10, '  '),
      item('zero', 0),
      item('negative', -1),
      item('nan', Number.NaN),
      item('infinity', Number.POSITIVE_INFINITY),
      item('excluded', 100),
    ]

    expect(getEligibleItems(source, ['excluded'])).toEqual([
      item('valid', 20, '김치찌개'),
    ])
    expect(source[0].label).toBe('  김치찌개  ')
  })

  it('normalizes relative weights and reports disabled entries as zero', () => {
    expect(probabilities([item('a', 3), item('b', 1), item('c', 0)])).toEqual({
      a: 75,
      b: 25,
      c: 0,
    })
    expect(probabilities([item('a', 3), item('b', 1)], ['a'])).toEqual({
      a: 0,
      b: 100,
    })
    expect(probabilities([item('a', 0)])).toEqual({ a: 0 })
  })

  it('uses half-open cumulative ranges at exact boundaries', () => {
    const items = [item('a', 30), item('b', 25), item('c', 20), item('d', 15), item('e', 10)]
    expect(pickWeighted(items, [], () => 0)?.id).toBe('a')
    expect(pickWeighted(items, [], () => 0.299999)?.id).toBe('a')
    expect(pickWeighted(items, [], () => 0.3)?.id).toBe('b')
    expect(pickWeighted(items, [], () => 0.55)?.id).toBe('c')
    expect(pickWeighted(items, [], () => 0.75)?.id).toBe('d')
    expect(pickWeighted(items, [], () => 0.9)?.id).toBe('e')
    expect(pickWeighted(items, [], () => 1 - Number.EPSILON)?.id).toBe('e')
  })

  it('renormalizes after exclusion and returns null for an exhausted list', () => {
    const items = [item('a', 3), item('b', 1)]
    expect(pickWeighted(items, ['a'], () => 0)?.id).toBe('b')
    expect(pickWeighted(items, ['a', 'b'], () => 0)).toBeNull()
    expect(pickWeighted([], [], () => 0)).toBeNull()
    expect(pickWeighted([item('zero', 0)], [], () => 0)).toBeNull()
  })

  it('rejects random sources outside the unit interval', () => {
    for (const invalid of [-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pickWeighted([item('a')], [], () => invalid)).toThrow(RangeError)
    }
  })

  it('uses the browser cryptographic random source by default', () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementationOnce((array) => {
        const words = array as Uint32Array
        words[0] = 0xffffffff
        return array
      })
    try {
      expect(pickWeighted([item('a'), item('b')])?.id).toBe('b')
      expect(getRandomValues).toHaveBeenCalledOnce()
    } finally {
      getRandomValues.mockRestore()
    }
  })

  it('handles arbitrary item IDs without prototype collisions', () => {
    const odds = probabilities([item('__proto__'), item('constructor')])
    expect(odds['__proto__']).toBe(50)
    expect(odds['constructor']).toBe(50)
    expect(Object.prototype.hasOwnProperty.call(odds, '__proto__')).toBe(true)
  })

  it('ships five running commitment penalties with equal default probabilities', () => {
    expect(DEFAULT_ITEMS).toHaveLength(5)
    expect(DEFAULT_ITEMS.map(({ label }) => label)).toEqual([
      '청소 20분',
      '설거지 전담',
      '친구에게 커피 사기',
      '배달 대신 직접 요리',
      '미뤄둔 일 30분',
    ])
    expect(Object.values(probabilities(DEFAULT_ITEMS))).toEqual([20, 20, 20, 20, 20])
    expect(new Set(DEFAULT_ITEMS.map(({ id }) => id)).size).toBe(5)
  })
})

function legacyState(): SavedState {
  return {
    items: [
      { id: 'lunch-1', label: '김치찌개', weight: 30, color: '#96dac6' },
      { id: 'lunch-2', label: '파스타', weight: 25, color: '#f2b99e' },
      { id: 'lunch-3', label: '초밥', weight: 20, color: '#bfb4ed' },
      { id: 'lunch-4', label: '쌀국수', weight: 15, color: '#a5c9ed' },
      { id: 'lunch-5', label: '샌드위치', weight: 10, color: '#e8d798' },
    ],
    history: [],
    excludeWinners: false,
    excludedIds: [],
    soundEnabled: false,
  }
}

describe('running defaults migration', () => {
  it('replaces only an untouched legacy seed and preserves all other settings', () => {
    const state = { ...legacyState(), excludeWinners: true, soundEnabled: true }
    const restored = parseSavedState(JSON.stringify(state))
    expect(restored).not.toBeNull()
    const migrated = migrateRunningDefaults(restored!)

    expect(migrated).toEqual({ ...state, items: DEFAULT_ITEMS })
    expect(migrated.items).not.toBe(DEFAULT_ITEMS)
    expect(migrated.items[0]).not.toBe(DEFAULT_ITEMS[0])
    expect(restored?.items).toEqual(state.items)
    expect(migrateRunningDefaults(migrated)).toBe(migrated)
  })

  it.each<Partial<DrawItem>>([
    { id: 'my-first-choice' },
    { label: '내가 정한 벌칙' },
    { weight: 31 },
    { color: '#123456' },
  ])('preserves a customized item field: %o', (change) => {
    const state = legacyState()
    state.items[0] = { ...state.items[0], ...change }
    expect(migrateRunningDefaults(state)).toBe(state)
  })

  it('preserves rearranged legacy choices', () => {
    const state = legacyState()
    state.items.reverse()
    expect(migrateRunningDefaults(state)).toBe(state)
  })

  it('preserves an existing draw history', () => {
    const state = legacyState()
    state.history = [{ ...result('legacy-draw'), itemId: 'lunch-1', label: '김치찌개' }]
    expect(migrateRunningDefaults(state)).toBe(state)
  })

  it('preserves existing winner exclusions even without a history', () => {
    const state = legacyState()
    state.excludeWinners = true
    state.excludedIds = ['lunch-1']
    expect(migrateRunningDefaults(state)).toBe(state)
  })

  it('preserves intentionally empty and custom lists', () => {
    for (const items of [[], [item('custom-choice', 20, '내가 정한 벌칙')]]) {
      const state = { ...legacyState(), items }
      expect(migrateRunningDefaults(state)).toBe(state)
    }
  })

  it('preserves lists with added or removed choices', () => {
    const smaller = legacyState()
    smaller.items.pop()
    const larger = legacyState()
    larger.items.push(item('custom-choice', 20, '추가한 벌칙'))
    expect(migrateRunningDefaults(smaller)).toBe(smaller)
    expect(migrateRunningDefaults(larger)).toBe(larger)
  })
})

describe('saved settings', () => {
  it.each([null, '', '{', 'null', '[]', '42', '{}', '{"items":{}}'])(
    'returns null for malformed or unsupported settings: %s',
    (raw) => {
      expect(parseSavedState(raw)).toBeNull()
    },
  )

  it('round-trips settings while preserving historic results for removed items', () => {
    const state = {
      items: [item('a'), item('b', 0)],
      history: [result('draw-1')],
      excludedIds: ['a'],
      excludeWinners: true,
      soundEnabled: true,
    }
    expect(parseSavedState(JSON.stringify(state))).toEqual(state)
  })

  it('keeps intentionally empty lists and defaults missing optional settings', () => {
    expect(parseSavedState('{"items":[]}')).toEqual({
      items: [],
      history: [],
      excludedIds: [],
      excludeWinners: false,
      soundEnabled: false,
    })
  })

  it('clamps and rounds saved weights to whole numbers in the 0..100 range', () => {
    const restored = parseSavedState(JSON.stringify({
      items: [item('a', -8), item('b', 150), item('c', 23.8), item('d', 0.2)],
    }))
    expect(restored?.items.map(({ weight }) => weight)).toEqual([0, 100, 24, 0])
  })

  it('discards invalid items and duplicate IDs, trims labels, and sanitizes colors', () => {
    const restored = parseSavedState(JSON.stringify({
      items: [
        null,
        item('blank', 2, '   '),
        { ...item('string-weight'), weight: '10' },
        { ...item('bad-number'), weight: null },
        { ...item(''), color: '#aabbcc' },
        { ...item('a', 4, '  우동  '), color: 'url(https://invalid.test)' },
        item('a', 90, 'duplicate'),
        item('b', 2, '가'.repeat(MAX_LABEL_LENGTH + 20)),
      ],
      excludeWinners: 'true',
      soundEnabled: 1,
      excludedIds: ['a', 'a', 'unknown', null],
    }))
    expect(restored?.items).toHaveLength(2)
    expect(restored?.items[0]).toMatchObject({ id: 'a', label: '우동', weight: 4 })
    expect(restored?.items[0].color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(restored?.items[1].label).toHaveLength(MAX_LABEL_LENGTH)
    expect(restored?.excludedIds).toEqual(['a'])
    expect(restored?.excludeWinners).toBe(false)
    expect(restored?.soundEnabled).toBe(false)
  })

  it('bounds list sizes and rejects invalid history records', () => {
    const restored = parseSavedState(JSON.stringify({
      items: Array.from({ length: MAX_ITEMS + 10 }, (_, i) => item(`item-${i}`)),
      history: [
        { ...result('invalid-probability'), probability: 101 },
        { ...result('invalid-time'), drawnAt: -1 },
        { ...result('out-of-range-date'), drawnAt: Number.MAX_SAFE_INTEGER },
        { ...result('invalid-label'), label: '' },
        { ...result('invalid-id'), itemId: null },
        ...Array.from({ length: MAX_HISTORY + 10 }, (_, i) => result(`draw-${i}`)),
      ],
    }))
    expect(restored?.items).toHaveLength(MAX_ITEMS)
    expect(restored?.history).toHaveLength(MAX_HISTORY)
    expect(restored?.history[0].id).toBe('draw-0')
    expect(restored?.history.at(-1)?.id).toBe(`draw-${MAX_HISTORY - 1}`)
  })

  it('ignores unexpected keys and safely handles non-array optional fields', () => {
    const restored = parseSavedState(JSON.stringify({
      items: [item('a')],
      history: {},
      excludedIds: 'a',
      unexpected: 'ignored',
    }))
    expect(restored?.history).toEqual([])
    expect(restored?.excludedIds).toEqual([])
    expect(restored).not.toHaveProperty('unexpected')
  })
})
