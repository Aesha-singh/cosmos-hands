#!/usr/bin/env node
/**
 * Compile every GLSL shader pair in headless Chrome.
 *
 *   npm run check:shaders
 *
 * Run this after touching anything in `src/shaders/`. It catches the failures a
 * JS syntax sweep cannot: functions defined twice, uniforms read but never
 * declared, varying type mismatches between stages, and uniform defaults of the
 * wrong type.
 *
 * Chrome is driven headlessly. SwiftShader gives WebGL2 in software, so this
 * needs no display, no GPU, and works in CI.
 *
 * The shader modules import nothing but relative paths, so they are served
 * verbatim — what gets compiled here is exactly what ships to the browser.
 *
 * @module tools/validate-shaders
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** @returns {string} path to a Chrome binary */
function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    console.error('No Chrome/Chromium found. Set CHROME_PATH to a binary and retry.');
    process.exit(2);
  }
  return found;
}

/**
 * Serve the repository over HTTP so the browser will accept its ES modules.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
function serveStatic() {
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
      .replace(/^([/\\])+/, '');
    // Refuse to serve outside the repo.
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT + sep) && file !== ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      res({
        url: `http://127.0.0.1:${port}/tools/shader-lab.html`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Run Chrome and collect its stdout.
 * @param {string[]} args
 * @param {number} timeoutMs
 */
function runChrome(args, timeoutMs = 120000) {
  return new Promise((res, rej) => {
    const proc = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rej(new Error(`Chrome timed out after ${timeoutMs}ms.\n${err.slice(-2000)}`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); rej(e); });
    proc.on('close', () => { clearTimeout(timer); res({ stdout: out, stderr: err }); });
  });
}

async function main() {
  const chrome = process.env.CHROME_PATH || findChrome();
  const site = await serveStatic();
  let exitCode = 0;

  try {
    // No --user-data-dir: pointing Chrome at a brand-new profile makes it run
    // its first-run updater, which stalls --dump-dom indefinitely. The default
    // profile is only read here, never written to.
    const { stdout } = await runChrome([
      chrome,
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--enable-unsafe-swiftshader',
      '--virtual-time-budget=15000',
      '--dump-dom',
      site.url,
    ]);

    const pre = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!pre) {
      console.error('Shader lab produced no output. DOM head:\n');
      console.error(stdout.slice(0, 3000));
      exitCode = 2;
    } else {
      const text = pre[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      console.log(text.trim());

      const verdict = text.match(/RESULT:(\S+)/);
      if (!verdict) {
        console.error('\nNo verdict recorded — the page did not finish.');
        exitCode = 2;
      } else if (verdict[1] !== 'PASS') {
        exitCode = 1;
      }
    }
  } finally {
    await site.close();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(2);
});