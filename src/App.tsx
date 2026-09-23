import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type SetStateAction } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Stack } from '@astryxdesign/core/Stack'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Switch } from '@astryxdesign/core/Switch'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { Selector } from '@astryxdesign/core/Selector'
import { ArrowRight, Check, ChevronDown, CircleHelp, Copy, History, ListPlus, Plus, RotateCcw, Shuffle, SlidersHorizontal, Sparkles, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { DEFAULT_ITEMS, MAX_HISTORY, MAX_ITEMS, MAX_LABEL_LENGTH, TIERS, STORAGE_KEY, createPendingEgg, getEligibleItems, getMissingTiers, openEgg, parseSavedState, probabilities, type DrawItem, type DrawResult, type SavedState, type TierId } from './lib/draw'
import { useSharedBoard } from './hooks/useSharedBoard'
import { mergeBoardItems } from './lib/sharedBoard'

type Notice = { message: string; undo?: () => void }
type Modal = 'help' | 'bulk' | 'new' | null
const LOCAL_BACKUP_KEY = 'bbob-before-sharing-v1'

function legacyItems(): DrawItem[] {
  try {
    const raw = localStorage.getItem(LOCAL_BACKUP_KEY) ?? localStorage.getItem(STORAGE_KEY)
    return parseSavedState(raw)?.items ?? []
  } catch { return [] }
}

function itemSignature(item: DrawItem) {
  return JSON.stringify([item.label.trim(), item.tier, item.enabled !== false])
}

function initialState(): SavedState {
  try {
    const saved = parseSavedState(localStorage.getItem(STORAGE_KEY))
    if (saved) return saved
  } catch { /* The app remains usable when browser storage is unavailable. */ }
  return { items: DEFAULT_ITEMS.map(item => ({ ...item })), history: [], excludeWinners: false, excludedIds: [], soundEnabled: false, pending: null }
}

function Flower({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 40 40" fill="currentColor" aria-hidden="true"><path d="M20 17C1-8-8 17 17 20-8 39 17 48 20 23c19 25 28 0 3-3C48 1 23-8 20 17Z" /></svg>
}

function percentage(value: number) {
  if (value > 0 && value < 0.1) return '<0.1%'
  if (value > 99.9 && value < 100) return '>99.9%'
  return `${Number(value.toFixed(1))}%`
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function App() {
  const [personal, setPersonal] = useState(initialState)
  const personalRef = useRef(personal)
  const [localItems] = useState(legacyItems)
  const shared = useSharedBoard()
  const { getItems: getSharedItems, setItems: setSharedItems } = shared
  const state = useMemo(() => ({ ...personal, items: shared.items }), [personal, shared.items])
  const setState = useCallback((update: SetStateAction<SavedState>) => {
    const current = { ...personalRef.current, items: getSharedItems() }
    const next = typeof update === 'function' ? update(current) : update
    if (next.items !== current.items) setSharedItems(next.items)
    personalRef.current = next
    setPersonal(next)
  }, [getSharedItems, setSharedItems])
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<DrawResult | null>(null)
  const [activeTier, setActiveTier] = useState<TierId>('high')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [bulkText, setBulkText] = useState('')
  const [bulkError, setBulkError] = useState('')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [storageOkay, setStorageOkay] = useState(true)
  const drawingRef = useRef(false)
  const openingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioRef = useRef<AudioContext | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const editorRef = useRef<HTMLElement>(null)
  const eggRef = useRef<HTMLButtonElement>(null)
  const resultRef = useRef<HTMLHeadingElement>(null)
  const reducedMotion = useReducedMotion()
  const excluded = state.excludeWinners ? state.excludedIds : []
  const eligible = getEligibleItems(state.items, excluded)
  const odds = probabilities(state.items, excluded)
  const missingTiers = getMissingTiers(state.items, excluded)
  const locked = spinning || state.pending !== null
  const editorLocked = locked || !shared.ready
  const canDraw = shared.ready && shared.status === 'synced'
  const tier = TIERS.find(tier => tier.id === activeTier)!
  const visibleItems = state.items.filter(item => item.tier === activeTier)
  const hasBlank = visibleItems.some(item => !item.label.trim())
  const pendingTier = TIERS.find(tier => tier.id === state.pending?.tier)
  const missingLabels = TIERS.filter(tier => missingTiers.includes(tier.id)).map(tier => tier.label).join('·')
  const shareStatus = { loading: '연결 중', synced: '공유됨', saving: '저장 중', offline: '연결 끊김', conflict: '수정 충돌' }[shared.status]
  const hasLocalImport = localItems.some(item => item.label.trim() && !DEFAULT_ITEMS.some(defaultItem => itemSignature(defaultItem) === itemSignature(item)))

  useEffect(() => {
    let saved = true
    try {
      if (localStorage.getItem(LOCAL_BACKUP_KEY) === null) localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify({ items: localItems }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...personal, items: shared.ready ? shared.items : personal.items }))
    } catch { saved = false }
    // Report the external browser storage result; it cannot be known during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStorageOkay(saved)
  }, [personal, shared.items, shared.ready, localItems])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    void audioRef.current?.close()
  }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (modal && !dialogRef.current?.open) dialogRef.current?.showModal()
    else if (!modal && dialogRef.current?.open) dialogRef.current?.close()
  }, [modal])

  useEffect(() => {
    if (!spinning && state.pending) eggRef.current?.focus({ preventScroll: true })
  }, [spinning, state.pending])

  useEffect(() => {
    if (result) resultRef.current?.focus({ preventScroll: true })
  }, [result])

  const chime = useCallback(() => {
    const context = audioRef.current
    if (!context || context.state !== 'running') return
    ;[523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const start = context.currentTime + index * 0.09
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.09, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.7)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.72)
    })
  }, [])

  const draw = useCallback(() => {
    if (drawingRef.current || state.pending || modal || !canDraw) return
    const exclusions = state.excludeWinners ? state.excludedIds : []
    const pending = createPendingEgg(state.items, exclusions)
    if (!pending) return
    drawingRef.current = true
    openingRef.current = false
    setNotice(null)
    if (state.soundEnabled) {
      try {
        audioRef.current ??= new AudioContext()
        void audioRef.current.resume().catch(() => {})
      } catch { /* Sound is optional and must never prevent a draw. */ }
    }
    setResult(null)
    setSpinning(true)
    setState(previous => ({ ...previous, pending }))
    timerRef.current = setTimeout(() => {
      setSpinning(false)
      drawingRef.current = false
      timerRef.current = null
    }, reducedMotion ? 180 : 1500)
  }, [state, reducedMotion, modal, canDraw, setState])

  function revealEgg() {
    if (spinning || openingRef.current || !state.pending) return
    const selected = openEgg(state.pending)
    if (!selected) return
    openingRef.current = true
    setNotice(null)
    setResult(selected)
    setState(previous => ({ ...previous, pending: null, history: [selected, ...previous.history.filter(entry => entry.id !== selected.id)].slice(0, MAX_HISTORY), excludedIds: previous.excludeWinners ? [...new Set([...previous.excludedIds, selected.itemId])] : previous.excludedIds }))
    if (state.soundEnabled) chime()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.code !== 'Space' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || modal || target?.closest('input, textarea, button, select, a, [role="combobox"], [contenteditable="true"]')) return
      event.preventDefault()
      draw()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draw, modal])

  function updateItem(id: string, change: Partial<DrawItem>) {
    if (drawingRef.current || editorLocked) return
    setNotice(null)
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, ...change } : item) }))
  }

  function addItem() {
    if (drawingRef.current || editorLocked || state.items.length >= MAX_ITEMS) return
    setNotice(null)
    const id = crypto.randomUUID()
    setState(previous => ({ ...previous, items: [...previous.items, { id, label: '', tier: activeTier, color: tier.color }] }))
    requestAnimationFrame(() => editorRef.current?.querySelector<HTMLInputElement>(`[data-item-id="${id}"] input`)?.focus())
  }

  function removeItem(id: string) {
    if (drawingRef.current || editorLocked) return
    const index = state.items.findIndex(item => item.id === id)
    const removed = state.items[index]
    const wasExcluded = state.excludedIds.includes(id)
    setState(previous => ({ ...previous, items: previous.items.filter(item => item.id !== id), excludedIds: previous.excludedIds.filter(itemId => itemId !== id) }))
    setNotice({ message: '삭제됨', undo: () => setState(previous => {
      if (previous.items.length >= MAX_ITEMS || previous.items.some(item => item.id === id)) return previous
      const items = [...previous.items]
      items.splice(Math.min(index, items.length), 0, removed)
      return { ...previous, items, excludedIds: wasExcluded ? [...previous.excludedIds, id] : previous.excludedIds }
    }) })
  }

  function addBulk(event: FormEvent) {
    event.preventDefault()
    if (editorLocked) return
    const labels = bulkText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (!labels.length) { setBulkError('항목을 입력해 주세요.'); return }
    if (labels.some(label => label.length > MAX_LABEL_LENGTH)) { setBulkError(`이름은 ${MAX_LABEL_LENGTH}자 이하로 입력하세요.`); return }
    if (state.items.length + labels.length > MAX_ITEMS) { setBulkError(`최대 ${MAX_ITEMS}개 · ${MAX_ITEMS - state.items.length}개 추가 가능`); return }
    setState(previous => ({ ...previous, items: [...previous.items, ...labels.map(label => ({ id: crypto.randomUUID(), label, tier: activeTier, color: tier.color }))] }))
    setBulkText('')
    setBulkError('')
    setModal(null)
    setNotice({ message: `${labels.length}개 추가됨` })
  }

  function resetRound() {
    if (locked) return
    setState(previous => ({ ...previous, excludedIds: [] }))
    setResult(null)
    setNotice({ message: '전체 항목 포함' })
  }

  function resetItems(useDefaults: boolean) {
    if (editorLocked) return
    const beforeItems = getSharedItems()
    const beforeHistory = [...personalRef.current.history]
    const beforeExcludedIds = [...personalRef.current.excludedIds]
    const resetSnapshot = useDefaults ? DEFAULT_ITEMS.map(item => ({ ...item })) : []
    setState(previous => ({ ...previous, items: resetSnapshot, history: [], excludedIds: [], pending: null }))
    setActiveTier('high')
    setResult(null)
    setModal(null)
    setNotice({ message: useDefaults ? '기본 벌칙으로 변경됨' : '목록 비움', undo: () => {
      const restored = mergeBoardItems(resetSnapshot, beforeItems, getSharedItems())
      if (!restored.ok) {
        setNotice({ message: restored.reason === 'capacity' ? '30개를 넘어 되돌릴 수 없어요.' : '다른 수정과 겹쳐 되돌릴 수 없어요.' })
        return
      }
      setState(previous => ({ ...previous, items: restored.items, history: beforeHistory, excludedIds: beforeExcludedIds }))
    } })
  }

  async function copyResult() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(`오늘의 벌칙: ${result.label} (${percentage(result.probability)})`)
      setNotice({ message: '복사됨' })
    } catch { setNotice({ message: '복사 실패 · 텍스트를 직접 선택하세요.' }) }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}`)
      setNotice({ message: '공유 링크 복사됨' })
    } catch { setNotice({ message: '주소창의 링크를 복사해 주세요.' }) }
  }

  function importLocalItems() {
    if (editorLocked) return
    const existing = new Set(state.items.map(itemSignature))
    const additions = localItems.filter(item => {
      const key = itemSignature(item)
      if (!item.label.trim() || existing.has(key)) return false
      existing.add(key)
      return true
    })
    if (state.items.length + additions.length > MAX_ITEMS) {
      setNotice({ message: `최대 ${MAX_ITEMS}개 · ${additions.length}개를 위한 자리가 필요해요.` })
      return
    }
    if (!additions.length) { setNotice({ message: '이미 목록에 있어요.' }); return }
    setState(previous => ({ ...previous, items: [...previous.items, ...additions.map(item => ({ ...item, id: crypto.randomUUID() }))] }))
    setNotice({ message: `${additions.length}개 가져옴` })
    setModal(null)
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#draw-studio">뽑기로 바로 가기</a>
      <header className="site-header">
        <a href="./" className="brand" aria-label="뽑, 홈"><Flower /><span>bbob<span className="brand-period">.</span></span><span className="brand-korean">뽑</span></a>
        <Stack direction="horizontal" gap={4} vAlign="center">
          <span className={`save-status ${shared.status === 'offline' || shared.status === 'conflict' || !storageOkay ? 'save-error' : ''}`} title="목록은 함께 편집하고, 뽑기 기록은 이 브라우저에 저장합니다."><span className="status-dot" />{shareStatus}{!storageOkay && ' · 기록 저장 불가'}</span>
          <button className="help-button" aria-label="공유 링크 복사" title="공유 링크 복사" onClick={() => void copyLink()}><Copy size={16} /></button>
          <button className="help-button" aria-label="이용 방법" title="이용 방법" onClick={() => setModal('help')}><CircleHelp size={17} /></button>
        </Stack>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div className="intro-copy"><h1 id="page-title">러닝 <span>약속</span><Flower /></h1><p className="intro-description">이틀 연속 쉬면, 벌칙 하나.</p></div>
        </section>

        {(shared.status === 'offline' || shared.status === 'conflict') && <div className="sync-notice" role="status"><span>{shared.status === 'conflict' ? shared.error ?? '수정이 겹쳤어요. 적용할 목록을 선택하세요.' : '공유 연결이 끊겨 저장 상태를 확인할 수 없어요.'}</span><div>{shared.status === 'conflict' ? <><button className="text-button" title="내 수정 대신 최신 공유 목록 불러오기" onClick={shared.reload}>최신 목록</button><button className="text-button" onClick={shared.retry}>내 수정 적용</button></> : <button className="text-button" onClick={shared.retry}>다시 연결</button>}</div></div>}

        <div className="studio-grid" id="draw-studio">
          <section className={`draw-panel glass-panel ${spinning ? 'is-spinning' : ''} ${result ? 'has-result' : ''} ${state.pending && !spinning ? 'has-egg' : ''}`} aria-labelledby="draw-title">
            <div className="panel-topline"><Sparkles className="section-spark" size={17} aria-hidden="true" /><button className={`icon-button sound-button ${state.soundEnabled ? 'is-active' : ''}`} aria-label={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} aria-pressed={state.soundEnabled} title={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} disabled={locked} onClick={() => setState(previous => ({ ...previous, soundEnabled: !previous.soundEnabled }))}>{state.soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}</button></div>
            <div className="draw-heading"><h2 id="draw-title">{spinning ? '뽑는 중…' : pendingTier ? `${pendingTier.label} · ${pendingTier.probability}%` : '오늘의 벌칙'}</h2></div>

            <div className="lottery-scene" aria-hidden="true" onPointerMove={event => {
              if (reducedMotion || event.pointerType !== 'mouse') return
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.style.setProperty('--pointer-x', `${((event.clientX - rect.left) / rect.width - 0.5) * 10}px`)
              event.currentTarget.style.setProperty('--pointer-y', `${((event.clientY - rect.top) / rect.height - 0.5) * 8}px`)
            }} onPointerLeave={event => { event.currentTarget.style.setProperty('--pointer-x', '0px'); event.currentTarget.style.setProperty('--pointer-y', '0px') }}>
              <div className="scene-halo" /><div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <span className="scene-spark spark-one">✦</span><span className="scene-spark spark-two">✧</span><span className="scene-dot dot-one" /><span className="scene-dot dot-two" />
              <div className="globe-shadow" />
              <div className="glass-globe"><div className="globe-shine" /><div className="globe-ring" />
                <div className="lottery-balls">{TIERS.map((tier, index) => <div className={`lottery-ball ball-${index} mini-egg tier-${tier.id}`} key={tier.id} style={{ '--ball-color': tier.color, '--ball-delay': `${index * -0.38}s` } as CSSProperties}><span>{tier.label}</span><Flower /></div>)}</div>
                {eligible.length === 0 && <Flower className="empty-globe-flower" />}
                <div className="globe-front" />
              </div>
              <div className="globe-base"><Flower /></div>
              {result && <div className="confetti">{Array.from({ length: 16 }, (_, index) => <i key={`${result.id}-${index}`} style={{ '--i': index, '--confetti-color': result.color } as CSSProperties} />)}</div>}
            </div>

            {state.pending && pendingTier && !spinning && <div className={`egg-reveal tier-${pendingTier.id}`}><button ref={eggRef} className="prize-egg" data-tier={pendingTier.id} aria-label={`${pendingTier.label} 알 열기`} aria-describedby="egg-hint" onClick={revealEgg}><span className="egg-aura" aria-hidden="true" /><span className="egg-shell" aria-hidden="true"><span className="egg-sheen" /><span className="egg-seam" /><Flower /></span><span className="egg-sparkles" aria-hidden="true">✧<span>✦</span>✧</span></button><p className="egg-caption" id="egg-hint">알을 눌러 열기</p></div>}
            {result && <div className={`result-card tier-${result.tier ?? 'high'} ${result.label.length > 24 ? 'long-result' : ''}`} key={result.id}><span className="result-eyebrow"><Sparkles size={13} /> {TIERS.find(tier => tier.id === result.tier)?.label ?? '결과'}</span><h3 ref={resultRef} tabIndex={-1}>{result.label}</h3><span className="result-probability" aria-label={`당첨 확률 ${percentage(result.probability)}`}>{percentage(result.probability)}</span><button className="copy-result" onClick={() => void copyResult()} aria-label="뽑기 결과 복사" title="결과 복사"><Copy size={15} /></button></div>}
            <div className="draw-bottom">
              <div className="draw-action"><Button label={spinning ? '뽑는 중…' : state.pending ? '알을 열어주세요' : result ? '다시 뽑기' : '알 뽑기'} variant="primary" size="lg" width="100%" isDisabled={locked || !canDraw || missingTiers.length > 0} icon={<Shuffle size={20} />} onClick={draw} /><ArrowRight className="draw-arrow" size={18} /></div>
              <p className="draw-hint">{locked ? '\u00a0' : !canDraw ? (shared.status === 'saving' ? '목록을 저장하고 있어요.' : '공유 목록을 확인하고 있어요.') : missingTiers.length ? `${missingLabels} 등급에 항목이 필요해요.` : <span className="desktop-shortcut"><kbd title="Space 키로 뽑기">Space</kbd></span>}</p>
            </div>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{spinning ? '알을 뽑는 중입니다.' : pendingTier ? `${pendingTier.label} 등급, ${pendingTier.eggLabel} 알입니다. 알을 눌러 벌칙을 확인하세요.` : result ? `뽑기 결과: ${result.label}. 당첨 확률 ${percentage(result.probability)}.` : ''}</p>
          </section>

          <section className="editor-panel glass-panel" ref={editorRef} aria-labelledby="editor-title">
            <div className="editor-heading"><Stack direction="horizontal" gap={2} vAlign="center"><SlidersHorizontal size={19} /><h2 id="editor-title">벌칙</h2><span className="count-badge">{state.items.length}</span></Stack><button className="text-button" aria-label="초기화" disabled={editorLocked} onClick={() => setModal('new')}><RotateCcw size={13} /> 초기화</button></div>
            <div className="tier-tabs"><TabList role="tablist" value={activeTier} onChange={value => setActiveTier(value as TierId)} layout="fill" size="sm" overflow="visible">{TIERS.map(tier => <Tab key={tier.id} value={tier.id} label={`${tier.label} ${tier.probability}%`} panelId={`panel-${tier.id}`} isLabelHidden endContent={<span className={`tier-tab-content tier-${tier.id}`}><span className="tier-dot" aria-hidden="true" /><strong>{tier.label}</strong><span>{tier.probability}%</span></span>} />)}</TabList></div>
            <div className="editor-toolbar"><span>{tier.label} <span className="muted">{visibleItems.length}개</span></span><span className="tier-rule">등급 안에서는 동일 확률</span></div>

            {TIERS.map(group => <div key={group.id} id={`panel-${group.id}`} role="tabpanel" aria-label={`${group.label} 벌칙`} hidden={activeTier !== group.id}>{activeTier === group.id && <div className="item-list">{visibleItems.length === 0 ? <div className="empty-items"><ListPlus size={30} strokeWidth={1.2} /><p>벌칙을 추가하세요.</p></div> : visibleItems.map((item, index) => {
              const isExcluded = excluded.includes(item.id)
              const disabledItem = item.enabled === false
              return <article className={`item-row ${isExcluded || disabledItem ? 'is-excluded' : ''}`} key={item.id} data-item-id={item.id} style={{ '--item-color': tier.color } as CSSProperties}>
                <div className="item-main"><span className="item-number">{isExcluded ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><TextInput label={`항목 ${index + 1} 이름`} isLabelHidden value={item.label} onChange={label => updateItem(item.id, { label: label.slice(0, MAX_LABEL_LENGTH) })} placeholder="벌칙 입력" size="sm" isDisabled={editorLocked} width="100%" /><span className="item-percentage" aria-label={missingTiers.length ? '등급별 항목을 채우면 추첨 가능' : `실제 당첨 확률 ${percentage(odds[item.id] ?? 0)}`}>{isExcluded || disabledItem ? '제외' : missingTiers.length ? '—' : percentage(odds[item.id] ?? 0)}</span><button className="remove-item icon-button" aria-label={`항목 ${index + 1} 삭제`} title="항목 삭제" disabled={editorLocked} onClick={() => removeItem(item.id)}><X size={15} /></button></div>
                <div className="item-options"><label className="item-enabled"><input type="checkbox" checked={!disabledItem} disabled={editorLocked} aria-label={`항목 ${index + 1} 추첨 포함`} onChange={event => updateItem(item.id, { enabled: event.target.checked })} />포함</label><Selector label={`항목 ${index + 1} 등급`} isLabelHidden options={TIERS.map(tier => ({ value: tier.id, label: tier.label }))} value={item.tier} onChange={value => { const target = TIERS.find(tier => tier.id === value); if (target) { updateItem(item.id, { tier: target.id, color: target.color }); setNotice({ message: `${target.label}(으)로 이동됨` }) } }} isDisabled={editorLocked} size="sm" variant="ghost" width={80} /></div>
              </article>
            })}</div>}</div>)}

            <div className="add-actions"><button className="add-item" aria-label="항목 추가" disabled={editorLocked || state.items.length >= MAX_ITEMS} onClick={addItem}><Plus size={17} /> 추가</button><button className="bulk-add" disabled={editorLocked || state.items.length >= MAX_ITEMS} onClick={() => { setBulkError(''); setModal('bulk') }} aria-label="여러 항목 한 번에 추가" title="여러 항목 한 번에 추가"><ListPlus size={19} /></button></div>
            {hasBlank && <p className="inline-note">빈 항목은 제외돼요.</p>}

            <div className="tier-overview" aria-label="등급별 준비 상태">{TIERS.map(tier => <span key={tier.id} className={missingTiers.includes(tier.id) ? 'tier-needs-item' : ''}><i style={{ backgroundColor: tier.color }} />{tier.label}<strong>{getEligibleItems(state.items, excluded).filter(item => item.tier === tier.id).length}</strong></span>)}</div>
            <div className="exclude-setting"><Switch label="중복 제외" value={state.excludeWinners} onChange={value => { setNotice(null); setState(previous => ({ ...previous, excludeWinners: value, excludedIds: [] })) }} isDisabled={locked} size="sm" labelPosition="start" labelSpacing="spread" width="100%" />{state.excludeWinners && state.excludedIds.length > 0 && <button disabled={locked} className="text-button restore-items" onClick={resetRound}>전체 포함</button>}</div>
          </section>
        </div>

        <section className="history-section" aria-labelledby="history-title"><div className="history-heading"><Stack direction="horizontal" gap={2} vAlign="center"><History size={17} /><h2 id="history-title">기록</h2><span className="history-count">{state.history.length}</span></Stack><div className="history-controls">{state.history.length > 0 && <button className="text-button" aria-label="기록 비우기" disabled={locked} onClick={() => { const history = state.history; setState(previous => ({ ...previous, history: [] })); setNotice({ message: '기록 비움', undo: () => setState(previous => ({ ...previous, history: [...previous.history, ...history].slice(0, MAX_HISTORY) })) }) }}><Trash2 size={13} /> 비우기</button>}</div></div>
          {state.history.length ? <><ol className="history-list">{(showAllHistory ? state.history : state.history.slice(0, 5)).map(entry => <li key={entry.id}><span className="history-item-dot" style={{ backgroundColor: entry.color }} /><div><strong>{entry.label}</strong><span>{new Date(entry.drawnAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} · {percentage(entry.probability)}</span></div></li>)}</ol>{state.history.length > 5 && <button className="history-expand text-button" onClick={() => setShowAllHistory(!showAllHistory)}>{showAllHistory ? '접기' : `전체 ${state.history.length}개`}<ChevronDown size={14} style={{ transform: showAllHistory ? 'rotate(180deg)' : undefined }} /></button>}</> : <div className="empty-history"><p>아직 기록이 없어요.</p></div>}
        </section>
      </main>

      <footer className="site-footer"><a className="footer-brand" href="./" aria-label="뽑, 홈">bbob.</a><Flower /></footer>

      {notice && <div className="toast" role="status"><Check size={17} /><span>{notice.message}</span>{notice.undo && <button disabled={locked} onClick={() => { setNotice(null); notice.undo?.() }}>되돌리기</button>}<button className="toast-close" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      <dialog className="app-dialog" ref={dialogRef} onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setModal(null) } }} aria-labelledby="dialog-title">
        <button className="dialog-close icon-button" onClick={() => setModal(null)} aria-label="창 닫기"><X size={20} /></button>
        {modal === 'help' && <><h2 id="dialog-title">이용 방법</h2><ul className="help-summary"><li>링크를 가진 누구나 목록을 편집할 수 있어요.</li><li>상 60% · 중 35% · 하 4.9% · 극하 0.1%</li><li>알을 뽑고, 눌러서 벌칙을 확인하세요.</li><li>같은 등급의 벌칙은 동일 확률로 나와요.</li><li>네 등급마다 추첨 가능한 항목이 필요해요.</li><li>‘중복 제외’로 비워진 등급은 ‘전체 포함’으로 복원하세요.</li></ul><p className="privacy-note">목록은 모두 공유 · 알과 기록은 내 브라우저에 저장됩니다.</p>{hasLocalImport && <button className="import-local text-button" disabled={editorLocked} onClick={importLocalItems}>이 기기의 목록 가져오기</button>}<Button label="닫기" variant="primary" width="100%" onClick={() => setModal(null)} /></>}
        {modal === 'bulk' && <form onSubmit={addBulk}><h2 id="dialog-title">한 번에 추가</h2><p className="dialog-description">{tier.label} 등급 · 한 줄에 하나씩.</p><label className="bulk-label" htmlFor="bulk-items">추가할 항목 <span>{MAX_ITEMS - state.items.length}개까지</span></label><textarea id="bulk-items" value={bulkText} onChange={event => setBulkText(event.target.value)} placeholder={'청소 20분\n설거지 전담\n친구에게 커피 사기'} rows={7} maxLength={MAX_ITEMS * (MAX_LABEL_LENGTH + 2)} aria-describedby={bulkError ? 'bulk-error' : undefined} aria-invalid={!!bulkError} />{bulkError && <p className="form-error" id="bulk-error" role="alert">{bulkError}</p>}<Button label="추가하기" type="submit" variant="primary" width="100%" icon={<Plus size={17} />} /></form>}
        {modal === 'new' && <><h2 id="dialog-title">목록 초기화</h2><p className="dialog-description">모두의 목록이 바뀝니다. 내 기록도 초기화됩니다.</p><Stack direction="horizontal" gap={2}><Button label="비우기" width="100%" onClick={() => resetItems(false)} /><Button label="기본 벌칙" variant="primary" width="100%" onClick={() => resetItems(true)} /></Stack></>}
      </dialog>
    </div>
  )
}

export default App
