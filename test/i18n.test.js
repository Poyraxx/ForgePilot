import test from 'node:test';
import assert from 'node:assert/strict';

import en from '../src/renderer/i18n/en.js';
import {
  SUPPORTED_LANGUAGE_IDS,
  resolveLanguageFromLocale,
  translate,
} from '../src/renderer/i18n/index.js';

test('all supported locales resolve the full english bundle without crashing', () => {
  const englishKeys = Object.keys(en);

  for (const language of SUPPORTED_LANGUAGE_IDS) {
    for (const key of englishKeys) {
      const value = translate(language, key, {
        count: 3,
        providerId: 'ollama',
        provider: 'Ollama',
        model: 'qwen3-coder-next:latest',
        name: 'spec.pdf',
        path: '.cokgizlicoder/attachments/spec.pdf',
        title: 'Release notes',
      });

      assert.equal(typeof value, 'string', `${language}:${key} should resolve to a string`);
      assert.notEqual(value.length, 0, `${language}:${key} should not resolve to an empty string`);
    }
  }
});

test('translate falls back to english and then to the raw key', () => {
  assert.equal(
    translate('de', 'window.close'),
    'Close'
  );
  assert.equal(
    translate('unsupported-language', 'settings.title'),
    'Settings'
  );
  assert.equal(
    translate('tr', 'missing.translation.key'),
    'missing.translation.key'
  );
});

test('resolveLanguageFromLocale prefers supported system locales and falls back to english', () => {
  assert.equal(resolveLanguageFromLocale('tr-TR'), 'tr');
  assert.equal(resolveLanguageFromLocale('de-DE'), 'de');
  assert.equal(resolveLanguageFromLocale('es-MX'), 'es');
  assert.equal(resolveLanguageFromLocale('ru-RU'), 'ru');
  assert.equal(resolveLanguageFromLocale('it-IT'), 'en');
});
