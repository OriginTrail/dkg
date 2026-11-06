// Generated core modules are trusted compiler output, but their memories still
// need a host-enforced maximum. V8 worker heap limits do not cap Wasm memory.
export function limitMemory(bytes, maxPages = 1024) {
  let position = 8;
  const read = () => {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = bytes[position++];
      if (byte === undefined) throw new Error('Invalid Wasm');
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return result;
    }
    throw new Error('Invalid Wasm integer');
  };
  const leb = value => {
    const out = [];
    do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)); } while (value);
    return out;
  };
  const parts = [bytes.subarray(0, 8)];
  while (position < bytes.length) {
    const beginning = position, section = bytes[position++], length = read(), end = position + length;
    if (end > bytes.length) throw new Error('Invalid Wasm section');
    if (section !== 5) { parts.push(bytes.subarray(beginning, end)); position = end; continue; }
    const count = read(), replacement = [...leb(count)];
    if (count > 1) throw new Error('Multiple guest memories are not supported');
    for (let i = 0; i < count; i++) {
      const flags = read(), initial = read();
      if (flags !== 0 && flags !== 1 || initial > maxPages) throw new Error('Unsupported guest memory');
      const maximum = flags === 1 ? Math.min(read(), maxPages) : maxPages;
      replacement.push(1, ...leb(initial), ...leb(maximum));
    }
    if (position !== end) throw new Error('Invalid guest memory section');
    parts.push(Uint8Array.from([5, ...leb(replacement.length), ...replacement]));
  }
  return Buffer.concat(parts);
}
