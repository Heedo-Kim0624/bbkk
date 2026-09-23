import type { CSSProperties, RefObject } from 'react'
import { Copy } from 'lucide-react'
import { TIERS, type DrawResult } from '../lib/draw'
import './tarot.css'

export type TarotDrawProps = {
  phase: 'idle' | 'shuffling' | 'choosing' | 'revealing' | 'revealed'
  result: DrawResult | null
  selectedIndex: number | null
  onChoose: (index: number) => void
  onCopy: () => void
  cardRef: RefObject<HTMLButtonElement | null>
  resultRef: RefObject<HTMLHeadingElement | null>
}

function Star({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="m20 3 3.8 13.2L37 20l-13.2 3.8L20 37l-3.8-13.2L3 20l13.2-3.8L20 3Z" stroke="currentColor" strokeWidth=".85" />
    <path d="m9 9 8.3 8.3M22.7 22.7 31 31M31 9l-8.3 8.3M17.3 22.7 9 31" stroke="currentColor" strokeWidth=".65" />
    <circle cx="20" cy="20" r="3" fill="currentColor" />
  </svg>
}

function CardBack() {
  return <svg className="tarot-back-art" viewBox="0 0 160 260" fill="none" aria-hidden="true">
    <rect x="9" y="9" width="142" height="242" rx="8" stroke="currentColor" strokeWidth=".7" />
    <rect x="15" y="15" width="130" height="230" rx="5" stroke="currentColor" strokeWidth=".35" opacity=".65" />
    <path d="M15 38c13 0 23-10 23-23M122 15c0 13 10 23 23 23M15 222c13 0 23 10 23 23M122 245c0-13 10-23 23-23" stroke="currentColor" strokeWidth=".65" />
    <path d="m80 40 47 90-47 90-47-90 47-90Z" stroke="currentColor" strokeWidth=".6" opacity=".8" />
    <path d="M80 48v164M40 130h80" stroke="currentColor" strokeWidth=".35" opacity=".5" />
    <ellipse cx="80" cy="130" rx="37" ry="59" stroke="currentColor" strokeWidth=".5" />
    <ellipse cx="80" cy="130" rx="48" ry="23" transform="rotate(-36 80 130)" stroke="currentColor" strokeWidth=".45" opacity=".7" />
    <circle cx="80" cy="130" r="25" stroke="currentColor" strokeWidth=".75" />
    <circle cx="80" cy="130" r="20" stroke="currentColor" strokeWidth=".35" opacity=".65" />
    <path d="m80 110 4.7 15.3L100 130l-15.3 4.7L80 150l-4.7-15.3L60 130l15.3-4.7L80 110Z" stroke="currentColor" strokeWidth=".85" />
    <circle cx="80" cy="130" r="3.5" fill="currentColor" />
    <path d="M83 60a10 10 0 1 0 0 18 10 10 0 0 1 0-18Z" stroke="currentColor" strokeWidth=".7" />
    <path d="m80 190 2.2 5.8L88 198l-5.8 2.2L80 206l-2.2-5.8L72 198l5.8-2.2L80 190Z" stroke="currentColor" strokeWidth=".6" />
    <path d="m32 67 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Zm96 112 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z" stroke="currentColor" strokeWidth=".5" />
    <g fill="currentColor"><circle cx="115" cy="78" r="1.15" /><circle cx="44" cy="182" r="1.15" /><circle cx="41" cy="106" r=".9" /><circle cx="119" cy="154" r=".9" /><circle cx="80" cy="27" r="1.1" /><circle cx="80" cy="233" r="1.1" /></g>
  </svg>
}

function formatProbability(value: number) {
  if (value > 0 && value < 0.1) return '<0.1%'
  if (value > 99.9 && value < 100) return '>99.9%'
  return `${Number(value.toFixed(1))}%`
}

export function TarotDraw({ phase, result, selectedIndex, onChoose, onCopy, cardRef, resultRef }: TarotDrawProps) {
  const hasSelection = (phase === 'revealing' || phase === 'revealed') && result !== null && selectedIndex !== null
  const resultTier = TIERS.find(tier => tier.id === result?.tier)

  return <div className={`tarot-draw phase-${phase}`} data-phase={phase} data-selected-index={hasSelection ? selectedIndex : undefined}>
    <div className="tarot-atmosphere" aria-hidden="true"><span className="tarot-orbit" /><span className="tarot-orbit tarot-orbit-inner" /><Star className="tarot-star tarot-star-one" /><Star className="tarot-star tarot-star-two" /><span className="tarot-dust tarot-dust-one" /><span className="tarot-dust tarot-dust-two" /></div>
    <div className="tarot-stage" role="group" aria-label="다섯 장의 카드">
      {Array.from({ length: 5 }, (_, index) => {
        const selected = hasSelection && selectedIndex === index
        const offset = index - 2
        return <div
          key={index}
          className={`tarot-card-slot ${selected ? 'is-selected' : ''} ${hasSelection && !selected ? 'is-dismissed' : ''}`}
          data-card-index={index}
          style={{ '--card-index': offset, '--card-angle': `${offset * 12}deg`, '--card-drop': `${Math.abs(offset) * 11}px`, '--card-order': index + 1, '--shuffle-delay': `${index * -0.16}s` } as CSSProperties}
        >
          <div className="tarot-flipper">
            <button
              ref={index === 2 ? cardRef : undefined}
              type="button"
              className="tarot-choice"
              aria-label={`${index + 1}번 카드 선택`}
              aria-hidden={hasSelection ? true : undefined}
              disabled={phase !== 'choosing'}
              onClick={() => onChoose(index)}
            ><CardBack /><span className="tarot-back-glint" aria-hidden="true" /></button>
            {selected && result && <article
              className={`result-card tarot-front tier-${result.tier ?? 'high'}`}
              data-tier={result.tier ?? 'high'}
              aria-hidden={phase !== 'revealed'}
            >
              <div className="tarot-front-ornament" aria-hidden="true"><span /><Star /><span /></div>
              <span className="result-eyebrow">{resultTier?.label ?? '결과'}</span>
              <h3 ref={resultRef} tabIndex={-1}>{result.label}</h3>
              <div className="tarot-result-footer"><span className="result-probability" aria-label={`당첨 확률 ${formatProbability(result.probability)}`}>{formatProbability(result.probability)}</span><button type="button" className="copy-result" aria-label="뽑기 결과 복사" title="결과 복사" tabIndex={phase === 'revealed' ? 0 : -1} onClick={onCopy}><Copy size={15} /></button></div>
            </article>}
          </div>
        </div>
      })}
    </div>
    <span className="tarot-ground" aria-hidden="true" />
  </div>
}

export default TarotDraw
