// Shell-free runner for the system git, used only by the snapshot safety net (WP B3b).
//
// Every call is `spawn(gitBinary, argv[])` — never a shell string — with a sanitised environment:
// inherited GIT_* variables are dropped (a GIT_DIR or GIT_INDEX_FILE leaking in from the gateway's
// own environment would silently point git at the wrong repository or index), prompts are off and
// optional locks are off so read-only commands never rewrite the user's index.
import { spawn } from 'node:child_process';

/** Dutch card text the caller shows when undo is impossible because git is not installed. */
export const GIT_MISSING_MESSAGE_NL = 'Ongedaan maken is niet beschikbaar: git ontbreekt';

/**
 * Typed error for the snapshot module. `code` is the contract callers switch on:
 * GIT_MISSING, GIT_FAILED, INVALID_INPUT, PATH_TOO_LONG, SNAPSHOT_EXISTS, SNAPSHOT_NOT_FOUND,
 * SNAPSHOT_CORRUPT, TOO_MANY_FILES, UNDO_INCOMPLETE.
 */
export class SnapshotError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const DEFAULT_GIT_BINARY = 'git';
let gitBinary = DEFAULT_GIT_BINARY;

/** Test-only: point the runner at another binary (e.g. a missing path to provoke GIT_MISSING). */
export function _setGitBinaryForTests(binary) { gitBinary = binary; }
export function _resetGitBinaryForTests() { gitBinary = DEFAULT_GIT_BINARY; }

// Applied to every call. fsmonitor/untrackedCache off: no user-configured hook process runs and no
// index extension is refreshed. gc.auto=0: a snapshot never starts a garbage collection.
const BASE_CONFIG_ARGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.quotePath=false',
  '-c', 'gc.auto=0',
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
]);

/** Environment for a git child: the parent env minus every GIT_* key, plus `extra`. */
export function gitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return { ...env, ...extra };
}

function spawnFailure(err, label) {
  if (err && err.code === 'ENOENT') {
    return new SnapshotError('GIT_MISSING', GIT_MISSING_MESSAGE_NL, { cause: 'git executable not found' });
  }
  return new SnapshotError('GIT_FAILED', `git ${label} could not start: ${err && err.message}`);
}

/** Write one chunk and wait for 'drain' when the pipe is full (fast-import can take minutes). */
export function writeChunk(stream, chunk) {
  if (stream.destroyed) return Promise.reject(new Error('git closed its input'));
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('git closed its input')); };
    stream.on('drain', onDrain);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

/**
 * Run `git <BASE_CONFIG> <args>`.
 * opts.env       full environment (default gitEnv())
 * opts.input     Buffer|string written to stdin, then stdin is closed
 * opts.writeInput async (stdin) => void — streams stdin itself; the runner closes stdin afterwards
 * opts.onStdout  (chunk) => void — stream stdout instead of buffering it
 * opts.okCodes   exit codes that resolve (default [0])
 * Resolves { code, stdout: Buffer, stderr: string }; rejects with a SnapshotError.
 */
export function runGit(args, opts = {}) {
  const label = opts.label || args.find((a) => !a.startsWith('-')) || 'command';
  const okCodes = opts.okCodes || [0];
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes || DEFAULT_MAX_STDOUT_BYTES;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitBinary, [...BASE_CONFIG_ARGS, ...args], {
        env: opts.env || gitEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(spawnFailure(err, label));
      return;
    }
    const outChunks = [];
    let outBytes = 0;
    const errChunks = [];
    let errBytes = 0;
    let stdinError = null;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (error) => settle(() => {
      child.kill();
      reject(error);
    });
    const timer = setTimeout(() => fail(new SnapshotError('GIT_FAILED', `git ${label} timed out after ${timeoutMs} ms`)), timeoutMs);

    child.on('error', (err) => settle(() => reject(spawnFailure(err, label))));
    // An early git exit closes the pipe (EPIPE). Recorded, and reported by 'close' below when the
    // exit code alone would otherwise look like success.
    child.stdin.on('error', (err) => { stdinError = err; });
    child.stdout.on('data', (chunk) => {
      if (opts.onStdout) {
        try {
          opts.onStdout(chunk);
        } catch (err) {
          fail(err instanceof SnapshotError ? err : new SnapshotError('GIT_FAILED', `git ${label} output handling failed: ${err.message}`));
        }
        return;
      }
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        fail(new SnapshotError('GIT_FAILED', `git ${label} produced more than ${maxStdout} bytes`));
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      errChunks.push(chunk);
      errBytes += chunk.length;
    });
    child.on('close', (code) => settle(() => {
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (!okCodes.includes(code)) {
        reject(new SnapshotError('GIT_FAILED', `git ${label} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`, { exitCode: code, stderr: stderr.slice(0, 2000) }));
        return;
      }
      if (stdinError) {
        reject(new SnapshotError('GIT_FAILED', `git ${label} closed its input early: ${stdinError.message}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(outChunks), stderr });
    }));

    if (opts.writeInput) {
      Promise.resolve()
        .then(() => opts.writeInput(child.stdin))
        .then(() => child.stdin.end())
        .catch((err) => fail(err instanceof SnapshotError ? err : new SnapshotError('GIT_FAILED', `writing to git ${label} failed: ${err.message}`)));
    } else if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Split NUL-terminated git output (`-z`) into strings, dropping the trailing empty element. */
export function splitNul(buffer) {
  const text = buffer.toString('utf8');
  if (text === '') return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Stream blobs out of `git cat-file --batch`. `onBlob(sha, buffer)` runs once per requested sha,
 * in request order; it must not throw for per-file problems (record them instead). A missing or
 * non-blob object fails the whole call with SNAPSHOT_CORRUPT.
 */
export async function readBlobs(prefixArgs, shas, onBlob) {
  if (shas.length === 0) return;
  let header = Buffer.alloc(0);
  let current = null;
  let bodyChunks = [];
  let bodyHave = 0;
  const onStdout = (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (current === null) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) {
          header = Buffer.concat([header, chunk.subarray(offset)]);
          return;
        }
        const line = Buffer.concat([header, chunk.subarray(offset, newline)]).toString('utf8');
        header = Buffer.alloc(0);
        offset = newline + 1;
        const match = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line);
        if (!match || match[2] !== 'blob') {
          throw new SnapshotError('SNAPSHOT_CORRUPT', `snapshot object is missing or not a file: ${line.slice(0, 120)}`);
        }
        current = { sha: match[1], need: Number(match[3]) + 1 };
        bodyChunks = [];
        bodyHave = 0;
      }
      if (current !== null) {
        const take = Math.min(current.need - bodyHave, chunk.length - offset);
        bodyChunks.push(chunk.subarray(offset, offset + take));
        bodyHave += take;
        offset += take;
        if (bodyHave === current.need) {
          const body = Buffer.concat(bodyChunks, current.need).subarray(0, current.need - 1);
          const sha = current.sha;
          current = null;
          bodyChunks = [];
          onBlob(sha, body);
        }
      }
    }
  };
  await runGit([...prefixArgs, 'cat-file', '--batch'], {
    label: 'cat-file',
    input: shas.join('\n') + '\n',
    onStdout,
    timeoutMs: 300_000,
  });
}
