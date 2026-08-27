/* ---------- Dark mode toggle ---------- */
(function() {
  var toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  var root = document.documentElement;
  var STORAGE_KEY = 'loopline_theme';

  toggle.addEventListener('click', function() {
    var isDark = root.getAttribute('data-theme') === 'dark';
    if (isDark) {
      root.removeAttribute('data-theme');
      try { localStorage.setItem(STORAGE_KEY, 'light'); } catch (e) {}
    } else {
      root.setAttribute('data-theme', 'dark');
      try { localStorage.setItem(STORAGE_KEY, 'dark'); } catch (e) {}
    }
  });
})();

/* ---------- Mobile nav toggle ---------- */
(function() {
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (!toggle || !links) return;

  function closeMenu() {
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    links.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', function(e) {
    e.stopPropagation();
    if (links.classList.contains('open')) closeMenu();
    else openMenu();
  });

  links.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', closeMenu);
  });

  document.addEventListener('click', function(e) {
    if (!links.contains(e.target) && !toggle.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', function() {
    if (window.innerWidth > 860) closeMenu();
  });
})();

/* ---------- Sliding nav underline (Apple/Stripe-style hover line) + scrollspy ---------- */
(function() {
  var navLinks = document.querySelector('.nav-links');
  var indicator = document.querySelector('.nav-indicator');
  if (!navLinks || !indicator) return;

  var links = Array.prototype.slice.call(navLinks.querySelectorAll('a'));
  var linkMap = {};
  links.forEach(function(l) {
    var id = l.getAttribute('href').replace('#', '');
    linkMap[id] = l;
  });

  var isHovering = false;
  var activeLink = null;
  var shownLink = null;

  function moveIndicatorTo(link) {
    shownLink = link;
    indicator.style.width = link.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + link.offsetLeft + 'px)';
  }
  function showIndicator() { navLinks.classList.add('show-indicator'); }
  function hideIndicator() { navLinks.classList.remove('show-indicator'); }

  links.forEach(function(link) {
    link.addEventListener('mouseenter', function() {
      isHovering = true;
      moveIndicatorTo(link);
      showIndicator();
    });
    link.addEventListener('focus', function() {
      isHovering = true;
      moveIndicatorTo(link);
      showIndicator();
    });
  });

  navLinks.addEventListener('mouseleave', function() {
    isHovering = false;
    if (activeLink) { moveIndicatorTo(activeLink); showIndicator(); }
    else { hideIndicator(); }
  });

  navLinks.addEventListener('focusout', function(e) {
    if (!navLinks.contains(e.relatedTarget)) {
      isHovering = false;
      if (activeLink) { moveIndicatorTo(activeLink); showIndicator(); }
      else { hideIndicator(); }
    }
  });

  window.addEventListener('resize', function() {
    if (shownLink) moveIndicatorTo(shownLink);
  });

  // scrollspy: highlight + slide the indicator to whichever section is in view
  var sectionEls = Object.keys(linkMap)
    .map(function(id) { return document.getElementById(id); })
    .filter(Boolean);

  if (sectionEls.length && 'IntersectionObserver' in window) {
    var spyObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var link = linkMap[entry.target.id];
        if (!link) return;
        links.forEach(function(l) { l.classList.remove('nav-active'); });
        link.classList.add('nav-active');
        activeLink = link;
        if (!isHovering) { moveIndicatorTo(link); showIndicator(); }
      });
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });

    sectionEls.forEach(function(el) { spyObserver.observe(el); });
  }
})();

/* ---------- Sticky header polish ---------- */
(function() {
  var header = document.querySelector('header');
  if (!header) return;
  function onScroll() {
    if (window.scrollY > 12) header.classList.add('is-scrolled');
    else header.classList.remove('is-scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

/* ---------- Scroll-reveal on entry ---------- */
(function() {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function tagGroup(selector, staggerMs) {
    var items = document.querySelectorAll(selector);
    items.forEach(function(el, idx) {
      el.classList.add('reveal');
      if (staggerMs) el.style.transitionDelay = (idx * staggerMs) + 'ms';
    });
  }

  tagGroup('.section-head', 0);
  tagGroup('.service-card', 90);
  tagGroup('.process-step', 90);
  tagGroup('.work-carousel, .work-dots', 0);
  tagGroup('.contact-info, #contact-form', 100);

  if (reduced || !('IntersectionObserver' in window)) return;

  var revealObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

  document.querySelectorAll('.reveal').forEach(function(el) {
    revealObserver.observe(el);
  });
})();

var contactForm = document.getElementById('contact-form');
if (contactForm) {
contactForm.addEventListener('submit', function(e) {
  e.preventDefault();
  var form = this;
  var status = document.getElementById('form-status');
  var submitBtn = form.querySelector('button[type="submit"]');
  var originalLabel = submitBtn.textContent;

  status.textContent = 'Sending...';
  status.classList.remove('form-status-success', 'form-status-error');
  submitBtn.disabled = true;
  submitBtn.style.opacity = '0.6';

  var formData = new FormData(form);

  fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: formData
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        status.textContent = "Thanks- we've got your message and will get back to you within 1–2 business days.";
        status.classList.add('form-status-success');
        form.reset();
      } else {
        status.textContent = data.message || "Something went wrong — please try again or email us directly.";
        status.classList.add('form-status-error');
      }
    })
    .catch(function() {
      status.textContent = "Couldn't send that — please try again or email us directly at hello@loopline.co.";
      status.classList.add('form-status-error');
    })
    .finally(function() {
      submitBtn.disabled = false;
      submitBtn.style.opacity = '';
      submitBtn.textContent = originalLabel;
    });
});
}

/* ---------- Recent work: 3D circular carousel ---------- */
(function() {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.work-card'));
  var count = cards.length;
  if (!count) return;

  var prevBtn = document.getElementById('work-prev');
  var nextBtn = document.getElementById('work-next');
  var dotsWrap = document.getElementById('work-dots');
  var current = 0;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var autoplayMs = 5000;
  var timer = null;

  // build dot indicators
  var dots = cards.map(function(_, idx) {
    var d = document.createElement('button');
    d.className = 'work-dot';
    d.type = 'button';
    d.setAttribute('aria-label', 'Go to work sample ' + (idx + 1));
    d.addEventListener('click', function() {
      goTo(idx);
      restartAutoplay();
    });
    dotsWrap.appendChild(d);
    return d;
  });

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  function render() {
    cards.forEach(function(card, idx) {
      var offset = mod(idx - current, count);
      var pos;
      if (offset === 0) pos = 'center';
      else if (offset === 1) pos = 'right';
      else if (offset === count - 1) pos = 'left';
      else pos = 'hidden';
      card.setAttribute('data-pos', pos);
      card.setAttribute('aria-hidden', pos === 'center' ? 'false' : 'true');
    });
    dots.forEach(function(d, idx) {
      d.classList.toggle('active', idx === current);
    });
  }

  function goTo(idx) {
    current = mod(idx, count);
    render();
  }

  function next() { goTo(current + 1); }
  function prevSlide() { goTo(current - 1); }

  nextBtn.addEventListener('click', function() { next(); restartAutoplay(); });
  prevBtn.addEventListener('click', function() { prevSlide(); restartAutoplay(); });

  // clicking a side (non-center) card jumps to it
  cards.forEach(function(card, idx) {
    card.addEventListener('click', function() {
      if (card.getAttribute('data-pos') !== 'center') {
        goTo(idx);
        restartAutoplay();
      }
    });
  });

  // keyboard support when the carousel area has focus
  var stage = document.querySelector('.work-carousel');
  if (stage) {
    stage.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowRight') { next(); restartAutoplay(); }
      if (e.key === 'ArrowLeft') { prevSlide(); restartAutoplay(); }
    });
  }

  function startAutoplay() {
    if (reduced || count < 2) return;
    timer = setInterval(next, autoplayMs);
  }
  function restartAutoplay() {
    if (timer) clearInterval(timer);
    startAutoplay();
  }

  render();
  startAutoplay();
})();