'use strict';

const {
    Plugin,
    PluginSettingTab,
    ItemView,
    Modal,
    Menu,
    Setting,
    Notice,
    normalizePath,
    TFile,
    requestUrl,
    setIcon,
    FuzzySuggestModal,
} = require('obsidian');

const VIEW_TYPE = 'library-view';

const TYPE_LABEL = { book: '图书', paper: '论文', other: '其他' };
const TYPE_ORDER = ['book', 'paper', 'other'];
const STATUSES = ['未读', '已读', '读完'];

const EXT_FORMAT = {
    pdf: 'pdf',
    epub: 'epub',
    mobi: 'mobi',
    azw3: 'azw3',
    azw: 'azw',
    fb2: 'fb2',
    djvu: 'djvu',
    txt: 'txt',
    cbz: 'cbz',
    cbr: 'cbr',
};

const FORMATS = ['pdf', 'epub', 'mobi', 'azw3', 'azw', 'fb2', 'djvu', 'txt', 'cbz', 'cbr', '其他'];

const SORT_OPTIONS = [
    { id: 'title', label: '标题' },
    { id: 'author', label: '作者' },
    { id: 'year', label: '年份' },
    { id: 'rating', label: '评分' },
    { id: 'created', label: '最近添加' },
];

const PAPER_TEMPLATE = `# 标题

## 摘要

## 关键词

## 引言

## 相关工作

## 方法

## 结果

## 讨论

## 结论

## 参考文献

`;

const LITERATURE_TEMPLATE = `# 文献阅读总结

## 基本信息
- 标题：
- 作者：
- 年份：
- 期刊 / 来源：
- DOI：

## 研究背景与问题

## 研究方法

## 主要结论

## 创新点

## 不足与局限

## 对我的启发

## 关键摘录

`;

const PALETTE = [
    ['#5b8def', '#82a8f0'], ['#3fa98f', '#66c2b0'], ['#d98e5a', '#e5ab82'],
    ['#8b7fd6', '#a89ee0'], ['#d8738f', '#e495ab'], ['#5aa7a0', '#7fc0bb'],
    ['#6b8fd4', '#92addf'], ['#c7985c', '#dbb27f'],
];

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatFromName(name) {
    const e = String(name).split('.').pop().toLowerCase();
    return EXT_FORMAT[e] || '其他';
}

function cleanTitle(name) {
    let t = String(name || '').trim();
    // 去掉扩展名
    t = t.replace(/\.[^.]+$/, '');
    // 去掉时间戳后缀 20261113_171547
    t = t.replace(/[_-]?\d{8}[_-]\d{6}$/, '');
    // 去掉 z-library / 1lib 等站点噪声括号
    t = t.replace(/\s*\((?:z-?library\.sk|1lib\.sk|z-?lib\.sk|z-lib\.org)[^)]*\)\s*$/i, '');
    t = t.replace(/\s*\((?:z-?library\.sk|1lib\.sk|z-?lib\.sk|z-lib\.org)[^)]*\)/ig, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    return t || '未命名';
}

// 提取用于搜索的主书名：去掉末尾括号噪声（作者/版本/站点）
function cleanSearchTitle(title) {
    let t = String(title || '').trim();
    t = t.replace(/\s*\([^()]*\)\s*$/, '');
    t = t.replace(/\s*\([^()]*\)\s*$/, '');
    t = t.replace(/[_-]?手机中文版$/, '').trim();
    return t || String(title || '').trim();
}

function colorFor(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (tag === 'button') n.type = 'button';
    return n;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 搜索关键词高亮
function highlight(text, query) {
    const t = escapeHtml(text);
    if (!query) return t;
    const q = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return t.replace(new RegExp('(' + q + ')', 'gi'), '<mark class="lib-hl">$1</mark>');
}

// 表单字段（纯 DOM）：标签在上、控件在下
function formField(parent, label, kind, value) {
    const row = parent.createDiv({ cls: 'lib-field' });
    row.createDiv({ cls: 'lib-field-label', text: label });
    let control;
    if (kind === 'textarea') {
        control = el('textarea', 'lib-text-input');
        control.value = value != null ? value : '';
    } else if (kind === 'select') {
        control = el('select', 'lib-text-input');
    } else if (kind === 'button') {
        control = el('button', 'lib-btn', value);
    } else {
        control = el('input', 'lib-text-input');
        control.type = 'text';
        control.value = value != null ? value : '';
    }
    row.appendChild(control);
    return control;
}

function openExternal(p) {
    try {
        const { shell } = require('electron');
        if (shell && shell.openPath) return shell.openPath(p);
    } catch (e) { /* ignore */ }
    return new Promise((resolve, reject) => {
        const cp = require('child_process');
        const cmd = process.platform === 'win32'
            ? `start "" "${p}"`
            : process.platform === 'darwin' ? `open "${p}"` : `xdg-open "${p}"`;
        cp.exec(cmd, (err) => (err ? reject(err) : resolve()));
    });
}

function extractDoi(text) {
    if (!text) return null;
    const m = String(text).match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/);
    return m ? m[0].replace(/[);,.]+$/, '') : null;
}

function extractYear(text) {
    if (!text) return '';
    const m = String(text).match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
}

function sanitizeFilename(name) {
    return String(name || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '未命名';
}

function crossrefType(t) {
    if (!t) return null;
    t = String(t).toLowerCase();
    if (['journal-article', 'proceedings-article', 'posted-content', 'dissertation', 'preprint'].includes(t)) return 'paper';
    if (['book', 'monograph', 'edited-book', 'reference-book', 'book-chapter', 'book-section', 'book-set'].includes(t)) return 'book';
    return 'other';
}

// 从 PDF 二进制做一次尽力而为的元数据提取（标题/作者/DOI）
function parsePdfMeta(buf) {
    const bytes = new Uint8Array(buf);
    const len = Math.min(bytes.length, 3 * 1024 * 1024);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
    return {
        doi: extractDoi(s),
        title: pdfMetaValue(s, 'Title'),
        author: pdfMetaValue(s, 'Author'),
    };
}

function pdfMetaValue(pdf, key) {
    const re = new RegExp('/' + key + '\\s*([(<])', 'i');
    const m = re.exec(pdf);
    if (!m) return '';
    const start = m.index + m[0].length;
    if (m[1] === '<') {
        const end = pdf.indexOf('>', start);
        if (end < 0) return '';
        return decodePdfString(pdf.slice(start, end));
    }
    let i = start, depth = 0, raw = '';
    while (i < pdf.length) {
        const c = pdf[i];
        if (c === '\\') { raw += pdf[i + 1] || ''; i += 2; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) break; }
        raw += c;
        i++;
    }
    return decodePdfString(raw);
}

function decodePdfString(raw) {
    if (raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
        let out = '';
        for (let i = 2; i + 1 < raw.length; i += 2) {
            out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
        }
        return out.trim();
    }
    return raw.trim();
}

// 通过 Crossref 按 DOI 抓取元数据
async function fetchCrossrefMeta(doi) {
    const url = 'https://api.crossref.org/works/' + encodeURIComponent(doi);
    try {
        const res = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': 'obsidian-library/1.0 (mailto:library@example.com)' } });
        const msg = res.json && res.json.message;
        if (!msg) return null;
        const authors = (msg.author || []).map((a) => {
            const n = a.family && a.given ? `${a.given} ${a.family}` : (a.name || '');
            return n.trim();
        }).filter(Boolean);
        let year = '';
        const issued = msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0];
        if (issued && issued[0]) year = String(issued[0]);
        const venue = (msg['container-title'] && msg['container-title'][0]) || '';
        const abstract = String(msg.abstract || '').replace(/<[^>]+>/g, '');
        return {
            title: (msg.title && msg.title[0]) || '',
            authors,
            year,
            venue,
            doi: msg.DOI || doi,
            abstract,
            type: msg.type || '',
        };
    } catch (e) {
        return null;
    }
}

// 带超时的请求（requestUrl 无超时参数，用 Promise.race 兜底，避免被墙时卡死）
function requestUrlTimeout(param, ms) {
    return Promise.race([
        requestUrl(param),
        new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms || 8000)),
    ]);
}

// 从豆瓣图书详情页抓取评分 + 简介（国内可直连，不用翻墙）
async function fetchDoubanDetail(url) {
    if (!url) return { score: null, summary: '' };
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://book.douban.com' + url;
    try {
        const res = await requestUrlTimeout({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000);
        const html = String(res.text || '');
        let score = null;
        const ratingM = /class="ll rating_num"[^>]*>\s*([\d.]+)/.exec(html);
        if (ratingM) score = parseFloat(ratingM[1]);
        let summary = '';
        const introM = /<div class="intro">([\s\S]*?)<\/div>/.exec(html);
        if (introM) {
            summary = introM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return { score: isNaN(score) ? null : score, summary };
    } catch (e) {
        return { score: null, summary: '' };
    }
}

// ---------- BibTeX ----------
function bibtexToItem(entry) {
    const typeMap = {
        article: 'paper', inproceedings: 'paper', conference: 'paper', incollection: 'paper',
        phdthesis: 'paper', mastersthesis: 'paper', techreport: 'paper', preprint: 'paper', unpublished: 'paper',
        book: 'book', booksection: 'book', inbook: 'book',
    };
    const et = (entry.type || 'misc').toLowerCase();
    const type = typeMap[et] || 'other';
    const authors = (entry.fields.author || '').split(/\s+and\s+/i).map(formatBibtexName).filter(Boolean);
    const keywords = (entry.fields.keywords || '').split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
    const venue = entry.fields.journal || entry.fields.booktitle || entry.fields.publisher || '';
    return {
        id: uid(),
        title: entry.fields.title || entry.key || '未命名',
        type,
        authors,
        year: extractYear(entry.fields.year || entry.fields.date || ''),
        category: venue || '未分类',
        tags: keywords,
        format: type === 'paper' ? 'pdf' : '其他',
        file: '',
        cover: '',
        status: '未读',
        rating: 0,
        notes: entry.fields.abstract || '',
        doi: entry.fields.doi || '',
        notePath: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

function formatBibtexName(name) {
    const n = String(name || '').trim();
    if (!n) return '';
    if (n.includes(',')) {
        const parts = n.split(',').map((s) => s.trim());
        const last = parts[0] || '';
        const first = (parts[1] || '').replace(/[{}~]/g, '');
        return (first + ' ' + last).trim();
    }
    return n.replace(/[{}~]/g, '');
}

function parseBibtex(text) {
    const entries = [];
    const src = String(text || '');
    let i = 0;
    while (i < src.length) {
        const at = src.indexOf('@', i);
        if (at < 0) break;
        const typeMatch = /^@\s*([a-zA-Z]+)/.exec(src.slice(at));
        if (!typeMatch) { i = at + 1; continue; }
        const type = typeMatch[1];
        let j = at + typeMatch[0].length;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '{' || src[j] === '(') {
            const open = src[j];
            const close = open === '{' ? '}' : ')';
            let k = j + 1;
            let depth = 1;
            let inBrace = 0;
            let inQuote = false;
            while (k < src.length && depth > 0) {
                const c = src[k];
                if (c === '"' && src[k - 1] !== '\\') inQuote = !inQuote;
                if (!inQuote) {
                    if (c === '{') inBrace++;
                    else if (c === '}') { if (inBrace > 0) inBrace--; else depth--; }
                    else if (c === '(' && open === '(') depth++;
                    else if (c === ')' && open === '(') depth--;
                }
                k++;
            }
            if (depth === 0) {
                entries.push(parseBibtexEntry(type, src.slice(j + 1, k - 1)));
                i = k;
                continue;
            }
        }
        i = at + 1;
    }
    return entries;
}

function parseBibtexEntry(type, body) {
    const entry = { type, key: '', fields: {} };
    const comma = findTopComma(body);
    if (comma < 0) { entry.key = body.trim(); return entry; }
    entry.key = body.slice(0, comma).trim();
    const rest = body.slice(comma + 1);
    let i = 0;
    while (i < rest.length) {
        while (i < rest.length && /[\s,]/.test(rest[i])) i++;
        if (i >= rest.length) break;
        const nameMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*=/.exec(rest.slice(i));
        if (!nameMatch) { i++; continue; }
        const name = nameMatch[1].toLowerCase();
        i += nameMatch[0].length;
        while (i < rest.length && /\s/.test(rest[i])) i++;
        if (i >= rest.length) break;
        let value = '';
        if (rest[i] === '{' || rest[i] === '"') {
            const open = rest[i];
            i++;
            let depth = 0;
            while (i < rest.length) {
                const c = rest[i];
                if (open === '{') {
                    if (c === '{') depth++;
                    else if (c === '}') { if (depth === 0) break; depth--; }
                } else if (c === '"') {
                    break;
                }
                value += c;
                i++;
            }
            i++;
        } else {
            const start = i;
            while (i < rest.length && !/[\s,]/.test(rest[i])) i++;
            value = rest.slice(start, i);
        }
        entry.fields[name] = value.trim();
    }
    return entry;
}

function findTopComma(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === ',' && depth === 0) return i;
    }
    return -1;
}

// 生成引用文本（BibTeX / GB/T 7714 / APA）
function citationText(item, format) {
    const authors = (item.authors || []).filter(Boolean);
    const title = item.title || '未命名';
    const year = item.year || '';
    const venue = item.category && item.category !== '未分类' ? item.category : '';
    const doi = item.doi || '';

    if (format === 'bibtex') {
        const et = item.type === 'paper' ? 'article' : (item.type === 'book' ? 'book' : 'misc');
        const key = (((authors[0] || 'anon').replace(/[^a-zA-Z0-9]/g, '') || 'anon') + (year || '') + title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)).toLowerCase();
        const parts = [`title = {${title}}`];
        if (authors.length) parts.push(`author = {${authors.join(' and ')}}`);
        if (venue) parts.push(et === 'article' ? `journal = {${venue}}` : `publisher = {${venue}}`);
        if (year) parts.push(`year = {${year}}`);
        if (doi) parts.push(`doi = {${doi}}`);
        return `@${et}{${key},\n  ${parts.join(',\n  ')}\n}`;
    }
    if (format === 'gbt') {
        const au = authors.length
            ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', 等' : '')
            : '';
        const mark = item.type === 'paper' ? '[J]' : (item.type === 'book' ? '[M]' : '[Z]');
        const segs = [];
        if (au) segs.push(au + '.');
        segs.push(title + mark + '.');
        if (venue) segs.push(venue + '.');
        if (year) segs.push(year + '.');
        if (doi) segs.push('DOI:' + doi + '.');
        return segs.join(' ');
    }
    if (format === 'apa') {
        const formatted = authors.map((a) => {
            const ps = a.split(/\s+/).filter(Boolean);
            if (ps.length >= 2) {
                const last = ps.pop();
                return last + ', ' + ps.map((p) => p.charAt(0) + '.').join(' ');
            }
            return a;
        });
        let au = '';
        if (formatted.length === 1) au = formatted[0];
        else if (formatted.length === 2) au = formatted[0] + ' & ' + formatted[1];
        else if (formatted.length > 2) au = formatted.slice(0, -1).join(', ') + ', & ' + formatted[formatted.length - 1];
        const segs = [];
        if (au) segs.push(au);
        if (year) segs.push('(' + year + ').');
        else segs.push('(n.d.).');
        segs.push(title + '.');
        if (venue) segs.push(venue + '.');
        if (doi) segs.push('https://doi.org/' + doi);
        return segs.join(' ');
    }
    return '';
}

// 解析 RIS 参考文献
function parseRis(text) {
    const entries = [];
    let cur = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = /^([A-Z0-9]{2})\s+-\s?(.*)$/.exec(line);
        if (!m) continue;
        const tag = m[1].toUpperCase();
        const val = m[2].trim();
        if (tag === 'TY') { cur = { type: val.toUpperCase(), fields: {} }; entries.push(cur); }
        else if (tag === 'ER') { cur = null; }
        else if (cur) {
            if (tag === 'AU') (cur.fields.authors = cur.fields.authors || []).push(val);
            else if (tag === 'KW') (cur.fields.keywords = cur.fields.keywords || []).push(val);
            else if (tag === 'TI') cur.fields.title = val;
            else if (tag === 'JO' || tag === 'JF' || tag === 'T2') cur.fields.journal = val;
            else if (tag === 'PY' || tag === 'DA') cur.fields.year = cur.fields.year || extractYear(val);
            else if (tag === 'DO') cur.fields.doi = val;
            else if (tag === 'AB') cur.fields.abstract = val;
        }
    }
    return entries.filter((e) => e.fields && e.fields.title);
}

function risToItem(entry) {
    const map = { JOUR: 'paper', CONF: 'paper', CHAP: 'paper', THES: 'paper', RPRT: 'paper', ELEC: 'paper', BOOK: 'book' };
    const type = map[entry.type] || 'other';
    return {
        id: uid(),
        title: entry.fields.title,
        type,
        authors: entry.fields.authors || [],
        year: entry.fields.year || '',
        category: entry.fields.journal || '未分类',
        tags: entry.fields.keywords || [],
        format: type === 'paper' ? 'pdf' : '其他',
        file: '', cover: '', status: '未读', rating: 0,
        notes: entry.fields.abstract || '',
        doi: entry.fields.doi || '', notePath: '', progress: 0, summary: '', score: null,
        createdAt: Date.now(), updatedAt: Date.now(),
    };
}

// 简易下拉菜单
function popupMenu(anchor, items) {
    const menu = new Menu();
    for (const it of items) {
        menu.addItem((entry) => {
            entry.setTitle(it.label).onClick(it.onClick);
            if (it.icon) entry.setIcon(it.icon);
        });
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 }, anchor.ownerDocument);
    return menu;
}

// 在鼠标位置弹出的上下文菜单
function contextMenu(evt, items) {
    const menu = new Menu();
    for (const it of items) {
        menu.addItem((entry) => entry.setTitle(it.label).onClick(it.onClick));
    }
    menu.showAtPosition({ x: evt.clientX, y: evt.clientY }, evt.target?.ownerDocument);
    return menu;
}

function toArrayBuffer(buf) {
    const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// 从 PDF 二进制中提取所有 JPEG（DCTDecode 原样存储），保持文档顺序
function extractJpegs(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const out = [];
    let i = 0;
    while (i < b.length - 1) {
        if (b[i] === 0xff && b[i + 1] === 0xd8) {
            let j = i + 2;
            let end = -1;
            while (j < b.length - 1) {
                if (b[j] === 0xff && b[j + 1] === 0xd9) { end = j + 2; break; }
                j++;
            }
            if (end > 0 && end - i > 1000) {
                out.push(b.slice(i, end));
                i = end;
                continue;
            }
        }
        i++;
    }
    return out;
}

// 解析 JPEG 宽高
function jpegSize(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let i = 2;
    while (i + 4 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        if (len < 2) break;
        i += 2 + len;
    }
    return null;
}

// 挑封面：优先文档顺序里第一张竖版、接近书封比例的图；找不到就返回 null（留占位）
function pickPdfCover(buf) {
    const jpgs = extractJpegs(buf);
    if (!jpgs.length) return null;
    for (const j of jpgs) {
        const s = jpegSize(j);
        if (!s || s.width < 120 || s.height < 160) continue;
        const r = s.height / s.width;
        if (r >= 1.2 && r <= 2.5) return j;
    }
    for (const j of jpgs) {
        const s = jpegSize(j);
        if (!s || s.width < 120 || s.height < 160) continue;
        const r = s.height / s.width;
        if (r > 1 && r <= 3.0) return j;
    }
    return null;
}

// ---------- 极简 ZIP 读取（用于 EPUB） ----------
function listZipEntries(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const entries = [];
    if (b.length < 22) return entries;
    let eocd = -1;
    for (let i = b.length - 22; i >= 0; i--) {
        if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return entries;
    const total = b.readUInt16LE(eocd + 10);
    const cdOffset = b.readUInt32LE(eocd + 16);
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
        if (b.readUInt32LE(p) !== 0x02014b50) break;
        const method = b.readUInt16LE(p + 10);
        const compSize = b.readUInt32LE(p + 20);
        const uncompSize = b.readUInt32LE(p + 24);
        const nameLen = b.readUInt16LE(p + 28);
        const extraLen = b.readUInt16LE(p + 30);
        const commentLen = b.readUInt16LE(p + 32);
        const localOffset = b.readUInt32LE(p + 42);
        const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.push({ name, method, compSize, uncompSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function readZipEntry(buf, entry) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const p = entry.localOffset;
    if (b.readUInt32LE(p) !== 0x04034b50) return null;
    const nameLen = b.readUInt16LE(p + 26);
    const extraLen = b.readUInt16LE(p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = b.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) {
        try { return require('zlib').inflateRawSync(comp); } catch (e) { return null; }
    }
    return null;
}

function extForCover(name) {
    const m = /\.(jpe?g|png|gif|webp)$/i.exec(name || '');
    if (!m) return 'jpg';
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
}

function epubCoverFromBuffer(buf) {
    const entries = listZipEntries(buf);
    if (!entries.length) return null;
    const byName = {};
    for (const e of entries) byName[e.name] = e;

    let opfPath = null;
    if (byName['META-INF/container.xml']) {
        const xml = readZipEntry(buf, byName['META-INF/container.xml']);
        if (xml) {
            const m = /full-path="([^"]+)"/.exec(xml.toString('utf8'));
            if (m) opfPath = m[1];
        }
    }
    if (!opfPath) {
        const opfEntry = entries.find((e) => /\.opf$/i.test(e.name));
        if (opfEntry) opfPath = opfEntry.name;
    }

    if (opfPath && byName[opfPath]) {
        const opf = readZipEntry(buf, byName[opfPath]);
        if (opf) {
            const opfStr = opf.toString('utf8');
            const meta = /<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i.exec(opfStr)
                || /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']cover["']/i.exec(opfStr);
            if (meta) {
                const id = meta[1];
                const itemRe = new RegExp('<item[^>]*id=["\']' + id + '["\'][^>]*>', 'i');
                const itemM = itemRe.exec(opfStr);
                if (itemM) {
                    const hrefM = /href=["']([^"']+)["']/i.exec(itemM[0]);
                    if (hrefM) {
                        const baseDir = opfPath.replace(/[^/]+$/, '');
                        const full = decodeURIComponent((baseDir + hrefM[1]).replace(/^\.\//, ''));
                        const imgEntry = byName[full] || entries.find((e) => e.name.endsWith(hrefM[1]));
                        if (imgEntry) {
                            const data = readZipEntry(buf, imgEntry);
                            if (data) return { data, ext: extForCover(imgEntry.name) };
                        }
                    }
                }
            }
        }
    }

    const imgRe = /\.(jpe?g|png|gif|webp)$/i;
    const cover = entries.find((e) => /(^|\/)(cover|frontcover|front|coverimage)[^/]*\.(jpe?g|png|gif|webp)$/i.test(e.name))
        || entries.find((e) => /cover/i.test(e.name) && imgRe.test(e.name));
    if (cover) {
        const data = readZipEntry(buf, cover);
        if (data) return { data, ext: extForCover(cover.name) };
    }
    return null;
}

// 豆瓣书籍建议接口（书名搜索）
async function doubanSuggest(q) {
    const url = 'https://book.douban.com/j/subject_suggest?q=' + encodeURIComponent(q);
    try {
        const res = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
        const data = res.json;
        if (!Array.isArray(data)) return [];
        return data.filter((d) => d && d.title).map((d) => ({
            title: d.title,
            authors: Array.isArray(d.author) ? d.author : (d.author ? [d.author] : []),
            year: d.year || '',
            publisher: d.publisher || '',
            cover: d.pic || d.cover || '',
            url: d.url || '',
        }));
    } catch (e) {
        return [];
    }
}

// 从 PDF 页签读取当前页码（多种访问方式，尽力而为）
function readLeafPdfPage(leaf) {
    try {
        const vs = leaf.getViewState();
        if (vs && vs.state && typeof vs.state.page === 'number' && vs.state.page > 0) return vs.state.page;
    } catch (e) { /* ignore */ }
    try {
        if (typeof leaf.getEphemeralState === 'function') {
            const es = leaf.getEphemeralState();
            if (es && typeof es.page === 'number' && es.page > 0) return es.page;
        }
    } catch (e) { /* ignore */ }
    try {
        const view = leaf.view;
        if (view) {
            for (const k of ['pdfViewer', '_pdfViewer', 'viewer', 'pdfView', 'renderer']) {
                const v = view[k];
                if (v && typeof v.currentPageNumber === 'number' && v.currentPageNumber > 0) return v.currentPageNumber;
            }
            if (typeof view.getState === 'function') {
                const st = view.getState();
                if (st && typeof st.page === 'number' && st.page > 0) return st.page;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 从 PDF 页签读取总页数（多种访问方式）
function readLeafPdfTotal(leaf) {
    try {
        const view = leaf.view;
        if (view) {
            for (const k of ['pdfViewer', '_pdfViewer', 'viewer', 'pdfView', 'renderer']) {
                const v = view[k];
                if (v) {
                    if (typeof v.pagesCount === 'number' && v.pagesCount > 0) return v.pagesCount;
                    if (v.pdfDocument && typeof v.pdfDocument.numPages === 'number') return v.pdfDocument.numPages;
                }
            }
            if (view.pdfDocument && typeof view.pdfDocument.numPages === 'number') return view.pdfDocument.numPages;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 从 PDF 页签读取滚动进度百分比（DOM 滚动容器，最可靠）
function readPdfScrollProgress(leaf) {
    try {
        const view = leaf.view;
        const root = view && (view.contentEl || view.containerEl);
        if (!root) return null;
        let scroller = null;
        if (root.scrollHeight > root.clientHeight + 5) scroller = root;
        if (!scroller) {
            let bestDiff = 0;
            root.querySelectorAll('*').forEach((n) => {
                const d = n.scrollHeight - n.clientHeight;
                if (d > bestDiff) { bestDiff = d; scroller = n; }
            });
            if (!scroller || bestDiff <= 5) {
                let n = root.parentElement;
                while (n) { if (n.scrollHeight > n.clientHeight + 5) { scroller = n; break; } n = n.parentElement; }
            }
        }
        if (!scroller) return null;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 0) return null;
        return Math.min(100, Math.max(0, Math.round(scroller.scrollTop / max * 100)));
    } catch (e) { return null; }
}

// progress 字段现为百分比 0–100
function percentOf(item) {
    return Math.min(100, Math.max(0, Math.round(item.progress || 0)));
}

function statusOf(item) {
    const p = percentOf(item);
    if (p >= 100) return '读完';
    if (p >= 15) return '已读';
    return '未读';
}

// =====================================================================
// 主插件
// =====================================================================
module.exports = class LibraryPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        await this.loadIndex();

        this.registerView(VIEW_TYPE, (leaf) => new LibraryView(leaf, this));

        this.addRibbonIcon('library', '打开资料库', () => this.activateView());

        this.addCommand({
            id: 'open-library',
            name: '打开资料库',
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: 'insert-citation',
            name: '插入引用',
            editorCallback: () => new CitationModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'generate-references',
            name: '生成参考文献',
            editorCallback: (editor) => this.generateReferences(editor),
        });

        this.addCommand({
            id: 'insert-paper-template',
            name: '插入论文写作模板',
            editorCallback: (editor) => editor.replaceSelection(PAPER_TEMPLATE),
        });

        this.addCommand({
            id: 'insert-literature-template',
            name: '插入文献阅读总结模板',
            editorCallback: (editor) => editor.replaceSelection(LITERATURE_TEMPLATE),
        });

        this.addCommand({
            id: 'ai-polish',
            name: 'AI 润色选中文字',
            editorCallback: (editor) => this.aiEditSelection(editor, '请润色下面的文字，使其更通顺、更学术、更简洁'),
        });

        this.addCommand({
            id: 'ai-expand',
            name: 'AI 扩写选中文字',
            editorCallback: (editor) => this.aiEditSelection(editor, '请扩写下面的文字，补充细节和论证，保持原意'),
        });

        this.addCommand({
            id: 'ai-rewrite',
            name: 'AI 改写选中文字',
            editorCallback: (editor) => this.aiEditSelection(editor, '请改写下面的文字，换一种表达方式，保持原意'),
        });

        this.addCommand({
            id: 'ai-translate',
            name: 'AI 翻译选中文字（中英互译）',
            editorCallback: (editor) => this.aiEditSelection(editor, '请翻译下面的文字：中文翻成英文，英文翻成中文'),
        });

        this.addSettingTab(new LibrarySettingTab(this.app, this));

        // 阅读进度：切页签时记一次，读取中每 8 秒记一次
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            this.captureProgress();
            if (leaf && leaf.view && leaf.view.getViewType && leaf.view.getViewType() === VIEW_TYPE) {
                leaf.view.refresh();
            }
        }));
        this.registerInterval(window.setInterval(() => this.captureProgress(), 8000));
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            try {
                leaf = workspace.getRightLeaf(false);
            } catch (e) {
                leaf = workspace.getLeaf('tab');
            }
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async loadSettings() {
        this.settings = Object.assign({
            libraryFolder: '资源库',
            aiApiKey: '',
            aiBaseUrl: 'https://api.deepseek.com/v1',
            aiModel: 'deepseek-chat',
        }, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    indexPath() {
        return normalizePath(this.settings.libraryFolder + '/.library.json');
    }

    attachFolder() {
        return normalizePath(this.settings.libraryFolder + '/附件');
    }

    coverFolder() {
        return normalizePath(this.settings.libraryFolder + '/封面');
    }

    async loadIndex() {
        try {
            const raw = await this.app.vault.adapter.read(this.indexPath());
            const data = JSON.parse(raw);
            this.index = data && Array.isArray(data.items) ? data : { items: [] };
        } catch (e) {
            this.index = { items: [] };
        }
        // 自愈迁移：旧版本可能把 md/docx 收进来，加载时自动剔除
        const before = this.index.items.length;
        this.index.items = this.index.items.filter((i) => i.format !== 'md' && i.format !== 'docx');
        if (this.index.items.length !== before) {
            await this.saveIndex();
        }
        return this.index;
    }

    async saveIndex() {
        await this.ensureFolder(this.settings.libraryFolder);
        await this.app.vault.adapter.write(this.indexPath(), JSON.stringify(this.index, null, 2));
    }

    async ensureFolder(p) {
        const parts = normalizePath(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur = cur ? cur + '/' + part : part;
            if (!this.app.vault.getAbstractFileByPath(cur)) {
                try { await this.app.vault.createFolder(cur); } catch (e) { /* exists */ }
            }
        }
    }

    refreshViews() {
        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => {
            if (l.view && typeof l.view.refresh === 'function') l.view.refresh();
        });
    }

    // 把本地文件写入库内附件目录，生成条目（返回新建的条目数组）
    async importFiles(files, opts) {
        const o = Object.assign({ type: 'book', category: '未分类', status: '未读' }, opts);
        await this.ensureFolder(this.attachFolder());
        const base = this.attachFolder();
        const created = [];
        for (const file of files) {
            const name = file.name || '未命名';
            const format = formatFromName(name);
            let rel = normalizePath(base + '/' + name);
            if (this.app.vault.getAbstractFileByPath(rel)) {
                const dot = name.lastIndexOf('.');
                const stem = dot >= 0 ? name.slice(0, dot) : name;
                const ext = dot >= 0 ? name.slice(dot) : '';
                rel = normalizePath(base + '/' + stem + '-' + uid() + ext);
            }
            const buf = await file.arrayBuffer();
            await this.app.vault.adapter.writeBinary(rel, buf);

            const id = uid();
            let coverRel = '';
            try {
                if (format === 'pdf') {
                    const cover = pickPdfCover(buf);
                    if (cover) {
                        await this.ensureFolder(this.coverFolder());
                        coverRel = normalizePath(this.coverFolder() + '/' + id + '.jpg');
                        await this.app.vault.adapter.writeBinary(coverRel, toArrayBuffer(cover));
                    }
                } else if (format === 'epub') {
                    const cover = epubCoverFromBuffer(buf);
                    if (cover) {
                        await this.ensureFolder(this.coverFolder());
                        coverRel = normalizePath(this.coverFolder() + '/' + id + '.' + cover.ext);
                        await this.app.vault.adapter.writeBinary(coverRel, toArrayBuffer(cover.data));
                    }
                }
            } catch (e) { /* 封面提取失败不影响导入 */ }

            const item = {
                id,
                title: cleanTitle(name),
                type: o.type,
                authors: [],
                year: extractYear(name),
                category: o.category,
                tags: [],
                format,
                file: rel,
                cover: coverRel,
                status: o.status,
                rating: 0,
                notes: '',
                doi: '',
                notePath: '',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.index.items.push(item);
            created.push(item);
        }
        await this.saveIndex();
        return created;
    }

    // 扫描库内已有的 pdf/epub/... 文件（图书/论文文件夹等），按引用收录
    async scanVault() {
        const files = this.app.vault.getFiles();
        const indexed = new Set(this.index.items.map((i) => i.file));
        let count = 0;
        for (const f of files) {
            const ext = (f.extension || '').toLowerCase();
            if (!EXT_FORMAT[ext]) continue;
            if (indexed.has(f.path)) continue;
            if (f.path.startsWith(this.attachFolder() + '/')) continue; // 已导入附件，避免重复

            const isPaper = /(^|\/)论文(\/|$)/.test(f.path);
            const type = isPaper ? 'paper' : 'book';
            this.index.items.push({
                id: uid(),
                title: cleanTitle(f.basename),
                type,
                authors: [],
                year: extractYear(f.basename),
                category: '未分类',
                tags: [],
                format: EXT_FORMAT[ext],
                file: f.path,
                cover: '',
                status: '未读',
                rating: 0,
                notes: '',
                doi: '',
                notePath: '',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
            count++;
        }
        await this.saveIndex();
        return count;
    }

    saveItem(item) {
        const i = this.index.items.findIndex((x) => x.id === item.id);
        if (i >= 0) {
            item.updatedAt = Date.now();
            this.index.items[i] = item;
        }
        return this.saveIndex();
    }

    removeItem(id, deleteFile) {
        const idx = this.index.items.findIndex((x) => x.id === id);
        if (idx < 0) return Promise.resolve();
        const item = this.index.items[idx];
        this.index.items.splice(idx, 1);
        const save = this.saveIndex();
        if (deleteFile && item.file) {
            const f = this.app.vault.getAbstractFileByPath(item.file);
            if (f instanceof TFile) {
                return save.then(() => this.app.vault.delete(f).catch(() => {}));
            }
        }
        return save;
    }

    async openItem(item) {
        const f = this.app.vault.getAbstractFileByPath(item.file);
        if (!(f instanceof TFile)) {
            new Notice('文件不存在：' + item.file);
            return;
        }
        if (item.format === 'pdf') {
            // 复用已打开的页签（保持滚动位置），否则跳到上次读到的页码
            const existing = this.app.workspace.getLeavesOfType('pdf').find((l) => {
                const vs = l.getViewState();
                return vs && vs.state && vs.state.file === item.file;
            });
            if (existing) {
                await this.app.workspace.revealLeaf(existing);
            } else {
                const page = item.page > 0
                    ? item.page
                    : (item.totalPages && item.progress > 0 ? Math.round(item.progress / 100 * item.totalPages) : null);
                const state = { file: f.path };
                if (page) state.page = page;
                await this.app.workspace.getLeaf('tab').setViewState({ type: 'pdf', state, active: true });
            }
        } else if (item.format === 'md' || item.format === 'txt' || item.format === 'epub') {
            await this.app.workspace.getLeaf('tab').openFile(f);
        } else {
            const abs = this.app.vault.adapter.getFullPath(f.path);
            try { await openExternal(abs); } catch (e) { new Notice('无法打开：' + e.message); }
        }
        item.lastReadAt = Date.now();
        this.saveItem(item).catch(() => {});
    }

    resourceUrl(path) {
        const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
        return f instanceof TFile ? this.app.vault.getResourcePath(f) : null;
    }

    // 记录当前 PDF 页签的进度（滚动百分比，可靠）+ 页码（尽力而为，用于续读），并自动更新状态
    async captureProgress() {
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf || !this.index) return;
        const vs = leaf.getViewState();
        const file = vs && vs.state && vs.state.file;
        if (!file) return;
        const item = this.index.items.find((i) => i.file === file);
        if (!item) return;
        let changed = false;
        const page = readLeafPdfPage(leaf);
        if (page != null && Math.round(page) !== item.page) { item.page = Math.round(page); changed = true; }
        const total = readLeafPdfTotal(leaf);
        if (total && total !== item.totalPages) { item.totalPages = total; changed = true; }
        const pct = readPdfScrollProgress(leaf);
        if (pct != null && pct !== percentOf(item)) { item.progress = pct; changed = true; }
        if (changed) {
            item.status = statusOf(item);
            item.lastReadAt = Date.now();
            await this.saveIndex();
        }
    }

    async revealItem(item) {
        const f = this.app.vault.getAbstractFileByPath(item.file);
        const abs = f ? this.app.vault.adapter.getFullPath(f.path) : this.app.vault.adapter.getFullPath(item.file);
        try {
            const { shell } = require('electron');
            if (shell && shell.showItemInFolder) { shell.showItemInFolder(abs); return; }
        } catch (e) { /* ignore */ }
        const path = require('path');
        openExternal(path.dirname(abs));
    }

    // 单个条目元数据补全（优先 DOI→Crossref，其次 PDF 内嵌元数据）
    async enrichItem(item) {
        if (!item || item.format !== 'pdf') return false;
        if (item.authors && item.authors.length && item.year) return false;
        if (!item.file) return false;
        let buf;
        try { buf = await this.app.vault.adapter.readBinary(item.file); } catch (e) { return false; }
        const meta = parsePdfMeta(buf);
        let changed = false;
        if (meta.doi) {
            const cm = await fetchCrossrefMeta(meta.doi);
            if (cm) {
                if (cm.title) { item.title = cm.title; changed = true; }
                if (cm.authors.length) { item.authors = cm.authors; changed = true; }
                if (cm.year) { item.year = cm.year; changed = true; }
                if (cm.venue) { item.category = cm.venue; changed = true; }
                if (cm.abstract) { item.notes = cm.abstract; changed = true; }
                if (cm.type && crossrefType(cm.type)) { item.type = crossrefType(cm.type); changed = true; }
                item.doi = cm.doi; changed = true;
            }
        } else {
            if (meta.title && !item.title) { item.title = meta.title; changed = true; }
            if (meta.author && !(item.authors && item.authors.length)) { item.authors = [meta.author]; changed = true; }
        }
        if (changed) await this.saveItem(item);
        return changed;
    }

    async enrichItems(items) {
        let n = 0;
        for (const it of items) {
            if (await this.enrichItem(it)) n++;
        }
        return n;
    }

    // 按 DOI 补全元数据（不落盘，由弹窗保存）
    async applyDoiMeta(item) {
        if (!item.doi) { new Notice('请先填写 DOI'); return; }
        new Notice('正在抓取 DOI 元数据…');
        const cm = await fetchCrossrefMeta(item.doi);
        if (!cm) { new Notice('未找到该 DOI 的元数据'); return; }
        if (cm.title) item.title = cm.title;
        if (cm.authors.length) item.authors = cm.authors;
        if (cm.year) item.year = cm.year;
        if (cm.venue) item.category = cm.venue;
        if (cm.abstract) item.notes = cm.abstract;
        if (cm.type && crossrefType(cm.type)) item.type = crossrefType(cm.type);
        item.doi = cm.doi;
        new Notice('元数据已补全');
    }

    // 用 DeepSeek（OpenAI 兼容）生成简介/标签/分类（不落盘，由弹窗保存）
    async aiFill(item) {
        if (!this.settings.aiApiKey) { new Notice('请先在插件设置里填写 DeepSeek API Key'); return null; }
        const title = String(item.title || '').trim();
        if (!title) { new Notice('需要先填写标题'); return null; }
        const info = [
            '书名：' + title,
            (item.authors && item.authors.length) ? '作者：' + item.authors.join('、') : '',
            item.year ? '年份：' + item.year : '',
            item.notes ? '已有备注：' + item.notes.slice(0, 200) : '',
        ].filter(Boolean).join('\n');
        const prompt = '请根据以下书籍信息，补全这本书的资料。\n' + info + '\n\n' +
            '要求：\n' +
            '1. 简介：80 字以内，客观概括这本书的内容/主题。\n' +
            '2. 标签：3–5 个简短关键词。\n' +
            '3. 分类：一个，如 政治哲学 / 经济金融 / 小说 / 计算机 等。\n' +
            '4. 作者：作者姓名数组（不确定就返回空数组 []）。\n' +
            '5. 年份：出版年份（不确定就返回空字符串 ""）。\n' +
            '6. DOI：确定知道才填，否则返回空字符串 ""。\n' +
            '注意：作者、年份、DOI 只在有把握时填写，不要编造。\n' +
            '只输出 JSON：{"summary":"...","tags":["..."],"category":"...","authors":["..."],"year":"...","doi":"..."}';
        new Notice('正在用 DeepSeek 补全资料…');
        try {
            const base = (this.settings.aiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
            const res = await requestUrlTimeout({
                url: base + '/chat/completions',
                method: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': 'Bearer ' + this.settings.aiApiKey },
                body: JSON.stringify({
                    model: this.settings.aiModel || 'deepseek-chat',
                    messages: [
                        { role: 'system', content: '你是图书资料整理助手，只输出符合要求的 JSON，不要输出其它文字。' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.6,
                    response_format: { type: 'json_object' },
                }),
            }, 20000);
            if (res.status !== 200) {
                new Notice('AI 请求失败(' + res.status + ')：' + String(res.text || '').slice(0, 120));
                return null;
            }
            const data = res.json;
            const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!content) { new Notice('AI 返回内容为空'); return null; }
            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (e) {
                const m = /\{[\s\S]*\}/.exec(content);
                if (!m) { new Notice('AI 返回无法解析'); return null; }
                parsed = JSON.parse(m[0]);
            }
            if (parsed.summary) item.summary = parsed.summary;
            if (Array.isArray(parsed.tags) && parsed.tags.length) {
                item.tags = parsed.tags.map((t) => String(t).trim()).filter(Boolean);
            }
            if (parsed.category && (!item.category || item.category === '未分类')) {
                item.category = String(parsed.category).trim();
            }
            if (Array.isArray(parsed.authors) && parsed.authors.length && (!item.authors || !item.authors.length)) {
                item.authors = parsed.authors.map((a) => String(a).trim()).filter(Boolean);
            }
            if (parsed.year && !item.year) item.year = String(parsed.year).trim();
            if (parsed.doi && !item.doi) item.doi = String(parsed.doi).trim();
            new Notice('AI 已补全资料');
            return true;
        } catch (e) {
            new Notice('AI 请求失败：' + e.message);
            return null;
        }
    }

    // 从文件本身提取封面（PDF / EPUB）
    async extractFileCover(item) {
        if (!item.file) { new Notice('该条目没有文件'); return null; }
        if (item.format === 'pdf') return this.extractPdfCover(item);
        if (item.format === 'epub') return this.extractEpubCover(item);
        new Notice('该格式暂不支持提取封面（支持 PDF / EPUB）');
        return null;
    }

    async extractPdfCover(item) {
        let buf;
        try { buf = await this.app.vault.adapter.readBinary(item.file); } catch (e) { new Notice('读取文件失败'); return null; }
        const cover = pickPdfCover(buf);
        if (!cover) { new Notice('PDF 里没找到可用的封面图'); return null; }
        await this.ensureFolder(this.coverFolder());
        const rel = normalizePath(this.coverFolder() + '/' + item.id + '.jpg');
        await this.app.vault.adapter.writeBinary(rel, toArrayBuffer(cover));
        item.cover = rel;
        await this.saveItem(item);
        new Notice('已从 PDF 提取封面');
        return rel;
    }

    async extractEpubCover(item) {
        let buf;
        try { buf = await this.app.vault.adapter.readBinary(item.file); } catch (e) { new Notice('读取文件失败'); return null; }
        const res = epubCoverFromBuffer(buf);
        if (!res) { new Notice('EPUB 里没找到封面图'); return null; }
        await this.ensureFolder(this.coverFolder());
        const rel = normalizePath(this.coverFolder() + '/' + item.id + '.' + res.ext);
        await this.app.vault.adapter.writeBinary(rel, toArrayBuffer(res.data));
        item.cover = rel;
        await this.saveItem(item);
        new Notice('已从 EPUB 提取封面');
        return rel;
    }

    async downloadCover(url, item) {
        const imgRes = await requestUrlTimeout({ url, method: 'GET' }, 10000);
        await this.ensureFolder(this.coverFolder());
        const ext = /\.png/i.test(url) ? 'png' : 'jpg';
        const rel = normalizePath(this.coverFolder() + '/' + item.id + '.' + ext);
        await this.app.vault.adapter.writeBinary(rel, imgRes.arrayBuffer);
        item.cover = rel;
        return rel;
    }

    async searchDouban(q) {
        return doubanSuggest(q);
    }

    async applyDoubanResult(item, r) {
        if (r.title) item.title = r.title;
        if (r.authors.length) item.authors = r.authors;
        if (r.year) item.year = String(r.year);
        if (r.publisher && (!item.category || item.category === '未分类')) item.category = r.publisher;
        if (r.cover) {
            try { await this.downloadCover(r.cover, item); } catch (e) { /* 封面下载失败不影响元数据 */ }
        }
        // 顺带抓豆瓣评分 + 简介（国内可直连）
        if (r.url && (item.score == null || !item.summary)) {
            try {
                new Notice('正在抓取豆瓣评分/简介…');
                const d = await fetchDoubanDetail(r.url);
                if (d.score != null && item.score == null) item.score = d.score;
                if (d.summary && !item.summary) item.summary = d.summary;
            } catch (e) { /* 忽略，不影响元数据 */ }
        }
    }

    // 打开 / 创建该书目的独立读书笔记
    async openOrCreateNote(item) {
        let rel = item.notePath;
        let file = rel ? this.app.vault.getAbstractFileByPath(rel) : null;
        if (!(file instanceof TFile)) {
            await this.ensureFolder(this.settings.libraryFolder + '/笔记');
            const safe = sanitizeFilename(item.title) || item.id;
            rel = normalizePath(this.settings.libraryFolder + '/笔记/' + safe + '.md');
            let n = 1;
            while (this.app.vault.getAbstractFileByPath(rel)) {
                rel = normalizePath(this.settings.libraryFolder + '/笔记/' + safe + ' ' + (n++) + '.md');
            }
            await this.app.vault.create(rel, this.noteTemplate(item));
            item.notePath = rel;
            await this.saveItem(item);
            file = this.app.vault.getAbstractFileByPath(rel);
        }
        await this.app.workspace.getLeaf('tab').openFile(file);
    }

    noteTemplate(item) {
        const authors = (item.authors || []).join('、') || '—';
        const fileLink = item.file ? `📎 文件：[[${item.file}]]` : '';
        const venue = item.category && item.category !== '未分类' ? item.category : '—';
        const isPaper = item.type === 'paper';
        const lines = [];
        lines.push('---');
        lines.push(`library-id: ${item.id}`);
        lines.push(`type: ${item.type}`);
        lines.push(`title: "${String(item.title).replace(/"/g, '\\"')}"`);
        lines.push(`author: "${authors.replace(/"/g, '\\"')}"`);
        if (item.year) lines.push(`year: ${item.year}`);
        if (item.category) lines.push(`category: ${item.category}`);
        lines.push(`status: ${item.status || '未读'}`);
        if (item.rating) lines.push(`rating: ${item.rating}`);
        if (item.doi) lines.push(`doi: ${item.doi}`);
        if ((item.tags || []).length) {
            lines.push('tags:');
            for (const t of item.tags) lines.push(`  - ${t}`);
        }
        lines.push('---');
        lines.push('');
        lines.push(`# ${item.title}`);
        lines.push('');
        lines.push(`> **作者**：${authors}　**年份**：${item.year || '—'}　**${isPaper ? '期刊' : '分类'}**：${venue}　**状态**：${item.status || '未读'}`);
        if (fileLink) {
            lines.push('');
            lines.push(fileLink);
        }
        lines.push('');
        if (isPaper) {
            lines.push('## 研究问题');
            lines.push('');
            lines.push('## 方法');
            lines.push('');
            lines.push('## 主要结论');
            lines.push('');
            lines.push('## 创新点 / 不足');
            lines.push('');
            lines.push('## 我的评价');
        } else {
            lines.push('## 摘录');
            lines.push('');
            lines.push('## 我的笔记');
        }
        lines.push('');
        lines.push('## 阅读进度');
        lines.push('');
        lines.push('- [ ] 开始阅读');
        lines.push('- [ ] 读完');
        lines.push('');
        return lines.join('\n');
    }

    // 导入 BibTeX 文本
    async importBibtex(text) {
        const entries = parseBibtex(text);
        if (!entries.length) return 0;
        const items = entries.map(bibtexToItem);
        this.index.items.push(...items);
        await this.saveIndex();
        return items.length;
    }

    // 导入参考文献（BibTeX 或 RIS 文本，自动识别）
    async importReferences(text) {
        const t = String(text || '').trim();
        if (!t) return 0;
        const isRis = /^TY\s+-\s/m.test(t);
        const entries = isRis ? parseRis(t) : parseBibtex(t);
        const items = isRis ? entries.map(risToItem) : entries.map(bibtexToItem);
        if (!items.length) return 0;
        this.index.items.push(...items);
        await this.saveIndex();
        return items.length;
    }

    // 复制引用（BibTeX / GB/T 7714 / APA）
    async copyCitation(item, format) {
        const text = citationText(item, format);
        if (!text) { new Notice('生成引用失败'); return; }
        try {
            await navigator.clipboard.writeText(text);
            new Notice('已复制引用（' + (format === 'bibtex' ? 'BibTeX' : format === 'gbt' ? 'GB/T 7714' : 'APA') + '）');
        } catch (e) {
            new Notice('复制失败：' + e.message);
        }
    }

    // 打开 DOI 原文链接
    async openDoi(item) {
        if (!item.doi) { new Notice('该条目没有 DOI'); return; }
        window.open('https://doi.org/' + encodeURIComponent(item.doi));
    }

    // ---------- 导出 ----------
    exportMarkdown() {
        const lines = ['# 我的资料库', ''];
        for (const it of this.index.items) {
            const authors = (it.authors || []).join('、');
            const bits = [];
            if (authors) bits.push('作者：' + authors);
            if (it.year) bits.push(it.year);
            if (it.category && it.category !== '未分类') bits.push(it.category);
            bits.push(TYPE_LABEL[it.type] || it.type);
            bits.push(statusOf(it));
            lines.push(`- **${it.title}**　${bits.join('　·　')}`);
        }
        return lines.join('\n');
    }

    exportCsv() {
        const rows = [['标题', '作者', '年份', '类型', '分类', '标签', '状态', '评分', 'DOI']];
        for (const it of this.index.items) {
            rows.push([
                it.title || '',
                (it.authors || []).join('; '),
                it.year || '',
                TYPE_LABEL[it.type] || it.type,
                it.category || '',
                (it.tags || []).join('; '),
                statusOf(it),
                String(it.rating || 0),
                it.doi || '',
            ]);
        }
        return rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    }

    exportBibtex() {
        return this.index.items
            .filter((i) => i.type === 'paper')
            .map((i) => citationText(i, 'bibtex'))
            .filter(Boolean)
            .join('\n\n');
    }

    async exportFile(name, content) {
        await this.ensureFolder(this.settings.libraryFolder + '/导出');
        const p = normalizePath(this.settings.libraryFolder + '/导出/' + name);
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f instanceof TFile) await this.app.vault.delete(f);
        await this.app.vault.create(p, content);
        return p;
    }

    async exportData(kind) {
        const date = new Date().toISOString().slice(0, 10);
        let name, content;
        if (kind === 'md') { name = `书单-${date}.md`; content = this.exportMarkdown(); }
        else if (kind === 'csv') { name = `书单-${date}.csv`; content = this.exportCsv(); }
        else if (kind === 'bib') { name = `引用-${date}.bib`; content = this.exportBibtex(); }
        else if (kind === 'json') { name = `备份-${date}.json`; content = JSON.stringify(this.index, null, 2); }
        else { return null; }
        const p = await this.exportFile(name, content);
        new Notice('已导出：' + p);
        return p;
    }

    // ---------- 批量操作 ----------
    async batchMarkRead(items) {
        for (const it of items) { it.progress = 100; it.status = statusOf(it); }
        await this.saveIndex();
        this.refreshViews();
        new Notice(`已将 ${items.length} 项标记为读完`);
    }

    async batchSetCategory(items, category) {
        for (const it of items) { it.category = category || '未分类'; }
        await this.saveIndex();
        this.refreshViews();
        new Notice(`已设置 ${items.length} 项分类为「${category || '未分类'}」`);
    }

    async batchDelete(items) {
        for (const it of items) {
            const idx = this.index.items.findIndex((x) => x.id === it.id);
            if (idx >= 0) this.index.items.splice(idx, 1);
        }
        await this.saveIndex();
        this.refreshViews();
        new Notice(`已删除 ${items.length} 项`);
    }

    batchCitations(items) {
        const text = items.map((i) => citationText(i, 'gbt')).filter(Boolean).join('\n');
        if (!text) { new Notice('没有可导出的引用'); return; }
        navigator.clipboard.writeText(text).then(() => new Notice(`已复制 ${items.length} 条引用（GB/T 7714）`));
    }

    // ---------- 论文写作 ----------
    // 生成参考文献：把 [@id] 标记替换成 [n] 编号，并在文末生成 GB/T 7714 列表
    async generateReferences(editor) {
        const content = editor.getValue();
        const ids = [];
        let m;
        const re = /\[@([a-z0-9]+)\]/g;
        while ((m = re.exec(content)) !== null) {
            if (!ids.includes(m[1])) ids.push(m[1]);
        }
        if (!ids.length) { new Notice('没有找到 [@引用] 标记（先点「插入引用」）'); return; }
        const items = ids.map((id) => this.index.items.find((i) => i.id === id)).filter(Boolean);
        const byId = {};
        items.forEach((it, i) => { byId[it.id] = i + 1; });
        let newContent = content.replace(/\[@([a-z0-9]+)\]/g, (all, id) => '[' + (byId[id] || '?') + ']');
        const refs = items.map((it, i) => `[${i + 1}] ${citationText(it, 'gbt')}`).join('\n');
        const headingIdx = newContent.search(/^##\s*参考文献\s*$/m);
        if (headingIdx >= 0) {
            newContent = newContent.slice(0, headingIdx).trimEnd() + '\n\n## 参考文献\n\n' + refs + '\n';
        } else {
            newContent = newContent.trimEnd() + '\n\n## 参考文献\n\n' + refs + '\n';
        }
        editor.setValue(newContent);
        new Notice(`已生成 ${items.length} 条参考文献`);
    }

    // AI 写作：按指令处理选中文字
    async aiWrite(text, instruction) {
        if (!this.settings.aiApiKey) { new Notice('请先在插件设置里填写 DeepSeek API Key'); return null; }
        if (!text || !text.trim()) { new Notice('请先选中要处理的文字'); return null; }
        new Notice('正在用 DeepSeek ' + instruction + '…');
        const prompt = instruction + '，只输出处理后的文字，不要任何解释：\n\n' + text;
        try {
            const base = (this.settings.aiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
            const res = await requestUrlTimeout({
                url: base + '/chat/completions',
                method: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': 'Bearer ' + this.settings.aiApiKey },
                body: JSON.stringify({
                    model: this.settings.aiModel || 'deepseek-chat',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.7,
                }),
            }, 30000);
            if (res.status !== 200) { new Notice('AI 请求失败(' + res.status + ')'); return null; }
            const data = res.json;
            const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            return content ? String(content).trim() : null;
        } catch (e) {
            new Notice('AI 请求失败：' + e.message);
            return null;
        }
    }

    async aiEditSelection(editor, instruction) {
        const sel = editor.getSelection();
        if (!sel) { new Notice('请先选中要处理的文字'); return; }
        const result = await this.aiWrite(sel, instruction);
        if (result) editor.replaceSelection(result);
    }
};

// =====================================================================
// 视图（前端主体）
// =====================================================================
class LibraryView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.state = {
            search: '',
            type: 'all',
            category: 'all',
            status: 'all',
            format: 'all',
            sort: 'title',
            viewMode: 'grid',
            mode: 'shelf',
            selecting: false,
            selected: new Set(),
        };
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return '资料库'; }
    getIcon() { return 'library'; }

    async onOpen() {
        const c = this.containerEl;
        c.empty();
        c.addClass('lib-root');

        this.toolbarEl = c.createDiv({ cls: 'lib-toolbar' });
        this.renderToolbar();

        const body = c.createDiv({ cls: 'lib-body' });
        this.sidebarEl = body.createDiv({ cls: 'lib-sidebar' });
        this.mainEl = body.createDiv({ cls: 'lib-main' });

        // 按 / 聚焦搜索框
        this._searchShortcut = (e) => {
            const active = this.containerEl.ownerDocument.activeElement;
            if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !active?.isContentEditable && !/INPUT|TEXTAREA|SELECT/.test(active?.tagName || '')) {
                e.preventDefault();
                const s = this.toolbarEl.querySelector('.lib-search');
                if (s) s.focus();
            }
        };
        this.containerEl.addEventListener('keydown', this._searchShortcut);

        this.refresh();
    }

    async onClose() {
        this.closeDropdown();
        if (this._searchShortcut) this.containerEl.removeEventListener('keydown', this._searchShortcut);
    }

    renderToolbar() {
        const t = this.toolbarEl;
        t.empty();

        // 搜索框（常驻，不随刷新重建，避免失焦）
        const search = el('input', 'lib-search');
        search.type = 'text';
        search.placeholder = '搜索标题 / 作者 / 分类…';
        search.setAttribute('aria-label', '搜索资料');
        search.value = this.state.search;
        search.addEventListener('input', () => {
            this.state.search = search.value;
            this.renderMain();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && search.value) {
                e.preventDefault();
                e.stopPropagation();
                this.clearSearch();
            }
        });
        this.searchInput = search;
        t.appendChild(search);

        // 类型分段
        this.typeSeg = el('div', 'lib-seg');
        this.typeSeg.setAttribute('aria-label', '资料类型');
        t.appendChild(this.typeSeg);

        // 视图切换（网格 ↔ 列表，单按钮切换）
        this.viewToggleBtn = el('button', 'lib-icon-btn', '');
        this.viewToggleBtn.addEventListener('click', () => {
            this.state.viewMode = this.state.viewMode === 'grid' ? 'list' : 'grid';
            this.updateToolbarState();
            this.renderMain();
        });
        t.appendChild(this.viewToggleBtn);

        // 统计 / 书架
        this.statsBtn = el('button', 'lib-btn', '统计');
        this.statsBtn.addEventListener('click', () => {
            this.state.mode = this.state.mode === 'shelf' ? 'stats' : 'shelf';
            this.updateToolbarState();
            this.renderMain();
        });
        t.appendChild(this.statsBtn);

        // 多选
        this.multiBtn = el('button', 'lib-btn', '多选');
        this.multiBtn.addEventListener('click', () => {
            this.state.selecting = !this.state.selecting;
            this.state.selected.clear();
            this.updateToolbarState();
            this.renderMain();
        });
        t.appendChild(this.multiBtn);

        const spacer = el('div', 'lib-spacer');
        t.appendChild(spacer);

        // 排序（紧凑）
        this.sortSelect = el('select', 'lib-select lib-select-compact');
        this.sortSelect.setAttribute('aria-label', '排序方式');
        this.sortSelect.title = '排序方式';
        for (const s of SORT_OPTIONS) {
            const o = el('option', null, s.label);
            o.value = s.id;
            this.sortSelect.appendChild(o);
        }
        this.sortSelect.addEventListener('change', () => {
            this.state.sort = this.sortSelect.value;
            this.renderMain();
        });
        t.appendChild(this.sortSelect);

        // 保留原工具栏的导出、导入入口。
        const exportBtn = el('button', 'lib-btn', '导出');
        exportBtn.setAttribute('aria-haspopup', 'menu');
        exportBtn.addEventListener('click', () => {
            this.closeDropdown();
            this._dropdown = popupMenu(exportBtn, [
                { label: '导出 Markdown 书单', onClick: () => this.plugin.exportData('md') },
                { label: '导出 CSV', onClick: () => this.plugin.exportData('csv') },
                { label: '导出全部引用(.bib)', onClick: () => this.plugin.exportData('bib') },
                { label: '导出完整备份(JSON)', onClick: () => this.plugin.exportData('json') },
            ]);
        });
        t.appendChild(exportBtn);
        const importBtn = el('button', 'lib-btn lib-btn-primary', '+ 导入');
        importBtn.setAttribute('aria-haspopup', 'menu');
        importBtn.addEventListener('click', () => this.showImportMenu(importBtn));
        t.appendChild(importBtn);

        this.updateToolbarState();
    }

    clearSearch() {
        this.state.search = '';
        this.searchInput.value = '';
        this.renderMain();
        this.searchInput.focus();
    }

    resetFilters() {
        Object.assign(this.state, { search: '', type: 'all', category: 'all', status: 'all', format: 'all' });
        this.searchInput.value = '';
        this.refresh();
    }

    showImportMenu(anchor) {
        this.closeDropdown();
        this._dropdown = popupMenu(anchor, [
            { label: '导入文件', icon: 'file-plus', onClick: () => this.pickFiles() },
            { label: '导入参考文献 (.bib / .ris)', onClick: () => this.pickReferenceFile() },
            { label: '扫描已有文件', icon: 'folder-search', onClick: async () => {
            const n = await this.plugin.scanVault();
            new Notice(n > 0 ? `已收录 ${n} 个文件` : '没有发现新的文件');
            this.refresh();
            } },
            { label: '粘贴 BibTeX', onClick: () => new BibtexModal(this.app, this.plugin).open() },
            { label: '新建条目', icon: 'plus', onClick: () => this.openItemModal(null) },
        ]);
    }

    closeDropdown() {
        if (this._dropdown) { this._dropdown.hide(); this._dropdown = null; }
    }

    updateToolbarState() {
        this.containerEl.dataset.type = this.state.type;
        // 类型分段
        this.typeSeg.empty();
        const types = [['all', '全部'], ...TYPE_ORDER.map((k) => [k, TYPE_LABEL[k]])];
        for (const [id, label] of types) {
            const b = el('button', 'lib-seg-btn' + (this.state.type === id ? ' is-active' : ''), label);
            b.setAttribute('aria-pressed', String(this.state.type === id));
            b.addEventListener('click', () => {
                this.state.type = id;
                this.state.category = 'all';
                this.updateToolbarState();
                this.renderMain();
                this.renderSidebar();
            });
            this.typeSeg.appendChild(b);
        }
        this.sortSelect.value = this.state.sort;
        setIcon(this.viewToggleBtn, this.state.viewMode === 'grid' ? 'list' : 'layout-grid');
        this.viewToggleBtn.title = this.state.viewMode === 'grid' ? '切换到列表' : '切换到网格';
        this.viewToggleBtn.setAttribute('aria-label', this.viewToggleBtn.title);

        // 统计/多选 按钮状态
        const isStats = this.state.mode === 'stats';
        this.statsBtn.textContent = isStats ? '书架' : '统计';
        this.statsBtn.classList.toggle('is-active', isStats);
        this.statsBtn.setAttribute('aria-pressed', String(isStats));
        this.multiBtn.textContent = this.state.selecting ? '完成' : '多选';
        this.multiBtn.classList.toggle('is-active', this.state.selecting);
        this.multiBtn.setAttribute('aria-pressed', String(this.state.selecting));
        this.multiBtn.style.display = isStats ? 'none' : '';
        // 统计模式下隐藏排序和视图切换
        this.sortSelect.style.display = isStats ? 'none' : '';
        this.viewToggleBtn.style.display = isStats ? 'none' : '';
    }

    getItems() { return this.plugin.index.items; }

    getFiltered() {
        let items = this.getItems().slice();
        const s = this.state;
        if (s.type !== 'all') items = items.filter((i) => i.type === s.type);
        if (s.category !== 'all') items = items.filter((i) => (i.category || '未分类') === s.category);
        if (s.status !== 'all') items = items.filter((i) => statusOf(i) === s.status);
        if (s.format !== 'all') items = items.filter((i) => i.format === s.format);
        if (s.search) {
            const q = s.search.trim().toLowerCase();
            items = items.filter((i) => {
                const hay = [i.title, (i.authors || []).join(' '), i.category, (i.tags || []).join(' '), i.year, i.notes].join(' ').toLowerCase();
                return hay.includes(q);
            });
        }
        const cmp = {
            title: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'),
            author: (a, b) => ((a.authors && a.authors[0]) || '').localeCompare((b.authors && b.authors[0]) || '', 'zh-Hans-CN'),
            year: (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0),
            rating: (a, b) => (b.rating || 0) - (a.rating || 0),
            created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
        }[s.sort] || ((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'));
        items.sort(cmp);
        return items;
    }

    getStats() {
        let items = this.getItems().slice();
        if (this.state.type !== 'all') items = items.filter((i) => i.type === this.state.type);
        const cats = {};
        const sts = { 未读: 0, 已读: 0, 读完: 0 };
        for (const it of items) {
            const cat = it.category || '未分类';
            cats[cat] = (cats[cat] || 0) + 1;
            sts[statusOf(it)] = (sts[statusOf(it)] || 0) + 1;
        }
        return { total: items.length, cats, sts };
    }

    refresh() {
        this.renderSidebar();
        this.renderMain();
        this.updateToolbarState();
    }

    animateNumber(el, from, to, duration) {
        const start = performance.now();
        const step = (now) => {
            const p = Math.min(1, (now - start) / (duration || 500));
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = String(Math.round(from + (to - from) * eased));
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    renderSidebar() {
        const sb = this.sidebarEl;
        sb.empty();
        const { total, cats, sts } = this.getStats();

        const stat = sb.createDiv({ cls: 'lib-stat' });
        const numEl = stat.createDiv({ cls: 'lib-stat-num', text: String(total) });
        if (typeof this._lastTotal === 'number' && this._lastTotal !== total) {
            this.animateNumber(numEl, this._lastTotal, total);
        }
        this._lastTotal = total;
        stat.createDiv({ cls: 'lib-stat-label', text: `未读 ${sts['未读']} · 已读 ${sts['已读']} · 读完 ${sts['读完']}` });

        // 状态：紧凑圆片（含"全部"）
        const chipRow = sb.createDiv({ cls: 'lib-chips' });
        const allChip = el('button', 'lib-chip-btn' + (this.state.status === 'all' ? ' is-active' : ''), '全部 ' + total);
        allChip.setAttribute('aria-pressed', String(this.state.status === 'all'));
        allChip.addEventListener('click', () => {
            this.state.status = 'all';
            this.renderSidebar();
            this.renderMain();
        });
        chipRow.appendChild(allChip);
        for (const s of STATUSES) {
            const chip = el('button', 'lib-chip-btn' + (this.state.status === s ? ' is-active' : ''), `${s} ${sts[s] || 0}`);
            chip.setAttribute('aria-pressed', String(this.state.status === s));
            chip.addEventListener('click', () => {
                this.state.status = this.state.status === s ? 'all' : s;
                this.renderSidebar();
                this.renderMain();
            });
            chipRow.appendChild(chip);
        }

        sb.createDiv({ cls: 'lib-side-title', text: '分类' });
        const categories = sb.createDiv({ cls: 'lib-categories' });
        this.sideLink(categories, '全部', 'all', 'category', total);
        const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
        for (const c of catNames) this.sideLink(categories, c, c, 'category', cats[c]);
    }

    sideLink(parent, label, value, key, count) {
        const active = this.state[key] === value;
        const row = el('button', 'lib-side-link' + (active ? ' is-active' : ''));
        row.setAttribute('aria-pressed', String(active));
        row.appendChild(el('span', 'lib-side-link-label', label));
        row.appendChild(el('span', 'lib-side-link-count', String(count)));
        row.addEventListener('click', () => {
            this.state[key] = active ? 'all' : value;
            this.renderSidebar();
            this.renderMain();
        });
        parent.appendChild(row);
    }

    renderMain() {
        const m = this.mainEl;
        m.empty();
        m.classList.remove('lib-stats');

        const items = this.getFiltered();
        const hasFilters = this.state.search.trim() || ['type', 'category', 'status', 'format'].some((key) => this.state[key] !== 'all');
        if (hasFilters) {
            const results = m.createDiv({ cls: 'lib-results-bar' });
            results.createDiv({ cls: 'lib-results-label', text: `筛选结果 · ${items.length} 份` });
            const reset = el('button', 'lib-results-reset', '清除筛选');
            reset.addEventListener('click', () => this.resetFilters());
            results.appendChild(reset);
        }

        if (this.state.mode === 'stats') {
            this.renderStats(m);
            return;
        }

        if (this.state.selecting) {
            this.renderBatchBar(m);
        }

        if (items.length === 0) {
            const empty = m.createDiv({ cls: 'lib-empty' });
            empty.createDiv({ cls: 'lib-empty-icon', text: hasFilters ? '🔎' : '📚' });
            if (hasFilters) {
                empty.createDiv({ cls: 'lib-empty-title', text: '没有找到匹配的资料' });
                empty.createDiv({ cls: 'lib-empty-sub', text: '试试其他关键词，或清除筛选查看全部收藏。' });
                const clear = el('button', 'lib-btn lib-btn-primary', '查看全部收藏');
                clear.addEventListener('click', () => this.resetFilters());
                empty.appendChild(clear);
                return;
            }
            empty.createDiv({ cls: 'lib-empty-title', text: '这里还是空的' });
            empty.createDiv({ cls: 'lib-empty-sub', text: '点击右上角「导入资料」，或扫描已有文件，开始整理你的阅读收藏。' });
            const b1 = el('button', 'lib-btn lib-btn-primary', '导入文件');
            b1.addEventListener('click', () => this.pickFiles());
            const b2 = el('button', 'lib-btn', '扫描已有文件');
            b2.addEventListener('click', async () => {
                const n = await this.plugin.scanVault();
                new Notice(n > 0 ? `已收录 ${n} 个文件` : '没有发现新的文件');
                this.refresh();
            });
            const row = empty.createDiv({ cls: 'lib-empty-btns' });
            row.appendChild(b1); row.appendChild(b2);
            return;
        }

        if (this.state.viewMode === 'list') this.renderList(m, items);
        else this.renderGrid(m, items);
    }

    toggleSelect(item) {
        if (this.state.selected.has(item.id)) this.state.selected.delete(item.id);
        else this.state.selected.add(item.id);
        this.renderMain();
    }

    renderBatchBar(m) {
        const bar = m.createDiv({ cls: 'lib-batch-bar' });
        const sel = this.state.selected;
        const count = sel.size;
        const items = this.getItems().filter((i) => sel.has(i.id));
        bar.createDiv({ cls: 'lib-batch-info', text: `已选 ${count} 项` });

        const mkBtn = (label, fn) => {
            const b = el('button', 'lib-btn', label);
            b.addEventListener('click', fn);
            bar.appendChild(b);
        };
        mkBtn('标记读完', () => this.plugin.batchMarkRead(items));
        mkBtn('设置分类', () => new PromptModal(this.app, '设置分类', '未分类', (v) => this.plugin.batchSetCategory(items, v)).open());
        mkBtn('复制引用', () => this.plugin.batchCitations(items));
        mkBtn('删除', async () => {
            if (confirm(`确定删除选中的 ${count} 项？`)) {
                this.state.selected.clear();
                await this.plugin.batchDelete(items);
            }
        });
        mkBtn('取消', () => {
            this.state.selected.clear();
            this.state.selecting = false;
            this.updateToolbarState();
            this.renderMain();
        });
    }

    renderStats(m) {
        const items = this.getFiltered();
        const total = items.length;
        const byType = { book: 0, paper: 0, other: 0 };
        const byStatus = { 未读: 0, 已读: 0, 读完: 0 };
        const cats = {};
        let ratingSum = 0, ratingCount = 0, pctSum = 0;
        for (const it of items) {
            byType[it.type] = (byType[it.type] || 0) + 1;
            byStatus[statusOf(it)] = (byStatus[statusOf(it)] || 0) + 1;
            const c = it.category || '未分类';
            cats[c] = (cats[c] || 0) + 1;
            if (it.rating) { ratingSum += it.rating; ratingCount++; }
            pctSum += percentOf(it);
        }
        const avgRating = ratingCount ? (ratingSum / ratingCount).toFixed(1) : '—';
        const avgPct = total ? Math.round(pctSum / total) : 0;

        m.addClass('lib-stats');

        const tiles = m.createDiv({ cls: 'lib-stats-tiles' });
        const tile = (label, value) => {
            const t = tiles.createDiv({ cls: 'lib-stat-tile' });
            t.createDiv({ cls: 'lib-stat-tile-num', text: String(value) });
            t.createDiv({ cls: 'lib-stat-tile-label', text: label });
        };
        tile('总数', total);
        tile('图书', byType.book);
        tile('论文', byType.paper);
        tile('已读', byStatus['已读']);
        tile('读完', byStatus['读完']);
        tile('平均评分', avgRating);
        tile('平均进度', avgPct + '%');

        m.createDiv({ cls: 'lib-stats-title', text: '阅读状态' });
        const statusBars = m.createDiv({ cls: 'lib-stats-bars' });
        for (const s of STATUSES) {
            const row = statusBars.createDiv({ cls: 'lib-stat-bar-row' });
            row.createDiv({ cls: 'lib-stat-bar-label', text: s });
            const bar = row.createDiv({ cls: 'lib-stat-bar' });
            const fill = bar.createDiv({ cls: 'lib-stat-bar-fill' });
            fill.style.width = (total ? Math.round(byStatus[s] / total * 100) : 0) + '%';
            row.createDiv({ cls: 'lib-stat-bar-num', text: String(byStatus[s] || 0) });
        }

        m.createDiv({ cls: 'lib-stats-title', text: '分类分布（前 10）' });
        const catRows = m.createDiv({ cls: 'lib-stats-bars' });
        const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]).slice(0, 10);
        const catMax = catNames.length ? cats[catNames[0]] : 1;
        for (const c of catNames) {
            const row = catRows.createDiv({ cls: 'lib-stat-bar-row' });
            row.createDiv({ cls: 'lib-stat-bar-label', text: c });
            const bar = row.createDiv({ cls: 'lib-stat-bar' });
            const fill = bar.createDiv({ cls: 'lib-stat-bar-fill' });
            fill.style.width = Math.round(cats[c] / catMax * 100) + '%';
            row.createDiv({ cls: 'lib-stat-bar-num', text: String(cats[c]) });
        }

        m.createDiv({ cls: 'lib-stats-title', text: '最近添加' });
        const recent = [...items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
        const rl = m.createDiv({ cls: 'lib-stats-recent' });
        for (const it of recent) {
            const r = rl.createDiv({ cls: 'lib-stat-recent-item' });
            r.createDiv({ cls: 'lib-stat-recent-title', text: it.title });
            r.createDiv({ cls: 'lib-stat-recent-meta', text: this.metaLine(it) || '—' });
            r.addEventListener('click', () => this.openOrEdit(it));
        }
    }

    coverBlock(item, size) {
        const c = el('div', 'lib-cover lib-cover-' + size);
        const showFallback = () => {
            const [c1, c2] = colorFor(item.title);
            c.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
            c.appendChild(el('span', 'lib-cover-char', (item.title || '?').trim().charAt(0).toUpperCase()));
            c.appendChild(el('span', 'lib-cover-fmt', String(item.format || '文档').toUpperCase()));
            c.classList.add('is-fallback');
        };
        const url = item.cover ? this.plugin.resourceUrl(item.cover) : null;
        if (url) {
            const img = el('img', 'lib-cover-img');
            img.alt = (item.title || '资料') + '封面';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.addEventListener('error', () => { img.remove(); showFallback(); }, { once: true });
            img.src = url;
            c.appendChild(img);
        } else {
            showFallback();
        }
        return c;
    }

    typeBadge(item) {
        return el('span', 'lib-badge lib-type-' + item.type, TYPE_LABEL[item.type] || item.type);
    }

    metaLine(item) {
        const parts = [];
        if (item.authors && item.authors.length) parts.push(item.authors.join('、'));
        if (item.year) parts.push(item.year);
        return parts.join(' · ');
    }

    // 卡片上的可点击星级（点一下打分，再点同一颗取消）
    starWidget(item) {
        const wrap = el('span', 'lib-stars lib-stars-click');
        const render = () => {
            wrap.empty();
            for (let i = 1; i <= 5; i++) {
                const s = el('button', 'lib-star-sm' + (i <= item.rating ? ' is-on' : ''), i <= item.rating ? '★' : '☆');
                s.setAttribute('aria-label', `评分 ${i} 星`);
                s.setAttribute('aria-pressed', String(i === item.rating));
                s.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const keepFocus = s.ownerDocument.activeElement === s;
                    item.rating = i === item.rating ? 0 : i;
                    this.plugin.saveItem(item);
                    render();
                    if (keepFocus) wrap.children[i - 1]?.focus();
                });
                wrap.appendChild(s);
            }
        };
        render();
        return wrap;
    }

    openOrEdit(item) {
        const hasFile = item.file && this.app.vault.getAbstractFileByPath(item.file) instanceof TFile;
        if (hasFile) this.plugin.openItem(item);
        else this.openItemModal(item);
    }

    makeItemAccessible(node, item) {
        node.tabIndex = 0;
        node.setAttribute('role', 'group');
        node.setAttribute('aria-label', `${item.title || '未命名'}，${statusOf(item)}${this.state.selecting ? (this.state.selected.has(item.id) ? '，已选择' : '，未选择') : ''}`);
        node.addEventListener('keydown', (e) => {
            if (e.target !== node || !['Enter', ' '].includes(e.key)) return;
            e.preventDefault();
            if (this.state.selecting) this.toggleSelect(item);
            else this.openOrEdit(item);
        });
    }

    renderGrid(m, items) {
        const g = m.createDiv({ cls: 'lib-grid' });
        let idx = 0;
        for (const it of items) {
            const card = g.createDiv({ cls: 'lib-card' });
            this.makeItemAccessible(card, it);
            if (this.state.selected.has(it.id)) card.addClass('is-selected');
            card.style.animationDelay = Math.min(idx, 12) * 20 + 'ms';
            idx++;
            card.appendChild(this.coverBlock(it, 'card'));
            const body = card.createDiv({ cls: 'lib-card-body' });
            const titleEl = body.createDiv({ cls: 'lib-card-title', attr: { title: it.title } });
            titleEl.innerHTML = highlight(it.title, this.state.search);
            if (it.authors && it.authors.length) {
                const authorEl = body.createDiv({ cls: 'lib-card-author' });
                authorEl.innerHTML = highlight(it.authors.join('、'), this.state.search);
            }
            if (it.year) {
                body.createDiv({ cls: 'lib-card-meta', text: it.year });
            }
            const badges = body.createDiv({ cls: 'lib-card-badges' });
            badges.appendChild(this.typeBadge(it));
            if (it.category && it.category !== '未分类') badges.appendChild(el('span', 'lib-chip', it.category));
            const pct = percentOf(it);
            if (pct > 0) {
                const bar = body.createDiv({ cls: 'lib-progress-bar' });
                bar.setAttribute('title', '已读 ' + pct + '%');
                const fill = bar.createDiv({ cls: 'lib-progress-fill' });
                fill.style.width = pct + '%';
            }
            const foot = body.createDiv({ cls: 'lib-card-foot' });
            foot.appendChild(this.starWidget(it));
            const st = statusOf(it);
            foot.appendChild(el('span', 'lib-status lib-status-' + st, st));
            const edit = el('button', 'lib-card-edit');
            edit.title = '编辑';
            edit.setAttribute('aria-label', '编辑 ' + it.title);
            setIcon(edit, 'pencil');
            edit.addEventListener('click', (e) => { e.stopPropagation(); this.openItemModal(it); });
            card.appendChild(edit);
            card.addEventListener('click', (e) => {
                if (e.target.closest('.lib-card-edit')) return;
                if (this.state.selecting) { this.toggleSelect(it); return; }
                this.openOrEdit(it);
            });
            card.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.showItemContextMenu(e, it); });
            g.appendChild(card);
        }
    }

    renderList(m, items) {
        const l = m.createDiv({ cls: 'lib-list' });
        let idx = 0;
        for (const it of items) {
            const row = l.createDiv({ cls: 'lib-row' });
            this.makeItemAccessible(row, it);
            if (this.state.selected.has(it.id)) row.addClass('is-selected');
            row.style.animationDelay = Math.min(idx, 12) * 20 + 'ms';
            idx++;
            row.appendChild(this.coverBlock(it, 'row'));
            const info = row.createDiv({ cls: 'lib-row-info' });
            const rt = info.createDiv({ cls: 'lib-row-title', attr: { title: it.title } });
            rt.innerHTML = highlight(it.title, this.state.search);
            const rm = info.createDiv({ cls: 'lib-row-meta' });
            rm.innerHTML = highlight(this.metaLine(it) || '—', this.state.search);
            const badges = row.createDiv({ cls: 'lib-row-badges' });
            badges.appendChild(this.typeBadge(it));
            if (it.category && it.category !== '未分类') badges.appendChild(el('span', 'lib-chip', it.category));
            row.appendChild(this.starWidget(it));
            const st = statusOf(it);
            row.appendChild(el('span', 'lib-status lib-status-' + st, st));
            if (percentOf(it) > 0) row.appendChild(el('span', 'lib-progress', '已读 ' + percentOf(it) + '%'));
            const edit = el('button', 'lib-row-edit');
            edit.title = '编辑';
            edit.setAttribute('aria-label', '编辑 ' + it.title);
            setIcon(edit, 'pencil');
            edit.addEventListener('click', (e) => { e.stopPropagation(); this.openItemModal(it); });
            row.appendChild(edit);
            row.addEventListener('click', (e) => {
                if (e.target.closest('.lib-row-edit')) return;
                if (this.state.selecting) { this.toggleSelect(it); return; }
                this.openOrEdit(it);
            });
            row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.showItemContextMenu(e, it); });
            l.appendChild(row);
        }
    }

    pickFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.pdf,.epub,.mobi,.azw3,.azw,.fb2,.djvu,.txt,.cbz,.cbr';
        input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            if (files.length) new ImportModal(this.app, this.plugin, files).open();
        });
        input.click();
    }

    pickReferenceFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.bib,.ris,.txt';
        input.addEventListener('change', async () => {
            const f = input.files && input.files[0];
            if (!f) return;
            const text = await f.text();
            const n = await this.plugin.importReferences(text);
            new Notice(n > 0 ? `已导入 ${n} 条参考文献` : '没有解析到条目');
            this.plugin.refreshViews();
        });
        input.click();
    }

    openItemModal(item) {
        new ItemModal(this.app, this.plugin, item, () => this.refresh()).open();
    }

    showItemContextMenu(evt, item) {
        contextMenu(evt, [
            { label: '打开', onClick: () => this.plugin.openItem(item) },
            { label: '编辑', onClick: () => this.openItemModal(item) },
            { label: '复制引用 ▸', onClick: () => contextMenu(
                { clientX: evt.clientX + 150, clientY: evt.clientY },
                [
                    { label: 'GB/T 7714', onClick: () => this.plugin.copyCitation(item, 'gbt') },
                    { label: 'APA', onClick: () => this.plugin.copyCitation(item, 'apa') },
                    { label: 'BibTeX', onClick: () => this.plugin.copyCitation(item, 'bibtex') },
                ]
            ) },
            { label: '标记读完', onClick: async () => { item.progress = 100; await this.plugin.saveItem(item); this.refresh(); } },
            { label: '删除', onClick: async () => { await this.plugin.removeItem(item.id, false); new Notice('已移除'); this.refresh(); } },
        ]);
    }
}

// =====================================================================
// 导入确认弹窗
// =====================================================================
class ImportModal extends Modal {
    constructor(app, plugin, files, defaultType) {
        super(app);
        this.plugin = plugin;
        this.files = files;
        this.type = defaultType || 'book';
        this.category = '未分类';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('lib-modal');
        contentEl.createEl('h3', { text: `导入 ${this.files.length} 个文件` });

        const list = contentEl.createDiv({ cls: 'lib-import-list' });
        this.files.slice(0, 30).forEach((f) => {
            list.createDiv({ cls: 'lib-import-item', text: `${f.name}  ·  ${formatFromName(f.name).toUpperCase()}` });
        });
        if (this.files.length > 30) list.createDiv({ cls: 'lib-import-more', text: `…还有 ${this.files.length - 30} 个` });

        // 类型
        contentEl.createDiv({ cls: 'lib-field-label', text: '导入为' });
        const seg = contentEl.createDiv({ cls: 'lib-seg' });
        for (const k of TYPE_ORDER) {
            const b = el('button', 'lib-seg-btn' + (k === this.type ? ' is-active' : ''), TYPE_LABEL[k]);
            b.addEventListener('click', () => {
                this.type = k;
                seg.querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
            });
            seg.appendChild(b);
        }

        // 分类
        contentEl.createDiv({ cls: 'lib-field-label', text: '分类' });
        const input = contentEl.createEl('input', { type: 'text', value: '未分类', cls: 'lib-text-input' });
        const dl = contentEl.createEl('datalist');
        dl.id = 'lib-cat-datalist';
        input.setAttribute('list', 'lib-cat-datalist');
        const cats = [...new Set(this.plugin.index.items.map((i) => i.category).filter(Boolean))];
        for (const c of cats) dl.createEl('option', { value: c });
        input.addEventListener('input', () => { this.category = input.value.trim() || '未分类'; });

        // 元数据补全选项
        const enrichRow = contentEl.createDiv({ cls: 'lib-check-row' });
        const enrichCheck = enrichRow.createEl('input', { type: 'checkbox', cls: 'lib-checkbox' });
        enrichCheck.id = 'lib-enrich-check';
        enrichCheck.checked = false;
        enrichRow.createEl('label', { text: '导入后自动识别 PDF 的 DOI/元数据（联网）', cls: 'lib-check-label', attr: { for: 'lib-enrich-check' } });

        // 按钮
        const btns = contentEl.createDiv({ cls: 'lib-modal-btns' });
        const ok = btns.createEl('button', { text: '确认导入', cls: 'mod-cta' });
        ok.addEventListener('click', async () => {
            ok.disabled = true;
            try {
                const created = await this.plugin.importFiles(this.files, { type: this.type, category: this.category || '未分类' });
                new Notice(`已导入 ${created.length} 个文件`);
                this.plugin.refreshViews();
                if (enrichCheck.checked && created.length) {
                    const n = await this.plugin.enrichItems(created);
                    if (n) { new Notice(`已自动补全 ${n} 个条目元数据`); this.plugin.refreshViews(); }
                }
                this.close();
            } catch (e) {
                new Notice('导入失败：' + e.message);
                ok.disabled = false;
            }
        });
        const cancel = btns.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =====================================================================
// 条目详情 / 编辑弹窗
// =====================================================================
class ItemModal extends Modal {
    constructor(app, plugin, item, onChanged) {
        super(app);
        this.plugin = plugin;
        this.item = item ? JSON.parse(JSON.stringify(item)) : this.blankItem();
        this.isNew = !item;
        this.onChanged = onChanged;
    }

    blankItem() {
        return {
            id: uid(),
            title: '',
            type: 'book',
            authors: [],
            year: '',
            category: '未分类',
            tags: [],
            format: 'pdf',
            file: '',
            cover: '',
            status: '未读',
            rating: 0,
            notes: '',
            doi: '',
            notePath: '',
            progress: 0,
            summary: '',
            score: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    onOpen() {
        this.contentEl.addClass('lib-modal', 'lib-item-modal');
        try {
            this.build();
        } catch (e) {
            console.error('[资料库] 编辑窗渲染失败', e);
            this.contentEl.createEl('p', { cls: 'lib-modal-desc', text: '编辑窗渲染出错：' + (e && e.message ? e.message : String(e)) });
        }
    }

    build() {
        const contentEl = this.contentEl;
        contentEl.empty();
        const it = this.item;

        contentEl.createEl('h3', { text: this.isNew ? '新建条目' : it.title });

        // 顶部操作
        const top = contentEl.createDiv({ cls: 'lib-item-top' });
        if (!this.isNew && it.file) {
            const open = top.createEl('button', { text: '打开文件', cls: 'lib-btn lib-btn-primary' });
            open.addEventListener('click', () => this.plugin.openItem(it));
            const reveal = top.createEl('button', { text: '显示位置', cls: 'lib-btn' });
            reveal.addEventListener('click', () => this.plugin.revealItem(it));
        }
        if (!this.isNew) {
            if (it.file && (it.format === 'pdf' || it.format === 'epub')) {
                const extractBtn = top.createEl('button', { text: '提取封面', cls: 'lib-btn' });
                extractBtn.addEventListener('click', async () => { await this.plugin.extractFileCover(it); this.build(); });
            }
            const doubanBtn = top.createEl('button', { text: '豆瓣搜索', cls: 'lib-btn' });
            doubanBtn.addEventListener('click', () => new DoubanModal(this.app, this.plugin, it, () => this.build()).open());
            const aiBtn = top.createEl('button', { text: 'AI 补全', cls: 'lib-btn' });
            aiBtn.addEventListener('click', async () => { await this.plugin.aiFill(it); this.build(); });
            const noteBtn = top.createEl('button', { text: '读书笔记', cls: 'lib-btn' });
            noteBtn.addEventListener('click', async () => { await this.plugin.openOrCreateNote(it); this.build(); });
            const citeBtn = top.createEl('button', { text: '复制引用', cls: 'lib-btn' });
            citeBtn.addEventListener('click', () => {
                popupMenu(citeBtn, [
                    { label: 'GB/T 7714（中文论文）', onClick: () => this.plugin.copyCitation(it, 'gbt') },
                    { label: 'APA（英文）', onClick: () => this.plugin.copyCitation(it, 'apa') },
                    { label: 'BibTeX（LaTeX）', onClick: () => this.plugin.copyCitation(it, 'bibtex') },
                ]);
            });
            if (it.doi) {
                const doiBtn = top.createEl('button', { text: '打开 DOI', cls: 'lib-btn' });
                doiBtn.addEventListener('click', () => this.plugin.openDoi(it));
            }
        }
        const coverUrl = it.cover ? this.plugin.resourceUrl(it.cover) : null;
        if (coverUrl) {
            const img = top.createEl('img', { cls: 'lib-item-cover' });
            img.alt = (it.title || '资料') + '封面';
            img.addEventListener('error', () => img.remove(), { once: true });
            img.src = coverUrl;
        }

        // 表单（纯 DOM）
        const f = contentEl.createDiv({ cls: 'lib-item-form' });

        const titleInput = formField(f, '标题', 'text', it.title);
        titleInput.addEventListener('input', () => { it.title = titleInput.value; });

        const typeBtn = formField(f, '类型', 'button', TYPE_LABEL[it.type] || it.type);
        typeBtn.addEventListener('click', () => {
            const idx = TYPE_ORDER.indexOf(it.type);
            it.type = TYPE_ORDER[(idx + 1) % TYPE_ORDER.length];
            typeBtn.textContent = TYPE_LABEL[it.type] || it.type;
        });

        const authorInput = formField(f, '作者', 'text', (it.authors || []).join(', '));
        authorInput.setAttribute('placeholder', '多个作者用逗号分隔');
        authorInput.addEventListener('input', () => { it.authors = authorInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); });

        const yearInput = formField(f, '年份', 'text', it.year || '');
        yearInput.addEventListener('input', () => { it.year = yearInput.value.trim(); });

        // DOI
        const doiInput = formField(f, 'DOI', 'text', it.doi || '');
        doiInput.setAttribute('placeholder', '10.xxxx/xxxxx');
        doiInput.addEventListener('input', () => { it.doi = doiInput.value.trim(); });
        const doiBtnWrap = f.createDiv({ cls: 'lib-field' });
        const doiBtn = el('button', 'lib-btn', '按 DOI 抓取元数据');
        doiBtn.addEventListener('click', async () => { await this.plugin.applyDoiMeta(it); this.build(); });
        doiBtnWrap.appendChild(doiBtn);

        const catInput = formField(f, '分类', 'text', it.category || '');
        catInput.addEventListener('input', () => { it.category = catInput.value.trim() || '未分类'; });

        const tagInput = formField(f, '标签', 'text', (it.tags || []).join(', '));
        tagInput.setAttribute('placeholder', '多个标签用逗号分隔');
        tagInput.addEventListener('input', () => { it.tags = tagInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); });

        const fmtSel = formField(f, '格式', 'select', '');
        for (const x of FORMATS) { const o = el('option', null, x); o.value = x; fmtSel.appendChild(o); }
        fmtSel.value = it.format || '其他';
        fmtSel.addEventListener('change', () => { it.format = fmtSel.value; });

        const progInput = formField(f, '阅读进度（%）', 'text', it.progress ? String(Math.round(it.progress)) : '');
        progInput.setAttribute('placeholder', '0–100，15% 已读，100% 读完');
        progInput.addEventListener('input', () => {
            const n = parseInt(progInput.value, 10);
            it.progress = isNaN(n) ? 0 : Math.min(100, Math.max(0, n));
            it.status = statusOf(it);
        });
        f.createDiv({ cls: 'lib-field-hint', text: '当前状态：' + statusOf(it) });

        // 评分（星级）
        const ratingRow = f.createDiv({ cls: 'lib-field' });
        ratingRow.createDiv({ cls: 'lib-field-label', text: '评分' });
        const starWrap = ratingRow.createDiv({ cls: 'lib-stars-input' });
        const renderStars = () => {
            starWrap.empty();
            for (let i = 1; i <= 5; i++) {
                const s = el('span', 'lib-star' + (i <= it.rating ? ' is-on' : ''), i <= it.rating ? '★' : '☆');
                s.addEventListener('click', () => { it.rating = i === it.rating ? 0 : i; renderStars(); });
                starWrap.appendChild(s);
            }
        };
        renderStars();

        const notesArea = formField(f, '备注 / 摘要', 'textarea', it.notes || '');
        notesArea.rows = 4;
        notesArea.addEventListener('input', () => { it.notes = notesArea.value; });

        const summaryArea = formField(f, '简介', 'textarea', it.summary || '');
        summaryArea.rows = 4;
        summaryArea.addEventListener('input', () => { it.summary = summaryArea.value; });

        const scoreInput = formField(f, '豆瓣评分', 'text', it.score != null ? String(it.score) : '');
        scoreInput.setAttribute('placeholder', '0–10');
        scoreInput.addEventListener('input', () => { const n = parseFloat(scoreInput.value); it.score = isNaN(n) ? null : n; });

        const coverInput = formField(f, '封面路径', 'text', it.cover || '');
        coverInput.addEventListener('input', () => { it.cover = coverInput.value.trim(); });

        const fileInput = formField(f, '文件路径', 'text', it.file || '');
        fileInput.addEventListener('input', () => { it.file = fileInput.value.trim(); });

        // 按钮
        const btns = contentEl.createDiv({ cls: 'lib-modal-btns' });
        const save = btns.createEl('button', { text: '保存', cls: 'mod-cta' });
        save.addEventListener('click', async () => {
            if (!it.title.trim()) { new Notice('请填写标题'); return; }
            if (this.isNew) this.plugin.index.items.push(it);
            await this.plugin.saveItem(it);
            new Notice('已保存');
            this.plugin.refreshViews();
            if (this.onChanged) this.onChanged();
            this.close();
        });
        const cancel = btns.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());

        // 危险区
        if (!this.isNew) {
            const danger = contentEl.createDiv({ cls: 'lib-danger' });
            const rmv = danger.createEl('button', { text: '从库中移除', cls: 'lib-btn lib-btn-danger' });
            rmv.addEventListener('click', async () => {
                if (!confirm('确定从库中移除该条目？（不会删除文件）')) return;
                await this.plugin.removeItem(it.id, false);
                new Notice('已移除');
                this.plugin.refreshViews();
                if (this.onChanged) this.onChanged();
                this.close();
            });
            const del = danger.createEl('button', { text: '移除并删除文件', cls: 'lib-btn lib-btn-danger' });
            del.addEventListener('click', async () => {
                if (!confirm('确定移除条目并删除库内文件？此操作不可撤销！')) return;
                await this.plugin.removeItem(it.id, true);
                new Notice('已删除');
                this.plugin.refreshViews();
                if (this.onChanged) this.onChanged();
                this.close();
            });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =====================================================================
// BibTeX 导入弹窗
// =====================================================================
class BibtexModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('lib-modal');
        contentEl.createEl('h3', { text: '导入 BibTeX' });
        contentEl.createEl('p', { cls: 'lib-modal-desc', text: '粘贴一个或多个 BibTeX 条目（@article / @book / @inproceedings …），会自动解析出标题、作者、年份、期刊并生成条目。' });
        const ta = contentEl.createEl('textarea', { cls: 'lib-textarea' });
        ta.rows = 14;
        ta.placeholder = '@article{key,\n  title = {A Sample Paper},\n  author = {Last, First and Last2, First2},\n  journal = {Journal Name},\n  year = {2024},\n  doi = {10.xxxx/xxxxx}\n}';
        const btns = contentEl.createDiv({ cls: 'lib-modal-btns' });
        const ok = btns.createEl('button', { text: '解析并导入', cls: 'mod-cta' });
        ok.addEventListener('click', async () => {
            const n = await this.plugin.importBibtex(ta.value);
            if (!n) { new Notice('没有解析到 BibTeX 条目'); return; }
            new Notice(`已导入 ${n} 条`);
            this.plugin.refreshViews();
            this.close();
        });
        const cancel = btns.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =====================================================================
// 简单文本输入弹窗
// =====================================================================
class PromptModal extends Modal {
    constructor(app, title, placeholder, onSubmit) {
        super(app);
        this.title = title;
        this.placeholder = placeholder || '';
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('lib-modal');
        contentEl.createEl('h3', { text: this.title });
        const input = contentEl.createEl('input', { type: 'text', cls: 'lib-text-input' });
        input.value = this.placeholder;
        input.setAttribute('placeholder', this.placeholder || '输入内容');
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.ok(); });
        const btns = contentEl.createDiv({ cls: 'lib-modal-btns' });
        const ok = btns.createEl('button', { text: '确定', cls: 'mod-cta' });
        ok.addEventListener('click', () => this.ok());
        const cancel = btns.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.close());
        this.input = input;
    }

    ok() {
        const v = this.input ? this.input.value.trim() : '';
        this.close();
        if (this.onSubmit) this.onSubmit(v);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =====================================================================
// 引用选择器（插入引用）
// =====================================================================
class CitationModal extends FuzzySuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    getItems() {
        return this.plugin.index.items;
    }

    getItemText(item) {
        const au = (item.authors && item.authors[0]) || '';
        return `${item.title}　·　${au} ${item.year || ''}　·　${TYPE_LABEL[item.type] || item.type}`;
    }

    onChooseItem(item) {
        const editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
        if (editor) {
            editor.replaceSelection('[@' + item.id + ']');
        } else {
            new Notice('请先打开一个笔记');
        }
    }
}

// =====================================================================
// 豆瓣搜索弹窗
// =====================================================================
class DoubanModal extends Modal {
    constructor(app, plugin, item, onApplied) {
        super(app);
        this.plugin = plugin;
        this.item = item;
        this.onApplied = onApplied;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('lib-modal');
        contentEl.createEl('h3', { text: '豆瓣搜索' });

        const qRow = contentEl.createDiv({ cls: 'lib-douban-query' });
        const input = qRow.createEl('input', { type: 'text', cls: 'lib-text-input' });
        input.value = cleanSearchTitle(this.item.title);
        input.setAttribute('placeholder', '输入书名');
        const searchBtn = qRow.createEl('button', { text: '搜索', cls: 'mod-cta' });
        const list = contentEl.createDiv({ cls: 'lib-douban-list' });

        const doSearch = async () => {
            const q = input.value.trim();
            if (!q) { new Notice('请输入书名'); return; }
            list.empty();
            list.createDiv({ cls: 'lib-douban-loading', text: '正在搜索豆瓣…' });
            const results = await this.plugin.searchDouban(q);
            list.empty();
            if (!results.length) {
                list.createDiv({ cls: 'lib-douban-empty', text: '豆瓣没搜到，可换个关键词，或用「AI 补全」生成简介。' });
                return;
            }
            for (const r of results) {
                const row = list.createDiv({ cls: 'lib-douban-item' });
                const info = row.createDiv({ cls: 'lib-douban-info' });
                info.createDiv({ cls: 'lib-douban-title', text: r.title });
                const sub = [r.authors.join('、'), r.year, r.publisher].filter(Boolean).join(' · ');
                info.createDiv({ cls: 'lib-douban-meta', text: sub || '—' });
                const apply = row.createEl('button', { text: '采用', cls: 'lib-btn lib-btn-primary' });
                apply.addEventListener('click', async () => {
                    await this.plugin.applyDoubanResult(this.item, r);
                    new Notice('已采用豆瓣元数据');
                    this.close();
                    if (this.onApplied) this.onApplied();
                });
                list.appendChild(row);
            }
        };
        searchBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
        if (this.item.title) setTimeout(doSearch, 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =====================================================================
// 设置
// =====================================================================
class LibrarySettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '资料库设置' });
        let folderDraft = this.plugin.settings.libraryFolder;
        let folderInput;
        new Setting(containerEl)
            .setName('资料库文件夹')
            .setDesc('填写库内相对路径，点击「保存位置」后生效。索引会保存到新目录，已有资料仍可打开。')
            .addText((t) => {
                folderInput = t;
                t.setValue(folderDraft).onChange((v) => { folderDraft = v; });
            })
            .addButton((button) => button.setButtonText('保存位置').onClick(async () => {
                const raw = folderDraft.trim().replace(/\\/g, '/') || '资源库';
                if (raw.startsWith('/') || raw.includes(':') || raw.split('/').includes('..')) {
                    new Notice('请输入资料库内的相对文件夹路径');
                    return;
                }
                const next = normalizePath(raw);
                const old = this.plugin.settings.libraryFolder;
                if (old === next) { new Notice('资料库位置未改变'); return; }
                button.setDisabled(true);
                this.plugin.settings.libraryFolder = next;
                try {
                    await this.plugin.saveIndex();
                    await this.plugin.saveSettings();
                    folderDraft = next;
                    folderInput.setValue(next);
                    this.plugin.refreshViews();
                    new Notice('资料库位置已保存');
                } catch (error) {
                    this.plugin.settings.libraryFolder = old;
                    new Notice('位置保存失败，请检查文件夹权限后重试');
                } finally {
                    button.setDisabled(false);
                }
            }));

        containerEl.createEl('h3', { text: 'AI 补全（DeepSeek）' });

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('填写服务提供方的密钥，输入内容默认隐藏。')
            .addText((t) => {
                t.inputEl.type = 'password';
                t.inputEl.autocomplete = 'off';
                t.inputEl.setAttribute('aria-label', 'API Key');
                t.setValue(this.plugin.settings.aiApiKey || '').onChange(async (v) => {
                    this.plugin.settings.aiApiKey = v.trim();
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('接口地址')
            .setDesc('默认 DeepSeek；也兼容其它 OpenAI 格式接口（如 OpenAI / Kimi / 本地 Ollama）。')
            .addText((t) => t.setValue(this.plugin.settings.aiBaseUrl || '').onChange(async (v) => {
                this.plugin.settings.aiBaseUrl = v.trim() || 'https://api.deepseek.com/v1';
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('模型')
            .setDesc('默认 deepseek-chat。')
            .addText((t) => t.setValue(this.plugin.settings.aiModel || '').onChange(async (v) => {
                this.plugin.settings.aiModel = v.trim() || 'deepseek-chat';
                await this.plugin.saveSettings();
            }));
    }
}
