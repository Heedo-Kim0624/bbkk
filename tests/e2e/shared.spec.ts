import { expect, test as base, type Page, type Route } from '@playwright/test'
import { DEFAULT_ITEMS, type DrawItem } from '../../src/lib/draw'

type Board = { items: DrawItem[]; revision: number; updated_at: string }

class SharedMock {
  board: Board = { items: structuredClone(DEFAULT_ITEMS), revision: 1, updated_at: new Date().toISOString() }
  offline = new Set<Page>()
  conflicts = 0
  holdWrites = false
  queued: { pageIndex: number; run: () => Promise<void> }[] = []
  private responses = new Map<string, Board>()
  private headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }

  async attach(page: Page, pageIndex: number) {
    await page.route('**/rest/v1/rpc/bbob_*', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: this.headers })
      if (this.offline.has(page)) return route.abort('internetdisconnected')
      if (route.request().url().endsWith('/bbob_get_board')) return route.fulfill({ json: this.board, headers: this.headers })
      if (this.holdWrites) {
        return new Promise<void>(resolve => this.queued.push({ pageIndex, run: async () => { await this.save(route); resolve() } }))
      }
      return this.save(route)
    })
  }

  private async save(route: Route) {
    const params = route.request().postDataJSON()
    const replay = this.responses.get(params.p_request_id)
    if (replay) return route.fulfill({ json: { status: 'ok', board: replay }, headers: this.headers })
    if (params.p_expected_revision !== this.board.revision) {
      this.conflicts++
      return route.fulfill({ json: { status: 'conflict', board: this.board }, headers: this.headers })
    }
    this.board = { items: structuredClone(params.p_items), revision: this.board.revision + 1, updated_at: new Date().toISOString() }
    this.responses.set(params.p_request_id, structuredClone(this.board))
    return route.fulfill({ json: { status: 'ok', board: this.board }, headers: this.headers })
  }

  async releaseWrites() {
    this.holdWrites = false
    const writes = this.queued.splice(0).sort((a, b) => a.pageIndex - b.pageIndex)
    for (const write of writes) await write.run()
  }
}

type Room = { a: Page; b: Page; store: SharedMock }
const test = base.extend<{ room: Room }>({
  room: async ({ browser, baseURL }, runFixture) => {
    const contexts = await Promise.all([browser.newContext({ reducedMotion: 'reduce' }), browser.newContext({ reducedMotion: 'reduce' })])
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
    const store = new SharedMock()
    await Promise.all([store.attach(a, 0), store.attach(b, 1)])
    await Promise.all([a.goto(baseURL!), b.goto(baseURL!)])
    await Promise.all([synced(a), synced(b)])
    try { await runFixture({ a, b, store }) } finally { await Promise.all(contexts.map(context => context.close())) }
  },
})

async function synced(page: Page) {
  await expect(page.locator('.save-status')).toContainText('공유됨', { timeout: 10_000 })
}

async function field(page: Page, index: number, value: string) {
  await page.getByRole('textbox', { name: '항목 ' + index + ' 이름', exact: true }).fill(value)
}

async function expectField(page: Page, index: number, value: string) {
  await expect(page.getByRole('textbox', { name: '항목 ' + index + ' 이름', exact: true })).toHaveValue(value, { timeout: 10_000 })
}

async function startConcurrentEdits(room: Room, aIndex: number, aLabel: string, bIndex: number, bLabel: string) {
  room.store.holdWrites = true
  await field(room.a, aIndex, aLabel)
  await field(room.b, bIndex, bLabel)
  await expect.poll(() => room.store.queued.length, { timeout: 10_000 }).toBe(2)
  await room.store.releaseWrites()
}

test('two isolated browsers share additions and edits across polling and reload', async ({ room }) => {
  const { a, b, store } = room
  await a.getByRole('button', { name: '항목 추가', exact: true }).click()
  await field(a, 3, '함께 정한 벌칙')
  await synced(a)
  await expectField(b, 3, '함께 정한 벌칙')
  await field(b, 3, '다른 브라우저에서 수정')
  await synced(b)
  await expectField(a, 3, '다른 브라우저에서 수정')
  await a.reload()
  await synced(a)
  await expectField(a, 3, '다른 브라우저에서 수정')
  expect(store.board.items).toHaveLength(6)
  expect(store.board.revision).toBeGreaterThan(1)
})

test('CAS conflict merges edits to different items without losing either change', async ({ room }) => {
  await startConcurrentEdits(room, 1, '첫 브라우저 수정', 2, '둘째 브라우저 수정')
  await Promise.all([synced(room.a), synced(room.b)])
  await expectField(room.a, 1, '첫 브라우저 수정')
  await expectField(room.a, 2, '둘째 브라우저 수정')
  await expectField(room.b, 1, '첫 브라우저 수정')
  await expectField(room.b, 2, '둘째 브라우저 수정')
  expect(room.store.conflicts).toBeGreaterThan(0)
})

test('same-field conflict requires choosing latest or explicitly applying the local edit', async ({ room }) => {
  await startConcurrentEdits(room, 1, '서버에 먼저 저장', 1, '아직 저장 안 된 수정')
  await expect(room.b.locator('.save-status')).toContainText('수정 충돌')
  await expect(room.b.locator('.draw-action button')).toBeDisabled()
  await room.b.getByRole('button', { name: '최신 목록', exact: true }).click()
  await synced(room.b)
  await expectField(room.b, 1, '서버에 먼저 저장')
  await startConcurrentEdits(room, 1, '서버의 두 번째 수정', 1, '명시적으로 적용할 수정')
  await expect(room.b.locator('.save-status')).toContainText('수정 충돌')
  await room.b.getByRole('button', { name: '내 수정 적용', exact: true }).click()
  await synced(room.b)
  await expectField(room.a, 1, '명시적으로 적용할 수정')
  await expectField(room.b, 1, '명시적으로 적용할 수정')
})

test('failed saves keep the local edit and recover on explicit reconnect', async ({ room }) => {
  room.store.offline.add(room.a)
  await field(room.a, 1, '연결 복구 후 저장할 수정')
  await expect(room.a.locator('.save-status')).toContainText('연결 끊김', { timeout: 10_000 })
  await expectField(room.a, 1, '연결 복구 후 저장할 수정')
  await expect(room.a.locator('.draw-action button')).toBeDisabled()
  await expectField(room.b, 1, '청소 20분')
  room.store.offline.delete(room.a)
  await room.a.getByRole('button', { name: '다시 연결', exact: true }).click()
  await synced(room.a)
  await expectField(room.b, 1, '연결 복구 후 저장할 수정')
})

test('pending candidates and history remain private while another browser edits the shared list', async ({ room }) => {
  const { a, b, store } = room
  await a.evaluate(() => {
    const original = crypto.getRandomValues.bind(crypto)
    Object.defineProperty(crypto, 'getRandomValues', { value(array: Uint32Array) {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = 0; return array }
      return original(array)
    } })
  })
  await a.getByRole('button', { name: '알 뽑기', exact: true }).click()
  await expect(a.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await expect(b.locator('.prize-egg')).toHaveCount(0)
  await expect(b.locator('.history-list li')).toHaveCount(0)
  await field(b, 1, '알을 뽑은 뒤 다른 사람이 바꿈')
  await synced(b)
  await expect.poll(() => store.board.items[0].label).toBe('알을 뽑은 뒤 다른 사람이 바꿈')
  store.offline.add(a)
  await a.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(a.locator('.save-status')).toContainText('연결 끊김', { timeout: 10_000 })
  await a.getByRole('button', { name: '상 알 열기', exact: true }).click()
  await expect(a.locator('.result-card h3')).toHaveText('청소 20분')
  await expect(a.locator('.history-list li')).toHaveCount(1)
  await expect(b.locator('.history-list li')).toHaveCount(0)
  await expect(a.locator('.draw-action button')).toBeDisabled()
  store.offline.delete(a)
  await a.getByRole('button', { name: '다시 연결', exact: true }).click()
  await synced(a)
  await a.reload()
  await synced(a)
  await expect(a.locator('.history-list li')).toHaveCount(1)
  await expect(b.locator('.history-list li')).toHaveCount(0)
  await expectField(a, 1, '알을 뽑은 뒤 다른 사람이 바꿈')
})

test('an existing device list is backed up and imported only after explicit choice', async ({ page, baseURL }) => {
  const store = new SharedMock()
  await store.attach(page, 0)
  await page.addInitScript(() => {
    localStorage.setItem('bbob-studio-v1', JSON.stringify({
      items: [{ id: 'device-private-item', label: '이 기기에만 있던 벌칙', tier: 'high', color: '#edf1f4' }],
      history: [{ id: 'device-history', itemId: 'device-private-item', label: '이 기기에만 있던 벌칙', color: '#edf1f4', probability: 100, drawnAt: Date.now(), tier: 'high' }],
      excludeWinners: false, excludedIds: [], soundEnabled: false, pending: null,
    }))
  })
  await page.goto(baseURL!)
  await synced(page)
  await expectField(page, 1, '청소 20분')
  expect(store.board.items).toHaveLength(5)
  expect(store.board.items.some(item => item.id === 'device-private-item')).toBe(false)
  await expect(page.locator('.history-list li')).toHaveCount(1)
  const backup = await page.evaluate(() => localStorage.getItem('bbob-before-sharing-v1'))
  expect(backup).toContain('이 기기에만 있던 벌칙')
  await page.getByRole('button', { name: '이용 방법', exact: true }).click()
  await page.getByRole('button', { name: '이 기기의 목록 가져오기', exact: true }).click()
  await synced(page)
  await expect.poll(() => store.board.items.length).toBe(6)
  const imported = store.board.items.find(item => item.label === '이 기기에만 있던 벌칙')
  expect(imported).toBeDefined()
  expect(imported?.id).not.toBe('device-private-item')
  expect(store.board.items.filter(item => item.label === '이 기기에만 있던 벌칙')).toHaveLength(1)
  await expect(page.locator('.history-list li')).toHaveCount(1)
})

test('reset undo preserves a newer remote addition and an unrelated remote edit', async ({ room }) => {
  const { a, b } = room
  await field(a, 1, '초기화 전의 내 수정')
  await synced(a)
  await b.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectField(b, 1, '초기화 전의 내 수정')
  await a.getByRole('button', { name: '초기화', exact: true }).click()
  await a.getByRole('dialog').getByRole('button', { name: '기본 벌칙', exact: true }).click()
  await synced(a)
  await b.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectField(b, 1, '청소 20분')
  await b.getByRole('button', { name: '항목 추가', exact: true }).click()
  await field(b, 3, '다른 사용자가 새로 추가')
  await field(b, 2, '다른 사용자가 수정')
  await synced(b)
  await a.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectField(a, 3, '다른 사용자가 새로 추가')
  await a.getByRole('button', { name: '되돌리기', exact: true }).click()
  await synced(a)
  await expectField(a, 1, '초기화 전의 내 수정')
  await expectField(a, 2, '다른 사용자가 수정')
  await expectField(a, 3, '다른 사용자가 새로 추가')
  await b.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectField(b, 1, '초기화 전의 내 수정')
  expect(room.store.board.items).toHaveLength(6)
})

test('leaving warns for an unsaved failed write but permits saved and clean-offline reloads', async ({ room }) => {
  const { a, store } = room
  store.offline.add(a)
  await a.getByRole('textbox', { name: '항목 1 이름', exact: true }).click()
  await field(a, 1, '아직 서버에 저장되지 않음')
  await expect(a.locator('.save-status')).toContainText('연결 끊김')
  const beforeUnload = a.waitForEvent('dialog')
  const blockedReload = a.reload({ timeout: 10_000 }).catch(() => null)
  const dialog = await beforeUnload
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await blockedReload
  await expectField(a, 1, '아직 서버에 저장되지 않음')
  store.offline.delete(a)
  await a.getByRole('button', { name: '다시 연결', exact: true }).click()
  await synced(a)
  let unexpectedDialogs = 0
  a.on('dialog', async nextDialog => { unexpectedDialogs++; await nextDialog.dismiss() })
  await a.reload({ timeout: 10_000 })
  await synced(a)
  expect(unexpectedDialogs).toBe(0)
  store.offline.add(a)
  await a.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(a.locator('.save-status')).toContainText('연결 끊김')
  await a.reload({ timeout: 10_000 })
  await expect(a.locator('#page-title')).toHaveText('러닝 약속')
  expect(unexpectedDialogs).toBe(0)
})
