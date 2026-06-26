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

function loadAccessBlockDetector() {
    return loadFunction('isAccessBlockResponse', {
        getResponseHeader: loadFunction('getResponseHeader'),
        getResponseText: loadFunction('getResponseText')
    });
}

function loadApiAccessBlocked() {
    return loadFunction('isApiAccessBlocked', {
        console: {
            warn() {}
        },
        fetch: async () => {
            throw new Error('legacy probe should not run when a response is supplied');
        },
        isAccessBlockResponse: loadAccessBlockDetector(),
        location: { hostname: 'www.vinted.pt' }
    });
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

test('detects Cloudflare challenge responses as API access blocks', async () => {
    const isAccessBlockResponse = loadAccessBlockDetector();
    const response = {
        status: 403,
        headers: {
            get(name) {
                return name.toLowerCase() === 'cf-mitigated' ? 'challenge' : null;
            }
        }
    };

    assert.equal(await isAccessBlockResponse(response), true);
});

test('does not treat plain forbidden item JSON as an API access block', async () => {
    const isAccessBlockResponse = loadAccessBlockDetector();
    const response = {
        status: 403,
        headers: {
            get(name) {
                return name.toLowerCase() === 'content-type' ? 'application/json' : null;
            }
        },
        clone() {
            return this;
        },
        text: async () => JSON.stringify({ message_code: 'forbidden' })
    };

    assert.equal(await isAccessBlockResponse(response), false);
});

test('checks the blocked item endpoint when polling for restored API access', async () => {
    let intervalCallback;
    let fetchedUrl = '';
    let solved = false;
    const context = {
        API_RECOVERY_RETRY_DELAYS: [5000, 15000, 30000, 60000],
        captchaCheckInterval: null,
        captchaProbeIndex: 0,
        captchaProbeItemIds: [],
        captchaRetryAttempt: 0,
        clearCaptchaCheckTimer() {},
        collectApiProbeItemIds: itemId => [String(itemId)],
        console: {
            log() {}
        },
        fetch: async url => {
            fetchedUrl = url;
            return { status: 200, ok: true };
        },
        isAccessBlockResponse: async () => false,
        location: { hostname: 'www.vinted.pt' },
        onCaptchaSolved() {
            solved = true;
        },
        setTimeout(callback) {
            intervalCallback = callback;
            return 1;
        },
        updateStatusMessage() {}
    };
    const startCaptchaCheck = loadFunction('startCaptchaCheck', context);

    startCaptchaCheck('9257941938');
    await intervalCallback();

    assert.equal(fetchedUrl, 'https://www.vinted.pt/api/v2/items/9257941938/details');
    assert.equal(solved, true);
});

test('rotates real item endpoints with backoff while polling for restored API access', async () => {
    const scheduled = [];
    const fetchedUrls = [];
    let solved = false;
    const challengeResponse = {
        status: 403,
        headers: {
            get(name) {
                return name.toLowerCase() === 'cf-mitigated' ? 'challenge' : null;
            }
        }
    };
    const healthyResponse = { status: 200, ok: true };
    const context = {
        API_RECOVERY_RETRY_DELAYS: [5000, 15000, 30000, 60000],
        captchaCheckInterval: null,
        captchaProbeIndex: 0,
        captchaProbeItemIds: [],
        captchaRetryAttempt: 0,
        clearCaptchaCheckTimer() {},
        clearTimeout() {},
        collectApiProbeItemIds: loadFunction('collectApiProbeItemIds', {
            addUniqueProbeItemId: loadFunction('addUniqueProbeItemId'),
            processedItems: new Map([
                ['333', { id: '333' }]
            ]),
            queue: [
                { id: '222' },
                { id: '333' }
            ]
        }),
        console: {
            log() {}
        },
        fetch: async url => {
            fetchedUrls.push(url);
            return fetchedUrls.length === 1 ? challengeResponse : healthyResponse;
        },
        isAccessBlockResponse: loadAccessBlockDetector(),
        location: { hostname: 'www.vinted.pt' },
        onCaptchaSolved() {
            solved = true;
        },
        setTimeout(callback, delay) {
            scheduled.push({ callback, delay });
            return scheduled.length;
        },
        updateStatusMessage() {}
    };
    const startCaptchaCheck = loadFunction('startCaptchaCheck', context);

    startCaptchaCheck('111');

    assert.equal(scheduled[0].delay, 5000);
    await scheduled[0].callback();
    assert.equal(fetchedUrls[0], 'https://www.vinted.pt/api/v2/items/111/details');
    assert.equal(solved, false);
    assert.equal(scheduled[1].delay, 15000);

    await scheduled[1].callback();

    assert.equal(fetchedUrls[1], 'https://www.vinted.pt/api/v2/items/222/details');
    assert.equal(solved, true);
});

test('manual API retry clears the paused state and starts an immediate real-item probe', () => {
    const warning = { style: { display: 'block' } };
    let statusMessage = '';
    let probeStarted = null;
    let processQueued = false;
    const context = {
        captchaCheckInterval: 42,
        captchaProbeItemIds: ['9257941938'],
        clearCaptchaCheckTimer() {},
        clearTimeout() {},
        collectApiProbeItemIds: () => ['9257941938'],
        document: {
            getElementById: id => id === 'vinted-captcha-warning' ? warning : null
        },
        isPausedForCaptcha: true,
        processQueue() {
            processQueued = true;
        },
        setTimeout(callback) {
            callback();
        },
        startCaptchaCheck(itemId, immediate) {
            probeStarted = { itemId, immediate };
        },
        updateStatusMessage(message) {
            statusMessage = message;
        }
    };
    const retryApiAccessNow = loadFunction('retryApiAccessNow', context);

    retryApiAccessNow();

    assert.equal(context.isPausedForCaptcha, false);
    assert.equal(warning.style.display, 'none');
    assert.match(statusMessage, /Retrying API access/i);
    assert.deepEqual(probeStarted, { itemId: '9257941938', immediate: true });
    assert.equal(processQueued, true);
});

test('pauses on captcha without opening an automatic popup from the main tab', async () => {
    let popupOpenCount = 0;
    const warning = { style: { display: 'none' } };
    const challengeResponse = {
        status: 403,
        ok: false,
        headers: {
            get(name) {
                return name.toLowerCase() === 'cf-mitigated' ? 'challenge' : null;
            }
        }
    };
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
        fetch: async () => challengeResponse,
        getCachedItem: () => null,
        isApiAccessBlocked: loadApiAccessBlocked(),
        isFilterEnabled: true,
        isPaused: false,
        isPausedForCaptcha: false,
        isProcessing: false,
        isWaitingForEnglish: false,
        location: { hostname: 'www.vinted.pt' },
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

test('skips a single forbidden item even when the legacy probe endpoint returns 403', async () => {
    const warning = { style: { display: 'none' } };
    const apiAccessBlocked = loadApiAccessBlocked();
    const item = {
        id: '654',
        element: new FakeElement('div'),
        overlay: new FakeElement('div'),
        country: '',
        seller: ''
    };
    let queueStatusUpdates = 0;
    let timeoutCallback;
    const forbiddenResponse = {
        status: 403,
        ok: false,
        headers: {
            get(name) {
                return name.toLowerCase() === 'content-type' ? 'application/json' : null;
            }
        },
        clone() {
            return this;
        },
        text: async () => JSON.stringify({ message_code: 'forbidden' })
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
        fetch: async () => forbiddenResponse,
        getCachedItem: () => null,
        isApiAccessBlocked: async response => {
            assert.ok(response, 'current item response should be inspected instead of the legacy probe');
            return apiAccessBlocked(response);
        },
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
