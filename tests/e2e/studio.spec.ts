import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_ITEMS } from '../../src/lib/draw'

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
  await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeEnabled()
}

async function drawAndOpen(page: Page, tierLabel = '상') {
  await page.locator('.draw-action button').click()
  const egg = page.getByRole('button', { name: tierLabel + ' 알 열기', exact: true })
  await expect(egg).toBeVisible()
  await egg.click()
  await expect(page.locator('.result-card h3')).toBeVisible()
}

async function itemLabels(page: Page) {
  return page.getByRole('textbox', { name: /항목 \d+ 이름/ }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))
}

test('fixed tier tabs and responsive studio render without overflow or browser errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openStudio(page)
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: 'outputs/browser/desktop-1440.png', fullPage: true, animations: 'disabled' })
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 })
    await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeVisible()
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

test('an unopened egg locks editing, survives reload, and writes history only when opened', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await seedAllTiers(page)
  await page.getByRole('button', { name: '알 뽑기', exact: true }).click()
  await expect(page.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await expect(page.locator('.result-card')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true })).toBeDisabled()
  await page.screenshot({ path: 'outputs/browser/desktop-pending-egg.png', fullPage: true, animations: 'disabled' })
  await page.reload()
  await expect(page.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '항목 1 등급', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '상 알 열기', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText('상 벌칙')
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeEnabled()
  await page.screenshot({ path: 'outputs/browser/desktop-result.png', fullPage: true, animations: 'disabled' })
  await page.reload()
  await expect(page.locator('.history-list li')).toHaveCount(1)
  await expect(page.locator('.prize-egg')).toHaveCount(0)
})

for (const [index, sample] of [0.2, 0.75, 0.975, 0.9995].entries()) {
  test(tierLabels[index] + ' tier creates its matching egg and only selects items in that tier', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await fixedRandom(page, [sample])
    await openStudio(page)
    await seedAllTiers(page)
    await page.getByRole('button', { name: '알 뽑기', exact: true }).click()
    const egg = page.getByRole('button', { name: tierLabels[index] + ' 알 열기', exact: true })
    await expect(egg).toBeVisible()
    await expect(page.locator('.prize-egg')).toHaveAttribute('data-tier', tierIds[index])
    await expect(page.locator('.history-list li')).toHaveCount(0)
    await page.locator('.draw-panel').screenshot({ path: 'outputs/browser/egg-tier-' + (index + 1) + '.png', animations: 'disabled' })
    await egg.click()
    await expect(page.locator('.result-card h3')).toHaveText(tierLabels[index] + ' 벌칙')
    await expect(page.locator('.history-list li')).toHaveCount(1)
  })
}

test('opening selects uniformly from the drawn tier after the egg is created', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2, 0.9])
  await openStudio(page)
  await seedAllTiers(page, ['첫 번째 상 벌칙', '두 번째 상 벌칙'])
  await page.getByRole('button', { name: '알 뽑기', exact: true }).click()
  await expect(page.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.getByRole('button', { name: '상 알 열기', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText('두 번째 상 벌칙')
  await expect(page.locator('.result-probability')).toContainText('30%')
})

test('missing or exhausted tier blocks drawing without changing fixed odds; restore includes every tier', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await startEmpty(page)
  await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeDisabled()
  for (let index = 0; index < tierTabs.length; index++) {
    await selectTier(page, index)
    await addItems(page, [tierLabels[index] + ' 벌칙'])
    if (index < tierTabs.length - 1) await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeEnabled()
  await selectTier(page, 0)
  await page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true }).uncheck()
  await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: '항목 1 추첨 포함', exact: true }).check()
  await page.getByRole('textbox', { name: '항목 1 이름', exact: true }).fill('')
  await expect(page.getByRole('button', { name: '알 뽑기', exact: true })).toBeDisabled()
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

test('Space ignores input controls and pending eggs; mutations lock during animation', async ({ page }) => {
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await page.getByRole('textbox', { name: '항목 1 이름', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await waitForShared(page)
  await page.locator('h1').click()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: '뽑는 중…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '항목 추가', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toBeDisabled()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await page.locator('h1').click()
  await page.keyboard.press('Space')
  await expect(page.locator('.history-list li')).toHaveCount(0)
  await page.getByRole('button', { name: '상 알 열기', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.history-list li')).toHaveCount(1)
})

test('mobile egg opening and a 60-character result remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  await page.getByRole('button', { name: '이용 방법', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click()
  const label = '가나다라마바사아자차카타파하'.repeat(5).slice(0, 60)
  await seedAllTiers(page, [label])
  await page.getByRole('button', { name: '알 뽑기', exact: true }).click()
  await expect(page.getByRole('button', { name: '상 알 열기', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '상 알 열기', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'outputs/browser/mobile-pending-egg.png', animations: 'disabled' })
  await page.getByRole('button', { name: '상 알 열기', exact: true }).click()
  await expect(page.locator('.result-card h3')).toHaveText(label)
  await page.locator('.result-card').scrollIntoViewIfNeeded()
  const resultBounds = await page.locator('.result-card').boundingBox()
  const actionBounds = await page.locator('.draw-action').boundingBox()
  expect(resultBounds).not.toBeNull()
  expect(actionBounds).not.toBeNull()
  expect(resultBounds!.y + resultBounds!.height).toBeLessThanOrEqual(actionBounds!.y)
  const sizes = await page.evaluate(() => ({ inner: innerWidth, document: document.documentElement.scrollWidth }))
  expect(sizes.document).toBeLessThanOrEqual(sizes.inner)
  await page.screenshot({ path: 'outputs/browser/mobile-result-390.png', animations: 'disabled' })
})

test('preset reset is explicit and reversible after custom choices and history survive reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixedRandom(page, [0.2])
  await openStudio(page)
  const presetLabels = await page.getByRole('textbox', { name: /항목 \d+ 이름/ }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))
  await seedAllTiers(page, ['내가 정한 벌칙'])
  await drawAndOpen(page)
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
  for (const [index, label] of presetLabels.entries()) {
    await expect(page.getByRole('textbox', { name: '항목 ' + (index + 1) + ' 이름', exact: true })).toHaveValue(label)
  }
  await page.getByRole('button', { name: '되돌리기', exact: true }).click()
  await expect(page.locator('.item-row')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '항목 1 이름', exact: true })).toHaveValue('내가 정한 벌칙')
  await expect(page.locator('.history-list li')).toHaveCount(1)
})
