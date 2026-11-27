// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
const renderer = vi.hoisted(() => ({ render: vi.fn(), createRoot: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: renderer.createRoot.mockReturnValue({ render: renderer.render }) }));
vi.mock('../src/App', () => ({ App: () => null }));
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });
it('mounts the application into its host element under StrictMode', async () => {
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
  const { App } = await import('../src/App');
  await import('../src/main');
  expect(renderer.createRoot).toHaveBeenCalledExactlyOnceWith(host);
  const tree = renderer.render.mock.calls[0][0];
  expect(tree.type).toBe(StrictMode); expect(tree.props.children.type).toBe(App);
});
