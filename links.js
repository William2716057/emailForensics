
const hostOf = u => {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};
const looksLikeUrl = t =>
    /^(https?:\/\/|www\.)\S+$/i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t);

function findLinks(m) {
    const found = new Map(); // url -> { kinds:Set, notes:Set }

    const add = (raw, kind, text = '', notes = []) => {
        const url = (raw || '').trim();
        if (!url || url === '#' || /^cid:/i.test(url)) return; // skip empty anchors and inline-image refs
        const e = found.get(url) || { kinds: new Set(), notes: new Set() };
        e.kinds.add(kind);
        notes.forEach(n => e.notes.add(n));

        const host = hostOf(url);
        // Visible text looks like a URL but the real destination is a different site
        if (kind === 'link' && text && looksLikeUrl(text)) {
            const shown = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text);
            if (shown && host && shown !== host)
                e.notes.add(`? link text shows ${shown} but goes to ${host}`);
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) e.notes.add('? raw IP address as host');
        if (host.includes('xn--')) e.notes.add('? punycode domain (possible lookalike)');
        if (/^(javascript|data):/i.test(url)) e.notes.add(`? ${url.split(':')[0]}: URL`);
        found.set(url, e);
    };

    // URLs written out as plain text
    const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\])]+/gi;
    const scan = (text, kind) =>
        (text.match(URL_RE) || []).forEach(u => {
            u = u.replace(/[.,;:!?]+$/, '');
            add(/^www\./i.test(u) ? 'http://' + u : u, kind);
        });

    if (m.html) {
        // DOMParser builds an inert document: no scripts run and no images or frames load
        const doc = new DOMParser().parseFromString(m.html, 'text/html');
        doc.querySelectorAll('a[href], area[href]')
            .forEach(a => add(a.getAttribute('href'), 'link', a.textContent.trim()));
        doc.querySelectorAll('form[action]')
            .forEach(f => add(f.getAttribute('action'), 'form action'));
        doc.querySelectorAll('img[src]').forEach(i => {
            const tiny = ['width', 'height'].some(a => i.hasAttribute(a) && parseInt(i.getAttribute(a), 10) <= 1);
            add(i.getAttribute('src'), 'image', '', tiny ? ['? 1px image (possible tracking pixel)'] : []);
        });
        doc.querySelectorAll('iframe[src], script[src]')
            .forEach(el => add(el.getAttribute('src'), el.tagName.toLowerCase()));
        scan(doc.body?.textContent || '', 'text');
    }
    if (m.text) scan(m.text, 'text');

    const rows = [], warnings = [];
    if (found.size) {
        rows.push(['Unique links', String(found.size)]);
        rows.push(['Domains', [...new Set([...found.keys()].map(hostOf).filter(Boolean))]]);
    }
    let i = 1;
    for (const [url, e] of found) {
        rows.push([`${i++}. ${[...e.kinds].join(', ')}`, [url, ...e.notes]]);
        e.notes.forEach(n => warnings.push(['Link', `${n} (${url})`]));
    }
    return { rows, warnings };
}