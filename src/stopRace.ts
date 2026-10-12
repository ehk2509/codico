/**
 * Lets Stop end a tool call that cannot be interrupted itself (a page load, a web
 * request, a workspace search). The work is left to finish or time out by itself; the
 * turn does not wait for it.
 */
export function untilStopped(work: Promise<string>, signal: AbortSignal, stopped: () => string): Promise<string> {
    if (signal.aborted) {
        work.catch(() => undefined);
        return Promise.resolve(stopped());
    }
    return new Promise<string>((resolve, reject) => {
        const onAbort = () => {
            // Whatever the abandoned work does later, nobody is waiting for it
            work.catch(() => undefined);
            resolve(stopped());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}
