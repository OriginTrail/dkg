// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HexagonPainter } from '../src/core/hexagon-painter.js';
import { PrefixManager } from '../src/core/prefix-manager.js';
import { canvasContext, config, edge, node } from './rendering-support.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('hexagon visual contracts', () => {
  it('scales degree, image minimum and explicit/risk multipliers independently', () => {
    const { styleEngine } = config(); const painter = new HexagonPainter(undefined, styleEngine);
    painter.setMaxDegree(10);
    expect(painter.getRadius(node('zero'))).toBe(24);
    expect(painter.getRadius(node('half', { degree: 5 }))).toBe(48);
    expect(painter.getRadius(node('full', { degree: 10 }))).toBe(72);
    expect(painter.getRadius(node('risk', { isHighRisk: true }))).toBe(48);
    expect(painter.getRadius(node('explicit', { isHighRisk: true, sizeMultiplier: 3 }))).toBe(72);
    expect(painter.getRadius(node('photo', { imageUrl: 'photo' }))).toBeCloseTo(43.2);
    painter.setMaxDegree(0);
    expect(painter.getRadius(node('one', { degree: 1 }))).toBe(72);
    const fixed = new HexagonPainter({ scaleWithDegree: false }, styleEngine);
    expect(fixed.getRadius(node('fixed'))).toBe(36);
    expect(fixed.getRadius(node('fixed-photo', { imageUrl: 'photo' }))).toBeCloseTo(43.2);
    const tiny = new HexagonPainter({ minSize: 1, maxSize: 2 }, styleEngine);
    expect(tiny.getRadius(node('tiny', { imageUrl: 'photo' }))).toBe(8);
  });
  it('expands compact circle types and draws a single flat circle without label or image work', () => {
    const { styleEngine } = config(); const painter = new HexagonPainter({ circleTypes: ['schema:Person'] }, styleEngine, new PrefixManager());
    const person = node('person', { types: ['https://schema.org/Person'], degree: 1, label: 'Person' });
    painter.setMaxDegree(2);
    expect(painter.isCircleNode(person)).toBe(true);
    expect(painter.isCircleNode(node('other'))).toBe(false);
    expect(painter.getRadius(person)).toBeCloseTo(30);
    const { ctx } = canvasContext(); painter.paint(ctx, person, 10, 20, 4);
    expect(ctx.arc).toHaveBeenCalledWith(10, 20, expect.closeTo(30), 0, 2 * Math.PI);
    expect(ctx.fill).toHaveBeenCalledOnce(); expect(ctx.fillText).not.toHaveBeenCalled(); expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(new HexagonPainter({ circleTypes: ['urn:type'], scaleWithDegree: false }, styleEngine).getRadius(node('c', { types: ['urn:type'] }))).toBeCloseTo(16.8);
  });
  it('draws a closed six-sided path, a gradient and a zoom-independent border', () => {
    const { hexPainter: painter } = config(); const { ctx, gradient } = canvasContext();
    expect(painter.paint(ctx, node('a', { label: 'Alice' }), 10, 20, 2)).toBe(24);
    expect(ctx.moveTo).toHaveBeenCalledWith(34, 20); expect(ctx.lineTo).toHaveBeenCalledTimes(5);
    expect(ctx.closePath).toHaveBeenCalledOnce(); expect(gradient.addColorStop.mock.calls.map(call => call[0])).toEqual([0, 1]);
    expect(ctx.fillText).toHaveBeenCalledWith('Alice', 10, 45); expect(ctx.globalAlpha).toBe(1);
  });
  it.each([
    ['short', 'short'],
    ['packages/node-ui/src/ProjectView.tsx', '…/ProjectView.tsx'],
    ['pkg/many/nested/directories/View.tsx', 'pkg/…/View.tsx'],
    ['veryveryverylongprefix/short.ts', '…/short.ts'],
    ['root/AnExtremelyLongFilenameThatWillNotFit.ts', 'root/AnExtremelyLongFil…'],
    ['#123 A very long pull request title', '#123 A very long pull r…'],
    ['#12345678901234567890 A long title', '#12345678901234567890 A…'],
    ['abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvw…'],
  ])('keeps useful identity in long labels: %s', (label, expected) => {
    const { hexPainter } = config(); const { ctx } = canvasContext();
    hexPainter.paint(ctx, node('a', { label }), 0, 0, 1);
    expect(ctx.fillText.mock.calls[0][0]).toBe(expected);
  });
  it('hides labels below the zoom threshold and fades them in between thresholds', () => {
    const { hexPainter } = config(); const { ctx, paints } = canvasContext();
    hexPainter.paint(ctx, node('label'), 0, 0, .3); expect(ctx.fillText).not.toHaveBeenCalled();
    hexPainter.paint(ctx, node('label'), 0, 0, .55);
    expect(paints.find(p => p.method === 'fillText')?.alpha).toBeCloseTo(.5);
  });
  it.each(['glow', 'border', 'opacity', 'none'] as const)('renders trust style %s without leaking canvas state', style => {
    const { styleEngine } = config({ gradient: false, defaultNodeColor: '#204060' });
    const painter = new HexagonPainter(undefined, styleEngine); painter.setTrustStyle(style);
    const { ctx, paints } = canvasContext();
    const trusted = node('trusted', { provenance: { sourceNames: [], sources: ['a', 'b', 'c', 'd', 'e'] } });
    painter.paint(ctx, trusted, 0, 0, 2);
    const border = paints.find(p => p.method === 'stroke')!;
    expect(border.width).toBe(style === 'border' ? 2.25 : .75);
    expect(paints.some(p => p.shadow === 6)).toBe(style === 'glow');
    expect(ctx.globalAlpha).toBe(1); expect(ctx.shadowBlur).toBe(0);
    painter.paint(ctx, node('untrusted'), 0, 0, 1);
    expect(ctx.globalAlpha).toBe(1);
  });
  it.each([false, true])('prioritizes risk borders over boundary/trust styling (high risk %s)', highRisk => {
    const { styleEngine } = config({ gradient: false }); const painter = new HexagonPainter(undefined, styleEngine);
    painter.setTrustStyle('border'); const { ctx, paints } = canvasContext();
    painter.paint(ctx, node('risk', { isHighRisk: highRisk, riskScore: 2, isBoundary: true, provenance: { sourceNames: [], sources: ['a', 'b'] } }), 0, 0, 2, 1.2);
    const stroke = paints.find(p => p.method === 'stroke')!;
    expect(stroke.stroke).toBe('rgba(220, 50, 50, 1)'); expect(stroke.width).toBe(highRisk ? 1.5 : 1);
    expect(paints.filter(p => p.method === 'fill').length).toBe(highRisk ? 2 : 1);
  });
  it.each([['#204060', '#90a0b0'], ['red', 'red']])('lightens boundary color %s when there is no risk', (color, expected) => {
    const { styleEngine } = config({ defaultNodeColor: color, gradient: false });
    const { ctx, paints } = canvasContext(); new HexagonPainter(undefined, styleEngine).paint(ctx, node('boundary', { isBoundary: true, riskScore: 0 }), 0, 0, 1);
    expect(paints.find(p => p.method === 'stroke')).toMatchObject({ stroke: expected, width: 2.5 });
  });
  it.each([
    { sources: [] }, { sources: ['a'] }, { sources: ['a', 'b'], contentHash: 'sha256:hash' },
    { sources: ['a'], blockchainAnchor: { txHash: 'tx:anchor' } },
  ])('draws only available provenance badges: %j', provenance => {
    const { hexPainter } = config(); const { ctx } = canvasContext();
    const item = node('a', { provenance: { ...provenance, sourceNames: [] } }); hexPainter.paint(ctx, item, 0, 0, 4);
    expect(ctx.arc.mock.calls.length).toBe(Number(provenance.sources.length > 0) + Number('contentHash' in provenance || 'blockchainAnchor' in provenance));
    if (provenance.sources.length) expect(ctx.fillText).toHaveBeenCalledWith(String(provenance.sources.length), 24 * .7, 24 * .6);
    ctx.arc.mockClear(); hexPainter.setShowBadges(false); hexPainter.paint(ctx, item, 0, 0, 4); expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe('image loading and RDF resolution', () => {
  it.each([['https://example.invalid/wide-photo.png', 200, 100, [-38, -4, 96, 48], 'anonymous'],
    ['data:image/svg+xml,contract-icon', 100, 200, [-2, -4, 24, 48], undefined]] as const)('crops %s, shares cached images and repaints after load', (url, width, height, bounds, cors) => {
    const images: any[] = [];
    vi.stubGlobal('Image', class { naturalWidth = width; naturalHeight = height; constructor() { images.push(this); } });
    const { styleEngine } = config(); const painter = new HexagonPainter({ scaleWithDegree: false, baseSize: 24, maxSize: 24 }, styleEngine);
    const loaded = vi.fn(); painter.setImageLoadCallback(loaded); const { ctx } = canvasContext(); const item = node('image', { imageUrl: url });
    painter.paint(ctx, item, 10, 20, 1); painter.paint(ctx, item, 10, 20, 1);
    expect(images).toHaveLength(1); expect(images[0].crossOrigin).toBe(cors); expect(ctx.drawImage).not.toHaveBeenCalled();
    images[0].onload(); expect(loaded).toHaveBeenCalledOnce(); painter.paint(ctx, item, 10, 20, 1);
    expect(ctx.drawImage).toHaveBeenCalledWith(images[0], ...bounds); expect(ctx.clip).toHaveBeenCalledOnce(); expect(ctx.globalAlpha).toBe(1);
  });
  it('retries failed images and supports loading before a repaint callback is registered', () => {
    const images: any[] = []; vi.stubGlobal('Image', class { constructor() { images.push(this); } });
    const { hexPainter } = config(); const { ctx } = canvasContext(); const item = node('retry', { imageUrl: 'https://example.invalid/retry.png' });
    hexPainter.paint(ctx, item, 0, 0, 1); images[0].onerror(); hexPainter.paint(ctx, item, 0, 0, 1);
    expect(images).toHaveLength(2); expect(() => images[1].onload()).not.toThrow();
  });
  it('resolves direct and linked images, rejecting non-HTTP values and broken links', () => {
    const { hexPainter } = config(); const subject = node('s'); const image = node('image');
    const prop = (key: string, value: string) => image.properties.set(key, [{ value, language: '', datatype: '' }]);
    subject.properties.set('https://schema.org/image', [{ value: 'javascript:bad', language: '', datatype: '' }]);
    expect(hexPainter.resolveImageUrl(subject, () => undefined)).toBeNull();
    const links = [edge('s', 'unrelated'), { ...edge('s', 'missing'), predicate: 'https://schema.org/image' }, { ...edge('s', 'image'), predicate: 'https://schema.org/image' }];
    const get = (id: string) => id === 'image' ? image : undefined;
    expect(hexPainter.resolveImageUrl(subject, get, () => links)).toBeNull();
    prop('https://schema.org/url', 'file:bad'); prop('https://schema.org/image', 'data:bad');
    expect(hexPainter.resolveImageUrl(subject, get, () => links)).toBeNull();
    prop('https://schema.org/image', 'http://example.invalid/fallback.jpg');
    expect(hexPainter.resolveImageUrl(subject, get, () => links)).toBe('http://example.invalid/fallback.jpg');
    prop('https://schema.org/url', 'https://example.invalid/photo.jpg');
    expect(hexPainter.resolveImageUrl(subject, get, () => links)).toBe('https://example.invalid/photo.jpg');
    subject.properties.set('https://schema.org/image', [{ value: 'http://example.invalid/direct.jpg', language: '', datatype: '' }]);
    expect(hexPainter.resolveImageUrl(subject, get, () => links)).toBe('http://example.invalid/direct.jpg');
  });
});
