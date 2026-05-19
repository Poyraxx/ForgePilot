import {
  DEFAULT_LANGUAGE,
  LANGUAGE_REGISTRY,
  SUPPORTED_LANGUAGE_IDS,
  getLanguageLabel,
  getLanguageLocale,
  resolveLanguage,
  resolveLanguageFromLocale,
} from '../../core/localization.js';
import en from './en.js';
import tr from './tr.js';
import de from './de.js';
import es from './es.js';
import ru from './ru.js';

export { DEFAULT_LANGUAGE, LANGUAGE_REGISTRY, SUPPORTED_LANGUAGE_IDS, getLanguageLabel, getLanguageLocale, resolveLanguage, resolveLanguageFromLocale };

export const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGE_IDS.map((id) => ({
  id,
  label: LANGUAGE_REGISTRY[id].label,
  locale: LANGUAGE_REGISTRY[id].locale,
}));

export const TRANSLATION_BUNDLES = Object.freeze({
  en,
  tr,
  de,
  es,
  ru,
});

export function translate(language, key, variables = {}) {
  const selected = TRANSLATION_BUNDLES[resolveLanguage(language)] ?? TRANSLATION_BUNDLES[DEFAULT_LANGUAGE];
  const fallback = TRANSLATION_BUNDLES[DEFAULT_LANGUAGE];
  const template = selected?.[key] ?? fallback?.[key] ?? key;

  return String(template).replace(/\{(\w+)\}/g, (_match, token) =>
    Object.prototype.hasOwnProperty.call(variables, token) ? String(variables[token]) : ''
  );
}
