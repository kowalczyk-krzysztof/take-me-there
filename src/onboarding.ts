// Scaffold stub. The install-time welcome and key setup arrive in a later
// step; this only proves the page loads and resolves locales.
export {};
document.title = chrome.i18n.getMessage('appName');
const heading = document.getElementById('title');
if (heading) {
  heading.textContent = chrome.i18n.getMessage('appName');
}
const blurb = document.getElementById('blurb');
if (blurb) {
  blurb.textContent = chrome.i18n.getMessage('appDesc');
}
