const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'code.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function loadFunction(functionName, context = {}) {
    let start = scriptSource.indexOf(`function ${functionName}`);
    assert.notEqual(start, -1, `${functionName} should exist`);
    if (scriptSource.slice(start - 6, start) === 'async ') {
        start -= 6;
    }

    const openBrace = scriptSource.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < scriptSource.length; i++) {
        if (scriptSource[i] === '{') depth++;
        if (scriptSource[i] === '}') depth--;
        if (depth === 0) {
            return vm.runInNewContext(`(${scriptSource.slice(start, i + 1)})`, context);
        }
    }

    throw new Error(`Could not extract ${functionName}`);
}

class FakeElement {
    constructor(tagName, attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.attributes = { ...attributes };
        this.children = [];
        this.style = {};
        this.textContent = '';
        this.innerHTML = '';
        this.parentNode = null;
        this.classList = {
            add() {},
            remove() {},
            toggle() {}
        };
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    querySelector() {
        return null;
    }

    querySelectorAll() {
        return [];
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    getAttribute(name) {
        return this.attributes[name] || null;
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
}

class FakeDocument {
    constructor(selectorMatches = [], htmlLang = 'en') {
        this.selectorMatches = new Set(selectorMatches);
        this.body = new FakeElement('body');
        this.head = new FakeElement('head');
        this.documentElement = new FakeElement('html', { lang: htmlLang });
    }

    createElement(tagName) {
        return new FakeElement(tagName);
    }

    getElementById(id) {
        return this.findById(this.body, id) || this.findById(this.head, id);
    }

    findById(element, id) {
        if (element.attributes.id === id || element.id === id) return element;
        for (const child of element.children) {
            const match = this.findById(child, id);
            if (match) return match;
        }
        return null;
    }

    querySelector(selector) {
        return this.selectorMatches.has(selector) ? new FakeElement('div') : null;
    }

    querySelectorAll() {
        return [];
    }
}

class FakeStorage {
    constructor() {
        this.values = new Map();
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

function runScript(selectorMatches = [], options = {}) {
    const document = new FakeDocument(selectorMatches, options.htmlLang || 'en');
    const intervals = [];
    const timeouts = [];
    const location = {
        href: 'https://www.vinted.nl/catalog',
        hostname: 'www.vinted.nl',
        pathname: '/catalog',
        search: ''
    };
    const window = {
        location,
        sessionStorage: new FakeStorage(),
        localStorage: new FakeStorage()
    };

    const context = {
        Blob: function Blob() {},
        FileReader: function FileReader() {},
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        URLSearchParams,
        alert() {},
        confirm: () => true,
        console: {
            error() {},
            log() {},
            warn() {}
        },
        document,
        fetch: async () => ({ ok: false, status: 403 }),
        localStorage: window.localStorage,
        location,
        MutationObserver: class {
            observe() {}
        },
        prompt: () => '',
        sessionStorage: window.sessionStorage,
        setInterval: (fn, delay) => {
            intervals.push({ fn, delay });
            return intervals.length;
        },
        clearInterval() {},
        setTimeout: (fn, delay) => {
            timeouts.push({ fn, delay });
            return timeouts.length;
        },
        window
    };
    context.window.window = window;
    context.window.document = document;

    vm.runInNewContext(scriptSource, context, { filename: scriptPath });

    return { document, intervals, timeouts };
}

function bodyText(document) {
    return document.body.children.map(child => child.textContent).join('\n');
}

test('keeps booting while modern Vinted header state is still unknown', () => {
    const { document, intervals } = runScript();

    assert.doesNotMatch(bodyText(document), /must be logged in/i);
    assert.ok(intervals.length >= 4);
});

test('shows the login warning when the current Vinted login button is present', () => {
    const { document, intervals } = runScript(['[data-testid="header--login-button"]']);

    assert.match(bodyText(document), /must be logged in/i);
    assert.equal(intervals.length, 0);
});

test('does not block current localized Vinted pages behind the old English-only guard', () => {
    const { document, intervals } = runScript(['figure.header-avatar'], { htmlLang: 'nl' });
    const warning = document.createElement('div');
    warning.id = 'vinted-language-warning';
    document.body.appendChild(warning);

    intervals.at(-1).fn();

    assert.notEqual(warning.style.display, 'block');
});

test('normalizes localized country names returned by current Vinted locales', () => {
    const normalizeCountryName = loadFunction('normalizeCountryName');

    assert.equal(normalizeCountryName('Nederland'), 'netherlands');
    assert.equal(normalizeCountryName('België / Belgique'), 'belgium');
    assert.equal(normalizeCountryName('Deutschland'), 'germany');
    assert.equal(normalizeCountryName('España'), 'spain');
});

test('pauses on captcha without opening an automatic popup from the main tab', async () => {
    let popupOpenCount = 0;
    const warning = { style: { display: 'none' } };
    const item = {
        id: '123',
        element: new FakeElement('div'),
        overlay: new FakeElement('div'),
        country: '',
        seller: ''
    };
    const context = {
        applyFilter() {},
        console: {
            error() {},
            log() {},
            warn() {}
        },
        countryToFlag: {},
        document: {
            getElementById: id => id === 'vinted-captcha-warning' ? warning : null
        },
        englishCheckComplete: true,
        fetch: async () => ({ status: 403, ok: false }),
        getCachedItem: () => null,
        isFilterEnabled: true,
        isPaused: false,
        isPausedForCaptcha: false,
        isProcessing: false,
        isWaitingForEnglish: false,
        location: { hostname: 'www.vinted.pt' },
        isApiAccessBlocked: async () => true,
        normalizeCountryName: value => String(value).toLowerCase(),
        openCaptchaPopup: () => {
            popupOpenCount++;
            return true;
        },
        queue: [item],
        setCachedItem() {},
        setTimeout() {},
        startCaptchaCheck() {},
        updateStatusMessage() {},
        updateQueueStatus() {},
        updateSellerFlagBadge() {}
    };
    const processQueue = loadFunction('processQueue', context);

    await processQueue();

    assert.equal(context.isPausedForCaptcha, true);
    assert.equal(warning.style.display, 'block');
    assert.equal(context.queue[0], item);
    assert.equal(popupOpenCount, 0);
});

test('skips a single forbidden item when the API probe is healthy', async () => {
    const warning = { style: { display: 'none' } };
    const item = {
        id: '456',
        element: new FakeElement('div'),
        overlay: new FakeElement('div'),
        country: '',
        seller: ''
    };
    let queueStatusUpdates = 0;
    let timeoutCallback;
    const context = {
        applyFilter() {},
        console: {
            error() {},
            log() {},
            warn() {}
        },
        countryToFlag: {},
        document: {
            getElementById: id => id === 'vinted-captcha-warning' ? warning : null
        },
        englishCheckComplete: true,
        fetch: async () => ({ status: 403, ok: false }),
        getCachedItem: () => null,
        isApiAccessBlocked: async () => false,
        isFilterEnabled: true,
        isPaused: false,
        isPausedForCaptcha: false,
        isProcessing: false,
        isWaitingForEnglish: false,
        location: { hostname: 'www.vinted.pt' },
        markItemUnavailable(itemData) {
            itemData.overlay.textContent = '⚠️ Unavailable';
        },
        normalizeCountryName: value => String(value).toLowerCase(),
        openCaptchaPopup: () => {
            throw new Error('popup should not open');
        },
        queue: [item],
        setCachedItem() {},
        setTimeout(callback) {
            timeoutCallback = callback;
        },
        startCaptchaCheck() {
            throw new Error('captcha polling should not start');
        },
        updateStatusMessage() {},
        updateQueueStatus() {
            queueStatusUpdates++;
        },
        updateSellerFlagBadge() {}
    };
    const processQueue = loadFunction('processQueue', context);

    await processQueue();
    if (timeoutCallback) timeoutCallback();

    assert.equal(context.isPausedForCaptcha, false);
    assert.equal(warning.style.display, 'none');
    assert.equal(context.queue.length, 0);
    assert.match(item.overlay.textContent, /Unavailable/);
    assert.equal(context.isProcessing, false);
    assert.equal(queueStatusUpdates, 1);
});

test('requests item details with credentials for userscript manager sandboxes', async () => {
    const item = {
        id: '789',
        element: new FakeElement('div'),
        overlay: new FakeElement('div'),
        country: '',
        seller: ''
    };
    const fetchCalls = [];
    const context = {
        applyFilter() {},
        console: {
            error() {},
            log() {},
            warn() {}
        },
        countryToFlag: {
            portugal: '🇵🇹'
        },
        document: {
            getElementById: () => null
        },
        englishCheckComplete: true,
        fetch: async (url, options) => {
            fetchCalls.push({ url, options });
            return {
                status: 200,
                ok: true,
                json: async () => ({
                    item: {
                        user: {
                            country_title_local: 'Portugal',
                            city: 'Lisboa',
                            login: 'seller-one'
                        }
                    }
                })
            };
        },
        getCachedItem: () => null,
        isApiAccessBlocked: async () => false,
        isFilterEnabled: true,
        isPaused: false,
        isPausedForCaptcha: false,
        isProcessing: false,
        isWaitingForEnglish: false,
        location: { hostname: 'www.vinted.pt' },
        normalizeCountryName: value => String(value).toLowerCase(),
        queue: [item],
        setCachedItem() {},
        setTimeout(callback) {
            callback();
        },
        startCaptchaCheck() {},
        updateStatusMessage() {},
        updateQueueStatus() {},
        updateSellerFlagBadge() {}
    };
    const processQueue = loadFunction('processQueue', context);

    await processQueue();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://www.vinted.pt/api/v2/items/789/details');
    assert.equal(fetchCalls[0].options.credentials, 'include');
    assert.match(fetchCalls[0].options.headers.Accept, /application\/json/);
    assert.match(item.overlay.textContent, /Portugal, Lisboa/);
    assert.equal(item.country, 'portugal');
});
