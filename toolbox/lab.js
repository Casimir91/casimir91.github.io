/* Python Lab: shared script for the guided pages.
   - a chapter is "done" when its "Your turn" cell has run without an error (or, in a chapter with no such cell,
     after the first slider move or the first successful Run); "I know this → skip" also marks it done;
   - a guess comes first: cells marked .lab-lazy in a chapter with a question wait for the guess (or "just show me"),
     the explanation appears when the chapter is done;
   - chapters without a question run their ready-made cells when they come into view;
   - the rail stays in view, marks where you are (.here) and what comes next (.next, pulsing);
   - after a while without any action a hint writes itself, and the Run button pulses;
   - the picture grows with the story; the "i" buttons open the note next to a slider. */
(function () {
  var doc = document, root = doc.documentElement;
  var auto = false;                       // true while this script itself presses a Run button
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var IDLE = 11000;                       // ms of stillness before a hint

  root.classList.add('lab-js');

  function sectionOf(el) { return el && el.closest ? el.closest('.lab-section') : null; }
  function hasTurn(section) { return !!(section && section.querySelector('.lab-turn')); }
  function all(sel, from) { return Array.prototype.slice.call((from || doc).querySelectorAll(sel)); }

  /* ---------- page furniture ---------- */
  function offset() {
    var h = doc.querySelector('#quarto-header');
    var px = h ? Math.round(h.getBoundingClientRect().height) : 56;
    root.style.setProperty('--lab-top', px + 'px');
  }

  function refresh() {
    var n = 0, next = null;
    all('.lab-section').forEach(function (s) {
      if (s.classList.contains('done')) n++; else if (!next) next = s;
    });
    all('.lab-step').forEach(function (a) {
      a.classList.toggle('next', !!next && a.getAttribute('href') === '#' + next.id);
    });
    var hero = doc.querySelector('.lab-hero-fig .lab-scene');
    if (hero) hero.setAttribute('data-stage', String(Math.min(n, 8)));
  }

  /* ---------- the guess and its explanation ---------- */
  function reveal(section) {
    var ask = section && section.querySelector('.lab-ask');
    if (!ask || ask.classList.contains('revealed')) return;
    var right = ask.getAttribute('data-right'), pick = ask.getAttribute('data-pick');
    ask.classList.add('revealed');
    all('.lab-opt', ask).forEach(function (o) {
      if (o.getAttribute('data-opt') === right) o.classList.add('right');
      else if (o.classList.contains('picked')) o.classList.add('wrong');
      o.disabled = true;
    });
    var v = ask.querySelector('.lab-verdict');
    if (v) v.textContent = !pick ? 'Here is the answer.' : (pick === right ? 'You guessed it.' : 'Not quite.');
    var r = ask.querySelector('.lab-reveal');
    if (r) r.hidden = false;
  }

  function done(section) {
    if (!section || !section.id) return;
    section.classList.add('done');
    all('.lab-step[href="#' + section.id + '"]').forEach(function (a) { a.classList.add('done'); });
    reveal(section);
    hideBubbles(section);
    clearTimeout(section._t);
    refresh();
  }

  /* ---------- hints that write themselves ---------- */
  function hideBubbles(section) {
    all('.lab-bubble', section).forEach(function (b) { b.hidden = true; b.textContent = ''; clearInterval(b._typing); });
    all('.lab-pair.nudged', section).forEach(function (p) { p.classList.remove('nudged'); });
  }

  function type(bubble, text) {
    clearInterval(bubble._typing);
    bubble.hidden = false;
    if (reduce) { bubble.textContent = text; return; }
    var i = 0;
    bubble.textContent = '';
    bubble.classList.add('typing');
    bubble._typing = setInterval(function () {
      i++;
      bubble.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(bubble._typing); bubble.classList.remove('typing'); }
    }, 24);
  }

  function nudge(section) {
    if (!section || section.classList.contains('done') || !section._vis) return;
    var turn = section.querySelector('.lab-turn:not(.ran)');
    var ask = section.querySelector('.lab-ask');
    var guessed = !ask || ask.hasAttribute('data-pick') || section.getAttribute('data-go');
    if (turn && guessed && (section._touched || !section.querySelector('.lab-lazy')) && turn.getAttribute('data-nudge')) {
      var b = turn._bubble;
      if (!b) {
        b = doc.createElement('p'); b.className = 'lab-bubble'; b.setAttribute('role', 'status');
        turn.parentNode.insertBefore(b, turn); turn._bubble = b;
      }
      turn.classList.add('nudged');
      type(b, turn.getAttribute('data-nudge'));
      return;
    }
    var gen = section.querySelector('.lab-bubble[data-text]');
    if (gen && guessed) type(gen, gen.getAttribute('data-text'));
  }

  function arm(section) {
    clearTimeout(section._t);
    if (!section || section.classList.contains('done') || !section._vis) return;
    section._t = setTimeout(function () { nudge(section); }, IDLE);
  }

  function touch(section) {
    if (!section) return;
    section._touched = true;
    hideBubbles(section);
    arm(section);
  }

  /* ---------- events ---------- */
  doc.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT' || !t.closest) return;
    var s = sectionOf(t);
    if (!s) return;
    touch(s);
    if (!hasTurn(s)) done(s);
  });

  doc.addEventListener('keydown', function (e) {
    if (e.target && e.target.closest && e.target.closest('.exercise-editor')) touch(sectionOf(e.target));
  });

  /* after a press on Run, wait for the output; count it only if it is not an error */
  function settle(pair, tries) {
    var out = pair.querySelector('.exercise-cell-output');
    var text = out ? out.textContent : '';
    var drawn = out && out.querySelector('img, canvas, svg');
    if (/Error|Traceback/.test(text)) return;
    if (drawn || text.trim().length > 0) {
      var s = sectionOf(pair);
      if (!hasTurn(s) || pair.classList.contains('lab-turn')) done(s);
      return;
    }
    if (tries > 0) setTimeout(function () { settle(pair, tries - 1); }, 700);
  }

  doc.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var sec = sectionOf(target);

    var run = target.closest('.exercise-editor-btn-run-code');
    if (run && !auto) {
      var pair = run.closest('.lab-pair');
      touch(sec);
      if (pair) {
        pair.classList.add('ran');
        setTimeout(function () { settle(pair, 12); }, 700);
      } else {
        done(sec);
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
      touch(sec);
    }

    var skip = target.closest('.lab-skip');
    if (skip) done(skip.closest('.lab-section'));

    var opt = target.closest('.lab-opt');
    if (opt) {
      var ask = opt.closest('.lab-ask');
      if (ask && !ask.classList.contains('revealed')) {
        all('.lab-opt', ask).forEach(function (o) {
          o.classList.toggle('picked', o === opt);
          o.setAttribute('aria-pressed', o === opt ? 'true' : 'false');
        });
        ask.setAttribute('data-pick', opt.getAttribute('data-opt'));
        go(sec);
        touch(sec);
        if (sec && sec.classList.contains('done')) reveal(sec);
      }
    }

    var show = target.closest('.lab-justshow');
    if (show) { go(sectionOf(show)); touch(sectionOf(show)); }
  });

  /* ---------- running the ready-made cells ---------- */
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

  function enqueue(pair) {
    if (pair.getAttribute('data-queued')) return;
    pair.setAttribute('data-queued', '1');
    queue.push(pair);
    pump();
  }

  function go(section) {
    if (!section) return;
    section.setAttribute('data-go', '1');
    all('.lab-lazy', section).forEach(enqueue);
  }

  function lazy() {
    var pairs = all('.lab-lazy').filter(function (p) {
      var s = sectionOf(p);
      return !(s && s.querySelector('.lab-ask'));       // chapters with a question wait for the guess
    });
    if (!pairs.length) return;
    if (!('IntersectionObserver' in window)) { pairs.forEach(enqueue); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); enqueue(en.target); }
      });
    }, { rootMargin: '300px 0px' });
    pairs.forEach(function (p) { io.observe(p); });
  }

  /* ---------- watching what is on screen ---------- */
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

  function observe() {
    if (!('IntersectionObserver' in window)) { all('.lab-section').forEach(function (s) { s._vis = true; }); return; }

    var vis = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var s = en.target;
        s._vis = en.isIntersecting;
        if (en.isIntersecting) arm(s); else clearTimeout(s._t);
      });
    }, { threshold: 0.25 });
    all('.lab-section').forEach(function (s) { vis.observe(s); });

    var here = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting || !en.target.id) return;
        all('.lab-step').forEach(function (a) { a.classList.toggle('here', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    all('.lab-section').forEach(function (s) { here.observe(s); });

    var figs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); figs.unobserve(en.target); }
      });
    }, { threshold: 0.4 });
    all('.lab-fig').forEach(function (f) { figs.observe(f); });
  }

  function init() {
    offset();
    window.addEventListener('resize', offset);
    all('.lab-section').forEach(function (s) {
      if (s.querySelector('.lab-ghost')) watch(s);
    });
    observe();
    lazy();
    refresh();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})();
