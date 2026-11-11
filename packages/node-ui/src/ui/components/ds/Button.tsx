/**
 * Button — the one button of the node UI (see DESIGN.md).
 *
 *   primary   the single main action in a view (white on black in dark mode)
 *   secondary default; outlined
 *   ghost     low emphasis: toolbars, dismiss, icon buttons
 *   danger    destructive; red outline, never a red fill
 *   swm / vm  actions that move knowledge into a layer: Share to SWM (cyan
 *             tint) and Publish to VM (the one purple fill)
 *
 * Sizes sm 24 / md 32 / lg 40. `icon` makes it square (give it an aria-label).
 */
import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'swm' | 'vm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  /** Square, icon-only button. */
  icon?: boolean;
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon = false, className, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ds-btn', variant !== 'secondary' && `ds-${variant}`, size !== 'md' && `ds-${size}`, icon && 'ds-icon', className)}
      {...rest}
    />
  );
});
