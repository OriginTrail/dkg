/** A data reference, never evaluated as JavaScript. Embedded in the native n8n expression. */
export function resolveComponentValue(value, item = {}, validateOnly = false) {
  const reference = expression => {
    const path = expression.trim();
    if (path.length > 256 || !/^\$json(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|\[(?:\d+|"[^"\\\r\n]+"|'[^'\\\r\n]+')\])*$/.test(path)) {
      throw new Error('Use an input reference to a field such as $json.current.temperature_2m.');
    }
    let result = item;
    for (const match of path.slice(5).matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+|"[^"\\\r\n]+"|'[^'\\\r\n]+')\]/g)) {
      const key = match[1] ?? (/^\d+$/.test(match[2]) ? match[2] : match[2].slice(1, -1));
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('__nos')) throw new Error('Reserved input reference.');
      if (validateOnly) continue;
      if (result === null || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error('Input field not found: ' + path);
      result = result[key];
    }
    return validateOnly ? null : result;
  };
  if (Array.isArray(value)) return value.map(v => resolveComponentValue(v, item, validateOnly));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, resolveComponentValue(v, item, validateOnly)]));
  if (typeof value !== 'string' || !value.includes('{' + '{')) return value;
  const source = value.startsWith('=') ? value.slice(1) : value;
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(source.trim());
  if (whole) { const result = reference(whole[1]); return validateOnly ? value : result; }
  const remainder = source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => { reference(path); return ''; });
  if (remainder.includes('{' + '{') || remainder.includes('}' + '}')) throw new Error('Close each input reference.');
  if (validateOnly) return value;
  return source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
    const result = reference(path);
    if (result !== null && typeof result === 'object') return JSON.stringify(result);
    return String(result ?? '');
  });
}

/** Public HTTPS destinations are chosen by the workflow author. n8n also checks DNS/IPs. */
export function validateComponentUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value)) throw new Error('Enter a valid HTTPS API URL.');
  const match = /^https:\/\/([^/?#]+)(?:[/?][^#]*)?$/.exec(value);
  const host = match?.[1]?.toLowerCase().replace(/:443$/, '');
  if (!host || host.includes('@') || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) {
    throw new Error('Use a public HTTPS hostname without embedded credentials or a custom port.');
  }
  return value;
}
