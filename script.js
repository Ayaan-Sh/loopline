(function() {
  var nodes = document.querySelectorAll('.flow-node');
  var i = 0;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function step() {
    nodes.forEach(function(n) { n.classList.remove('active'); });
    nodes[i].classList.add('active');
    i = (i + 1) % nodes.length;
  }

  if (!reduced) {
    step();
    setInterval(step, 1100);
  } else if (nodes.length) {
    nodes[0].classList.add('active');
  }
})();

/* ---------- Sliding nav underline (Apple/Stripe-style hover line) ---------- */
(function() {
  var navLinks = document.querySelector('.nav-links');
  var indicator = document.querySelector('.nav-indicator');
  if (!navLinks || !indicator) return;

  var links = Array.prototype.slice.call(navLinks.querySelectorAll('a'));

  function moveTo(el) {
    indicator.style.width = el.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + el.offsetLeft + 'px)';
  }

  links.forEach(function(link) {
    link.addEventListener('mouseenter', function() {
      navLinks.classList.add('is-hovering');
      moveTo(link);
    });
    link.addEventListener('focus', function() {
      navLinks.classList.add('is-hovering');
      moveTo(link);
    });
  });

  navLinks.addEventListener('mouseleave', function() {
    navLinks.classList.remove('is-hovering');
  });

  navLinks.addEventListener('focusout', function(e) {
    if (!navLinks.contains(e.relatedTarget)) {
      navLinks.classList.remove('is-hovering');
    }
  });
})();

document.getElementById('contact-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var name = this.name.value.trim();
  var company = this.company.value.trim();
  var email = this.email.value.trim();
  var message = this.message.value.trim();

  var subject = encodeURIComponent('Project inquiry from ' + name + (company ? ' (' + company + ')' : ''));
  var body = encodeURIComponent(
    'Name: ' + name + '\n' +
    'Company: ' + company + '\n' +
    'Email: ' + email + '\n\n' +
    message
  );

  window.location.href = 'mailto:hello@loopline.co?subject=' + subject + '&body=' + body;
  document.getElementById('form-status').textContent = 'Opening your email client...';
});

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