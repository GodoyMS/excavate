import type {
  CommitDetailDto,
  CommitListResponse,
  CommitSummaryDto,
  RepoSummary,
} from '@excavate/core';
import { LENSES, NotImplementedError, VIEWS, parseOid, repoId } from '@excavate/core';
import { describe, expect, it, vi } from 'vitest';

import {
  DIRECTORY_AGGREGATION_THRESHOLD,
  escapeHtml,
  skeletonPage,
  squarifiedTreemap,
} from './index.js';

describe('the view and lens surface', () => {
  it('ships the five views that survive into lean v1', () => {
    // People, Decisions, and Search are cut: ownership surfaces inline, Decisions is
    // post-v1, and search lives in ⌘K.
    expect(VIEWS).toEqual(['overview', 'story', 'timeline', 'map', 'files']);
  });

  it('ships five lenses', () => {
    expect(LENSES).toHaveLength(5);
  });
});

describe('the Map', () => {
  it('aggregates to directories above the readability limit, not the perf limit', () => {
    // p90 of repositories is ~12k files, which Canvas2D handles at 60fps. Above 15k a
    // treemap is unreadable anyway, so aggregation is the better visualization — not a
    // degradation.
    expect(DIRECTORY_AGGREGATION_THRESHOLD).toBe(15_000);
    expect(DIRECTORY_AGGREGATION_THRESHOLD).toBeGreaterThan(12_000);
  });

  it('defers Persistent Layout to M4, where its test is the milestone gate', () => {
    expect(() => squarifiedTreemap([], { width: 100, height: 100 })).toThrow(
      NotImplementedError,
    );
    expect(() => squarifiedTreemap([], { width: 100, height: 100 })).toThrow(/M4/);
  });
});

/* ── The M0.4 walking skeleton ─────────────────────────────────────────────── */

const HOSTILE_SUBJECT = 'fix <script>alert(document.cookie)</script> the parser';
const TOKEN = 'kR2zvJ8pVQ0hLxT7bN3mCd9sYfWgA1eU4iOaX6qZjBk';
const OID = parseOid('a'.repeat(40));

const SUMMARY: CommitSummaryDto = {
  oid: OID,
  subject: HOSTILE_SUBJECT,
  authorName: 'Ada Lovelace',
  authoredAt: { epochSeconds: 1_700_000_000, offsetMinutes: 0 },
  insertions: 4,
  deletions: 2,
  filesChanged: 1,
  significance: 0.4,
  isMerge: false,
};

const DETAIL: CommitDetailDto = {
  ...SUMMARY,
  body: 'The <b>real</b> reason this changed.',
  parents: [],
  committedAt: { epochSeconds: 1_700_000_000, offsetMinutes: 0 },
  committerName: 'Ada Lovelace',
};

const LIST: CommitListResponse = {
  commits: [SUMMARY],
  nextCursor: null,
  projection: 'first-parent',
};

const OTHER_OID = parseOid('b'.repeat(40));

const OTHER_SUMMARY: CommitSummaryDto = {
  ...SUMMARY,
  oid: OTHER_OID,
  subject: 'teach the parser about tabs',
};

const OTHER_DETAIL: CommitDetailDto = {
  ...OTHER_SUMMARY,
  body: 'The reason the second commit changed.',
  parents: [],
  committedAt: { epochSeconds: 1_700_000_100, offsetMinutes: 0 },
  committerName: 'Ada Lovelace',
};

const LIST_TWO: CommitListResponse = {
  commits: [SUMMARY, OTHER_SUMMARY],
  nextCursor: null,
  projection: 'first-parent',
};

/** A finished, whole index — the case in which the page has nothing to warn about. */
const READY_SUMMARY: RepoSummary = {
  repoId: repoId('fixture'),
  root: '/repo',
  headOid: OID,
  indexState: 'ready',
  commitCount: 1,
  personCount: 1,
  fileCount: 1,
  firstCommitAt: { epochSeconds: 1_700_000_000, offsetMinutes: 0 },
  lastCommitAt: { epochSeconds: 1_700_000_000, offsetMinutes: 0 },
  partial: null,
};

/**
 * A DOM small enough to fit in a test and large enough to run the page's script.
 *
 * The skeleton's script is a string literal, so the only way to protect the M0.4
 * interaction — and the fact that commit text never becomes markup — is to execute it.
 * `textContent` is modelled the way the real DOM behaves: reading a node's text
 * concatenates its descendants', so an assertion cannot pass by accident.
 */
interface FakeElement {
  readonly tagName: string;
  type: string;
  className: string;
  textContent: string;
  readonly children: FakeElement[];
  readonly attributes: Map<string, string>;
  readonly listeners: Map<string, (() => void)[]>;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(type: string, handler: () => void): void;
  removeAttribute(name: string): void;
  /** The concatenated text of this node and its descendants. */
  text(): string;
  click(): void;
}

function element(tagName: string): FakeElement {
  const node: FakeElement = {
    tagName,
    type: '',
    className: '',
    textContent: '',
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      const existing = node.listeners.get(type) ?? [];
      existing.push(handler);
      node.listeners.set(type, existing);
    },
    removeAttribute(name) {
      node.attributes.delete(name);
    },
    text() {
      return node.textContent + node.children.map((child) => child.text()).join('');
    },
    click() {
      for (const handler of node.listeners.get('click') ?? []) handler();
    },
  };
  return node;
}

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A response body, or a function producing one later.
 *
 * The deferred form is what makes the out-of-order test possible: the page's correctness
 * under two overlapping clicks cannot be observed if every fetch settles immediately.
 */
type Responder = () => Promise<unknown>;

interface Page {
  byId(id: string): FakeElement;
  readonly calls: readonly FetchCall[];
  readonly replaced: readonly string[];
  readonly stored: Map<string, string>;
}

/**
 * Executes the page's inline script against the fakes above.
 *
 * `new Function` is deliberate and confined to this file: the script under test is
 * untypechecked JavaScript inside an HTML string, and running it here is what makes the
 * milestone's acceptance criterion an assertion instead of a manual click. The shipped
 * page contains no `eval` of its own — Part 7 §7.4.2 — and the daemon's CSP on `/` is
 * what enforces that.
 */
function run(
  html: string,
  responses: Readonly<Record<string, unknown>>,
  options: { readonly search?: string; readonly stored?: Map<string, string> } = {},
): Page {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error('the page has no inline script');

  const nodes = new Map<string, FakeElement>([
    ['commits', element('ul')],
    ['detail', element('pre')],
    ['status', element('p')],
  ]);
  const calls: FetchCall[] = [];
  const replaced: string[] = [];
  const stored = options.stored ?? new Map<string, string>();

  const document = {
    getElementById: (id: string): FakeElement | null => nodes.get(id) ?? null,
    createElement: (tagName: string): FakeElement => element(tagName),
  };
  const location = { search: options.search ?? '', pathname: '/' };
  const history = {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      replaced.push(url);
      const [pathname, search] = url.split('?');
      location.pathname = pathname ?? '/';
      location.search = search === undefined ? '' : `?${search}`;
    },
  };
  const sessionStorage = {
    getItem: (key: string): string | null => stored.get(key) ?? null,
    setItem: (key: string, value: string): void => void stored.set(key, value),
  };
  const fetch = async (
    url: string,
    init: { readonly headers?: Record<string, string> },
  ): Promise<unknown> => {
    calls.push({ url, headers: init.headers ?? {} });
    const entry = responses[url];
    const body = typeof entry === 'function' ? await (entry as Responder)() : entry;
    const ok = body !== undefined;
    // `text()`, not `json()`, because that is what the page calls — a fake that offered
    // only `json()` would let the page's own parsing go untested.
    const payload = ok
      ? body
      : { error: { code: 'NOT_FOUND', message: 'no such commit' } };
    return {
      ok,
      status: ok ? 200 : 404,
      text: () => Promise.resolve(JSON.stringify(payload)),
    };
  };

  // Aliased before use: naming a parameter `document` would make `typeof document`
  // resolve to the parameter's own annotation.
  type Doc = typeof document;
  type Loc = typeof location;
  type Hist = typeof history;
  type Store = typeof sessionStorage;
  type Fetch = typeof fetch;
  type ClientScript = (
    document: Doc,
    location: Loc,
    history: Hist,
    sessionStorage: Store,
    fetch: Fetch,
  ) => void;

  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- see the doc comment
  const client = new Function(
    'document',
    'location',
    'history',
    'sessionStorage',
    'fetch',
    script,
  ) as unknown as ClientScript;

  client(document, location, history, sessionStorage, fetch);

  return {
    byId: (id) => {
      const node = nodes.get(id);
      if (node === undefined) throw new Error(`no #${id} in the page`);
      return node;
    },
    calls,
    replaced,
    stored,
  };
}

describe('the walking-skeleton page', () => {
  it('lists the commits it fetched and shows a commit’s message when it is clicked', async () => {
    // This is M0.4's acceptance criterion, whole: fetch the list, render it, click a row,
    // see that commit's message.
    const page = run(skeletonPage(), {
      '/api/commits': LIST,
      '/api/repo/summary': READY_SUMMARY,
      [`/api/commits/${OID}`]: DETAIL,
    });

    await vi.waitFor(() => expect(page.byId('commits').children).toHaveLength(1));
    const row = page.byId('commits').children[0];
    expect(row?.text()).toContain(HOSTILE_SUBJECT);
    expect(row?.text()).toContain(OID.slice(0, 7));

    // Directly, not via the concatenation above: the hostile subject is one node's own
    // `textContent`, which is the property that makes it text rather than markup. The
    // fake DOM has no `innerHTML`, so a page that assigned one would leave `text()`
    // empty and fail the assertions above — this pins down *how* it got there.
    const [oidSpan, subjectSpan] = row?.children[0]?.children ?? [];
    expect(oidSpan?.textContent).toBe(`${OID.slice(0, 7)} `);
    expect(subjectSpan?.textContent).toBe(HOSTILE_SUBJECT);
    expect(subjectSpan?.children).toHaveLength(0);

    row?.children[0]?.click();
    await vi.waitFor(() =>
      expect(page.byId('detail').text()).toContain(
        'The <b>real</b> reason this changed.',
      ),
    );
    expect(page.calls.map((call) => call.url)).toEqual([
      '/api/commits',
      '/api/repo/summary',
      `/api/commits/${OID}`,
    ]);
    // A finished, whole index has nothing to warn about, so the notice stays empty.
    expect(page.byId('status').text()).toBe('');
  });

  it('prints the index state and the partial badge above a list it cannot vouch for', async () => {
    // A list of commits is not self-describing: a history the walk never finished looks
    // exactly like a short one. The daemon supplies the badge; dropping it here would put
    // a truncated history on screen with nothing to say so.
    const page = run(skeletonPage(), {
      '/api/commits': LIST,
      '/api/repo/summary': {
        ...READY_SUMMARY,
        indexState: 'stale',
        partial: { reason: 'interrupted', skipped: 'history after 120 commits' },
      } satisfies RepoSummary,
    });

    await vi.waitFor(() => expect(page.byId('status').text()).not.toBe(''));
    const shown = page.byId('status').text();
    expect(shown).toContain('index stale');
    expect(shown).toContain('interrupted');
    expect(shown).toContain('history after 120 commits');
  });

  it('says it does not know the index state rather than implying the index is whole', async () => {
    // The summary route failing is not a reason to render the list unqualified.
    const page = run(skeletonPage(), { '/api/commits': LIST });
    await vi.waitFor(() =>
      expect(page.byId('status').text()).toContain('Could not read the index status'),
    );
  });

  it('contains no sink that could turn repository text into markup', () => {
    // A source-level check, and deliberately separate from the behavioural one above:
    // that test proves the subject arrived as `textContent`, this one proves there is no
    // second path a later edit could reach for. Commit messages are attacker-controlled in
    // the general case, and an XSS in a tool people point at untrusted repositories is a
    // real bug rather than a theoretical one.
    const html = skeletonPage();
    expect(html).not.toMatch(
      /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/,
    );
    expect(html).toMatch(/\.textContent =/);
  });

  it('never leaves a stale response in the detail pane after a second click', async () => {
    // Two clicks in quick succession, with the *first* request resolving last. Without a
    // guard the late response wins and the pane shows a commit other than the selected
    // one — an answer that does not match the question it was asked.
    let releaseFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const page = run(skeletonPage(), {
      '/api/commits': LIST_TWO,
      [`/api/commits/${OID}`]: () => first.then(() => DETAIL),
      [`/api/commits/${OTHER_OID}`]: OTHER_DETAIL,
    });

    await vi.waitFor(() => expect(page.byId('commits').children).toHaveLength(2));
    const rows = page.byId('commits').children;
    rows[0]?.children[0]?.click();
    rows[1]?.children[0]?.click();

    await vi.waitFor(() =>
      expect(page.byId('detail').text()).toContain(
        'The reason the second commit changed.',
      ),
    );

    releaseFirst();
    await first;
    // Give the first request's continuation every chance to overwrite the pane.
    await Promise.resolve();
    await Promise.resolve();
    expect(page.byId('detail').text()).toContain('The reason the second commit changed.');
    expect(page.byId('detail').text()).not.toContain('The <b>real</b> reason');
  });

  it('says so when the daemon answers without a JSON body', async () => {
    // A 200 with nothing in it must not render as an empty repository.
    const page = run(skeletonPage(), { '/api/commits': null });
    await vi.waitFor(() => expect(page.byId('detail').text()).toContain('no JSON body'));
  });

  it('escapes markup in every value it interpolates into the document itself', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & so")).toBe('it&#39;s &amp; so');
    expect(skeletonPage({ title: HOSTILE_SUBJECT })).not.toContain('<script>alert');
  });

  it('cannot be broken out of by a config value carrying a closing script tag', () => {
    // The config is interpolated into executable code, and `JSON.stringify` escapes quotes
    // but knows nothing about HTML — so an `apiBaseUrl` containing `</script>` would end
    // the element early and inject whatever came next.
    const html = skeletonPage({ apiBaseUrl: '</script><script>alert(1)</script>' });
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('takes the token out of the address bar and sends it as a bearer credential', async () => {
    // LEAN-V1 §2.2: the token is handled invisibly. One left in the address bar ends up
    // pasted into a bug report.
    const page = run(
      skeletonPage(),
      { '/api/commits': LIST },
      { search: `?token=${TOKEN}&view=overview` },
    );

    expect(page.replaced).toEqual(['/?view=overview']);
    expect(page.stored.get('excavate.session-token')).toBe(TOKEN);
    // Two requests: the commit list, then the index status. Both must carry the header.
    await vi.waitFor(() => expect(page.calls).toHaveLength(2));
    expect(page.calls.map((call) => call.url)).toEqual([
      '/api/commits',
      '/api/repo/summary',
    ]);
    for (const call of page.calls) {
      expect(call.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('survives a reload, when the token is only in session storage', async () => {
    const page = run(
      skeletonPage(),
      { '/api/commits': LIST },
      { search: '', stored: new Map([['excavate.session-token', TOKEN]]) },
    );

    expect(page.replaced).toEqual([]);
    // Two requests: the commit list, then the index status. Both must carry the header.
    await vi.waitFor(() => expect(page.calls).toHaveLength(2));
    expect(page.calls.map((call) => call.url)).toEqual([
      '/api/commits',
      '/api/repo/summary',
    ]);
    for (const call of page.calls) {
      expect(call.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('reports an API failure in place of the message rather than failing silently', async () => {
    const page = run(skeletonPage(), {});
    await vi.waitFor(() =>
      expect(page.byId('detail').text()).toContain('NOT_FOUND: no such commit'),
    );
  });

  it('addresses the API through the contract’s own route table', () => {
    const html = skeletonPage({ apiBaseUrl: 'http://127.0.0.1:9999' });
    expect(html).toContain('"commits":"/api/commits"');
    expect(html).toContain('"commit":"/api/commits/:oid"');
    expect(html).toContain('"apiBaseUrl":"http://127.0.0.1:9999"');
  });
});
