import { describe, expect, test } from 'bun:test';
import { normalizeUrl } from '../src/shared/url';

describe('normalizeUrl security boundaries', () => {
  test('accepts http, https, about:blank, and localhost shorthands', () => {
    expect(normalizeUrl('https://example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(normalizeUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    expect(normalizeUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('')).toBe('about:blank');
  });

  test('rejects file:, data:, javascript:, chrome:, and devtools: schemes', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('data:text/html,<script>alert(1)</script>')).toThrow(
      'Unsupported URL scheme',
    );
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('chrome://settings')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('devtools://devtools/bundled/inspector.html')).toThrow(
      'Unsupported URL scheme',
    );
  });
});
