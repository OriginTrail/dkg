import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  placement: 'below' | 'above';
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  className,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [highlight, setHighlight] = useState<number>(() => {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? placeholder;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeightEstimate = Math.min(240, options.length * 36 + 16);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placement: 'below' | 'above' =
      spaceBelow < menuHeightEstimate + 16 && spaceAbove > spaceBelow ? 'above' : 'below';
    setPosition({
      left: rect.left,
      top: placement === 'below' ? rect.bottom + 4 : rect.top - 4,
      width: rect.width,
      placement,
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) computePosition();
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => computePosition();
    const onResize = () => computePosition();
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, close, computePosition]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlight(idx >= 0 ? idx : 0);
      // focus menu for keyboard nav
      requestAnimationFrame(() => menuRef.current?.focus());
    }
  }, [open, value, options]);

  // If the parent flips `disabled` to true while the menu is open the
  // trigger greys out but the portal-rendered menu stays mounted and
  // interactive — users could keep clicking stale options. Close the
  // menu in that case so the menu state matches the trigger's affordance.
  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => {
        for (let i = 1; i <= options.length; i++) {
          const next = (h + i) % options.length;
          if (!options[next]?.disabled) return next;
        }
        return h;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => {
        for (let i = 1; i <= options.length; i++) {
          const next = (h - i + options.length) % options.length;
          if (!options[next]?.disabled) return next;
        }
        return h;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[highlight];
      if (opt && !opt.disabled) {
        onChange(opt.value);
        close();
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      // Find the first enabled option so Home doesn't land on a disabled
      // entry that makes Enter a no-op (matches the ArrowUp/Down behavior).
      const firstEnabled = options.findIndex((o) => !o.disabled);
      if (firstEnabled >= 0) setHighlight(firstEnabled);
    } else if (e.key === 'End') {
      e.preventDefault();
      // Find the last enabled option for the same reason.
      let lastEnabled = -1;
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i]?.disabled) { lastEnabled = i; break; }
      }
      if (lastEnabled >= 0) setHighlight(lastEnabled);
    }
  };

  const rootClassName = ['v10-select', className, disabled ? 'disabled' : '', open ? 'open' : ''].filter(Boolean).join(' ');

  const menuStyle: React.CSSProperties | undefined = position
    ? position.placement === 'below'
      ? { position: 'fixed', left: position.left, top: position.top, width: position.width }
      : { position: 'fixed', left: position.left, top: position.top, width: position.width, transform: 'translateY(-100%)' }
    : undefined;

  return (
    <div ref={rootRef} className={rootClassName}>
      <button
        ref={triggerRef}
        type="button"
        className="v10-select-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={`v10-select-value ${selected ? '' : 'placeholder'}`}>{displayLabel}</span>
        <ChevronDown className="v10-select-caret" size={12} aria-hidden="true" />

      </button>

      {open && position && createPortal(
        <ul
          ref={menuRef}
          className={`v10-select-menu v10-select-menu-${position.placement}`}
          role="listbox"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          style={menuStyle}
        >
          {options.length === 0 && (
            <li className="v10-select-option empty" aria-disabled="true">No options</li>
          )}
          {options.map((opt, idx) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={[
                'v10-select-option',
                opt.value === value ? 'selected' : '',
                idx === highlight ? 'highlighted' : '',
                opt.disabled ? 'disabled' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => setHighlight(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // Guard with `disabled` as well — the menu lives in a portal,
                // so without this a race where the parent flips `disabled`
                // mid-interaction could still commit a stale option (the
                // close-on-disabled effect above will follow up, but the
                // click could still race ahead of the effect on the same
                // tick).
                if (disabled || opt.disabled) return;
                onChange(opt.value);
                close();
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
