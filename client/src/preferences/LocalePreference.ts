export type LocalePreference = 'system' | 'zh-CN' | 'en-US';

export function normalizeLocalePreference(value: unknown): LocalePreference {
  return value === 'zh-CN' || value === 'en-US' ? value : 'system';
}

export function resolveUiLocale(preference: LocalePreference, browserLanguage: string): 'zh-CN' | 'en-US' {
  if (preference !== 'system') return preference;
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
