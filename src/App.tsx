import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Stack } from '@astryxdesign/core/Stack'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Slider } from '@astryxdesign/core/Slider'
import { Switch } from '@astryxdesign/core/Switch'
import { ArrowRight, Check, ChevronDown, CircleHelp, Copy, History, ListPlus, Plus, RotateCcw, Shuffle, SlidersHorizontal, Sparkles, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { DEFAULT_ITEMS, MAX_HISTORY, MAX_ITEMS, MAX_LABEL_LENGTH, PALETTE, STORAGE_KEY, getEligibleItems, migrateRunningDefaults, parseSavedState, pickWeighted, probabilities, type DrawItem, type DrawResult, type SavedState } from './lib/draw'

type Notice = { message: string; undo?: () => void }
type Modal = 'help' | 'bulk' | 'new' | null

function initialState(): SavedState {
  try {
    const saved = parseSavedState(localStorage.getItem(STORAGE_KEY))
    if (saved) return migrateRunningDefaults(saved)
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
    setNotice(null)
    if (state.soundEnabled) {
      try {
        audioRef.current ??= new AudioContext()
        void audioRef.current.resume().catch(() => {})
      } catch { /* Sound is optional and must never prevent a draw. */ }
    }
    const selected: DrawResult = { id: crypto.randomUUID(), itemId: winner.id, label: winner.label.trim(), color: winner.color, probability: probabilities(state.items, exclusions)[winner.id], drawnAt: Date.now() }
    setResult(null)
    setPreview('뽑는 중…')
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
    setNotice({ message: '삭제됨', undo: () => setState(previous => {
      if (previous.items.length >= MAX_ITEMS || previous.items.some(item => item.id === id)) return previous
      const items = [...previous.items]
      items.splice(Math.min(index, items.length), 0, removed)
      return { ...previous, items, excludedIds: wasExcluded ? [...previous.excludedIds, id] : previous.excludedIds }
    }) })
  }

  function addBulk(event: FormEvent) {
    event.preventDefault()
    const labels = bulkText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (!labels.length) { setBulkError('항목을 입력해 주세요.'); return }
    if (labels.some(label => label.length > MAX_LABEL_LENGTH)) { setBulkError(`이름은 ${MAX_LABEL_LENGTH}자 이하로 입력하세요.`); return }
    if (state.items.length + labels.length > MAX_ITEMS) { setBulkError(`최대 ${MAX_ITEMS}개 · ${MAX_ITEMS - state.items.length}개 추가 가능`); return }
    setState(previous => ({ ...previous, items: [...previous.items, ...labels.map((label, index) => ({ id: crypto.randomUUID(), label, weight: 20, color: PALETTE[(previous.items.length + index) % PALETTE.length] }))] }))
    setBulkText('')
    setBulkError('')
    setModal(null)
    setNotice({ message: `${labels.length}개 추가됨` })
  }

  function resetRound() {
    setState(previous => ({ ...previous, excludedIds: [] }))
    setResult(null)
    setNotice({ message: '전체 항목 포함' })
  }

  function resetItems(useDefaults: boolean) {
    const previousState = state
    setState(previous => ({ ...previous, items: useDefaults ? DEFAULT_ITEMS.map(item => ({ ...item })) : [], history: [], excludedIds: [] }))
    setResult(null)
    setModal(null)
    setNotice({ message: useDefaults ? '기본 벌칙으로 변경됨' : '목록 비움', undo: () => setState(previousState) })
  }

  async function copyResult() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(`오늘의 벌칙: ${result.label} (${percentage(result.probability)})`)
      setNotice({ message: '복사됨' })
    } catch { setNotice({ message: '복사 실패 · 텍스트를 직접 선택하세요.' }) }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#draw-studio">뽑기로 바로 가기</a>
      <header className="site-header">
        <a href="./" className="brand" aria-label="뽑, 홈"><Flower /><span>bbob<span className="brand-period">.</span></span><span className="brand-korean">뽑</span></a>
        <Stack direction="horizontal" gap={4} vAlign="center">
          <span className={`save-status ${storageOkay ? '' : 'save-error'}`} title={storageOkay ? '이 브라우저에 자동 저장' : '이 브라우저에서는 저장할 수 없습니다'}><span className="status-dot" />{storageOkay ? '저장됨' : '저장 불가'}</span>
          <button className="help-button" aria-label="이용 방법" title="이용 방법" onClick={() => setModal('help')}><CircleHelp size={17} /></button>
        </Stack>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div className="intro-copy"><h1 id="page-title">러닝 <span>약속</span><Flower /></h1><p className="intro-description">이틀 연속 쉬면, 벌칙 하나.</p></div>
        </section>

        <div className="studio-grid" id="draw-studio">
          <section className={`draw-panel glass-panel ${spinning ? 'is-spinning' : ''} ${result ? 'has-result' : ''}`} aria-labelledby="draw-title">
            <div className="panel-topline"><Sparkles className="section-spark" size={17} aria-hidden="true" /><button className={`icon-button sound-button ${state.soundEnabled ? 'is-active' : ''}`} aria-label={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} aria-pressed={state.soundEnabled} title={state.soundEnabled ? '효과음 끄기' : '효과음 켜기'} disabled={spinning} onClick={() => setState(previous => ({ ...previous, soundEnabled: !previous.soundEnabled }))}>{state.soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}</button></div>
            <div className="draw-heading"><h2 id="draw-title">{spinning ? '뽑는 중…' : '오늘의 벌칙'}</h2></div>

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
                <div className="lottery-balls">{(eligible.length ? eligible : []).slice(0, 7).map((item, index) => <div className={`lottery-ball ball-${index}`} key={item.id} style={{ '--ball-color': item.color, '--ball-delay': `${index * -0.38}s` } as CSSProperties}><span>{String(index + 1).padStart(2, '0')}</span><Flower /></div>)}</div>
                {eligible.length === 0 && <Flower className="empty-globe-flower" />}
                <div className="globe-front" />
              </div>
              <div className="globe-base"><Flower /></div>
              {spinning && <div className="shuffle-preview" key={preview}>{preview}</div>}
              {result && <div className="confetti">{Array.from({ length: 16 }, (_, index) => <i key={`${result.id}-${index}`} style={{ '--i': index, '--confetti-color': PALETTE[index % PALETTE.length] } as CSSProperties} />)}</div>}
            </div>

            {result && <div className={`result-card ${result.label.length > 24 ? 'long-result' : ''}`} key={result.id}><span className="result-eyebrow"><Sparkles size={13} /> 결과</span><h3>{result.label}</h3><span className="result-probability" aria-label={`당첨 확률 ${percentage(result.probability)}`}>{percentage(result.probability)}</span><button className="copy-result" onClick={() => void copyResult()} aria-label="뽑기 결과 복사" title="결과 복사"><Copy size={15} /></button></div>}
            <div className="draw-bottom">
              <div className="draw-action"><Button label={spinning ? '뽑는 중…' : allDrawn ? '다시 시작' : result ? '다시 뽑기' : '벌칙 뽑기'} variant="primary" size="lg" width="100%" isDisabled={spinning || (!eligible.length && !allDrawn)} icon={allDrawn ? <RotateCcw size={19} /> : <Shuffle size={20} />} onClick={allDrawn ? resetRound : draw} /><ArrowRight className="draw-arrow" size={18} /></div>
              <p className="draw-hint">{allDrawn ? '모두 뽑았어요.' : !eligible.length ? '이름과 비중을 입력하세요.' : <span className="desktop-shortcut"><kbd title="Space 키로 뽑기">Space</kbd></span>}</p>
            </div>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{spinning ? '뽑기 진행 중입니다.' : result ? `뽑기 결과: ${result.label}. 당첨 확률 ${percentage(result.probability)}.` : ''}</p>
          </section>

          <section className="editor-panel glass-panel" ref={editorRef} aria-labelledby="editor-title">
            <div className="editor-heading"><Stack direction="horizontal" gap={2} vAlign="center"><SlidersHorizontal size={19} /><h2 id="editor-title">벌칙</h2><span className="count-badge">{state.items.length}</span></Stack><button className="text-button" aria-label="초기화" disabled={spinning} onClick={() => setModal('new')}><RotateCcw size={13} /> 초기화</button></div>
            <div className="editor-toolbar"><span>비중 조절</span><button className="text-button" disabled={spinning || !state.items.length} onClick={() => { setNotice(null); setState(previous => ({ ...previous, items: previous.items.map(item => ({ ...item, weight: 20 })) })) }}><Shuffle size={13} /> 동일하게</button></div>

            <div className="item-list">{state.items.length === 0 ? <div className="empty-items"><ListPlus size={30} strokeWidth={1.2} /><p>벌칙을 추가하세요.</p></div> : state.items.map((item, index) => {
              const isExcluded = excluded.includes(item.id)
              return <article className={`item-row ${isExcluded ? 'is-excluded' : ''} ${item.weight === 0 ? 'is-zero' : ''}`} key={item.id} data-item-id={item.id} style={{ '--item-color': item.color } as CSSProperties}>
                <div className="item-main"><span className="item-number">{isExcluded ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><TextInput label={`항목 ${index + 1} 이름`} isLabelHidden value={item.label} onChange={label => updateItem(item.id, { label: label.slice(0, MAX_LABEL_LENGTH) })} placeholder="벌칙 입력" size="sm" isDisabled={spinning} width="100%" /><span className="item-percentage" aria-label={`실제 당첨 확률 ${percentage(odds[item.id] ?? 0)}`}>{isExcluded ? '제외' : percentage(odds[item.id] ?? 0)}</span><button className="remove-item icon-button" aria-label={`항목 ${index + 1} 삭제`} title="항목 삭제" disabled={spinning} onClick={() => removeItem(item.id)}><X size={15} /></button></div>
                <div className="item-weight"><Slider label={`항목 ${index + 1} 비중`} isLabelHidden value={item.weight} onChange={(weight: number) => updateItem(item.id, { weight })} min={0} max={100} step={1} valueDisplay="none" isDisabled={spinning || isExcluded} width="100%" /><label className="weight-input"><input aria-label={`항목 ${index + 1} 비중 직접 입력`} type="number" inputMode="numeric" min={0} max={100} step={1} value={item.weight} disabled={spinning || isExcluded} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) updateItem(item.id, { weight: Math.min(100, Math.max(0, Math.round(value))) }) }} /></label></div>
              </article>
            })}</div>

            <div className="add-actions"><button className="add-item" aria-label="항목 추가" disabled={spinning || state.items.length >= MAX_ITEMS} onClick={addItem}><Plus size={17} /> 추가</button><button className="bulk-add" disabled={spinning || state.items.length >= MAX_ITEMS} onClick={() => { setBulkError(''); setModal('bulk') }} aria-label="여러 항목 한 번에 추가" title="여러 항목 한 번에 추가"><ListPlus size={19} /></button></div>
            {hasBlank && <p className="inline-note">빈 항목은 제외돼요.</p>}

            <div className="probability-summary"><div className="probability-summary-heading"><span>확률</span><strong>{eligible.length ? '100' : '0'}<span>%</span></strong></div><div className="probability-bar" aria-label="항목별 확률 분포">{state.items.map(item => (odds[item.id] ?? 0) > 0 && <span key={item.id} style={{ width: `${odds[item.id]}%`, backgroundColor: item.color }} title={`${item.label}: ${percentage(odds[item.id])}`} />)}</div></div>
            <div className="exclude-setting"><Switch label="중복 제외" value={state.excludeWinners} onChange={value => { setNotice(null); setState(previous => ({ ...previous, excludeWinners: value, excludedIds: [] })) }} isDisabled={spinning} size="sm" labelPosition="start" labelSpacing="spread" width="100%" />{state.excludeWinners && state.excludedIds.length > 0 && <button disabled={spinning} className="text-button restore-items" onClick={resetRound}>전체 포함</button>}</div>
          </section>
        </div>

        <section className="history-section" aria-labelledby="history-title"><div className="history-heading"><Stack direction="horizontal" gap={2} vAlign="center"><History size={17} /><h2 id="history-title">기록</h2><span className="history-count">{state.history.length}</span></Stack><div className="history-controls">{state.history.length > 0 && <button className="text-button" aria-label="기록 비우기" disabled={spinning} onClick={() => { const history = state.history; setState(previous => ({ ...previous, history: [] })); setNotice({ message: '기록 비움', undo: () => setState(previous => ({ ...previous, history: [...previous.history, ...history].slice(0, MAX_HISTORY) })) }) }}><Trash2 size={13} /> 비우기</button>}</div></div>
          {state.history.length ? <><ol className="history-list">{(showAllHistory ? state.history : state.history.slice(0, 5)).map(entry => <li key={entry.id}><span className="history-item-dot" style={{ backgroundColor: entry.color }} /><div><strong>{entry.label}</strong><span>{new Date(entry.drawnAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} · {percentage(entry.probability)}</span></div></li>)}</ol>{state.history.length > 5 && <button className="history-expand text-button" onClick={() => setShowAllHistory(!showAllHistory)}>{showAllHistory ? '접기' : `전체 ${state.history.length}개`}<ChevronDown size={14} style={{ transform: showAllHistory ? 'rotate(180deg)' : undefined }} /></button>}</> : <div className="empty-history"><p>아직 기록이 없어요.</p></div>}
        </section>
      </main>

      <footer className="site-footer"><a className="footer-brand" href="./" aria-label="뽑, 홈">bbob.</a><Flower /></footer>

      {notice && <div className="toast" role="status"><Check size={17} /><span>{notice.message}</span>{notice.undo && <button disabled={spinning} onClick={() => { notice.undo?.(); setNotice(null) }}>되돌리기</button>}<button className="toast-close" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      <dialog className="app-dialog" ref={dialogRef} onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setModal(null) } }} aria-labelledby="dialog-title">
        <button className="dialog-close icon-button" onClick={() => setModal(null)} aria-label="창 닫기"><X size={20} /></button>
        {modal === 'help' && <><h2 id="dialog-title">이용 방법</h2><ul className="help-summary"><li>이틀 연속 쉬면 벌칙 하나를 뽑아요.</li><li>이름을 입력하고 비중을 조절하세요.</li><li>비중 20 : 10이면 확률은 2 : 1. 0은 제외돼요.</li><li>‘중복 제외’를 켜면 같은 벌칙은 다시 뽑히지 않아요.</li></ul><p className="privacy-note">최대 30개 · 기록은 이 브라우저에만 저장됩니다.</p><Button label="닫기" variant="primary" width="100%" onClick={() => setModal(null)} /></>}
        {modal === 'bulk' && <form onSubmit={addBulk}><h2 id="dialog-title">한 번에 추가</h2><p className="dialog-description">한 줄에 하나씩.</p><label className="bulk-label" htmlFor="bulk-items">추가할 항목 <span>{MAX_ITEMS - state.items.length}개까지</span></label><textarea id="bulk-items" value={bulkText} onChange={event => setBulkText(event.target.value)} placeholder={'청소 20분\n설거지 전담\n친구에게 커피 사기'} rows={7} maxLength={MAX_ITEMS * (MAX_LABEL_LENGTH + 2)} aria-describedby={bulkError ? 'bulk-error' : undefined} aria-invalid={!!bulkError} />{bulkError && <p className="form-error" id="bulk-error" role="alert">{bulkError}</p>}<Button label="추가하기" type="submit" variant="primary" width="100%" icon={<Plus size={17} />} /></form>}
        {modal === 'new' && <><h2 id="dialog-title">목록 초기화</h2><p className="dialog-description">현재 항목과 기록을 지웁니다.</p><Stack direction="horizontal" gap={2}><Button label="비우기" width="100%" onClick={() => resetItems(false)} /><Button label="기본 벌칙" variant="primary" width="100%" onClick={() => resetItems(true)} /></Stack></>}
      </dialog>
    </div>
  )
}

export default App
