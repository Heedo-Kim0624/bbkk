import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Stack } from '@astryxdesign/core/Stack'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Slider } from '@astryxdesign/core/Slider'
import { Switch } from '@astryxdesign/core/Switch'
import { ArrowDown, ArrowRight, Check, ChevronDown, CircleHelp, Copy, History, ListPlus, Plus, RotateCcw, Shuffle, SlidersHorizontal, Sparkles, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { DEFAULT_ITEMS, MAX_HISTORY, MAX_ITEMS, MAX_LABEL_LENGTH, PALETTE, STORAGE_KEY, getEligibleItems, parseSavedState, pickWeighted, probabilities, type DrawItem, type DrawResult, type SavedState } from './lib/draw'

type Notice = { message: string; undo?: () => void }
type Modal = 'help' | 'bulk' | 'new' | null

function initialState(): SavedState {
  try {
    const saved = parseSavedState(localStorage.getItem(STORAGE_KEY))
    if (saved) return saved
  } catch { /* The app remains usable when browser storage is unavailable. */ }
  return { items: DEFAULT_ITEMS.map(item => ({ ...item })), history: [], excludeWinners: false, excludedIds: [], soundEnabled: false }
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
  const [state, setState] = useState(initialState)
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<DrawResult | null>(null)
  const [preview, setPreview] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [bulkText, setBulkText] = useState('')
  const [bulkError, setBulkError] = useState('')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [storageOkay, setStorageOkay] = useState(true)
  const drawingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioRef = useRef<AudioContext | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const editorRef = useRef<HTMLElement>(null)
  const reducedMotion = useReducedMotion()
  const excluded = state.excludeWinners ? state.excludedIds : []
  const eligible = getEligibleItems(state.items, excluded)
  const odds = probabilities(state.items, excluded)
  const hasBlank = state.items.some(item => !item.label.trim())
  const allDrawn = state.excludeWinners && state.excludedIds.length > 0 && eligible.length === 0 && getEligibleItems(state.items).length > 0

  useEffect(() => {
    let saved = true
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch { saved = false }
    // Report the external browser storage result; it cannot be known during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStorageOkay(saved)
  }, [state])

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
    if (!spinning || reducedMotion) return
    let index = 0
    const candidates = getEligibleItems(state.items, state.excludeWinners ? state.excludedIds : [])
    const interval = setInterval(() => setPreview(candidates[index++ % candidates.length]?.label ?? ''), 110)
    return () => clearInterval(interval)
  }, [spinning, reducedMotion, state.items, state.excludeWinners, state.excludedIds])

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
    if (drawingRef.current || modal) return
    const exclusions = state.excludeWinners ? state.excludedIds : []
    const winner = pickWeighted(state.items, exclusions)
    if (!winner) return
    drawingRef.current = true
    if (state.soundEnabled) {
      try {
        audioRef.current ??= new AudioContext()
        void audioRef.current.resume().catch(() => {})
      } catch { /* Sound is optional and must never prevent a draw. */ }
    }
    const selected: DrawResult = { id: crypto.randomUUID(), itemId: winner.id, label: winner.label.trim(), color: winner.color, probability: probabilities(state.items, exclusions)[winner.id], drawnAt: Date.now() }
    setResult(null)
    setPreview('행운을 섞는 중')
    setSpinning(true)
    timerRef.current = setTimeout(() => {
      setResult(selected)
      setState(previous => ({ ...previous, history: [selected, ...previous.history].slice(0, MAX_HISTORY), excludedIds: previous.excludeWinners ? [...new Set([...previous.excludedIds, selected.itemId])] : previous.excludedIds }))
      setSpinning(false)
      drawingRef.current = false
      timerRef.current = null
      if (state.soundEnabled) chime()
    }, reducedMotion ? 180 : 2200)
  }, [state, reducedMotion, chime, modal])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.code !== 'Space' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || modal || target?.closest('input, textarea, button, select, a, [role="slider"], [contenteditable="true"]')) return
      event.preventDefault()
      draw()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draw, modal])

  function updateItem(id: string, change: Partial<DrawItem>) {
    if (drawingRef.current) return
    setNotice(null)
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, ...change } : item) }))
  }

  function addItem() {
    if (drawingRef.current || state.items.length >= MAX_ITEMS) return
    setNotice(null)
    const id = crypto.randomUUID()
    setState(previous => ({ ...previous, items: [...previous.items, { id, label: '', weight: 20, color: PALETTE[previous.items.length % PALETTE.length] }] }))
    requestAnimationFrame(() => editorRef.current?.querySelector<HTMLInputElement>(`[data-item-id="${id}"] input`)?.focus())
  }

  function removeItem(id: string) {
    if (drawingRef.current) return
    const index = state.items.findIndex(item => item.id === id)
    const removed = state.items[index]
    const wasExcluded = state.excludedIds.includes(id)
    setState(previous => ({ ...previous, items: previous.items.filter(item => item.id !== id), excludedIds: previous.excludedIds.filter(itemId => itemId !== id) }))
    setNotice({ message: '항목을 삭제했어요.', undo: () => setState(previous => {
      if (previous.items.length >= MAX_ITEMS || previous.items.some(item => item.id === id)) return previous
      const items = [...previous.items]
      items.splice(Math.min(index, items.length), 0, removed)
      return { ...previous, items, excludedIds: wasExcluded ? [...previous.excludedIds, id] : previous.excludedIds }
    }) })
  }

  function addBulk(event: FormEvent) {
    event.preventDefault()
    const labels = bulkText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (!labels.length) { setBulkError('추가할 항목을 한 줄에 하나씩 적어 주세요.'); return }
    if (labels.some(label => label.length > MAX_LABEL_LENGTH)) { setBulkError(`항목 이름은 ${MAX_LABEL_LENGTH}자까지 입력할 수 있어요.`); return }
    if (state.items.length + labels.length > MAX_ITEMS) { setBulkError(`항목은 최대 ${MAX_ITEMS}개까지 만들 수 있어요. 현재 ${MAX_ITEMS - state.items.length}개를 더 추가할 수 있어요.`); return }
    setState(previous => ({ ...previous, items: [...previous.items, ...labels.map((label, index) => ({ id: crypto.randomUUID(), label, weight: 20, color: PALETTE[(previous.items.length + index) % PALETTE.length] }))] }))
    setBulkText('')
    setBulkError('')
    setModal(null)
    setNotice({ message: `${labels.length}개 항목을 추가했어요.` })
  }

  function resetRound() {
    setState(previous => ({ ...previous, excludedIds: [] }))
    setResult(null)
    setNotice({ message: '모든 항목이 다시 뽑기에 참여해요.' })
  }

  async function copyResult() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(`오늘의 뽑! ${result.label} ✨ (당첨 확률 ${percentage(result.probability)})`)
      setNotice({ message: '결과를 복사했어요.' })
    } catch { setNotice({ message: '복사할 수 없어요. 결과의 텍스트를 직접 선택해 주세요.' }) }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#draw-studio">뽑기로 바로 가기</a>
      <header className="site-header">
        <a href="./" className="brand" aria-label="뽑, 홈"><Flower /><span>bbob<span className="brand-period">.</span></span><span className="brand-korean">뽑</span></a>
        <span className="header-caption">작은 우연이 필요한 순간</span>
        <Stack direction="horizontal" gap={4} vAlign="center">
          <span className={`save-status ${storageOkay ? '' : 'save-error'}`}><span className="status-dot" />{storageOkay ? '이 기기에 자동 저장' : '저장할 수 없는 환경'}</span>
          <button className="help-button" aria-label="이용 방법" onClick={() => setModal('help')}><CircleHelp size={17} /><span>이용 방법</span></button>
        </Stack>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div className="intro-copy"><p className="eyebrow"><span /> A LITTLE CHANCE, A LITTLE JOY</p><h1 id="page-title">고민은 가볍게,<br className="mobile-break" /> 선택은 <span>재미있게.</span><Flower /></h1><p className="intro-description">무엇을 뽑아볼까요? 선택지를 담고, 작은 우연에 맡겨보세요.</p></div>
          <div className="intro-note" aria-hidden="true"><span>Let luck do its thing.</span><svg viewBox="0 0 75 45" fill="none"><path d="M5 6c13 25 53-14 47 7-4 14-18 17-12 7 6-9 18-3 24 14m-12-3 13 5 2-14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
        </section>

        <div className="studio-grid" id="draw-studio">
          <section className={`draw-panel glass-panel ${spinning ? 'is-spinning' : ''} ${result ? 'has-result' : ''}`} aria-labelledby="draw-title">
            <div className="panel-topline"><span className="section-label"><Sparkles size={15} /> LUCKY DRAW</span><button className={`icon-button sound-button ${state.soundEnabled ? 'is-active' : ''}`} aria-label={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} aria-pressed={state.soundEnabled} title={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} disabled={spinning} onClick={() => setState(previous => ({ ...previous, soundEnabled: !previous.soundEnabled }))}>{state.soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}</button></div>
            <div className="draw-heading"><h2 id="draw-title">{spinning ? '두근두근, 어떤 선택일까요?' : result ? '당신의 작은 우연은' : '오늘의 행운을 뽑아보세요'}</h2><p>{spinning ? '선택지들을 골고루 섞고 있어요' : result ? '망설임은 여기까지. 이제 즐겨볼 시간!' : `${eligible.length}개의 선택지, 하나의 즐거운 결정`}</p></div>

            <div className="lottery-scene" aria-hidden="true" onPointerMove={event => {
              if (reducedMotion || event.pointerType !== 'mouse') return
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.style.setProperty('--pointer-x', `${((event.clientX - rect.left) / rect.width - 0.5) * 10}px`)
              event.currentTarget.style.setProperty('--pointer-y', `${((event.clientY - rect.top) / rect.height - 0.5) * 8}px`)
            }} onPointerLeave={event => { event.currentTarget.style.setProperty('--pointer-x', '0px'); event.currentTarget.style.setProperty('--pointer-y', '0px') }}>
              <div className="scene-halo" /><div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <span className="scene-spark spark-one">✦</span><span className="scene-spark spark-two">✧</span><span className="scene-dot dot-one" /><span className="scene-dot dot-two" />
              <span className="floating-label float-one"><span />made of possibilities</span><span className="floating-label float-two"><Sparkles size={12} /> a little bit of luck</span>
              <div className="globe-shadow" />
              <div className="glass-globe"><div className="globe-shine" /><div className="globe-ring" />
                <div className="lottery-balls">{(eligible.length ? eligible : []).slice(0, 7).map((item, index) => <div className={`lottery-ball ball-${index}`} key={item.id} style={{ '--ball-color': item.color, '--ball-delay': `${index * -0.38}s` } as CSSProperties}><span>{String(index + 1).padStart(2, '0')}</span><Flower /></div>)}</div>
                {eligible.length === 0 && <Flower className="empty-globe-flower" />}
                <div className="globe-front" /><span className="globe-wordmark">a moment of chance</span>
              </div>
              <div className="globe-base"><Flower /><span>MAKE A LITTLE MAGIC</span></div>
              {spinning && <div className="shuffle-preview" key={preview}>{preview}</div>}
              {result && <div className="confetti">{Array.from({ length: 16 }, (_, index) => <i key={`${result.id}-${index}`} style={{ '--i': index, '--confetti-color': PALETTE[index % PALETTE.length] } as CSSProperties} />)}</div>}
            </div>

            {result && <div className={`result-card ${result.label.length > 24 ? 'long-result' : ''}`} key={result.id}><span className="result-eyebrow"><Sparkles size={13} /> TODAY’S PICK</span><h3>{result.label}</h3><span className="result-probability">이 순간의 당첨 확률 {percentage(result.probability)}</span><button className="copy-result" onClick={() => void copyResult()} aria-label="뽑기 결과 복사" title="결과 복사"><Copy size={15} /></button></div>}
            <div className="draw-bottom">
              <div className="draw-action"><Button label={spinning ? '행운을 고르는 중…' : allDrawn ? '새 라운드 시작하기' : result ? '한 번 더 뽑기' : '행운 뽑기'} variant="primary" size="lg" width="100%" isDisabled={spinning || (!eligible.length && !allDrawn)} icon={allDrawn ? <RotateCcw size={19} /> : <Shuffle size={20} />} onClick={allDrawn ? resetRound : draw} /><ArrowRight className="draw-arrow" size={18} /></div>
              <p className="draw-hint">{allDrawn ? '모든 항목을 뽑았어요. 새로운 라운드를 시작해 보세요.' : !eligible.length ? '이름과 0보다 큰 비중을 가진 항목을 추가해 주세요.' : <><span className="desktop-shortcut"><kbd>Space</kbd> 키로도 뽑을 수 있어요</span><span className="mobile-hint">버튼을 눌러 오늘의 선택을 만나보세요</span></>}</p>
            </div>
            <div className="draw-panel-footer"><span className="status-dot" /><span>설정한 확률대로, 매번 새로운 우연</span><span className="footer-spark">✧</span></div>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{spinning ? '뽑기 진행 중입니다.' : result ? `뽑기 결과: ${result.label}. 당첨 확률 ${percentage(result.probability)}.` : ''}</p>
          </section>

          <section className="editor-panel glass-panel" ref={editorRef} aria-labelledby="editor-title">
            <div className="editor-heading"><Stack direction="horizontal" gap={2} vAlign="center"><SlidersHorizontal size={19} /><h2 id="editor-title">선택지 담기</h2><span className="count-badge">{state.items.length}</span></Stack><button className="text-button" disabled={spinning} onClick={() => setModal('new')}><RotateCcw size={13} /> 새로 만들기</button></div>
            <p className="editor-description">원하는 항목을 적고, 당첨 확률을 조절해 보세요.</p>
            <div className="editor-toolbar"><span>뽑기 항목 <span className="muted">/ 최대 {MAX_ITEMS}개</span></span><button className="text-button" disabled={spinning || !state.items.length} onClick={() => { setState(previous => ({ ...previous, items: previous.items.map(item => ({ ...item, weight: 20 })) })); setNotice({ message: '모든 항목의 비중을 같게 맞췄어요.' }) }}><Shuffle size={13} /> 균등하게</button></div>

            <div className="item-list">{state.items.length === 0 ? <div className="empty-items"><ListPlus size={30} strokeWidth={1.2} /><p>어떤 선택을 담아볼까요?</p><span>아래 버튼으로 첫 항목을 추가해 주세요.</span></div> : state.items.map((item, index) => {
              const isExcluded = excluded.includes(item.id)
              return <article className={`item-row ${isExcluded ? 'is-excluded' : ''} ${item.weight === 0 ? 'is-zero' : ''}`} key={item.id} data-item-id={item.id} style={{ '--item-color': item.color } as CSSProperties}>
                <div className="item-main"><span className="item-number">{isExcluded ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><TextInput label={`항목 ${index + 1} 이름`} isLabelHidden value={item.label} onChange={label => updateItem(item.id, { label: label.slice(0, MAX_LABEL_LENGTH) })} placeholder="항목 이름을 입력해 주세요" size="sm" isDisabled={spinning} width="100%" /><span className="item-percentage" aria-label={`실제 당첨 확률 ${percentage(odds[item.id] ?? 0)}`}>{isExcluded ? '당첨 완료' : percentage(odds[item.id] ?? 0)}</span><button className="remove-item icon-button" aria-label={`항목 ${index + 1} 삭제`} title="항목 삭제" disabled={spinning} onClick={() => removeItem(item.id)}><X size={15} /></button></div>
                <div className="item-weight"><Slider label={`항목 ${index + 1} 비중`} isLabelHidden value={item.weight} onChange={(weight: number) => updateItem(item.id, { weight })} min={0} max={100} step={1} valueDisplay="none" isDisabled={spinning || isExcluded} width="100%" /><label className="weight-input"><span>비중</span><input aria-label={`항목 ${index + 1} 비중 직접 입력`} type="number" inputMode="numeric" min={0} max={100} step={1} value={item.weight} disabled={spinning || isExcluded} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) updateItem(item.id, { weight: Math.min(100, Math.max(0, Math.round(value))) }) }} /></label></div>
              </article>
            })}</div>

            <div className="add-actions"><button className="add-item" disabled={spinning || state.items.length >= MAX_ITEMS} onClick={addItem}><Plus size={17} /> 항목 추가</button><button className="bulk-add" disabled={spinning || state.items.length >= MAX_ITEMS} onClick={() => { setBulkError(''); setModal('bulk') }} aria-label="여러 항목 한 번에 추가" title="여러 항목 한 번에 추가"><ListPlus size={19} /></button></div>
            {hasBlank && <p className="inline-note">이름이 비어 있는 항목은 뽑기에서 제외돼요.</p>}

            <div className="probability-summary"><div className="probability-summary-heading"><span>전체 당첨 확률</span><strong>{eligible.length ? '100' : '0'}<span>%</span></strong></div><div className="probability-bar" aria-label="항목별 확률 분포">{state.items.map(item => (odds[item.id] ?? 0) > 0 && <span key={item.id} style={{ width: `${odds[item.id]}%`, backgroundColor: item.color }} title={`${item.label}: ${percentage(odds[item.id])}`} />)}</div><p><CircleHelp size={12} /> 비중에 따라 확률이 자동으로 계산돼요. 비중 0은 제외돼요.</p></div>
            <div className="exclude-setting"><Switch label="당첨된 항목 제외" value={state.excludeWinners} onChange={value => { setState(previous => ({ ...previous, excludeWinners: value, excludedIds: [] })); setNotice({ message: value ? '지금부터 당첨된 항목은 다음 뽑기에서 제외돼요.' : '모든 항목이 다시 뽑기에 참여해요.' }) }} isDisabled={spinning} size="sm" labelPosition="start" labelSpacing="spread" width="100%" /><div className="exclude-description"><span>한 번 뽑힌 항목은 다음 뽑기에서 빼둘게요.</span>{state.excludeWinners && state.excludedIds.length > 0 && <button disabled={spinning} className="text-button" onClick={resetRound}>다시 포함</button>}</div></div>
          </section>
        </div>

        <section className="history-section" aria-labelledby="history-title"><div className="history-heading"><Stack direction="horizontal" gap={2} vAlign="center"><History size={17} /><h2 id="history-title">지나간 우연들</h2><span className="history-count">{state.history.length}</span></Stack><div className="history-controls"><span>최근 {MAX_HISTORY}회 보관</span>{state.history.length > 0 && <button className="text-button" disabled={spinning} onClick={() => { const history = state.history; setState(previous => ({ ...previous, history: [] })); setNotice({ message: '뽑기 기록을 비웠어요.', undo: () => setState(previous => ({ ...previous, history: [...previous.history, ...history].slice(0, MAX_HISTORY) })) }) }}><Trash2 size={13} /> 기록 비우기</button>}</div></div>
          {state.history.length ? <><ol className="history-list">{(showAllHistory ? state.history : state.history.slice(0, 5)).map((entry, index) => <li key={entry.id}><span className="history-item-dot" style={{ backgroundColor: entry.color }} /><div><strong>{entry.label}</strong><span>{new Date(entry.drawnAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} · {percentage(entry.probability)}</span></div>{index === 0 && <span className="latest-badge">방금 뽑은</span>}</li>)}</ol>{state.history.length > 5 && <button className="history-expand text-button" onClick={() => setShowAllHistory(!showAllHistory)}>{showAllHistory ? '접기' : `기록 ${state.history.length}개 모두 보기`}<ChevronDown size={14} style={{ transform: showAllHistory ? 'rotate(180deg)' : undefined }} /></button>}</> : <div className="empty-history"><span className="empty-history-icon"><History size={20} strokeWidth={1.3} /></span><p>아직 조용하네요.<span>첫 번째 우연을 만들어 보세요.</span></p><ArrowDown size={16} /></div>}
        </section>
        <div className="bottom-note"><span><Flower /> 매일의 작은 결정을 조금 더 즐겁게.</span><span>ALL YOU NEED IS A LITTLE LUCK.</span></div>
      </main>

      <footer className="site-footer"><a className="footer-brand" href="./">bbob.</a><span>가볍게 뽑고, 즐겁게 선택하세요.</span><span>Made for your little moments <Flower /></span></footer>

      {notice && <div className="toast" role="status"><Check size={17} /><span>{notice.message}</span>{notice.undo && <button disabled={spinning} onClick={() => { notice.undo?.(); setNotice(null) }}>되돌리기</button>}<button className="toast-close" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      <dialog className="app-dialog" ref={dialogRef} onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setModal(null) } }} aria-labelledby="dialog-title">
        <button className="dialog-close icon-button" onClick={() => setModal(null)} aria-label="창 닫기"><X size={20} /></button>
        {modal === 'help' && <><span className="dialog-symbol"><Flower /></span><p className="eyebrow">A SMALL GUIDE</p><h2 id="dialog-title">가벼운 선택을 위한 세 단계</h2><ol className="help-steps"><li><span>01</span><div><strong>선택지를 담아 주세요</strong><p>먹고 싶은 메뉴, 친구 이름, 선물까지. 텍스트로 최대 30개를 입력할 수 있어요.</p></div></li><li><span>02</span><div><strong>원하는 만큼 비중을 조절하세요</strong><p>비중이 20과 10이면 당첨 확률은 2:1이에요. 표시된 %가 실제 확률이며, 0인 항목과 빈 항목은 뽑히지 않아요.</p></div></li><li><span>03</span><div><strong>나머지는 우연에 맡겨보세요</strong><p>행운 뽑기 버튼이나 Space 키를 눌러 보세요. ‘당첨된 항목 제외’를 켜면 중복 없이 뽑을 수 있어요.</p></div></li></ol><p className="privacy-note">항목과 기록은 현재 브라우저에만 저장돼요. 브라우저 데이터를 지우면 함께 사라집니다.</p><Button label="좋아요, 시작할게요" variant="primary" width="100%" onClick={() => setModal(null)} /></>}
        {modal === 'bulk' && <form onSubmit={addBulk}><p className="eyebrow">MORE POSSIBILITIES</p><h2 id="dialog-title">여러 항목, 한 번에.</h2><p className="dialog-description">한 줄에 하나씩 적어 주세요. 모두 같은 비중으로 추가돼요.</p><label className="bulk-label" htmlFor="bulk-items">추가할 항목 <span>최대 {MAX_ITEMS - state.items.length}개 더 추가 가능</span></label><textarea id="bulk-items" value={bulkText} onChange={event => setBulkText(event.target.value)} placeholder={'아이스 아메리카노\n따뜻한 라테\n달콤한 밀크티'} rows={7} maxLength={MAX_ITEMS * (MAX_LABEL_LENGTH + 2)} aria-describedby={bulkError ? 'bulk-error' : undefined} aria-invalid={!!bulkError} />{bulkError && <p className="form-error" id="bulk-error" role="alert">{bulkError}</p>}<Button label="선택지에 추가하기" type="submit" variant="primary" width="100%" icon={<Plus size={17} />} /></form>}
        {modal === 'new' && <><span className="dialog-symbol"><RotateCcw size={26} /></span><h2 id="dialog-title">새로운 선택을 담아볼까요?</h2><p className="dialog-description">현재 항목과 기록을 비우고 빈 목록으로 시작해요.</p><Stack direction="horizontal" gap={2}><Button label="취소" width="100%" onClick={() => setModal(null)} /><Button label="새로 만들기" variant="primary" width="100%" onClick={() => { const previousState = state; setState(previous => ({ ...previous, items: [], history: [], excludedIds: [] })); setResult(null); setModal(null); setNotice({ message: '새로운 뽑기를 만들었어요.', undo: () => setState(previousState) }) }} /></Stack></>}
      </dialog>
    </div>
  )
}

export default App
