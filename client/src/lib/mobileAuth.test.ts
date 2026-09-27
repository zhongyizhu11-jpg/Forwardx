import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileAuth } from './mobileAuth';

test('mobile server addresses preserve HTTPS, HTTP and IPv6 support', () => {
  for (const value of ['https://panel.example', 'http://192.168.1.2:9810', 'http://[::1]:9810']) {
    assert.ok(mobileAuth.isValidPanelUrl(value));
  }
  for (const value of ['', 'javascript:alert(1)', 'file:///private/data']) {
    assert.equal(mobileAuth.isValidPanelUrl(value), false);
  }
  assert.equal(mobileAuth.normalizePanelUrl(' https://panel.example/// '), 'https://panel.example');
});

test('iOS selects the configured panel API; browsers stay same-origin', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map([['forwardx.mobile.panelUrl', 'https://panel.example']]);
  const nativeWindow = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    localStorage: { getItem: (key: string) => values.get(key) ?? null },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: nativeWindow });
  try {
    assert.equal(mobileAuth.platform, 'ios');
    assert.equal(mobileAuth.isNative, true);
    assert.equal(mobileAuth.trpcUrl(), 'https://panel.example/api/trpc');
    nativeWindow.Capacitor.isNativePlatform = () => false;
    assert.equal(mobileAuth.platform, 'web');
    assert.equal(mobileAuth.trpcUrl(), '/api/trpc');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
