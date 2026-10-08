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

export class BrowserManager {
    private _browser: Browser | null = null;
    private _page: Page | null = null;
    private _allowPrivateNetwork = false;

    setAllowPrivateNetwork(allow: boolean): void {
        this._allowPrivateNetwork = allow;
    }

    private async _assertRequestAllowed(rawUrl: string): Promise<void> {
        await assertBrowserRequestAllowed(rawUrl, this._allowPrivateNetwork);
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
