import { spawn } from 'node:child_process';

const MAX_OUTPUT = 8192;
const MAX_TIMEOUT = 300000;
const TEARDOWN_MS = 2000;

// Permission checks belong to the caller. No model-reported check is evidence.
export async function runDirectCommand({ command, cwd, timeoutMs = 60000, signal }) {
  const error = (output) => ({ status: 'error', exitCode: null, output, uncertain: false });
  if (typeof command !== 'string' || !command.trim() || command.length > 16000
    || typeof cwd !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) return error('Invalid direct command or timeout');
  if (signal?.aborted) return { status: 'aborted', exitCode: null, output: '', uncertain: false };
  return new Promise((resolve) => {
    let child;
    let timer;
    let teardown;
    let settled = false;
    let stopping;
    let size = 0;
    const chunks = [];
    const append = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const keep = buffer.subarray(0, MAX_OUTPUT - size);
      if (keep.length) { chunks.push(keep); size += keep.length; }
    };
    const finish = (status, exitCode = null, uncertain = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(teardown);
      signal?.removeEventListener('abort', abort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      // A partial UTF-8 character must not expand beyond the byte limit.
      let output = Buffer.concat(chunks).toString('utf8');
      while (Buffer.byteLength(output) > MAX_OUTPUT) output = output.slice(0, -1);
      resolve({ status, exitCode, output, uncertain });
    };
    const stop = (reason) => {
      if (settled || stopping) return;
      stopping = reason;
      // Even a closed shell cannot prove every descendant stopped. Interrupted
      // commands remain uncertain, preventing reuse of their workspace evidence.
      teardown = setTimeout(() => finish(reason, child?.exitCode ?? null, true), TEARDOWN_MS);
      if (!child?.pid) return finish(reason, null, true);
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => finish(reason, child.exitCode, true));
        killer.once('close', () => finish(reason, child.exitCode, true));
        killer.unref();
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const abort = () => stop('aborted');
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (cause) => { append(cause.message); finish(stopping ?? 'error', null, Boolean(stopping)); });
      child.once('close', (code) => {
        if (stopping) {
          if (process.platform !== 'win32') finish(stopping, code, true);
        } else finish(code === 0 ? 'passed' : 'failed', code, code === null);
      });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (cause) { append(cause.message); finish('error'); }
  });
}
