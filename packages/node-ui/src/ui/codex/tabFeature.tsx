import React from 'react';
import { createRecoverableLazyView } from '../components/Shell/RecoverableLazyView.js';
import { codexEnabled } from './enabled.js';

const CodexView = createRecoverableLazyView(() => (
  import('./CodexView.js').then((module) => module.CodexView)
), 'Codex');

export interface ShellTabFeature {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly defaultSelection: boolean;
  readonly closable: boolean;
  readonly layout: { readonly hideRightPanel: boolean };
  render(): React.ReactNode;
}

export const CODEX_TAB_FEATURE: ShellTabFeature = Object.freeze({
  id: 'codex',
  label: 'Codex',
  path: '/ui/codex',
  enabled: codexEnabled,
  defaultSelection: codexEnabled,
  closable: false,
  layout: Object.freeze({ hideRightPanel: true }),
  render: () => <CodexView />,
});

export const SHELL_TAB_FEATURES: readonly ShellTabFeature[] = Object.freeze([
  CODEX_TAB_FEATURE,
]);

export const enabledShellTabFeatures = () => SHELL_TAB_FEATURES.filter((feature) => feature.enabled);
export const shellTabFeatureById = (id: string) => SHELL_TAB_FEATURES.find((feature) => feature.id === id);
export const shellTabFeatureByPath = (path: string) => SHELL_TAB_FEATURES.find((feature) => feature.path === path);
