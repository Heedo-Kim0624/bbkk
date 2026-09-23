import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ITEMS,
  MAX_HISTORY,
  MAX_ITEMS,
  MAX_LABEL_LENGTH,
  PALETTE,
  getEligibleItems,
  parseSavedState,
  pickWeighted,
  probabilities,
  type DrawItem,
  type DrawResult,
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

  it('ships five lunch options whose default weights total 100', () => {
    expect(DEFAULT_ITEMS).toHaveLength(5)
    expect(DEFAULT_ITEMS.map(({ weight }) => weight)).toEqual([30, 25, 20, 15, 10])
    expect(new Set(DEFAULT_ITEMS.map(({ id }) => id)).size).toBe(5)
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
