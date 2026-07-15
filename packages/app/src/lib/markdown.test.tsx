// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from './markdown.js';

const html = (text: string) => render(<div>{renderMarkdown(text)}</div>).container.innerHTML;

describe('renderMarkdown', () => {
  it('renders bold, italic, and inline code', () => {
    const out = html('has **bold** and *ital* and `code`');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>ital</em>');
    expect(out).toContain('<code');
  });

  it('renders http(s) links only, with safe rel', () => {
    const out = html('see [docs](https://example.com) not [bad](javascript:alert(1))');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).not.toContain('javascript:');
  });

  it('renders bullet lists', () => {
    const out = html('intro\n- one\n- two');
    expect(out).toContain('<ul');
    expect((out.match(/<li/g) ?? []).length).toBe(2);
  });

  it('never injects raw html', () => {
    const out = html('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
