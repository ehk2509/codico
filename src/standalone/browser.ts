/** Optional browser automation for Codico CLI via the installed Chromium/Playwright runtime. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, Browser, Page } from 'playwright-core';
import { wrapUntrusted } from '../untrustedContent';
import type { ToolCall } from '../toolParser';
import type { CliApproval } from './nodeWorkspace';

export class CliBrowser {
    private browser?: Browser;
    private page?: Page;
    constructor(private readonly approve: CliApproval, private readonly executablePath?: string) {}

    private async getPage(): Promise<Page> {
        if (!this.browser) {
            this.browser = await chromium.launch({
                headless: true,
                ...(this.executablePath ? { executablePath: this.executablePath } : {}),
            });
        }
        if (!this.page || this.page.isClosed()) { this.page=await this.browser.newPage({acceptDownloads:false}); }
        return this.page;
    }

    async execute(tool: ToolCall, signal: AbortSignal): Promise<string> {
        if (signal.aborted) { return 'Stopped'; }
        if (tool.type === 'browser_close') {
            await this.close(); return 'Browser closed';
        }
        if (tool.type === 'browser_navigate') {
            const target = new URL(tool.url);
            if (!['http:','https:'].includes(target.protocol) || target.username || target.password) {
                return 'Denied: unsupported or credential-bearing URL';
            }
            if (!await this.approve('command','Navigate browser to '+target.href)) { return 'Denied: browser navigation not approved'; }
            const page = await this.getPage();
            await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30_000});
            return wrapUntrusted('browser '+page.url(),(await page.locator('body').innerText({timeout:10_000})).slice(0,10000));
        }
        const page=await this.getPage();
        if (tool.type === 'browser_click') {
            if (!await this.approve('command','Click browser selector '+tool.selector)) { return 'Denied: browser click not approved'; }
            await page.locator(tool.selector).first().click({timeout:10_000});
            return 'Clicked '+tool.selector;
        }
        if (tool.type === 'browser_type') {
            if (!await this.approve('command','Type text into browser selector '+tool.selector)) { return 'Denied: browser typing not approved'; }
            await page.locator(tool.selector).first().fill(tool.text,{timeout:10_000});
            if (tool.submit) { await page.locator(tool.selector).first().press('Enter'); }
            return 'Typed into '+tool.selector;
        }
        if (tool.type === 'browser_get_text') {
            const text=await (tool.selector ? page.locator(tool.selector).first() : page.locator('body')).innerText({timeout:10_000});
            return wrapUntrusted('browser '+page.url(),text.slice(0,12000));
        }
        if (tool.type === 'browser_screenshot') {
            const dir=path.join(os.tmpdir(),'codico-browser');
            fs.mkdirSync(dir,{recursive:true,mode:0o700});
            const file=path.join(dir,randomUUID()+'.png');
            await page.screenshot({path:file,fullPage:false,timeout:15_000});
            return 'Screenshot saved: '+file+' (visual interpretation is not supported by the text-only CLI)';
        }
        return 'Browser tool unsupported';
    }

    async close(): Promise<void> {
        await this.browser?.close(); this.browser=undefined; this.page=undefined;
    }
}
