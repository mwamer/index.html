(function () {
    var form = document.getElementById('contact-form');
    if (!form) return;

    var summary = document.getElementById('form-summary');
    var success = document.getElementById('form-success');
    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        success.hidden = true;

        // A filled honeypot means a bot: stop without any message.
        if (form.elements.website.value) return;

        var invalid = validate();
        summary.hidden = invalid.length === 0;

        if (invalid.length > 0) {
            invalid[0].focus();
            return;
        }

        success.hidden = false;
        success.focus();
    });

    form.addEventListener('input', function (event) {
        var field = event.target;
        if (field.getAttribute('aria-invalid') === 'true') check(field);
    });

    function validate() {
        var fields = [form.elements.name, form.elements.email, form.elements.message, form.elements.consent];
        return fields.filter(function (field) { return !check(field); });
    }

    function check(field) {
        var message = errorFor(field);
        var error = document.getElementById(field.id + '-error');
        error.hidden = !message;
        if (message) error.textContent = message;
        if (message) field.setAttribute('aria-invalid', 'true');
        else field.removeAttribute('aria-invalid');
        return !message;
    }

    function errorFor(field) {
        if (field.type === 'checkbox') return field.checked ? '' : 'Tick the box to confirm you agree.';
        var value = field.value.trim();
        if (field.id === 'name') return value ? '' : 'Enter your full name.';
        if (field.id === 'message') return value ? '' : 'Tell me briefly how I can help.';
        if (!value) return 'Enter your email address.';
        return emailPattern.test(value) ? '' : 'Enter an email address in the format name@example.com.';
    }
})();
