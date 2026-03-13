import React, { useState, useRef, useCallback, useEffect } from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  /** max-width in px, default 280 */
  maxWidth?: number;
}

export function Tooltip({ text, children, maxWidth = 280 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
    setVisible(true);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  // Reposition if it overflows viewport
  useEffect(() => {
    if (!visible || !tipRef.current || !pos) return;
    const tip = tipRef.current;
    const r = tip.getBoundingClientRect();
    let x = pos.x;
    let y = pos.y;

    // Push left if overflowing right
    if (r.right > window.innerWidth - 12) {
      x -= r.right - window.innerWidth + 12;
    }
    // Push right if overflowing left
    if (r.left < 12) {
      x += 12 - r.left;
    }
    // Flip below if overflowing top
    if (r.top < 12) {
      const triggerRect = triggerRef.current!.getBoundingClientRect();
      y = triggerRect.bottom;
      tip.classList.add('tt-below');
    } else {
      tip.classList.remove('tt-below');
    }

    if (x !== pos.x || y !== pos.y) {
      setPos({ x, y });
    }
  }, [visible, pos]);

  return (
    <span
      ref={triggerRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      style={{ display: 'inline-flex', alignItems: 'center' }}
    >
      {children}
      {visible && pos && (
        <div
          ref={tipRef}
          className="tt"
          style={{
            left: pos.x,
            top: pos.y,
            maxWidth,
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

/** Small info icon that wraps a Tooltip */
export function InfoTip({ text, maxWidth }: { text: string; maxWidth?: number }) {
  return (
    <Tooltip text={text} maxWidth={maxWidth}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4, verticalAlign: 'middle', opacity: 0.7 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </Tooltip>
  );
}
