// Fills the "Latest news" strip from the items on news.html (newest first, at most 8).
// If news.html cannot be read, the items typed into the page stay in place.
(function () {
    var track = document.querySelector('[data-news-ticker]');
    if (!track || !window.fetch || !window.DOMParser) return;

    var MAX_ITEMS = 8;

    fetch('news.html')
        .then(function (response) {
            if (!response.ok) throw new Error('news.html not readable');
            return response.text();
        })
        .then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var items = Array.prototype.slice.call(doc.querySelectorAll('.news-item'), 0, MAX_ITEMS)
                .map(readItem)
                .filter(function (item) { return item.title; });
            if (items.length) render(items);
        })
        .catch(function () { /* keep the typed items */ });

    function readItem(article) {
        var pill = article.querySelector('.status-pill');
        var role = article.querySelector('.news-item-role');
        var date = article.querySelector('.news-item-date');
        var title = article.querySelector('.news-item-title');
        var record = article.querySelector('.news-links a[href^="engagement-"]');
        return {
            date: date ? date.textContent.trim() : '',
            type: (role && role.textContent.trim()) || (pill ? pill.textContent.trim() : ''),
            title: title ? title.textContent.trim() : '',
            href: record ? record.getAttribute('href') : 'news.html'
        };
    }

    function render(items) {
        track.textContent = '';
        [false, true].forEach(function (isCopy) {
            items.forEach(function (item) {
                track.appendChild(buildLink(item, isCopy));
            });
        });
    }

    function buildLink(item, isCopy) {
        var link = document.createElement('a');
        link.className = 'tk-item';
        link.href = item.href;
        if (isCopy) {
            link.setAttribute('aria-hidden', 'true');
            link.tabIndex = -1;
        }
        [['tk-date', item.date], ['tk-type', item.type], ['tk-title', item.title]].forEach(function (part) {
            var span = document.createElement('span');
            span.className = part[0];
            span.textContent = part[1];
            link.appendChild(span);
        });
        return link;
    }
})();
