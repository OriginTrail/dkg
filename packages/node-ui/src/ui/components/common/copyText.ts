/** Support node dashboards served over HTTP as well as secure contexts. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const active = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Copy unavailable');
  } finally {
    input.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
