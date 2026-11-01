
// ---------- Helpers ----------
const panelByTitle = t =>
    [...document.querySelectorAll('.panel')].find(p => p.querySelector('h2')?.textContent.trim() === t);

// Fill a panel with label/value rows. Uses textContent only (email data is untrusted).
function render(title, rows) {
    const p = panelByTitle(title);
    if (!p) return;
    p.querySelectorAll(':scope > :not(h2)').forEach(e => e.remove());
    if (!rows.length) rows = [['', 'Nothing found']];
    for (const [label, value] of rows) {
        const div = document.createElement('div');
        if (label) {
            const b = document.createElement('strong');
            b.textContent = label + ': ';
            div.append(b);
        }
        const span = document.createElement('span');
        span.style.wordBreak = 'break-all';
        span.textContent = Array.isArray(value) ? value.join('\n') : value;
        span.style.whiteSpace = 'pre-wrap';
        div.append(span);
        p.append(div);
    }
}

const bufToBinary = buf => {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
    return s;
};
const binToBytes = s => Uint8Array.from(s, c => c.charCodeAt(0));

function bytesToText(bytes, charset) {
    const label = (charset || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    const attempt = (cs, fatal) => {
        try { return new TextDecoder(cs, { fatal }).decode(bytes); } catch { return null; }
    };
    // No charset declared: try strict UTF-8 first, else assume Windows-1252
    if (!label) return attempt('utf-8', true) ?? attempt('windows-1252', false);
    // Declared charset (shift_jis, iso-2022-jp, euc-kr, gb2312, big5, koi8-r, ...), then fallbacks
    return attempt(label, false) ?? attempt('utf-8', true) ?? attempt('windows-1252', false);
}

const decodeQP = s =>
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

// RFC 2047 encoded words: =?UTF-8?B?...?= / =?ISO-2022-JP?B?...?=
// Adjacent words with the same charset/encoding are joined BEFORE decoding, because
// a multibyte character (or ISO-2022-JP escape sequence) can be split across words.
const WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/;
function decodeWords(str = '') {
    str = str.replace(/(\?=)\s+(=\?)/g, '$1$2');
    return str.replace(/(?:=\?[^?]+\?[bBqQ]\?[^?]*\?=)+/g, run => {
        const words = run.match(new RegExp(WORD.source, 'g'));
        let out = '';
        for (let i = 0; i < words.length;) {
            const [, cs, enc] = words[i].match(WORD);
            let bin = '', j = i;
            for (; j < words.length; j++) {
                const m = words[j].match(WORD);
                if (m[1].toLowerCase() !== cs.toLowerCase() || m[2].toUpperCase() !== enc.toUpperCase()) break;
                try {
                    bin += enc.toUpperCase() === 'B' ? atob(m[3]) : decodeQP(m[3].replace(/_/g, ' '));
                } catch { /* skip bad word */ }
            }
            out += bytesToText(binToBytes(bin), cs.split('*')[0]); // "utf-8*ja" -> "utf-8"
            i = j;
        }
        return out;
    });
}

// MIME parsing (.eml core)
// Headers read as a binary string: if they contain raw UTF-8 bytes, decode them properly
function fixRaw(v) {
    if (!/[\x80-\xff]/.test(v) || /[^\x00-\xff]/.test(v)) return v;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(binToBytes(v)); } catch { return v; }
}

function parseHeaders(text) {
    const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
    return unfolded.split(/\r?\n/).filter(l => l.includes(':')).map(l => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), fixRaw(l.slice(i + 1).trim())];
    });
}
const getAll = (h, name) => h.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
const get = (h, name) => getAll(h, name)[0] || '';

function parseParams(value) {
    const [main, ...rest] = value.split(';');
    const params = {};
    for (const r of rest) {
        const m = r.match(/^\s*([^=\s]+)\s*=\s*"?([^"]*)"?\s*$/);
        if (m) params[m[1].toLowerCase()] = m[2];
    }
    for (const k of Object.keys(params)) {
        if (k.endsWith('*') && !/\*\d/.test(k)) {
            const m = params[k].match(/^([^']*)'[^']*'(.*)$/);
            if (m) {
                const bin = m[2].replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
                params[k.slice(0, -1)] = bytesToText(binToBytes(bin), m[1] || 'utf-8');
            }
        }
    }
    return { type: main.trim().toLowerCase(), params };
}

function parseMime(raw) {
    const split = raw.search(/\r?\n\r?\n/);
    const headText = split === -1 ? raw : raw.slice(0, split);
    const body = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
    const headers = parseHeaders(headText);
    const { type, params } = parseParams(get(headers, 'content-type') || 'text/plain');
    const disp = parseParams(get(headers, 'content-disposition') || '');
    const node = {
        headers, type, params, children: [],
        cte: get(headers, 'content-transfer-encoding').toLowerCase(),
        disposition: disp.type,
        filename: decodeWords(disp.params.filename || params.name || ''),
    };
    if (type.startsWith('multipart/') && params.boundary) {
        const parts = body.split('--' + params.boundary).slice(1);
        for (const p of parts) {
            if (p.startsWith('--')) break; // closing delimiter
            node.children.push(parseMime(p.replace(/^\r?\n/, '')));
        }
    } else if (type === 'message/rfc822') {
        node.children.push(parseMime(body));
    } else {
        if (node.cte === 'base64') {
            try { node.bytes = binToBytes(atob(body.replace(/[^A-Za-z0-9+/=]/g, ''))); }
            catch { node.bytes = new Uint8Array(); }
        } else if (node.cte === 'quoted-printable') {
            node.bytes = binToBytes(decodeQP(body));
        } else {
            node.bytes = binToBytes(body);
        }
    }
    return node;
}

function walk(node, fn, depth = 0) {
    fn(node, depth);
    node.children.forEach(c => walk(c, fn, depth + 1));
}

//Format detection
async function loadEmail(file) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const ext = file.name.split('.').pop().toLowerCase();

    // OLE2 compound file => Outlook .msg
    if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return loadMsg(buf);

    let raw = bufToBinary(buf);
    let note = '';

    // mbox: starts with "From " line; use the first message
    if (/^From \S+/.test(raw)) {
        const msgs = raw.split(/\r?\n(?=From \S+ .*\d{4}\r?\n)/);
        raw = msgs[0].replace(/^From .*\r?\n/, '');
        note = `mbox file with ${msgs.length} message(s); showing the first`;
    }
    // .emlx: first line is the byte length of the message
    if (ext === 'emlx' || /^\d+\r?\n/.test(raw)) {
        const m = raw.match(/^(\d+)\r?\n/);
        if (m) raw = raw.slice(m[0].length, m[0].length + parseInt(m[1], 10));
    }

    const root = parseMime(raw);
    let text = '', html = '';
    const attachments = [], structure = [];
    walk(root, (n, d) => {
        structure.push('  '.repeat(d) + n.type + (n.params.charset ? ` (${n.params.charset})` : '') +
            (n.cte ? ` [${n.cte}]` : ''));
        if (!n.bytes) return;
        const isAttach = n.disposition === 'attachment' || n.filename;
        if (isAttach) attachments.push({ name: n.filename || '(unnamed)', type: n.type, size: n.bytes.length });
        else if (n.type === 'text/plain') text += bytesToText(n.bytes, n.params.charset);
        else if (n.type === 'text/html') html += bytesToText(n.bytes, n.params.charset);
    });
    return { headers: root.headers, text, html, attachments, structure, note, format: ext };
}

async function loadMsg(buf) {
    // .msg needs a library. @kenjiuno/msgreader is a pure-JS reader.
    const { default: MsgReader } = await import('https://esm.sh/@kenjiuno/msgreader');
    const d = new MsgReader(buf).getFileData();
    const headers = d.headers ? parseHeaders(d.headers) : [];
    if (!headers.length) {
        headers.push(['From', `${d.senderName || ''} <${d.senderEmail || ''}>`]);
        headers.push(['To', (d.recipients || []).map(r => `${r.name} <${r.email}>`).join(', ')]);
        headers.push(['Subject', d.subject || '']);
    }
    return {
        headers, text: d.body || '', html: d.bodyHtml || '',
        attachments: (d.attachments || []).map(a => ({
            name: a.fileName || a.name || '(unnamed)', type: a.mimeType || '', size: a.contentLength || 0,
        })),
        structure: ['Outlook .msg (OLE2 compound file)'], note: '', format: 'msg',
    };
}

//Analysis
const IP_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const domainOf = s => (s.match(/@([A-Za-z0-9.-]+)/) || [])[1]?.toLowerCase() || '';

function populate(m) {
    const h = m.headers;
    const dec = name => getAll(h, name).map(decodeWords);

    // Body
    const p = panelByTitle('Email Content');
    p.querySelectorAll(':scope > :not(h2)').forEach(e => e.remove());
    const subj = document.createElement('div');
    subj.innerHTML = '<strong>Subject: </strong>';
    subj.append(decodeWords(get(h, 'subject')) || '(none)');
    p.append(subj);
    if (m.note) { const n = document.createElement('em'); n.textContent = m.note; p.append(n); }
    if (m.html) {
        // Sandboxed with no permissions: scripts, forms and top navigation are blocked
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', '');
        // Wrap long unbroken strings inside the email's own document too
        f.srcdoc = '<style>html,body{overflow-wrap:anywhere;word-break:break-word}img{max-width:100%;height:auto}</style>' + m.html;
        f.style.cssText = 'width:100%;height:400px;border:1px solid #ccc;background:#fff';
        p.append(f);
    }
    if (m.text) {
        const pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-width:100%;margin:0';
        pre.textContent = m.text;
        p.append(pre);
    }

    render('Sender Data', [
        ['From', dec('from')], ['Sender', dec('sender')],
        ['Reply-To', dec('reply-to')], ['Return-Path', getAll(h, 'return-path')],
    ].filter(r => r[1].length));

    render('Recipient Data', [
        ['To', dec('to')], ['Cc', dec('cc')], ['Bcc', dec('bcc')],
        ['Delivered-To', getAll(h, 'delivered-to')],
    ].filter(r => r[1].length));

    const received = getAll(h, 'received');
    const dateStr = get(h, 'date');
    const parsed = new Date(dateStr);
    render('Date and Time Data', [
        ['Date header', dateStr],
        ['As UTC', isNaN(parsed) ? 'unparseable' : parsed.toISOString()],
        ['Last hop (earliest)', received.at(-1)?.split(';').pop().trim() || ''],
        ['First hop (latest)', received[0]?.split(';').pop().trim() || ''],
    ]);

    render('Technical Metadata', [
        ['Message-ID', get(h, 'message-id')], ['MIME-Version', get(h, 'mime-version')],
        ['Content-Type', get(h, 'content-type')],
        ['Content-Transfer-Encoding', get(h, 'content-transfer-encoding')],
        ['Header count', String(h.length)], ['File format', m.format],
    ].filter(r => r[1]));

    render('Attachment Metadata', m.attachments.map(a =>
        [a.name, `${a.type}, ${a.size.toLocaleString()} bytes`]));

    const ips = [...new Set([...received.join(' ').matchAll(IP_RE)].map(x => x[0])
        .concat(getAll(h, 'x-originating-ip').flatMap(v => v.match(IP_RE) || [])))];
    render('Network and IP Metadata', [
        ['IP addresses found', ips], ['X-Originating-IP', getAll(h, 'x-originating-ip')],
    ].filter(r => r[1].length));

    render('Email Routing Information', received.map((r, i) =>
        [`Hop ${received.length - i}`, r]));

    render('Email Client and Device Information', [
        ['X-Mailer', getAll(h, 'x-mailer')], ['User-Agent', getAll(h, 'user-agent')],
        ['X-MimeOLE', getAll(h, 'x-mimeole')], ['Thread-Index', getAll(h, 'thread-index')],
    ].filter(r => r[1].length));

    render('Structure and Formatting', [
        ['MIME tree', m.structure], ['Has plain text', String(!!m.text)], ['Has HTML', String(!!m.html)],
    ]);

    render('Relationship and Conversations', [
        ['In-Reply-To', getAll(h, 'in-reply-to')], ['References', getAll(h, 'references')],
        ['Thread-Topic', dec('thread-topic')],
    ].filter(r => r[1].length));

    // Email carries no location data; timezone offsets are the only real hint without an IP lookup
    const tz = [dateStr, ...received.map(r => r.split(';').pop())]
        .map(s => (s.match(/[+-]\d{4}\b/) || [])[0]).filter(Boolean);
    render('Geography', [['Timezone offsets seen', [...new Set(tz)]], ['IPs to geolocate', ips]]
        .filter(r => r[1].length));

    // Heuristic red flags
    const flags = [];
    const from = domainOf(get(h, 'from')), rp = domainOf(get(h, 'return-path')),
        reply = domainOf(get(h, 'reply-to'));
    if (from && rp && from !== rp) flags.push(['Mismatch', `From domain (${from}) differs from Return-Path (${rp})`]);
    if (from && reply && from !== reply) flags.push(['Mismatch', `From domain (${from}) differs from Reply-To (${reply})`]);
    const auth = (get(h, 'authentication-results') + ' ' + get(h, 'received-spf')).toLowerCase();
    for (const k of ['spf', 'dkim', 'dmarc'])
        if (new RegExp(`${k}=(fail|softfail|none|temperror|permerror)`).test(auth))
            flags.push(['Auth', `${k.toUpperCase()} did not pass`]);
    m.attachments.filter(a => /\.(exe|scr|js|vbs|bat|cmd|jar|lnk|iso|docm|xlsm)$/i.test(a.name))
        .forEach(a => flags.push(['Risky attachment', a.name]));
    if (m.html && /href\s*=\s*["']?https?:\/\/\d+\.\d+\.\d+\.\d+/i.test(m.html))
        flags.push(['Link', 'HTML contains a link to a raw IP address']);
    render('Suspicious Activity', flags.length ? flags : [['', 'No obvious red flags found by these basic checks']]);

    // Everything else, X- headers
    render('Other Metadata Discovered', h.filter(([n]) => /^x-/i.test(n)).map(([n, v]) => [n, v]));
}


document.getElementById('fileUpload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        populate(await loadEmail(file));
    } catch (err) {
        console.error(err);
        render('Email Content', [['Error', `Could not parse this file: ${err.message}`]]);
    }
});

//What is the sending email address?
//What is the email address of the recipient?
//What is the subject line of the email?
//What date was the Email sent? Date format: MM/DD/YYYY
//What is the originating IP?
//What country is the ip address from?
//What is the name of the attachment when you unzip it? (with extension)
//What is the sha256 hash of the File?
//Is the email attachment malicious? Yes/No
//What is the return path of the email?
//What is the domain name of the url in this mail?
//What is the sender IP address listed in the Received-SPF header?

//What is the return path of the email ?
//What is the domain name of the url in this mail ?
//What is the sender IP address listed in the Received - SPF header ?

//Is this email a phishing email ?

/*
Email Content

Subject, body, HTML and plain text

Sender Data

From, Return - Path, Reply - To

Recipient Data

To, CC, BCC

Date and Time

Sent, received, time zones

Technical Metadata

Message - ID, MIME, User - Agent

Network Intelligence

IP addresses, hostnames, geolocation

Routing Information

Received headers, mail servers

Authentication

SPF, DKIM, DMARC, ARC

Attachment Metadata

Names, sizes, hashes, EXIF

Email Structure

MIME parts, embedded images, HTML

Client and Device

Mail software, version, OS

Conversation Data

Thread IDs, references, replies

Geographic Analysis

IP locations and time zones

Security Analysis

Spoofing, suspicious links, anomalies

Other Metadata

Any additional discovered headers

*/
