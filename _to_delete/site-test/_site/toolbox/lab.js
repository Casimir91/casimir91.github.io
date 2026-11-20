/* Python Lab: tiny shared script for the guided pages.
   - a chapter is "done" when its "Your turn" cell has run without an error (or, in a chapter with no such cell,
     after the first slider move or the first successful Run); "I know this → skip" also marks it done;
   - cells marked .lab-lazy run by themselves the first time their chapter comes into view;
   - the soft placeholder disappears as soon as the first graph is drawn;
   - the small "i" buttons open and close the note next to a slider. */
(function () {
  var doc = document;
  var auto = false;            // true while this script itself presses a Run button

  function done(section) {
    if (!section || !section.id) return;
    section.classList.add('done');
    doc.querySelectorAll('.lab-step[href="#' + section.id + '"]').forEach(function (a) { a.classList.add('done'); });
  }

  function hasTurn(section) { return !!(section && section.querySelector('.lab-turn')); }

  doc.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT' || !t.closest) return;
    var s = t.closest('.lab-section');
    if (s && !hasTurn(s)) done(s);
  });

  /* after a press on Run, wait for the output; count it only if it is not an error */
  function settle(pair, tries) {
    var out = pair.querySelector('.exercise-cell-output');
    var text = out ? out.textContent : '';
    var drawn = out && out.querySelector('img, canvas, svg');
    if (/Error|Traceback/.test(text)) return;
    if (drawn || text.trim().length > 0) {
      var s = pair.closest('.lab-section');
      if (!hasTurn(s) || pair.classList.contains('lab-turn')) done(s);
      return;
    }
    if (tries > 0) setTimeout(function () { settle(pair, tries - 1); }, 700);
  }

  doc.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var run = target.closest('.exercise-editor-btn-run-code');
    if (run && !auto) {
      var pair = run.closest('.lab-pair');
      if (pair) {
        pair.classList.add('ran');
        setTimeout(function () { settle(pair, 12); }, 700);
      } else {
        done(run.closest('.lab-section'));
      }
    }

    var info = target.closest('.lab-i');
    if (info) {
      var note = info.parentElement && info.parentElement.querySelector('.lab-info');
      if (note) {
        var open = note.hasAttribute('hidden');
        if (open) note.removeAttribute('hidden'); else note.setAttribute('hidden', '');
        info.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }

    var skip = target.closest('.lab-skip');
    if (skip) done(skip.closest('.lab-section'));
  });

  /* run the ready-made cells of a chapter, one after the other, when it first comes into view */
  var queue = [];
  var busy = false;

  function pump() {
    if (busy || !queue.length) return;
    var pair = queue[0];
    var btn = pair.querySelector('.exercise-editor-btn-run-code');
    if (!btn || btn.classList.contains('disabled')) { setTimeout(pump, 400); return; }
    queue.shift();
    busy = true;
    auto = true;
    btn.click();
    auto = false;
    setTimeout(function () { busy = false; pump(); }, 900);
  }

  function lazy() {
    var pairs = doc.querySelectorAll('.lab-lazy');
    if (!pairs.length) return;
    if (!('IntersectionObserver' in window)) { pairs.forEach(function (p) { queue.push(p); }); pump(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); queue.push(en.target); pump(); }
      });
    }, { rootMargin: '300px 0px' });
    pairs.forEach(function (p) { io.observe(p); });
  }

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
    lazy();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})();
