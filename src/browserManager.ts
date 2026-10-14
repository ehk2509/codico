import * as fs from 'fs';
// Types only: playwright-core takes ~0.5 s to load, so it is loaded on first browser use
// rather than at extension activation.
import type { Browser, Page } from 'playwright-core';
import { assertBrowserRequestAllowed } from './browserNetworkPolicy';

const CHROME_PATHS = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** What browser_expect checks on the page. */
export interface Expectation {
    /** A CSS selector; the whole page when absent. */
    selector?: string;
    /** Text that must be in the element (or the page). */
    text?: string;
    /** For a selector: it is visible, hidden, there at all, or absent. Default: visible, or contains the text. */
    state?: 'visible' | 'hidden' | 'exists' | 'absent';
    timeoutMs?: number;
}

export class BrowserManager {
    private _browser: Browser | null = null;
    private _page: Page | null = null;
    private _allowPrivateNetwork = false;
    /** Apps Codico started on this machine: reachable although the private network is not. */
    private readonly _allowedOrigins = new Set<string>();
    /** Console errors, page errors and failed requests not yet reported. */
    private _errors: string[] = [];
    /** Told of every error as it happens (the acceptance evidence). */
    onError?: (text: string) => void;

    setAllowPrivateNetwork(allow: boolean): void {
        this._allowPrivateNetwork = allow;
    }

    allowOrigin(origin: string): void { this._allowedOrigins.add(origin); }
    isAllowedOrigin(rawUrl: string): boolean { try { return this._allowedOrigins.has(new URL(rawUrl).origin); } catch { return false; } }

    private async _assertRequestAllowed(rawUrl: string): Promise<void> {
        if (this.isAllowedOrigin(rawUrl)) { return; }
        await assertBrowserRequestAllowed(rawUrl, this._allowPrivateNetwork);
    }

    /** The errors seen since the last call. */
    takeErrors(): string[] { const errors = this._errors; this._errors = []; return errors; }

    private _error(text: string): void {
        const line = text.replace(/\s+/g, ' ').trim().slice(0, 500);
        if (this._errors.length < 50) { this._errors.push(line); }
        this.onError?.(line);
    }

    private _watch(page: Page): void {
        page.on('console', message => { if (message.type() === 'error') { this._error(`console: ${message.text()}`); } });
        page.on('pageerror', error => this._error(`page error: ${error.message}`));
        page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') { this._error(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'failed'})`); } });
        page.on('response', response => { if (response.status() >= 500) { this._error(`server error: ${response.status()} ${response.request().method()} ${response.url()}`); } });
    }

    private async _installNetworkPolicy(page: Page): Promise<void> {
        await page.route('**/*', async route => {
            try {
                await this._assertRequestAllowed(route.request().url());
                await route.continue();
            } catch {
                await route.abort('blockedbyclient');
            }
        });
        // WebSockets bypass page.route: without this a page could reach local services over ws://
        await page.routeWebSocket(/.*/, async ws => {
            try {
                await this._assertRequestAllowed(ws.url().replace(/^ws/, 'http'));
                ws.connectToServer();
            } catch {
                await ws.close({ code: 1008, reason: 'Blocked by Codico network policy' });
            }
        });
    }

    private _findChrome(): string | undefined {
        return CHROME_PATHS.find(p => {
            try { fs.accessSync(p); return true; } catch { return false; }
        });
    }

    async ensurePage(): Promise<Page> {
        if (!this._browser || !this._browser.isConnected()) {
            const executablePath = this._findChrome();
            if (!executablePath) {
                throw new Error(
                    'No Chrome/Chromium found. Install Google Chrome or Chromium and try again.\n' +
                    'Checked paths: ' + CHROME_PATHS.join(', ')
                );
            }
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { chromium } = require('playwright-core') as typeof import('playwright-core');
            this._browser = await chromium.launch({
                executablePath,
                headless: false, // visible so user can watch the browser
            });
        }
        if (!this._page || this._page.isClosed()) {
            this._page = await this._browser.newPage();
            this._watch(this._page);
            await this._installNetworkPolicy(this._page);
        }
        return this._page;
    }

    async navigate(url: string): Promise<{ text: string; title: string; currentUrl: string }> {
        await this._assertRequestAllowed(url);
        const page = await this.ensurePage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return {
            text: `Navigated to ${page.url()}`,
            title: await page.title(),
            currentUrl: page.url(),
        };
    }

    async click(selector: string): Promise<string> {
        const page = await this.ensurePage();
        await page.click(selector, { timeout: 10_000 });
        await page.waitForLoadState('domcontentloaded').catch(() => null);
        return `Clicked "${selector}". Current URL: ${page.url()}`;
    }

    async typeText(selector: string, text: string, submit: boolean): Promise<string> {
        const page = await this.ensurePage();
        await page.fill(selector, text);
        if (submit) { await page.press(selector, 'Enter'); }
        return `Typed "${text}" into "${selector}"${submit ? ' and submitted' : ''}.`;
    }

    async getText(selector?: string): Promise<string> {
        const page = await this.ensurePage();
        if (selector) {
            const el = await page.$(selector);
            if (!el) { return `No element found for selector: ${selector}`; }
            return (await el.textContent()) ?? '';
        }
        // Full visible text — use innerText via string eval to avoid TS DOM type issues
        const text = await page.evaluate('document.body.innerText') as string;
        return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20_000);
    }

    /**
     * Checks the page, waiting up to the timeout for the condition to hold (pages update after
     * a click). The result is Codico's own observation, for the acceptance evidence.
     */
    async expect(expectation: Expectation): Promise<{ passed: boolean; detail: string }> {
        const page = await this.ensurePage();
        const timeout = Math.max(500, Math.min(30_000, expectation.timeoutMs ?? 5000));
        const { selector, text } = expectation;
        const state = expectation.state ?? (text ? undefined : 'visible');
        const until = Date.now() + timeout;
        let last = '';
        for (;;) {
            try {
                const result = await this._check(page, selector, text, state);
                if (result.passed) { return result; }
                last = result.detail;
            } catch (error) { last = error instanceof Error ? error.message.split('\n')[0] : String(error); }
            if (Date.now() >= until) { return { passed: false, detail: `${last} (waited ${timeout} ms)` }; }
            await page.waitForTimeout(250);
        }
    }

    private async _check(page: Page, selector: string | undefined, text: string | undefined, state: Expectation['state']): Promise<{ passed: boolean; detail: string }> {
        if (!selector) {
            const body = await page.evaluate('document.body ? document.body.innerText : ""') as string;
            return body.includes(text ?? '') ? { passed: true, detail: 'the page shows the text' } : { passed: false, detail: 'the page does not show the text' };
        }
        const element = await page.$(selector);
        if (state === 'absent') { return element ? { passed: false, detail: 'the element is there' } : { passed: true, detail: 'no such element' }; }
        if (!element) { return { passed: false, detail: 'no element matches the selector' }; }
        if (state === 'exists') { return { passed: true, detail: 'the element is there' }; }
        const visible = await element.isVisible();
        if (state === 'hidden') { return visible ? { passed: false, detail: 'the element is visible' } : { passed: true, detail: 'the element is hidden' }; }
        if (!visible) { return { passed: false, detail: 'the element is not visible' }; }
        if (text === undefined) { return { passed: true, detail: 'the element is visible' }; }
        const content = ((await element.innerText().catch(() => null)) ?? (await element.textContent()) ?? '').replace(/\s+/g, ' ').trim();
        const value = await element.inputValue().catch(() => undefined);
        if (content.includes(text) || value?.includes(text)) { return { passed: true, detail: `the element shows "${(value?.includes(text) ? value : content).slice(0, 120)}"` }; }
        return { passed: false, detail: `the element shows "${(content || value || '').slice(0, 120)}"` };
    }

    async screenshot(): Promise<Buffer> {
        const page = await this.ensurePage();
        return page.screenshot({ type: 'png', fullPage: false });
    }

    async close(): Promise<void> {
        if (this._browser) {
            await this._browser.close();
            this._browser = null;
            this._page = null;
        }
    }

    get isOpen(): boolean {
        return !!(this._browser?.isConnected());
    }

    get currentUrl(): string {
        return this._page?.url() ?? '';
    }
}
