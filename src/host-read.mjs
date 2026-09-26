// Read-only SDK calls may ignore AbortSignal. Race the response as well as
// signalling cancellation; never use this wrapper for side effects.
import { AsyncLocalStorage } from 'node:async_hooks';

export function createBoundedHostReader(client) {
  const budget = new AsyncLocalStorage();
  const session = Object.create(client?.session ?? null);
  for (const method of ['get', 'status', 'messages', 'message']) {
    if (typeof client?.session?.[method] !== 'function') continue;
    session[method] = async (input = {}) => {
      const remaining = Math.min(2000, budget.getStore()?.() ?? 2000);
      if (remaining <= 0) throw new Error('Host read deadline exceeded');
      const controller = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      let timer, abort;
      const expired = new Promise((_, reject) => {
        abort = () => reject(new Error('Host read deadline exceeded'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(() => controller.abort(), Math.ceil(remaining));
      });
      try {
        if (signal.aborted) throw new Error('Host read deadline exceeded');
        return await Promise.race([Promise.resolve().then(() => client.session[method]({ ...input, signal })), expired]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    };
  }
  return { client: client ? Object.defineProperty(Object.create(client), 'session', { value: session, enumerable: true }) : client,
    withBudget: (remaining, operation) => budget.run(remaining, operation) };
}
