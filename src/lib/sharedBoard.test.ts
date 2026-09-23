import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedBoardClient, mergeBoardItems, SharedBoardController, type SharedBoard, type SharedBoardClient } from './sharedBoard'
import type { DrawItem } from './draw'

const item = (id: string, label = id): DrawItem => ({ id, label, tier: 'high', color: '#edf1f4' })
const board = (items: DrawItem[], revision = 1): SharedBoard => ({ items, revision, updated_at: '2026-09-23T00:00:00Z' })
const flush = async () => { await vi.advanceTimersByTimeAsync(0) }

afterEach(() => vi.useRealTimers())

describe('three-way shared list merge', () => {
  it('preserves edits to different items', () => {
    expect(mergeBoardItems([item('a'), item('b')], [item('a', 'mine'), item('b')], [item('a'), item('b', 'remote')])).toEqual({ ok: true, items: [item('a', 'mine'), item('b', 'remote')] })
  })
  it('merges independent fields on one item', () => {
    expect(mergeBoardItems([item('a')], [item('a', 'mine')], [{ ...item('a'), enabled: false }])).toEqual({ ok: true, items: [{ ...item('a', 'mine'), enabled: false }] })
  })
  it('keeps concurrent additions', () => {
    const merged = mergeBoardItems([item('a')], [item('a'), item('b')], [item('a'), item('c')])
    expect(merged.ok && merged.items.map(entry => entry.id)).toEqual(['a', 'c', 'b'])
  })
  it('accepts deleting an unchanged item and identical simultaneous edits', () => {
    expect(mergeBoardItems([item('a'), item('b')], [item('a', 'new')], [item('a', 'new'), item('b')])).toEqual({ ok: true, items: [item('a', 'new')] })
  })
  it('does not conflict on absent versus true enabled', () => {
    expect(mergeBoardItems([item('a')], [{ ...item('a'), enabled: true }], [item('a', 'new')]).ok).toBe(true)
  })
  it('rejects differing changes to the same field', () => {
    expect(mergeBoardItems([item('a')], [item('a', 'mine')], [item('a', 'remote')]).ok).toBe(false)
  })
  it.each([true, false])('rejects deletion against modification in either direction (%s)', mineDeletes => {
    expect(mergeBoardItems([item('a')], mineDeletes ? [] : [item('a', 'changed')], mineDeletes ? [item('a', 'changed')] : []).ok).toBe(false)
  })
  it('rejects conflicting additions with the same ID', () => {
    expect(mergeBoardItems([], [item('a', 'mine')], [item('a', 'remote')]).ok).toBe(false)
  })
  it('does not silently drop additions exceeding the shared maximum', () => {
    const initial = Array.from({ length: 29 }, (_, index) => item(String(index)))
    expect(mergeBoardItems(initial, [...initial, item('mine')], [...initial, item('remote')]).ok).toBe(false)
  })
  it('explicit resolution prefers only conflicting local fields while keeping unrelated remote edits and additions', () => {
    expect(mergeBoardItems(
      [item('a'), item('b')],
      [item('a', 'mine'), item('b')],
      [{ ...item('a', 'theirs'), enabled: false }, item('b', 'remote edit'), item('new')],
      { preferLocalConflicts: true },
    )).toEqual({ ok: true, items: [{ ...item('a', 'mine'), enabled: false }, item('b', 'remote edit'), item('new')] })
  })
  it.each([true, false])('explicit deletion/modification resolution prefers the local change (%s)', mineDeletes => {
    const merged = mergeBoardItems([item('a')], mineDeletes ? [] : [item('a', 'local edit')], mineDeletes ? [item('a', 'remote edit')] : [], { preferLocalConflicts: true })
    expect(merged).toEqual({ ok: true, items: mineDeletes ? [] : [item('a', 'local edit')] })
  })
})

describe('public RPC client', () => {
  it('sends publishable key without an Authorization header', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(board([item('a', '')])), { status: 200 }))
    const client = createSharedBoardClient({ url: 'https://example.test/rest/v1', publishableKey: 'sb_publishable_public', fetcher })
    await expect(client.getBoard(new AbortController().signal)).resolves.toMatchObject({ revision: 1 })
    expect(fetcher.mock.calls[0][0]).toBe('https://example.test/rest/v1/rpc/bbob_get_board')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { apikey: 'sb_publishable_public', 'Content-Type': 'application/json' }, body: '{}' })
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('rejects malformed remote data and HTTP failures without returning defaults', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [], revision: -1, updated_at: '' }))).mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    const client = createSharedBoardClient({ url: 'https://example.test/rest/v1', publishableKey: 'public', fetcher })
    await expect(client.getBoard(new AbortController().signal)).rejects.toThrow()
    await expect(client.getBoard(new AbortController().signal)).rejects.toThrow()
  })
})

function setup(initial = board([item('a'), item('b')])) {
  vi.useFakeTimers()
  const client: SharedBoardClient = { getBoard: vi.fn().mockResolvedValue(initial), saveBoard: vi.fn() }
  const controller = new SharedBoardController(client)
  controller.start()
  return { client, controller }
}

describe('shared board synchronization', () => {
  it('does not report unsaved work for a clean load or a failed clean polling read', async () => {
    const { client, controller } = setup()
    expect(controller.getSnapshot().hasUnsavedChanges).toBe(false)
    await flush()
    expect(controller.getSnapshot().hasUnsavedChanges).toBe(false)
    vi.mocked(client.getBoard).mockRejectedValueOnce(new Error('offline read'))
    controller.refresh()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ status: 'offline', ready: true, hasUnsavedChanges: false })
    controller.stop()
  })
  it('reports dirty saving/offline drafts and clears unsaved status after acknowledgement', async () => {
    const { client, controller } = setup()
    await flush()
    controller.setItems([item('a', 'draft'), item('b')])
    expect(controller.getSnapshot()).toMatchObject({ status: 'saving', hasUnsavedChanges: true })
    controller.setItems([item('a'), item('b')])
    expect(controller.getSnapshot()).toMatchObject({ status: 'synced', hasUnsavedChanges: false })
    vi.mocked(client.saveBoard).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'ok', board: board([item('a', 'draft'), item('b')], 2) })
    controller.setItems([item('a', 'draft'), item('b')])
    await vi.advanceTimersByTimeAsync(550)
    expect(controller.getSnapshot()).toMatchObject({ status: 'offline', hasUnsavedChanges: true })
    controller.retry()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ status: 'synced', hasUnsavedChanges: false })
    controller.stop()
  })
  it('keeps unsaved protection when a draft is reverted while a write acknowledgement is ambiguous', async () => {
    const { client, controller } = setup()
    await flush()
    vi.mocked(client.saveBoard).mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ status: 'ok', board: board([item('a', 'sent'), item('b')], 2) })
      .mockResolvedValueOnce({ status: 'ok', board: board([item('a'), item('b')], 3) })
    controller.setItems([item('a', 'sent'), item('b')])
    await vi.advanceTimersByTimeAsync(550)
    controller.setItems([item('a'), item('b')])
    expect(controller.getSnapshot()).toMatchObject({ status: 'offline', hasUnsavedChanges: true })
    controller.retry()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ status: 'saving', hasUnsavedChanges: true })
    await vi.advanceTimersByTimeAsync(550)
    expect(controller.getSnapshot()).toMatchObject({ status: 'synced', hasUnsavedChanges: false })
    expect(controller.getItems()).toEqual([item('a'), item('b')])
    controller.stop()
  })
  it('starts empty and is ready only after a successful load', async () => {
    const { controller } = setup()
    expect(controller.getSnapshot()).toMatchObject({ items: [], ready: false, status: 'loading' })
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ ready: true, status: 'synced' })
    controller.stop()
  })
  it('keeps failed initial loading offline without pretending to have data', async () => {
    vi.useFakeTimers()
    const controller = new SharedBoardController({ getBoard: vi.fn().mockRejectedValue(new Error('network')), saveBoard: vi.fn() })
    controller.start()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ items: [], ready: false, status: 'offline' })
    controller.stop()
  })
  it('debounces edits and preserves a newer local edit while saving', async () => {
    const { client, controller } = setup()
    await flush()
    let finish!: (value: { status: 'ok'; board: SharedBoard }) => void
    vi.mocked(client.saveBoard).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ status: 'ok', board: board([item('a', 'newest'), item('b')], 3) })
    controller.setItems([item('a', 'sent'), item('b')])
    await vi.advanceTimersByTimeAsync(549)
    expect(client.saveBoard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    controller.setItems([item('a', 'newest'), item('b')])
    finish({ status: 'ok', board: board([item('a', 'sent'), item('b')], 2) })
    await flush()
    expect(controller.getItems()[0].label).toBe('newest')
    await vi.advanceTimersByTimeAsync(550)
    expect(controller.getSnapshot().status).toBe('synced')
    expect(client.saveBoard).toHaveBeenCalledTimes(2)
    controller.stop()
  })
  it('automatically merges nonconflicting CAS changes and retries against the new revision', async () => {
    const { client, controller } = setup()
    await flush()
    vi.mocked(client.saveBoard).mockResolvedValueOnce({ status: 'conflict', board: board([item('a'), item('b', 'remote')], 2) }).mockResolvedValueOnce({ status: 'ok', board: board([item('a', 'mine'), item('b', 'remote')], 3) })
    controller.setItems([item('a', 'mine'), item('b')])
    await vi.advanceTimersByTimeAsync(1100)
    expect(vi.mocked(client.saveBoard).mock.calls[1][0]).toMatchObject({ p_expected_revision: 2 })
    expect(controller.getItems().map(entry => entry.label)).toEqual(['mine', 'remote'])
    expect(controller.getSnapshot().status).toBe('synced')
    controller.stop()
  })
  it('preserves conflicting drafts; explicit retry conflicts again if the remote changed', async () => {
    const { client, controller } = setup()
    await flush()
    vi.mocked(client.saveBoard).mockResolvedValueOnce({ status: 'conflict', board: board([item('a', 'remote'), item('b')], 2) }).mockResolvedValueOnce({ status: 'conflict', board: board([item('a', 'new remote'), item('b')], 3) })
    controller.setItems([item('a', 'mine'), item('b')])
    await vi.advanceTimersByTimeAsync(550)
    expect(controller.getSnapshot().status).toBe('conflict')
    expect(controller.getItems()[0].label).toBe('mine')
    controller.retry()
    await flush()
    expect(controller.getSnapshot().status).toBe('conflict')
    expect(vi.mocked(client.saveBoard).mock.calls[1][0]).toMatchObject({ p_expected_revision: 2 })
    expect(controller.getItems()[0].label).toBe('mine')
    controller.stop()
  })
  it('reuses the original request ID and payload after an ambiguous network failure', async () => {
    const { client, controller } = setup()
    await flush()
    vi.mocked(client.saveBoard).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ status: 'ok', board: board([item('a', 'sent'), item('b')], 2) })
    controller.setItems([item('a', 'sent'), item('b')])
    await vi.advanceTimersByTimeAsync(550)
    expect(controller.getSnapshot().status).toBe('offline')
    controller.setItems([item('a', 'newer draft'), item('b')])
    controller.retry()
    await flush()
    const calls = vi.mocked(client.saveBoard).mock.calls
    expect(calls[1][0]).toEqual(calls[0][0])
    expect(controller.getItems()[0].label).toBe('newer draft')
    expect(controller.getSnapshot().error).toBeNull()
    controller.stop()
  })
  it('explicit conflict retry applies the actual local delta without deleting remote additions or edits', async () => {
    const { client, controller } = setup()
    await flush()
    const remote = board([{ ...item('a', 'theirs'), enabled: false }, item('b', 'remote edit'), item('new')], 2)
    const resolved = [{ ...item('a', 'mine'), enabled: false }, item('b', 'remote edit'), item('new')]
    vi.mocked(client.saveBoard).mockResolvedValueOnce({ status: 'conflict', board: remote }).mockResolvedValueOnce({ status: 'ok', board: board(resolved, 3) })
    controller.setItems([item('a', 'mine'), item('b')])
    await vi.advanceTimersByTimeAsync(550)
    controller.retry()
    await flush()
    expect(vi.mocked(client.saveBoard).mock.calls[1][0].p_items).toEqual(resolved)
    expect(controller.getItems()).toEqual(resolved)
    expect(controller.getSnapshot().status).toBe('synced')
    controller.stop()
  })
  it('keeps both sides safe when explicit conflict resolution would exceed the item limit', async () => {
    const initial = Array.from({ length: 29 }, (_, index) => item(String(index)))
    const { client, controller } = setup(board(initial))
    await flush()
    vi.mocked(client.saveBoard).mockResolvedValueOnce({ status: 'conflict', board: board([...initial, item('remote addition')], 2) })
    controller.setItems([...initial, item('mine addition')])
    await vi.advanceTimersByTimeAsync(550)
    controller.retry()
    await flush()
    expect(client.saveBoard).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', error: '합치면 30개를 넘어요. 항목을 줄이거나 최신 목록을 불러오세요.' })
    expect(controller.getItems()).toEqual([...initial, item('mine addition')])
    // Removing one original item permits a later explicit merge without losing the remote addition.
    controller.setItems(previous => previous.filter(entry => entry.id !== '0'))
    vi.mocked(client.saveBoard).mockImplementationOnce(async request => ({ status: 'ok', board: board(request.p_items, 3) }))
    controller.retry()
    await flush()
    expect(controller.getItems().map(entry => entry.id)).toContain('remote addition')
    expect(controller.getItems().map(entry => entry.id)).toContain('mine addition')
    expect(controller.getItems()).toHaveLength(30)
    expect(controller.getSnapshot().status).toBe('synced')
    controller.stop()
  })
  it('reload explicitly discards the local draft and loads the newest remote', async () => {
    const { client, controller } = setup()
    await flush()
    controller.setItems([item('a', 'draft'), item('b')])
    vi.mocked(client.getBoard).mockResolvedValue(board([item('a', 'remote')], 4))
    controller.reload()
    await flush()
    expect(controller.getItems()).toEqual([item('a', 'remote')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.saveBoard).not.toHaveBeenCalled()
    controller.stop()
  })
  it('aborts in-flight work and ignores late callbacks after stop', async () => {
    vi.useFakeTimers()
    let finish!: (value: SharedBoard) => void
    const client: SharedBoardClient = { getBoard: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve })), saveBoard: vi.fn() }
    const controller = new SharedBoardController(client)
    controller.start()
    const signal = vi.mocked(client.getBoard).mock.calls[0][0]
    controller.stop()
    expect(signal.aborted).toBe(true)
    finish(board([item('a')]))
    await flush()
    expect(controller.getSnapshot().ready).toBe(false)
  })
})
