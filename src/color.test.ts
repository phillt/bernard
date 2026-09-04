import { describe, it, expect } from 'vitest';
import {
  parseColor,
  relativeLuminance,
  contrastRatio,
  composite,
  contrastOver,
  nearestToken,
} from './color.js';

describe('parseColor', () => {
  it('reads every hex form', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor('#aabbcc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor('#AABBCC')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor('#abcd')?.a).toBeCloseTo(0.867, 2);
    expect(parseColor('#aabbcc80')?.a).toBeCloseTo(0.502, 2);
  });

  it('reads the functional forms, including the space-separated one', () => {
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgba(1, 2, 3, .5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    // What a modern generator is as likely to emit as the comma form.
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it('returns null for what it does not understand, rather than a plausible number', () => {
    // The honesty boundary: a caller must handle this, not receive a guess.
    for (const bad of [
      'red',
      'transparent',
      'var(--bg)',
      'color-mix(in srgb, red, blue)',
      '#ab',
      '#abcde',
      'nonsense',
      '',
    ]) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe('relativeLuminance and contrastRatio', () => {
  it('anchors on the two colours whose values are definitional', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('is symmetric — the ratio does not know which colour is the text', () => {
    expect(contrastRatio('#0d1117', '#f97316')).toBe(contrastRatio('#f97316', '#0d1117'));
  });

  it('reproduces the pair this whole change turns on', () => {
    // The button fix: `--accent-fg` on `--accent`.
    expect(contrastRatio('#0d1117', '#f97316')).toBeCloseTo(6.75, 2);
    // What it replaces, which fails AA outright.
    expect(contrastRatio('#ffffff', '#f97316')).toBeCloseTo(2.8, 2);
  });

  it('refuses a translucent colour rather than treating it as opaque', () => {
    // Silently flattening onto an assumed backdrop is how a checker reports a
    // pass it never measured.
    expect(contrastRatio('rgba(249,115,22,0.15)', '#0d1117')).toBeNull();
    expect(contrastRatio('red', '#0d1117')).toBeNull();
  });
});

describe('composite and contrastOver', () => {
  it('paints a translucent fill onto its backdrop', () => {
    const out = composite({ r: 249, g: 115, b: 22, a: 0.15 }, { r: 13, g: 17, b: 23, a: 1 });
    expect(Math.round(out.r)).toBe(48);
    expect(Math.round(out.g)).toBe(32);
    expect(Math.round(out.b)).toBe(23);
    expect(out.a).toBe(1);
  });

  it('measures text over a dim fill over the page, bottom-last', () => {
    const onBg = contrastOver('#e6edf3', ['rgba(249,115,22,0.15)', '#0d1117']);
    const onSurface = contrastOver('#e6edf3', ['rgba(249,115,22,0.15)', '#161b22']);
    expect(onBg).toBeCloseTo(13.22, 1);
    expect(onSurface).toBeCloseTo(11.91, 1);
  });

  it('returns null when the bottom layer is itself translucent', () => {
    // What is beneath it is a fact about a paint stack this module cannot see.
    expect(contrastOver('#ffffff', ['rgba(0,0,0,0.5)'])).toBeNull();
    expect(contrastOver('#ffffff', [])).toBeNull();
  });
});

describe('nearestToken', () => {
  const PALETTE = {
    '--bg': '#0d1117',
    '--text': '#e6edf3',
    '--accent': '#f97316',
    '--danger': '#ff7b72',
    '--success': '#3fb950',
    '--info': '#58a6ff',
    '--accent-dim': 'rgba(249, 115, 22, 0.15)',
  };

  it('maps the red Bernard itself hard-coded to --danger, not --accent', () => {
    // The case OKLab exists for: sRGB-Euclidean distance gets this wrong and
    // suggests the orange accent. A suggestion that names the wrong token is
    // worse than none, because it will be taken.
    expect(nearestToken('#f85149', PALETTE)).toBe('--danger');
  });

  it('maps obvious colours to their obvious tokens', () => {
    expect(nearestToken('#00ff00', PALETTE)).toBe('--success');
    expect(nearestToken('#ffffff', PALETTE)).toBe('--text');
    expect(nearestToken('#000000', PALETTE)).toBe('--bg');
  });

  it('never suggests a translucent token, which has no fixed appearance', () => {
    expect(Object.keys(PALETTE)).toContain('--accent-dim');
    for (const probe of ['#f97316', '#302017', '#ff7b72']) {
      expect(nearestToken(probe, PALETTE)).not.toBe('--accent-dim');
    }
  });

  it('returns null for a colour it cannot parse', () => {
    expect(nearestToken('chartreuse', PALETTE)).toBeNull();
  });
});
