import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Turn } from '../server/agents.ts';
import { money } from './api';

/* Small pieces shared by the one-stall arena and the street crawl. */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function useCount(target: number, ms = 650) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduced()) {
      setV(target);
      from.current = target;
      return;
    }
    const a = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const cur = a + (target - a) * (1 - Math.pow(1 - p, 3));
      from.current = cur;
      setV(p >= 1 ? target : cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function Bubble({ tone, turn, active, empty, label }: { tone: 'buyer' | 'seller'; turn?: Turn; active: boolean; empty: string; label?: string }) {
  return (
    <div className={`bubble ${tone}${active ? ' on' : ''}`}>
      {label && turn && <span className="bubble-label">To {label}</span>}
      <AnimatePresence mode="wait">
        <motion.p key={turn ? `${turn.round}-${turn.side}-${turn.action}-${turn.price}-${label ?? ''}` : 'empty'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          {turn ? turn.line : empty}
        </motion.p>
      </AnimatePresence>
      {turn?.price != null && (
        <span className="bubble-price">
          {turn.action === 'accept' ? 'Accepted at ' : turn.side === 'buyer' ? 'Offers ' : 'Asks '}
          {money(turn.price)}
        </span>
      )}
    </div>
  );
}

export function PriceTag({ value, caption, swing, swingKey, deal, currency }: { value: number; caption: string; swing: number; swingKey: string; deal: boolean; currency: string }) {
  const shown = useCount(value);
  const text = Math.abs(shown - value) < 0.005 ? money(value, currency) : money(Math.round(shown), currency);
  return (
    <div className="tag-wrap" aria-live="polite">
      <svg className="tag-string" viewBox="0 0 4 70" aria-hidden="true">
        <line x1="2" y1="0" x2="2" y2="70" stroke="var(--brass)" strokeWidth="2" />
      </svg>
      <motion.div key={swingKey} className={`price-tag${deal ? ' deal' : ''}`} style={{ transformOrigin: '50% 0' }} initial={{ rotate: 0 }} animate={reduced() ? { rotate: 0 } : { rotate: [0, 11 * swing, -6 * swing, 3 * swing, 0] }} transition={{ duration: 1.1, ease: 'easeOut' }}>
        <span className="tag-caption">{caption}</span>
        <strong>{text}</strong>
      </motion.div>
    </div>
  );
}
