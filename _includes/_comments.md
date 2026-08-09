```{=html}
<style>
  /* The Cusdis iframe defaults to 150px, and its resize message does not always
     arrive, which leaves the form scrolling inside a small box. min-height sets
     a comfortable floor while still letting Cusdis grow it if resize does fire,
     since an inline height from the SDK beats this rule. */
  #cusdis_thread iframe {
    width: 100%;
    min-height: 480px;
    border: 0;
  }
  #comments-section {
    margin-top: 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid rgba(128, 128, 128, 0.3);
  }
  #comments-section > p {
    margin-bottom: 1rem;
  }
</style>
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
