export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGE_REGISTRY = Object.freeze({
  en: Object.freeze({
    id: 'en',
    label: 'English',
    locale: 'en-US',
  }),
  tr: Object.freeze({
    id: 'tr',
    label: 'Türkçe',
    locale: 'tr-TR',
  }),
  de: Object.freeze({
    id: 'de',
    label: 'Deutsch',
    locale: 'de-DE',
  }),
  es: Object.freeze({
    id: 'es',
    label: 'Español',
    locale: 'es-ES',
  }),
  ru: Object.freeze({
    id: 'ru',
    label: 'Русский',
    locale: 'ru-RU',
  }),
});

export const SUPPORTED_LANGUAGE_IDS = Object.freeze(Object.keys(LANGUAGE_REGISTRY));

export function isSupportedLanguage(value) {
  return SUPPORTED_LANGUAGE_IDS.includes(String(value ?? '').trim().toLowerCase());
}

export function resolveLanguage(value, fallback = DEFAULT_LANGUAGE) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return isSupportedLanguage(normalized) ? normalized : fallback;
}

export function resolveLanguageFromLocale(value, fallback = DEFAULT_LANGUAGE) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const exact = SUPPORTED_LANGUAGE_IDS.find((languageId) => normalized === languageId);
  if (exact) {
    return exact;
  }

  const prefix = normalized.split(/[-_]/)[0];
  return isSupportedLanguage(prefix) ? prefix : fallback;
}

export function getLanguageLocale(language, fallback = LANGUAGE_REGISTRY[DEFAULT_LANGUAGE].locale) {
  return LANGUAGE_REGISTRY[resolveLanguage(language)]?.locale ?? fallback;
}

export function getLanguageLabel(language) {
  return LANGUAGE_REGISTRY[resolveLanguage(language)]?.label ?? LANGUAGE_REGISTRY[DEFAULT_LANGUAGE].label;
}
