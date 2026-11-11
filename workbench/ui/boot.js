// Before the first paint: put the saved look and detail level on <html>, so the page never flashes the wrong one.
// A classic script (not a module) so it runs before the stylesheet is applied; the lists match ui/prefs.js.
(function () {
  var d = document.documentElement, t = null, l = null;
  try { t = localStorage.getItem('wb-theme'); l = localStorage.getItem('wb-detail'); } catch (e) { /* storage blocked */ }
  if (t === 'green' || t === 'black-gold' || t === 'ivory') d.setAttribute('data-theme', t);
  if (l === 'calm' || l === 'more') d.setAttribute('data-detail', l);
}());
