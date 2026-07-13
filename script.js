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
    } else {
      nodes[0].classList.add('active');
    }
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