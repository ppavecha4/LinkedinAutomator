// Remembers a language the visitor picked, and, on hosting where the web server does not choose,
// sends the root page to the visitor's language. No tracking, no third-party code.
(function () {
  'use strict';
  var all = ['en', 'es', 'pt', 'de', 'nl'];
  function remember(lang) {
    var keep = '; path=/; max-age=31536000; SameSite=Lax';
    document.cookie = 'lang=' + lang + keep;
    // Static hosts such as Netlify can only test whether a cookie exists, so there is one per language.
    all.forEach(function (code) {
      document.cookie = code === lang ? 'pref_' + code + '=1' + keep : 'pref_' + code + '=; path=/; max-age=0';
    });
  }
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[data-lang]');
    if (link) remember(link.getAttribute('data-lang'));
  });
  var body = document.body;
  var offered = (body.getAttribute('data-chooser') || '').split(' ').filter(Boolean);
  if (!offered.length) return;
  var saved = (document.cookie.match(/(?:^|;\s*)lang=([a-z]{2})(?:;|$)/) || [])[1];
  var wanted = [saved].concat(navigator.languages || [navigator.language]);
  for (var i = 0; i < wanted.length; i++) {
    var code = String(wanted[i] || '').slice(0, 2).toLowerCase();
    if (offered.indexOf(code) !== -1) return window.location.replace(code + '/');
  }
  window.location.replace(body.getAttribute('data-default') + '/');
})();
