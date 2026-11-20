/* Python Lab: tiny shared script for the guided pages.
   - a step is "done" after the first slider move or the first press of a Run button in its section;
   - the soft placeholder disappears as soon as the first graph is drawn;
   - the small "i" buttons open and close the note next to a slider. */
(function () {
  var doc = document;

  function done(section) {
    if (!section || !section.id) return;
    section.classList.add('done');
    doc.querySelectorAll('.lab-step[href="#' + section.id + '"]').forEach(function (a) { a.classList.add('done'); });
  }

  doc.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && t.closest) done(t.closest('.lab-section'));
  });

  doc.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var run = target.closest('.exercise-editor-btn-run-code');
    if (run) done(run.closest('.lab-section'));

    var info = target.closest('.lab-i');
    if (info) {
      var note = info.parentElement && info.parentElement.querySelector('.lab-info');
      if (note) {
        var open = note.hasAttribute('hidden');
        if (open) note.removeAttribute('hidden'); else note.setAttribute('hidden', '');
        info.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }
  });

  function watch(section) {
    if (!('MutationObserver' in window)) return;
    var mo = new MutationObserver(function () {
      if (section.querySelector('img, canvas, .exercise-cell-output svg')) {
        section.classList.add('live');
        mo.disconnect();
      }
    });
    mo.observe(section, { childList: true, subtree: true });
  }

  function init() {
    doc.querySelectorAll('.lab-section').forEach(function (s) {
      if (s.querySelector('.lab-ghost')) watch(s);
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})();
