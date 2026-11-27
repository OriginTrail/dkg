/**
 * Toggle — an on/off setting that takes effect straight away (see DESIGN.md).
 * Use a checkbox instead when the choice is applied by a later button press.
 *
 * It always needs a name: pass `aria-label`, or `aria-labelledby` when a
 * visible label sits beside it. `busy` shows a save in progress and ignores
 * clicks; the state only changes when the caller updates `checked`. Busy uses
 * `aria-disabled`, not `disabled`, so the toggle keeps keyboard focus while it
 * saves. It forwards its ref so a dialog can return focus to it.
 */
import React from 'react';

export interface ToggleProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-checked'> {
  checked: boolean;
  busy?: boolean;
}

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, busy = false, className, onClick, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy}
      aria-disabled={busy}
      className={['ds-toggle', className].filter(Boolean).join(' ')}
      onClick={busy ? undefined : onClick}
      {...rest}
    >
      <span className="ds-toggle-knob" aria-hidden="true" />
    </button>
  );
});
