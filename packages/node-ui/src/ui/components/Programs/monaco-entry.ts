// Browser-only vendor entry. Built separately to stay within the UI heap limit.
export * as monaco from 'monaco-editor/editor/editor.api';
export * as ts from 'monaco-editor/languages/features/typescript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/find/browser/findController';
