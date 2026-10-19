export const THEMES = Object.freeze([
  {id: 'system', name: 'Как на устройстве'},
  {id: 'light', name: 'Светлая'},
  {id: 'dark', name: 'Тёмная'}
]);

export function resolveTheme(preference = 'system', systemDark = false) {
  return preference === 'dark' || preference === 'system' && systemDark ? 'dark' : 'light';
}

export function applyTheme(preference = 'system') {
  const selected = THEMES.some(theme => theme.id === preference) ? preference : 'system';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(selected, dark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#09090b' : '#fafafa';
  try {
    const key = 'hemis-planner-theme-v1:' + new URL('./', location.href).pathname;
    if (localStorage.getItem(key) !== selected) localStorage.setItem(key, selected);
  } catch { /* Choosing a theme still works when browser storage is unavailable. */ }
  return theme;
}
