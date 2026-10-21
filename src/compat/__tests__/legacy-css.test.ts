import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { legacyCss } from '../legacy-css';

describe('Chromium 80 stylesheet output', () => {
  it('lowers variable-opacity colors, insets and dark-mode selectors without losing rules', async () => {
    const result = await postcss([legacyCss()]).process(
      '.dark\\:bg:is(.dark *) { color: rgb(12 34 56 / var(--opacity, 1)); inset: 1px 2px 3px 4px; } button:where([type="button"]):focus-visible { color: rgb(1 2 3); }',
      { from: undefined },
    );
    expect(result.css).toContain('.dark .dark\\:bg');
    expect(result.css).toContain('rgba(12,34,56, var(--opacity, 1))');
    expect(result.css).toContain('top: 1px');
    expect(result.css).toContain('right: 2px');
    expect(result.css).toContain('bottom: 3px');
    expect(result.css).toContain('left: 4px');
    expect(result.css).toContain('button[type="button"]:focus');
    expect(result.css).not.toContain(':is(');
    expect(result.css).not.toContain(':where(');
  });
});
