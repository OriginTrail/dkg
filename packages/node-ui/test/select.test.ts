// @vitest-environment happy-dom
//
// Covers the custom `Select` component introduced in PR1 (replaces the
// native <select> for the project picker). Focused on keyboard navigation,
// portal rendering, and click selection.

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { Select, type SelectOption } from '../src/ui/components/common/Select.js';

const OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta', disabled: true },
];

async function renderSelect(props: {
  value?: string;
  onChange?: (v: string) => void;
  options?: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
}): Promise<{
  container: HTMLDivElement;
  trigger: HTMLButtonElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(Select, {
        value: props.value ?? 'a',
        onChange: props.onChange ?? (() => {}),
        options: props.options ?? OPTIONS,
        disabled: props.disabled,
        placeholder: props.placeholder,
        ariaLabel: 'Project',
      }),
    );
  });

  const trigger = container.querySelector('.v10-select-trigger') as HTMLButtonElement;
  return {
    container,
    trigger,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getPortalMenu(): HTMLUListElement | null {
  return document.body.querySelector('.v10-select-menu') as HTMLUListElement | null;
}

describe('Select (custom dropdown)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  it('renders the trigger with the selected option label and aria attributes', async () => {
    const { trigger, container, unmount } = await renderSelect({ value: 'b' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toBe('Project');
    expect(trigger.textContent).toContain('Bravo');
    expect(getPortalMenu()).toBeNull();
    expect(container.querySelector('.v10-select-menu')).toBeNull();
    await unmount();
  });

  it('renders the placeholder when no option matches the value', async () => {
    const { trigger, unmount } = await renderSelect({
      value: 'missing',
      placeholder: 'Choose…',
    });
    expect(trigger.textContent).toContain('Choose…');
    const valueSpan = trigger.querySelector('.v10-select-value');
    expect(valueSpan?.classList.contains('placeholder')).toBe(true);
    await unmount();
  });

  it('opens the listbox in a portal under document.body when clicked', async () => {
    const { trigger, container, unmount } = await renderSelect({});
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = getPortalMenu();
    expect(menu).toBeTruthy();
    // Menu lives outside the root container (portal target == document.body).
    expect(container.contains(menu!)).toBe(false);
    expect(document.body.contains(menu!)).toBe(true);
    expect(menu!.getAttribute('role')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await unmount();
  });

  it('opens on Enter from the trigger (keyboard)', async () => {
    const { trigger, unmount } = await renderSelect({});
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();
    await unmount();
  });

  it('opens on ArrowDown from the trigger (keyboard)', async () => {
    const { trigger, unmount } = await renderSelect({});
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();
    await unmount();
  });

  it('opens on Space from the trigger (keyboard)', async () => {
    const { trigger, unmount } = await renderSelect({});
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();
    await unmount();
  });

  it('ArrowDown / ArrowUp navigates the highlight, skipping disabled options', async () => {
    const { trigger, unmount } = await renderSelect({ value: 'a' });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menu = getPortalMenu()!;
    expect(menu).toBeTruthy();

    // Initial highlight matches the selected value (idx 0 = 'a').
    let highlighted = menu.querySelector('.v10-select-option.highlighted');
    expect(highlighted?.textContent).toBe('Alpha');

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    highlighted = getPortalMenu()!.querySelector('.v10-select-option.highlighted');
    expect(highlighted?.textContent).toBe('Bravo');

    await act(async () => {
      getPortalMenu()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    highlighted = getPortalMenu()!.querySelector('.v10-select-option.highlighted');
    expect(highlighted?.textContent).toBe('Charlie');

    // ArrowDown from Charlie should skip disabled Delta and wrap to Alpha.
    await act(async () => {
      getPortalMenu()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    highlighted = getPortalMenu()!.querySelector('.v10-select-option.highlighted');
    expect(highlighted?.textContent).toBe('Alpha');

    // ArrowUp from Alpha should also skip disabled Delta and wrap to Charlie.
    await act(async () => {
      getPortalMenu()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    highlighted = getPortalMenu()!.querySelector('.v10-select-option.highlighted');
    expect(highlighted?.textContent).toBe('Charlie');

    await unmount();
  });

  it('Home / End jump highlight to first / last option', async () => {
    const { trigger, unmount } = await renderSelect({ value: 'b' });
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menu = getPortalMenu()!;

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(
      getPortalMenu()!.querySelector('.v10-select-option.highlighted')?.textContent,
    ).toBe('Alpha');

    await act(async () => {
      getPortalMenu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    // End now skips disabled options (consistent with ArrowDown/ArrowUp), so
    // it lands on Charlie — the last ENABLED option — instead of the
    // disabled Delta entry below it. Enter on a disabled highlight was a
    // no-op anyway; skipping at the navigation step avoids the dead-end.
    expect(
      getPortalMenu()!.querySelector('.v10-select-option.highlighted')?.textContent,
    ).toBe('Charlie');

    await unmount();
  });

  it('Enter on the highlighted option calls onChange and closes the menu', async () => {
    const onChange = vi.fn();
    const { trigger, unmount } = await renderSelect({ value: 'a', onChange });

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menu = getPortalMenu()!;
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      getPortalMenu()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
    expect(getPortalMenu()).toBeNull();

    await unmount();
  });

  it('Enter on a disabled option does not commit and the menu stays open', async () => {
    const onChange = vi.fn();
    // Initial value points at the disabled Delta option, so the menu opens
    // with the highlight already on a disabled row. Keyboard navigation
    // (Home/End/ArrowUp/ArrowDown) skips disabled now, but the Enter
    // guard still has to be a no-op for this entry — that's what we're
    // pinning down here.
    const { trigger, unmount } = await renderSelect({ value: 'd', onChange });

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menu = getPortalMenu()!;
    expect(menu.querySelector('.v10-select-option.highlighted')?.textContent).toBe('Delta');

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(getPortalMenu()).toBeTruthy();
    await unmount();
  });

  it('Escape closes the menu without committing', async () => {
    const onChange = vi.fn();
    const { trigger, unmount } = await renderSelect({ value: 'a', onChange });

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(getPortalMenu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await unmount();
  });

  it('clicking an option commits the value and closes the menu', async () => {
    const onChange = vi.fn();
    const { trigger, unmount } = await renderSelect({ value: 'a', onChange });

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const charlie = Array.from(
      document.body.querySelectorAll('.v10-select-option'),
    ).find((el) => el.textContent?.trim() === 'Charlie') as HTMLElement | undefined;
    expect(charlie).toBeTruthy();

    await act(async () => {
      charlie!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('c');
    expect(getPortalMenu()).toBeNull();
    await unmount();
  });

  it('clicking a disabled option does not commit and the menu stays open', async () => {
    const onChange = vi.fn();
    const { trigger, unmount } = await renderSelect({ value: 'a', onChange });

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const delta = Array.from(
      document.body.querySelectorAll('.v10-select-option'),
    ).find((el) => el.textContent?.trim() === 'Delta') as HTMLElement | undefined;
    expect(delta).toBeTruthy();
    expect(delta!.classList.contains('disabled')).toBe(true);

    await act(async () => {
      delta!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(getPortalMenu()).toBeTruthy();
    await unmount();
  });

  it('clicking outside the trigger and menu closes the menu', async () => {
    const { trigger, unmount } = await renderSelect({});
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(getPortalMenu()).toBeNull();
    outside.remove();
    await unmount();
  });

  it('does not open when disabled', async () => {
    const onChange = vi.fn();
    const { trigger, unmount } = await renderSelect({ disabled: true, onChange });
    expect(trigger.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getPortalMenu()).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(getPortalMenu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await unmount();
  });

  it('closes the menu and ignores option clicks when disabled flips true mid-interaction', async () => {
    // Codex BOMw6: when the parent flips `disabled` while the menu is
    // open, the trigger greys out but the portal-rendered menu must NOT
    // remain interactive — otherwise users can keep selecting stale
    // options. Two guards cover this:
    //   1. an effect closes the menu when `disabled` becomes true;
    //   2. the option `onClick` re-reads `disabled` so a click that
    //      races the effect on the same tick is still a no-op.
    const onChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const props = (disabled: boolean) =>
      React.createElement(Select, {
        value: 'a',
        onChange,
        options: OPTIONS,
        disabled,
        ariaLabel: 'Project',
      });

    await act(async () => {
      root.render(props(false));
    });
    const trigger = container.querySelector('.v10-select-trigger') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getPortalMenu()).toBeTruthy();

    // Parent flips `disabled` → menu must close.
    await act(async () => {
      root.render(props(true));
    });
    expect(getPortalMenu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders an empty-state row when no options are provided', async () => {
    const { trigger, unmount } = await renderSelect({ value: '', options: [] });
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = getPortalMenu();
    expect(menu).toBeTruthy();
    const empty = menu!.querySelector('.v10-select-option.empty');
    expect(empty?.textContent).toBe('No options');
    await unmount();
  });
});
