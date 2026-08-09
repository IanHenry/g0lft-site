```{=html}
<section id="comments-section" hidden>
<h2>Comments</h2>
<p>You don't need an account, just a name. Comments are read before they appear,
so there may be a short delay before yours shows up.</p>
<div id="cusdis_thread"
     data-host="https://cusdis.com"
     data-app-id="dea1e098-1427-480b-8085-9974093665c4"></div>
</section>
<script>
(function () {
  var el = document.getElementById('cusdis_thread');
  if (!el) return;
  // Stay invisible until a real Cusdis app id has been filled in, so the
  // section never appears half-working on the live site.
  var appId = el.getAttribute('data-app-id');
  if (!appId || appId.indexOf('REPLACE_WITH') === 0) return;

  // A stable id per page, so comments stay attached to the right page.
  var path = window.location.pathname.replace(/index\.html$/, '');
  if (path.length > 1) path = path.replace(/\/$/, '');
  el.setAttribute('data-page-id', path);
  el.setAttribute('data-page-url', window.location.origin + path);
  el.setAttribute('data-page-title', document.title);

  document.getElementById('comments-section').removeAttribute('hidden');

  var s = document.createElement('script');
  s.src = 'https://cusdis.com/js/cusdis.es.js';
  s.defer = true;
  document.body.appendChild(s);
})();
</script>
```
