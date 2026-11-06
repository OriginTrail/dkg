import type { KeyboardEvent } from 'react';

/**
 * Makes a row that can't be a real button work from the keyboard: it joins the
 * tab order and Enter or Space does what a click does. Keys pressed on controls
 * inside the row stay with those controls.
 */
export function pressable(press: () => void) {
  return {
    tabIndex: 0,
    onClick: press,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      press();
    },
  };
}
