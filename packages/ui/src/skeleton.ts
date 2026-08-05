/**
 * The M0.4 walking skeleton: `GET /api/commits` → a plain list → click shows the
 * message. That exact interaction is the milestone's acceptance criterion (ROADMAP M0
 * deliverable 4), and proving one thread through every layer is the whole point of it.
 *
 * **This is M0-only scaffolding.** M3 replaces it wholesale with the React app, the
 * Part 12 §12.3 design tokens, and the app shell. Nothing here is meant to survive, so
 * it is deliberately plain: no framework, no build step, one string. ROADMAP M0 even
 * permits cutting it down to `JSON.stringify` if the milestone runs late.
 *
 * **Its inline script is a string literal and is therefore not typechecked.** Treat
 * every edit to it as untyped JavaScript, and keep it small enough to read in one
 * sitting — that is the price of a page with no bundler, and it is exactly why M3's
 * replacement is a real module rather than a bigger string.
 *
 * Two behaviours in it are contractual rather than incidental:
 *
 * - **The token is handled invisibly** (LEAN-V1 §2.2). `excavate .` hands the browser
 *   `http://127.0.0.1:<port>/?token=…`; the page stashes the token, strips it from the
 *   address bar with `history.replaceState`, and uses `Authorization: Bearer` for every
 *   later call. A token left in the address bar gets pasted into a bug report, and it
 *   is what `Referrer-Policy: no-referrer` on the daemon side is protecting too.
 * - **Commit text reaches the DOM through `textContent`, never as markup.** Commit
 *   messages are attacker-controlled text in the general case; an XSS in a tool people
 *   point at untrusted repositories is a real bug, not a theoretical one. `textContent`
 *   is the defence rather than an escaping pass, because there is then no interpolation
 *   site left to get wrong.
 * - **An index that is not finished says so.** The page reads `/api/repo/summary` and
 *   prints the index state and any `PartialIndexBadge` above the list. A list of commits
 *   is not self-describing: a truncated history looks exactly like a short one, and
 *   showing it without the badge the daemon supplied would be this product's worst
 *   failure mode (Part 7 §7.7, honest degradation).
 *
 * Route strings come from `ROUTES` in `@excavate/core` rather than being written out
 * here, so the page cannot drift from the daemon's route table.
 */

import { AUTH_SCHEME, ROUTES, TOKEN_QUERY_PARAM } from '@excavate/core';

export interface SkeletonPageConfig {
  /**
   * Prefix for API calls. Empty — the default — means same-origin, which is how the
   * daemon serves the page. Set it when running the page against a daemon on another
   * port (LEAN-V1 §2.2's `vite dev` loop, from M3).
   */
  readonly apiBaseUrl?: string;
  readonly title?: string;
}

/**
 * HTML-escape a value being interpolated into the document.
 *
 * Used only for the handful of values `skeletonPage` itself inlines; everything that
 * comes from the repository goes through `textContent` instead. Both single and double
 * quotes are escaped so the result is safe in an attribute as well as in text.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_TITLE = 'Excavate — walking skeleton';

/** Where the token lives between navigations, so a reload survives stripping it from the URL. */
const TOKEN_STORAGE_KEY = 'excavate.session-token';

export function skeletonPage(config: SkeletonPageConfig = {}): string {
  const title = escapeHtml(config.title ?? DEFAULT_TITLE);
  const script = clientScript(config.apiBaseUrl ?? '');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark light; }
      body {
        margin: 0;
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 4fr);
        gap: 1.5rem;
        padding: 1.5rem;
        font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      h1 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; }
      ul { list-style: none; margin: 0; padding: 0; }
      li + li { border-top: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 15%, transparent); }
      button {
        all: unset;
        display: block;
        width: 100%;
        padding: 0.4rem 0.5rem;
        cursor: pointer;
        text-align: left;
      }
      button:hover, button:focus-visible { background: color-mix(in srgb, currentColor 10%, transparent); }
      button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
      .oid { opacity: 0.6; }
      #status { margin: 0 0 0.75rem; }
      #status:empty { display: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="status" role="status"></p>
      <ul id="commits" aria-busy="true"></ul>
    </main>
    <aside>
      <h1>Message</h1>
      <pre id="detail">Select a commit.</pre>
    </aside>
    <script>${script}</script>
  </body>
</html>
`;
}

/**
 * The untyped half. Kept in one function so the boundary between typechecked module
 * code and the string literal is a single, obvious line.
 *
 * Everything the script needs from the contract is injected as a JSON literal rather
 * than assumed, which is what keeps `ROUTES` the only definition of a route string.
 */
function clientScript(apiBaseUrl: string): string {
  const constants = {
    apiBaseUrl,
    commits: ROUTES.commits,
    commit: ROUTES.commit,
    summary: ROUTES.repoSummary,
    scheme: AUTH_SCHEME,
    tokenParam: TOKEN_QUERY_PARAM,
    storageKey: TOKEN_STORAGE_KEY,
  };

  /* `<` becomes `<`, which is the same character to a JavaScript string literal and
     cannot close the `<script>` element it sits inside. Without it an `apiBaseUrl`
     containing `</script>` would end the script early and inject whatever followed —
     `JSON.stringify` escapes quotes and backslashes but knows nothing about HTML, and this
     is the one place the page interpolates caller-supplied text into executable code. */
  const literal = JSON.stringify(constants).replace(/</g, '\\u003c');

  return `
      const C = ${literal};

      const takeToken = () => {
        const params = new URLSearchParams(location.search);
        const fromUrl = params.get(C.tokenParam);
        if (fromUrl) {
          sessionStorage.setItem(C.storageKey, fromUrl);
          params.delete(C.tokenParam);
          const rest = params.toString();
          history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
        }
        return sessionStorage.getItem(C.storageKey) || '';
      };

      const token = takeToken();

      const api = async (path) => {
        const response = await fetch(C.apiBaseUrl + path, {
          cache: 'no-store',
          headers: { Authorization: C.scheme + ' ' + token },
        });
        // Read as text and parse defensively. A daemon that answered with something that
        // is not JSON — a proxy's error page, a truncated body — would otherwise surface
        // as a parser error naming a character offset, which tells the user nothing about
        // what actually failed.
        const text = await response.text();
        let body = null;
        try { body = text === '' ? null : JSON.parse(text); } catch (ignored) { body = null; }
        if (!response.ok) {
          throw new Error(body && body.error ? body.error.code + ': ' + body.error.message : 'HTTP ' + response.status);
        }
        if (body === null) {
          throw new Error('HTTP ' + response.status + ' with no JSON body');
        }
        return body;
      };

      const list = document.getElementById('commits');
      const detail = document.getElementById('detail');
      const status = document.getElementById('status');

      // Which detail request the pane is showing. Without it, clicking two rows in quick
      // succession leaves whichever response arrives last in the pane — so the message on
      // screen can belong to a commit other than the selected one. A tool whose answer
      // does not match the question it was asked is worse than a slow one.
      let shown = 0;

      const showCommit = async (oid) => {
        const ticket = shown + 1;
        shown = ticket;
        detail.textContent = 'Loading ' + oid.slice(0, 7) + '…';
        try {
          const commit = await api(C.commit.replace(':oid', encodeURIComponent(oid)));
          if (ticket !== shown) return;
          detail.textContent = commit.body ? commit.subject + '\\n\\n' + commit.body : commit.subject;
        } catch (error) {
          if (ticket !== shown) return;
          detail.textContent = 'Could not load ' + oid.slice(0, 7) + ': ' + error.message;
        }
      };

      const row = (commit) => {
        const button = document.createElement('button');
        button.type = 'button';
        const oid = document.createElement('span');
        oid.className = 'oid';
        oid.textContent = commit.oid.slice(0, 7) + ' ';
        const subject = document.createElement('span');
        subject.textContent = commit.subject;
        button.appendChild(oid);
        button.appendChild(subject);
        button.addEventListener('click', () => { showCommit(commit.oid); });
        const item = document.createElement('li');
        item.appendChild(button);
        return item;
      };

      const loadCommits = async () => {
        try {
          const page = await api(C.commits);
          for (const commit of page.commits) list.appendChild(row(commit));
          if (page.commits.length === 0) detail.textContent = 'This repository has no indexed commits yet.';
        } catch (error) {
          detail.textContent = 'Could not load commits: ' + error.message;
        } finally {
          list.removeAttribute('aria-busy');
        }
      };

      // A list of commits is not self-describing: a history the walk never finished looks
      // exactly like a short one. Anything other than a finished index is therefore said
      // out loud, in the daemon's own words, above the list it qualifies.
      const loadStatus = async () => {
        try {
          const summary = await api(C.summary);
          const notes = [];
          if (summary.indexState !== 'ready') notes.push('index ' + summary.indexState);
          if (summary.partial) notes.push('incomplete index — ' + summary.partial.reason + ': ' + summary.partial.skipped);
          status.textContent = notes.join(' · ');
        } catch (error) {
          // Not knowing whether the index is complete is itself worth saying.
          status.textContent = 'Could not read the index status: ' + error.message;
        }
      };

      // Started in this order and deliberately not awaited in sequence: neither request
      // should be able to hold the other up.
      loadCommits();
      loadStatus();
    `;
}
