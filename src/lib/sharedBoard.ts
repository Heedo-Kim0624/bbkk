import { MAX_ITEMS, MAX_LABEL_LENGTH, TIERS, type DrawItem } from './draw'

export type SharedBoard = { items: DrawItem[]; revision: number; updated_at: string }
export type SaveBoardRequest = { p_expected_revision: number; p_items: DrawItem[]; p_request_id: string }
export type SaveBoardResponse = { status: 'ok' | 'conflict'; board: SharedBoard }
export type SharedBoardStatus = 'loading' | 'synced' | 'saving' | 'offline' | 'conflict'
export type SharedBoardSnapshot = { items: DrawItem[]; status: SharedBoardStatus; ready: boolean; error: string | null; hasUnsavedChanges: boolean }
export type SharedBoardClient = {
  getBoard(signal: AbortSignal): Promise<SharedBoard>
  saveBoard(request: SaveBoardRequest, signal: AbortSignal): Promise<SaveBoardResponse>
}

const cloneItems = (items: DrawItem[]) => items.map(item => ({ ...item }))
const fields = ['label', 'tier', 'color', 'enabled'] as const
const fieldValue = (item: DrawItem, field: typeof fields[number]) => field === 'enabled' ? item.enabled !== false : item[field]
const sameItem = (left: DrawItem, right: DrawItem) => left.id === right.id && fields.every(field => fieldValue(left, field) === fieldValue(right, field))
const sameItems = (left: DrawItem[], right: DrawItem[]) => left.length === right.length && left.every((item, index) => sameItem(item, right[index]))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function validatedItems(value: unknown): DrawItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const ids = new Set<string>()
  const items: DrawItem[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 128 || ids.has(item.id)
      || typeof item.label !== 'string' || item.label.length > MAX_LABEL_LENGTH
      || !TIERS.some(tier => tier.id === item.tier)
      || typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)
      || (item.enabled !== undefined && typeof item.enabled !== 'boolean')) return null
    ids.add(item.id)
    items.push({ id: item.id, label: item.label, tier: item.tier as DrawItem['tier'], color: item.color, ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}) })
  }
  return items
}

function validatedBoard(value: unknown): SharedBoard {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error('공유 목록을 확인할 수 없어요.')
  }
  const items = validatedItems(value.items)
  if (!items) throw new Error('공유 목록을 확인할 수 없어요.')
  return { items, revision: value.revision as number, updated_at: value.updated_at }
}

/** Merge identity, deletion and each editable field without overwriting unrelated edits. */
export function mergeBoardItems(
  base: DrawItem[], mine: DrawItem[], remote: DrawItem[],
  { preferLocalConflicts = false }: { preferLocalConflicts?: boolean } = {},
): { ok: true; items: DrawItem[] } | { ok: false; reason: 'fields' | 'capacity' } {
  const baseMap = new Map(base.map(item => [item.id, item]))
  const mineMap = new Map(mine.map(item => [item.id, item]))
  const remoteMap = new Map(remote.map(item => [item.id, item]))
  const ids = new Set([...remote.map(item => item.id), ...mine.map(item => item.id), ...base.map(item => item.id)])
  const merged: DrawItem[] = []
  for (const id of ids) {
    const original = baseMap.get(id)
    const local = mineMap.get(id)
    const current = remoteMap.get(id)
    if (!original) {
      if (local && current && !sameItem(local, current) && !preferLocalConflicts) return { ok: false, reason: 'fields' }
      const addition = local ?? current
      if (addition) merged.push({ ...addition })
      continue
    }
    if (!local || !current) {
      const survivor = local ?? current
      if (survivor && !sameItem(original, survivor)) {
        if (!preferLocalConflicts) return { ok: false, reason: 'fields' }
        // Explicit local deletion wins; an explicitly modified local item survives remote deletion.
        if (local) merged.push({ ...local })
      }
      continue
    }
    const result = { ...current }
    for (const field of fields) {
      const before = fieldValue(original, field)
      const localValue = fieldValue(local, field)
      const remoteValue = fieldValue(current, field)
      if (localValue !== before && remoteValue !== before && localValue !== remoteValue && !preferLocalConflicts) return { ok: false, reason: 'fields' }
      if (localValue !== before) Object.assign(result, { [field]: local[field] })
    }
    merged.push(result)
  }
  return merged.length <= MAX_ITEMS ? { ok: true, items: merged } : { ok: false, reason: 'capacity' }
}

export function createSharedBoardClient({ url, publishableKey, fetcher = fetch }: { url: string; publishableKey: string; fetcher?: typeof fetch }): SharedBoardClient {
  async function rpc(name: string, body: object, signal: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(cancel, 12_000)
    try {
      const response = await fetcher(`${url.replace(/\/$/, '')}/rpc/${name}`, {
        method: 'POST', signal: controller.signal,
        headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('공유 목록에 연결할 수 없어요.')
      return await response.json()
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
    }
  }
  return {
    async getBoard(signal) { return validatedBoard(await rpc('bbob_get_board', {}, signal)) },
    async saveBoard(request, signal) {
      const response = await rpc('bbob_save_board', request, signal)
      if (!isRecord(response) || (response.status !== 'ok' && response.status !== 'conflict')) throw new Error('저장 결과를 확인할 수 없어요.')
      return { status: response.status, board: validatedBoard(response.board) }
    },
  }
}

type SaveAttempt = { base: SharedBoard; request: SaveBoardRequest; force: boolean }

/** External store keeps async operations serialized and makes all draft transitions testable. */
export class SharedBoardController {
  private snapshot: SharedBoardSnapshot = { items: [], status: 'loading', ready: false, error: null, hasUnsavedChanges: false }
  private confirmed: SharedBoard | null = null
  private conflictRemote: SharedBoard | null = null
  private conflictBase: DrawItem[] | null = null
  private attempt: SaveAttempt | null = null
  private listeners = new Set<() => void>()
  private active = false
  private busy = false
  private generation = 0
  private abort: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private mergeRetries = 0
  private client: SharedBoardClient

  constructor(client: SharedBoardClient) { this.client = client }

  getSnapshot = () => this.snapshot
  getItems = () => cloneItems(this.snapshot.items)
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private dirty() { return this.confirmed !== null && !sameItems(this.snapshot.items, this.confirmed.items) }

  private emit(status: SharedBoardStatus, error: string | null = null, items = this.snapshot.items) {
    const ready = this.confirmed !== null
    const hasUnsavedChanges = (this.confirmed !== null && !sameItems(items, this.confirmed.items))
      || (this.attempt !== null && !sameItems(this.attempt.request.p_items, this.attempt.base.items))
    if (status === this.snapshot.status && error === this.snapshot.error && ready === this.snapshot.ready
      && hasUnsavedChanges === this.snapshot.hasUnsavedChanges && sameItems(items, this.snapshot.items)) return
    this.snapshot = { items: cloneItems(items), status, ready, error, hasUnsavedChanges }
    this.listeners.forEach(listener => listener())
  }

  private cancelWork() {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.busy = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  start = () => { if (!this.active) { this.active = true; this.refresh() } }
  stop = () => { this.active = false; this.cancelWork() }

  setItems = (next: DrawItem[] | ((old: DrawItem[]) => DrawItem[])) => {
    if (!this.confirmed) return
    const items = validatedItems(typeof next === 'function' ? next(this.getItems()) : next)
    if (!items) { this.emit('conflict', '항목은 최대 30개, 이름은 60자까지예요.'); return }
    if (sameItems(items, this.snapshot.items)) return
    if (this.snapshot.status === 'conflict' || this.snapshot.status === 'offline') {
      this.emit(this.snapshot.status, this.snapshot.error, items)
      return
    }
    this.emit('saving', null, items)
    this.schedule()
  }

  refresh = () => {
    if (!this.active || this.busy || this.snapshot.status === 'conflict') return
    if (this.attempt || this.dirty()) {
      // Keep the 550 ms typing debounce, except when recovering from an offline request.
      if (this.timer !== null && this.snapshot.status !== 'offline') return
      void this.save()
    } else {
      if (this.snapshot.status === 'offline') this.emit('loading')
      void this.read()
    }
  }

  reload = () => {
    this.cancelWork()
    this.attempt = null
    this.conflictRemote = null
    this.conflictBase = null
    this.mergeRetries = 0
    this.emit('loading', null, this.confirmed?.items ?? [])
    if (this.active) void this.read()
  }

  retry = () => {
    if (!this.active || this.busy) return
    if (this.conflictRemote) {
      // Apply only this draft's delta against the common base, retaining unrelated remote work.
      const resolved = mergeBoardItems(this.conflictBase ?? this.confirmed!.items, this.snapshot.items, this.conflictRemote.items, { preferLocalConflicts: true })
      if (!resolved.ok) {
        this.emit('conflict', '합치면 30개를 넘어요. 항목을 줄이거나 최신 목록을 불러오세요.')
        return
      }
      this.confirmed = this.conflictRemote
      this.conflictRemote = null
      this.conflictBase = null
      this.mergeRetries = 0
      this.emit('saving', null, resolved.items)
      this.attempt = this.makeAttempt(true)
      void this.save()
    } else if (this.attempt || this.dirty()) {
      this.emit('saving')
      void this.save()
    } else {
      this.emit('loading')
      void this.read()
    }
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.active || this.snapshot.status === 'conflict' || this.snapshot.status === 'offline') return
    if (!this.dirty() && !this.attempt) { this.emit('synced'); return }
    this.timer = setTimeout(() => { this.timer = null; void this.save() }, 550)
  }

  private makeAttempt(force: boolean): SaveAttempt {
    const base = this.confirmed!
    return { base, force, request: { p_expected_revision: base.revision, p_items: this.getItems(), p_request_id: crypto.randomUUID() } }
  }

  private conflict(remote: SharedBoard, base: DrawItem[], reason: 'fields' | 'capacity' = 'fields') {
    this.conflictRemote = remote
    this.conflictBase = cloneItems(base)
    this.emit('conflict', reason === 'capacity' ? '합치면 30개를 넘어요. 항목을 줄이거나 최신 목록을 불러오세요.' : '다른 곳에서 같은 항목을 수정했어요.')
  }

  private async read() {
    if (!this.active || this.busy) return
    this.busy = true
    const generation = this.generation
    const controller = new AbortController()
    this.abort = controller
    try {
      const remote = await this.client.getBoard(controller.signal)
      if (!this.active || generation !== this.generation) return
      if (this.confirmed && remote.revision < this.confirmed.revision) return
      const merged = this.confirmed ? mergeBoardItems(this.confirmed.items, this.snapshot.items, remote.items) : { ok: true as const, items: remote.items }
      if (!merged.ok) { this.conflict(remote, this.confirmed!.items, merged.reason); return }
      this.confirmed = remote
      this.emit(sameItems(merged.items, remote.items) ? 'synced' : 'saving', null, merged.items)
    } catch {
      if (this.active && generation === this.generation) this.emit('offline', '공유 목록에 연결할 수 없어요.')
    } finally {
      if (generation === this.generation) {
        this.busy = false
        this.abort = null
        if (this.snapshot.status === 'saving') this.schedule()
      }
    }
  }

  private async save() {
    if (!this.active || this.busy || !this.confirmed || this.snapshot.status === 'conflict') return
    if (!this.attempt && !this.dirty()) { this.emit('synced'); return }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.attempt ??= this.makeAttempt(false)
    const attempt = this.attempt
    this.busy = true
    const generation = this.generation
    const controller = new AbortController()
    this.abort = controller
    this.emit('saving')
    try {
      const response = await this.client.saveBoard(attempt.request, controller.signal)
      if (!this.active || generation !== this.generation) return
      this.attempt = null
      const baseItems = response.status === 'ok' ? attempt.request.p_items : attempt.base.items
      const merged = mergeBoardItems(baseItems, this.snapshot.items, response.board.items)
      if (!merged.ok || (response.status === 'conflict' && (attempt.force || ++this.mergeRetries > 4))) {
        this.conflict(response.board, baseItems, !merged.ok ? merged.reason : 'fields')
        return
      }
      this.confirmed = response.board
      if (response.status === 'ok') this.mergeRetries = 0
      this.emit(sameItems(merged.items, response.board.items) ? 'synced' : 'saving', null, merged.items)
    } catch {
      // The server may have committed even if its response was lost. Keep this exact request.
      if (this.active && generation === this.generation) this.emit('offline', '저장을 확인하지 못했어요. 다시 시도해 주세요.')
    } finally {
      if (generation === this.generation) {
        this.busy = false
        this.abort = null
        if (this.snapshot.status === 'saving') this.schedule()
      }
    }
  }
}
