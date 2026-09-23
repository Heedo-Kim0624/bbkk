import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_ITEMS, type SavedState } from '../../src/lib/draw'

const tierTabs = ['상 60%', '중 35%', '하 4.9%', '극하 0.1%'] as const
const tierLabels = ['상', '중', '하', '극하'] as const
const tierIds = ['high', 'medium', 'low', 'ultra'] as const

test.beforeEach(async ({ page }) => {
  let board = { items: structuredClone(DEFAULT_ITEMS), revision: 1, updated_at: new Date().toISOString() }
  const responses = new Map<string, typeof board>()
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
  await page.route('**/rest/v1/rpc/bbob_*', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (route.request().url().endsWith('/bbob_get_board')) return route.fulfill({ json: board, headers })
    const params = route.request().postDataJSON()
    const replay = responses.get(params.p_request_id)
    if (replay) return route.fulfill({ json: { status: 'ok', board: replay }, headers })
    if (params.p_expected_revision !== board.revision) return route.fulfill({ json: { status: 'conflict', board }, headers })
    board = { items: params.p_items, revision: board.revision + 1, updated_at: new Date().toISOString() }
    responses.set(params.p_request_id, structuredClone(board))
    return route.fulfill({ json: { status: 'ok', board }, headers })
  })
})

async function waitForShared(page: Page) {
  await expect(page.locator('.save-status')).toContainText('공유됨')
}

async function personalState(page: Page): Promise<SavedState> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('bbob-studio-v1')!))
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '벌칙', exact: true })).toBeVisible()
  await expect(page.locator('#page-title')).toHaveText('러닝 약속')
  await expect(page.getByText('이틀 연속 쉬면, 벌칙 하나.', { exact: true })).toBeVisible()
  for (const name of tierTabs) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible()
  await waitForShared(page)
}

async function fixedRandom(page: Page, samples: number[]) {
  await page.addInitScript(values => {
    let index = 0
    const original = crypto.getRandomValues.bind(crypto)
    Object.defineProperty(crypto, 'getRandomValues', {
      value(array: Uint32Array) {
        if (array instanceof Uint32Array && array.length === 1) {
          array[0] = Math.floor(values[Math.min(index++, values.length - 1)] * 0x100000000)
          return array
        }
        return original(array)
      },
    })
    // Native randomUUID stays untouched so record IDs remain unique.
  }, samples)
}

async function selectTier(page: Page, index: number) {
  await page.getByRole('tab', { name: tierTabs[index], exact: true }).click()
  await expect(page.getByRole('tab', { name: tierTabs[index], exact: true })).toHaveAttribute('aria-selected', 'true')
}

async function startEmpty(page: Page) {
  await page.getByRole('button', { name: '초기화', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('모두의 목록이 바뀝니다.')
  await page.getByRole('dialog').getByRole('button', { name: '비우기', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(0)
}

async function addItems(page: Page, labels: string[]) {
  await page.getByRole('button', { name: '여러 항목 한 번에 추가' }).click()
  await page.getByLabel('추가할 항목').fill(labels.join('\n'))
  await page.getByRole('button', { name: '추가하기', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
}

async function seedAllTiers(page: Page, firstTierLabels = ['상 벌칙']) {
  await startEmpty(page)
  for (let index = 0; index < tierTabs.length; index++) {
    await selectTier(page, index)
    await addItems(page, index === 0 ? firstTierLabels : [tierLabels[index] + ' 벌칙'])
  }
  await selectTier(page, 0)
  await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeEnabled()
}

async function drawAndOpen(page: Page) {
  await page.locator('.draw-action button').click()
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  const card = page.getByRole('button', { name: '3번 카드 선택', exact: true })
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.locator('.result-card h3')).toBeVisible()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeEnabled()
}

async function itemLabels(page: Page) {
  return page.getByRole('textbox', { name: /항목 \d+ 이름/ }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))
}

test('fixed tier tabs and responsive studio render without overflow or browser errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openStudio(page)
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(page.locator('.glass-globe, .prize-egg')).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: 'outputs/browser/desktop-1440.png', fullPage: true, animations: 'disabled' })
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 })
    await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeVisible()
    const sizes = await page.evaluate(() => ({ inner: innerWidth, document: document.documentElement.scrollWidth }))
    expect(sizes.document, 'horizontal overflow at ' + width + 'px').toBeLessThanOrEqual(sizes.inner)
    if (width === 390) {
      // Offscreen backdrop-filter layers need a paint before full-page capture.
      await page.locator('.editor-panel').scrollIntoViewIfNeeded()
      await page.screenshot({ path: 'outputs/browser/mobile-editor-scrolled.png', animations: 'disabled' })
      await page.screenshot({ path: 'outputs/browser/mobile-390.png', fullPage: true, animations: 'disabled' })
    }
  }
  expect(errors).toEqual([])
})

test('text edits, tier moves, deletion undo and reload retain custom choices', async ({ page }) => {
  await openStudio(page)
  await seedAllTiers(page, ['첫 벌칙', '옮길 벌칙'])
  await page.getByRole('textbox', { name: '항목 2 이름', exact: true }).fill('수정한 벌칙')
  await page.getByRole('combobox', { name: '항목 2 등급', exact: true }).click()
  await page.getByRole('option', { name: '중', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(1)
  await selectTier(page, 1)
  await expect(page.locator('.item-row')).toHaveCount(2)
  const movedIndex = (await itemLabels(page)).indexOf('수정한 벌칙')
  expect(movedIndex).toBeGreaterThanOrEqual(0)
  await page.getByRole('button', { name: '항목 ' + (movedIndex + 1) + ' 삭제', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(1)
  await page.getByRole('button', { name: '되돌리기', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(2)
  await page.getByRole('button', { name: '항목 추가', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '항목 3 이름', exact: true })).toBeFocused()
  await page.getByRole('textbox', { name: '항목 3 이름', exact: true }).fill('추가한 벌칙')
  await waitForShared(page)
  await page.reload()
  await selectTier(page, 1)
  await expect(page.locator('.item-row')).toHaveCount(3)
  expect(await itemLabels(page)).toEqual(expect.arrayContaining(['중 벌칙', '수정한 벌칙', '추가한 벌칙']))
  for (const name of tierTabs) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible()
})

test('five pending cards lock editing, survive reload, and write history only after choosing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await seedAllTiers(page)
  await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeVisible()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await expect(page.locator('.result-card')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true })).toBeDisabled()
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 })
    await page.locator('.tarot-draw').scrollIntoViewIfNeeded()
    const panelBounds = await page.locator('.draw-panel').boundingBox()
    expect(panelBounds).not.toBeNull()
    for (const card of await page.locator('.tarot-choice').all()) {
      const bounds = await card.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x, 'card left inside panel at ' + width + 'px').toBeGreaterThanOrEqual(panelBounds!.x)
      expect(bounds!.x + bounds!.width, 'card right inside panel at ' + width + 'px').toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width)
    }
    const hitRegions = await page.locator('.tarot-choice').evaluateAll(cards => cards.map(card => {
      const bounds = card.getBoundingClientRect()
      for (let y = Math.max(12, bounds.top + 12); y < Math.min(innerHeight - 12, bounds.bottom - 12); y += 8) {
        for (let x = Math.max(12, bounds.left + 12); x < Math.min(innerWidth - 12, bounds.right - 12); x += 8) {
          const points = [[x, y], [x - 11, y - 11], [x + 11, y - 11], [x - 11, y + 11], [x + 11, y + 11]]
          if (points.every(([px, py]) => document.elementFromPoint(px, py)?.closest('.tarot-choice') === card)) return true
        }
      }
      return false
    }))
    expect(hitRegions, 'each card needs a visible 24px hit region at ' + width + 'px').toEqual([true, true, true, true, true])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: 'outputs/browser/tarot-spread-' + width + '.png', fullPage: true, animations: 'disabled' })
  }
  await page.screenshot({ path: 'outputs/browser/desktop-pending-cards.png', fullPage: true, animations: 'disabled' })
  await page.reload()
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeFocused()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '항목 1 등급', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '3번 카드 선택', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText('상 벌칙')
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeEnabled()
  await page.screenshot({ path: 'outputs/browser/desktop-result.png', fullPage: true, animations: 'disabled' })
  await page.reload()
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(0)
  await expect(page.locator('.result-card h3')).toHaveText('상 벌칙')
  await expect(page.locator('.other-card')).toHaveCount(4)
})

for (const [index, sample] of [0.2, 0.75, 0.975, 0.9995].entries()) {
  test(tierLabels[index] + ' tier is hidden behind card backs and colors the chosen front', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await fixedRandom(page, [sample])
    await openStudio(page)
    await seedAllTiers(page)
    await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
    const card = page.getByRole('button', { name: (index + 1) + '번 카드 선택', exact: true })
    await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
    await expect(card).toBeVisible()
    await expect(page.locator('.tarot-choice[data-tier]')).toHaveCount(0)
    await expect(page.locator('.history-list li')).toHaveCount(0)
    await card.click()
    await expect(page.locator('.result-card h3')).toHaveText(tierLabels[index] + ' 벌칙')
    await expect(page.locator('.result-card')).toHaveAttribute('data-tier', tierIds[index])
    await expect(page.locator('.history-list li')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeEnabled()
    await page.locator('.draw-panel').screenshot({ path: 'outputs/browser/tarot-tier-' + (index + 1) + '.png', animations: 'disabled' })
  })
}

test('each card preassigns a uniform candidate from its independently drawn tier', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, Array.from({ length: 5 }, () => [0.2, 0.9]).flat())
  await openStudio(page)
  await seedAllTiers(page, ['첫 번째 상 벌칙', '두 번째 상 벌칙'])
  await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeVisible()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.getByRole('button', { name: '3번 카드 선택', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText('두 번째 상 벌칙')
  await expect(page.locator('.result-probability')).toContainText('30%')
})

test('five fixed card contents reveal by position, preserve the other four after reload, and exclude only the chosen card', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2, 0, 0.2, 0.99, 0.75, 0.5, 0.975, 0.5, 0.9995, 0.5])
  await openStudio(page)
  await page.getByRole('switch', { name: '중복 제외', exact: true }).click()
  await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  const pending = (await personalState(page)).pending
  if (!pending || !('kind' in pending) || pending.kind !== 'cards') throw new Error('Expected a saved five-card deck')
  expect(pending.cards.map(card => card.itemId)).toEqual(DEFAULT_ITEMS.map(item => item.id))
  expect(pending.cards.map(card => card.tier)).toEqual(['high', 'high', 'medium', 'low', 'ultra'])
  expect(pending.cards.map(card => card.probability)).toEqual([30, 30, 35, 4.9, 0.1])
  await expect(page.locator('.other-cards, .result-card')).toHaveCount(0)
  await expect(page.locator('.history-list li')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  expect((await personalState(page)).pending).toEqual(pending)
  await page.getByRole('button', { name: '2번 카드 선택', exact: true }).click()
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-phase', 'revealed')
  await expect(page.locator('.result-card h3')).toHaveText(pending.cards[1].label)
  await expect(page.locator('.other-cards')).toHaveAttribute('aria-label', '나머지 카드')
  await expect(page.locator('.other-card')).toHaveCount(4)
  for (const index of [0, 2, 3, 4]) {
    const other = page.locator('.other-card[data-card-index="' + index + '"]')
    await expect(other.locator('h4')).toHaveText(pending.cards[index].label)
    await expect(other).toHaveAttribute('data-tier', pending.cards[index].tier)
  }
  await expect(page.locator('.other-cards button, .other-cards input')).toHaveCount(0)
  const selected = await personalState(page)
  expect(selected.pending).toBeNull()
  expect(selected.history).toHaveLength(1)
  expect(selected.history[0].itemId).toBe(pending.cards[1].itemId)
  expect(selected.excludedIds).toEqual([pending.cards[1].itemId])
  expect(selected.revealed?.cards).toEqual(pending.cards)
  expect(selected.revealed?.selectedIndex).toBe(1)
  expect(selected.revealed?.id).toBe(selected.history[0].id)
  await page.screenshot({ path: 'outputs/browser/remaining-cards-varied-desktop.png', fullPage: true, animations: 'disabled' })

  await page.reload()
  await waitForShared(page)
  expect((await personalState(page)).revealed).toEqual(selected.revealed)
  await expect(page.locator('.result-card h3')).toHaveText(pending.cards[1].label)
  await expect(page.locator('.other-card h4')).toHaveText([0, 2, 3, 4].map(index => pending.cards[index].label))
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await page.getByRole('button', { name: '다시 뽑기', exact: true }).click()
  await expect(page.locator('.other-cards, .result-card')).toHaveCount(0)
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(5)
  expect((await personalState(page)).revealed).toBeNull()
  await expect(page.locator('.history-list li')).toHaveCount(1)
})

test('missing or exhausted tier blocks drawing without changing fixed odds; restore includes every tier', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await startEmpty(page)
  await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeDisabled()
  for (let index = 0; index < tierTabs.length; index++) {
    await selectTier(page, index)
    await addItems(page, [tierLabels[index] + ' 벌칙'])
    if (index < tierTabs.length - 1) await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeEnabled()
  await selectTier(page, 0)
  await page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true }).uncheck()
  await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true }).check()
  await page.getByRole('textbox', { name: '항목 1 이름', exact: true }).fill('')
  await expect(page.getByRole('button', { name: '카드 뽑기', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '항목 1 이름', exact: true }).fill('상 벌칙')
  await page.getByRole('switch', { name: '중복 제외', exact: true }).click()
  await drawAndOpen(page)
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.draw-action button')).toBeDisabled()
  for (const name of tierTabs) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '전체 포함', exact: true }).click()
  await expect(page.locator('.draw-action button')).toBeEnabled()
  await drawAndOpen(page)
  await expect(page.locator('.history-list li')).toHaveCount(2)
  await page.getByRole('button', { name: '기록 비우기', exact: true }).click()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.getByRole('button', { name: '되돌리기', exact: true }).click()
  await expect(page.locator('.history-list li')).toHaveCount(2)
})

test('bulk input validates empty, overlong and excess entries; keyboard dialogs preserve history', async ({ page }) => {
  await openStudio(page)
  await startEmpty(page)
  await page.getByRole('button', { name: '여러 항목 한 번에 추가' }).click()
  await page.getByRole('button', { name: '추가하기', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('항목을 입력해 주세요.')
  await page.getByLabel('추가할 항목').fill('가'.repeat(61))
  await page.getByRole('button', { name: '추가하기', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('60자')
  await page.getByLabel('추가할 항목').fill(Array.from({ length: 31 }, (_, index) => '항목 ' + index).join('\n'))
  await page.getByRole('button', { name: '추가하기', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('30개')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('button', { name: '여러 항목 한 번에 추가' })).toBeFocused()
  await page.getByRole('button', { name: '이용 방법', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('storage denied still permits drawing and opening with a persistence warning', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError') } })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await expect(page.locator('.save-status')).toContainText('저장 불가')
  await drawAndOpen(page)
  await expect(page.locator('.history-list li')).toHaveCount(1)
})

test('Space ignores input controls and pending cards; mutations lock during shuffle', async ({ page }) => {
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await page.getByRole('textbox', { name: '항목 1 이름', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await waitForShared(page)
  await page.locator('h1').click()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: '섞는 중…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeDisabled()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeEnabled()
  await page.locator('h1').click()
  await page.keyboard.press('Space')
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.getByRole('button', { name: '3번 카드 선택', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-list li')).toHaveCount(1)
})

test('mobile tarot selection and a 60-character result remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await page.getByRole('button', { name: '이용 방법', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click()
  const label = '가나다라마바사아자차카타파하'.repeat(5).slice(0, 60)
  await seedAllTiers(page, [label])
  await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
  await expect(page.getByRole('button', { name: '3번 카드 선택', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '3번 카드 선택', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'outputs/browser/mobile-pending-cards.png', animations: 'disabled' })
  await page.getByRole('button', { name: '3번 카드 선택', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText(label)
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-phase', 'revealed')
  await page.locator('.result-card').scrollIntoViewIfNeeded()
  const resultBounds = await page.locator('.result-card').boundingBox()
  const actionBounds = await page.locator('.draw-action').boundingBox()
  expect(resultBounds).not.toBeNull()
  expect(actionBounds).not.toBeNull()
  expect(resultBounds!.y + resultBounds!.height).toBeLessThanOrEqual(actionBounds!.y)
  const sizes = await page.evaluate(() => ({ inner: innerWidth, document: document.documentElement.scrollWidth }))
  expect(sizes.document).toBeLessThanOrEqual(sizes.inner)
  await page.screenshot({ path: 'outputs/browser/mobile-result-390.png', animations: 'disabled' })
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 })
    await expect(page.locator('.other-card h4')).toHaveText([label, label, label, label])
    await page.locator('.other-cards').scrollIntoViewIfNeeded()
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }
      return { panel: box('.draw-panel'), result: box('.result-card'), others: box('.other-cards'), action: box('.draw-action'), scrollWidth: document.documentElement.scrollWidth }
    })
    expect(layout.scrollWidth).toBeLessThanOrEqual(width)
    expect(layout.others.left).toBeGreaterThanOrEqual(layout.panel.left)
    expect(layout.others.right).toBeLessThanOrEqual(layout.panel.right)
    expect(layout.others.top).toBeGreaterThanOrEqual(layout.result.bottom)
    expect(layout.others.bottom <= layout.action.top || layout.others.top >= layout.action.bottom).toBe(true)
    const boxes = await page.locator('.other-card').evaluateAll(cards => cards.map(card => {
      const rect = card.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: card.clientWidth, scrollWidth: card.scrollWidth }
    }))
    for (const [index, box] of boxes.entries()) {
      expect(box.scrollWidth).toBeLessThanOrEqual(box.width)
      for (const other of boxes.slice(index + 1)) {
        expect(box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom).toBe(true)
      }
    }
    await page.screenshot({ path: 'outputs/browser/remaining-cards-' + width + '.png', fullPage: true, animations: 'disabled' })
  }
})

test('normal-motion selection locks once and survives reload during the flip without another draw', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await page.getByRole('button', { name: '카드 뽑기', exact: true }).click()
  const fifth = page.getByRole('button', { name: '5번 카드 선택', exact: true })
  await expect(fifth).toBeEnabled()
  await fifth.click()
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-phase', 'revealing')
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-selected-index', '4')
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(0)
  await expect(page.locator('.draw-action button')).toBeDisabled()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled()
  await page.reload()
  await waitForShared(page)
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.tarot-choice:enabled')).toHaveCount(0)
  const restored = await personalState(page)
  expect(restored.pending).toBeNull()
  expect(restored.revealed?.selectedIndex).toBe(4)
  await expect(page.locator('.other-card')).toHaveCount(4)
  await expect(page.locator('.result-card h3')).toHaveText(restored.history[0].label)

  await page.getByRole('button', { name: '다시 뽑기', exact: true }).click()
  await expect(page.locator('.other-cards')).toHaveCount(0)
  await page.getByRole('button', { name: '1번 카드 선택', exact: true }).click()
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-phase', 'revealed')
  await expect(page.locator('.tarot-draw')).toHaveAttribute('data-selected-index', '0')
  await expect(page.locator('.history-list li')).toHaveCount(2)
  await expect(page.locator('.result-card h3')).toBeFocused()
  await expect(page.locator('.tarot-card-slot.is-selected')).toHaveCount(1)
  await expect(page.locator('.tarot-card-slot.is-dismissed')).toHaveCount(4)
  for (const card of await page.locator('.tarot-card-slot.is-dismissed').all()) await expect(card).toHaveCSS('opacity', '0')
  const front = await page.locator('.result-card').boundingBox()
  const action = await page.locator('.draw-action').boundingBox()
  expect(front).not.toBeNull()
  expect(action).not.toBeNull()
  expect(front!.y + front!.height).toBeLessThanOrEqual(action!.y)
  await page.screenshot({ path: 'outputs/browser/desktop-tarot-normal-motion.png', fullPage: true, animations: 'disabled' })
})

test('preset reset is explicit and reversible after custom choices and history survive reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  const presetLabels = await page.getByRole('textbox', { name: /항목 \d+ 이름/ }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))
  await seedAllTiers(page, ['내가 정한 벌칙'])
  await drawAndOpen(page)
  const beforeReset = (await personalState(page)).revealed
  expect(beforeReset?.cards).toHaveLength(5)
  await page.reload()
  await selectTier(page, 0)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toHaveValue('내가 정한 벌칙')
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await page.getByRole('button', { name: '초기화', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '기본 벌칙', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await selectTier(page, 0)
  await expect(page.locator('.item-row')).toHaveCount(presetLabels.length)
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await expect(page.locator('.result-card, .other-cards')).toHaveCount(0)
  for (const [index, label] of presetLabels.entries()) {
    await expect(page.getByRole('textbox', { name: '항목 ' + (index + 1) + ' 이름', exact: true })).toHaveValue(label)
  }
  await page.getByRole('button', { name: '되돌리기', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toHaveValue('내가 정한 벌칙')
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.result-card h3')).toHaveText('내가 정한 벌칙')
  await expect(page.locator('.other-card h4')).toHaveText(Array(4).fill('내가 정한 벌칙'))
  expect((await personalState(page)).revealed).toEqual(beforeReset)
  await waitForShared(page)
  await page.reload()
  await expect(page.locator('.result-card h3')).toHaveText('내가 정한 벌칙')
  await expect(page.locator('.other-card h4')).toHaveText(Array(4).fill('내가 정한 벌칙'))
  await expect(page.locator('.history-list li')).toHaveCount(1)
  expect((await personalState(page)).revealed).toEqual(beforeReset)
})
