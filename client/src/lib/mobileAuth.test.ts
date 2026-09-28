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

test('links handed to other apps use the panel address, never capacitor://localhost', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map([['forwardx.mobile.panelUrl', 'https://panel.example/']]);
  const nativeWindow = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    localStorage: { getItem: (key: string) => values.get(key) ?? null },
    location: { origin: 'capacitor://localhost' },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: nativeWindow });
  try {
    assert.equal(mobileAuth.panelOrigin(), 'https://panel.example');
    nativeWindow.Capacitor.isNativePlatform = () => false;
    nativeWindow.location.origin = 'https://fo.example';
    assert.equal(mobileAuth.panelOrigin(), 'https://fo.example');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('passwords are never persisted; legacy plaintext passwords are purged on start and logout', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>([
    ['forwardx.mobile.password', 'hunter2'],
    ['forwardx.mobile.username', 'alice'],
  ]);
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  try {
    await mobileAuth.hydrateNative();
    assert.equal(values.has('forwardx.mobile.password'), false, 'startup migration removes the stored password');
    assert.equal(mobileAuth.getUsername(), 'alice');

    mobileAuth.setUsername(' bob ');
    mobileAuth.setToken('session-token');
    assert.equal(mobileAuth.getUsername(), 'bob');
    assert.equal(mobileAuth.getToken(), 'session-token');
    assert.equal('getPassword' in mobileAuth, false);
    assert.equal([...values.values()].includes('hunter2'), false);

    values.set('forwardx.mobile.password', 'hunter2');
    mobileAuth.clear();
    assert.equal(mobileAuth.getToken(), '');
    assert.equal(values.has('forwardx.mobile.password'), false, 'logout removes token and any stored password');
    assert.equal(mobileAuth.wasLoggedOut(), true);
    assert.equal(mobileAuth.getUsername(), 'bob', 'the remembered username survives logout');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('plain http panel addresses are flagged as insecure', () => {
  assert.equal(mobileAuth.isInsecurePanelUrl('http://192.168.1.2:9810'), true);
  assert.equal(mobileAuth.isInsecurePanelUrl(' HTTP://panel.example/ '), true);
  assert.equal(mobileAuth.isInsecurePanelUrl('https://panel.example'), false);
  assert.equal(mobileAuth.isInsecurePanelUrl(''), false);
  assert.equal(mobileAuth.isInsecurePanelUrl('javascript:alert(1)'), false);
});
