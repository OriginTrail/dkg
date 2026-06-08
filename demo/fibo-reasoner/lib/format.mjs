// Small, self-contained terminal formatting. No deps — a demo dir should stand
// on its own. Honours NO_COLOR and non-TTY stdout (so `| jq` / piped output is
// clean).

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

export const divider = (ch = '─', w = 74) => dim(ch.repeat(w));
export const header = (t) => `\n${bold(t)}\n${divider()}`;
export const step = (id, t) => `${cyan('▶')} ${bold(id)}  ${t}`;
export const note = (t) => `${dim('·')} ${dim(t)}`;
export const success = (t) => `${green('✓')} ${t}`;
export const warn = (t) => `${yellow('!')} ${t}`;
export const fail = (t) => `${red('✗')} ${t}`;
export const kv = (k, v) => `  ${dim(String(k).padEnd(18))}${v}`;
export const bullet = (t) => `    ${dim('•')} ${t}`;

// A labelled box marking which memory layer a write lands in — the visual spine
// of the demo. layer ∈ { WM, SWM, VM }.
const LAYER_COLOR = { WM: yellow, SWM: cyan, VM: green };
export function layerTag(layer, text) {
  const paint = LAYER_COLOR[layer] ?? bold;
  return `${paint(`[${layer}]`)} ${text}`;
}

export function paragraphs(lines) {
  return lines.map((l) => l).join('\n\n');
}
