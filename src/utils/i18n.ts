export const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);
