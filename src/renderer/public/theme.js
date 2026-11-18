// The saved theme on <html> before the first paint (no light flash in dark mode).
try {
  document.documentElement.dataset.theme = JSON.parse(localStorage.getItem('env-settings') || '{}').theme || 'light'
} catch (e) {
  document.documentElement.dataset.theme = 'light'
}
