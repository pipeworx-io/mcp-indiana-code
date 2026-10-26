interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared full-text-search helpers for every caller of the FTS5 case/statute
 * search shard (workers/gateway/src/search-shard.ts, `op match ?`).
 *
 * THE BUG THIS FIXES (fleet #3070). Several packs sent the caller's raw text
 * straight into FTS5's MATCH operator. A comma, a '?', or an AND/OR/NOT/NEAR
 * in the question is FTS5 syntax, so the shard throws a SQLite error — and
 * the pack reported that as `index_unreachable`, an infrastructure failure,
 * when the real problem was punctuation in a plain-language question. Even
 * once the syntax is sanitized, ANDing every word of a whole sentence
 * ("what does X require") returns zero hits, because no statute section
 * contains the literal word "what" — a silent, wrong "no match" for what is
 * actually a query-shape problem, not an absence of an answer.
 *
 * Two packs independently built the identical fix — illinois-code
 * (bdc38b2c2) and france-legi's core.ts — before this existed. Lifted here so
 * every other caller of the shard (north-carolina-code, indiana-code,
 * wyoming-code, the court-listener case-law fan-out in caselaw-search.ts, and
 * any future statute pack) gets it for free instead of re-deriving it a
 * third, fourth, fifth time.
 */

type FtsMode = 'all' | 'any';

/**
 * Caller text -> a safe FTS5 MATCH expression. Every word (or quoted phrase)
 * is re-quoted as an FTS5 string literal, so FTS5 operators (AND/OR/NOT/
 * NEAR), column filters, and stray punctuation in a plain-language question
 * — commas, question marks, the very things a real caller's sentence is full
 * of — cannot change the query's meaning or throw a syntax error. Non-letter,
 * non-digit characters are simply dropped by the `\p{L}\p{N}` match, which is
 * what turns "bond, and license" (a syntax error against `op match ?`) into
 * a clean three-term query.
 *
 * `mode: 'all'` ANDs every term (precise, for a short deliberate query);
 * `mode: 'any'` ORs them (a relaxed retry for a whole sentence — see
 * `shardSearch` below, which is the fallback policy this exists to support).
 *
 * `extraTerm`, when given, is ANDed on as its own already-resolved literal
 * (e.g. a jurisdiction/code token every hit must also carry). Resolving a
 * caller-facing id into that literal — france-legi's `codeToken` — is the
 * caller's job, not this function's; this only assembles the final MATCH
 * string.
 *
 * Returns null when the text has no searchable words at all (e.g. "???").
 */
function ftsQuery(text: string, mode: FtsMode, extraTerm?: string | null): string | null {
  const parts: string[] = [];
  const re = /"([^"]+)"|([\p{L}\p{N}]+)/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[2];
    const words = raw.match(/[\p{L}\p{N}]+/gu);
    if (!words?.length) continue;
    parts.push(`"${words.join(' ')}"`);
  }
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0] : mode === 'all' ? parts.join(' AND ') : `(${parts.join(' OR ')})`;
  return extraTerm ? `${body} AND "${extraTerm}"` : body;
}

interface FtsHit {
  opinion_id: number;
  score: number;
}

interface FtsShardResult {
  hits: FtsHit[];
  /** Which query actually produced `hits`. Null only when the text had no
   *  searchable words at all (`ftsQuery` returned null) and the shard was
   *  never called. */
  mode: FtsMode | null;
  /** False only on a genuine shard/transport failure — non-2xx, a network
   *  error, or a body that doesn't parse. That is a real infrastructure
   *  problem and callers MUST report it as one (e.g. `index_unreachable`).
   *  A legitimate zero-hit search still reports `ok: true` with `hits: []`
   *  — callers MUST NOT collapse that distinction (silent-zero-policy). */
  ok: boolean;
}

interface ShardStub {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/**
 * Query ONE shard stub with the ALL->ANY fallback: try an ALL-words match
 * first (the precise read of a short, deliberate query — "currency exchange
 * license fee"), and only retry with an OR-ranked ANY-word match when the
 * query has more than one word and the ALL attempt came back empty. A long
 * plain-language question ANDs every one of its words, including stopwords
 * like "what" or "does" that statute/opinion text is unlikely to contain
 * verbatim — that AND-of-a-sentence zero is not evidence the answer is
 * absent, it's the ALL mode being too strict for a sentence shaped input.
 * bm25's own idf weighting discounts a word that appears in nearly every
 * document, so the ANY retry needs no separate stopword list (same reasoning
 * search-shard.ts's own "NO STOPWORD LIST" note gives for not stripping
 * function words from the index itself).
 */
async function shardSearch(
  stub: ShardStub,
  text: string,
  limit: number,
  extraTerm?: string | null,
): Promise<FtsShardResult> {
  const runQuery = async (matchQuery: string): Promise<FtsHit[]> => {
    const res = await stub.fetch('https://shard/query', {
      method: 'POST',
      body: JSON.stringify({ q: matchQuery, limit }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`shard_http_${res.status}`);
    const out = (await res.json()) as { results?: FtsHit[] };
    return out.results ?? [];
  };

  const allQuery = ftsQuery(text, 'all', extraTerm);
  if (!allQuery) return { hits: [], mode: null, ok: true };

  try {
    let hits = await runQuery(allQuery);
    let mode: FtsMode = 'all';
    if (!hits.length && /\s/.test(text)) {
      const anyQuery = ftsQuery(text, 'any', extraTerm);
      if (anyQuery) {
        hits = await runQuery(anyQuery);
        mode = 'any';
      }
    }
    return { hits, mode, ok: true };
  } catch {
    return { hits: [], mode: null, ok: false };
  }
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}


/**
 * HTML-to-text helpers shared by the state statute packs.
 *
 * One decoder rather than one per pack, because the copies had already begun
 * to drift: the hex-entity case (&#x2003; em space, &#x2014; em dash) was
 * handled in Florida's copy and not California's, so Californian statutes were
 * quietly emitting raw entities where punctuation belonged. Fixed once here.
 *
 * publish-pack.sh inlines workspace imports, so a standalone pack still ships
 * self-contained.
 */

const SCRIPT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK = /<\/?(p|div|br|tr|li|h[1-6]|blockquote)\b[^>]*>/gi;

/** Convert a slice of statute HTML to readable plain text. */
function statuteText(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(SCRIPT, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Hex before decimal: legislature sites emit &#x2003; and &#x2014;
    // constantly, and a decimal-only decoder leaves them in the middle of the
    // statute looking like markup noise.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&sect;/g, '\u00a7')
    // Named entities that carry MEANING, decoded before the catch-all below.
    // This was a real defect: the catch-all replaced &ndash; with a SPACE, so
    // Maryland's "&sect;2&ndash;201." decoded to "2 201" and a lookup for
    // section 2-201 reported a statute that plainly exists as missing. Dashes
    // are everywhere in statutory text and numbering, so the corruption was
    // silent and general rather than particular to one state.
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&rsquo;|&apos;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text from a container, starting AFTER its opening tag.
 *
 * Slicing at the marker itself leaves the tail of the tag — `laws-body">` — as
 * the first characters of the statute, which is exactly what three packs did
 * before testing caught it.
 */
function textFromContainer(html: string, marker: string | RegExp): string | null {
  const i = typeof marker === 'string' ? html.indexOf(marker) : html.search(marker);
  if (i === -1) return null;
  const gt = html.indexOf('>', i);
  return statuteText(html.slice(gt === -1 ? i : gt + 1));
}

/**
 * Read a statute response as text, honouring its actual encoding.
 *
 * Several state sites serve WINDOWS-1252 while sending `content-type:
 * text/html` with no charset. Response.text() assumes UTF-8, so their smart
 * quotes and non-breaking spaces decode to replacement characters — Nevada
 * rendered `"Murder" defined` as mojibake, and Oregon's section headings
 * became unmatchable because the "space" after the section number is a 0xA0
 * that never survived the decode.
 *
 * That is the quiet kind of damage: the text still looks like text, so nothing
 * errors, and a heading regex simply stops matching for reasons no one can see
 * in the output.
 *
 * Strict UTF-8 first — if the bytes really are UTF-8 this succeeds and nothing
 * changes — then fall back to windows-1252, which decodes every byte and so
 * cannot itself fail.
 */
async function readStatuteResponse(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Cut one section out of a page that holds a whole chapter.
 *
 * A section number appears several times on these pages and only one of them
 * starts the statute. The others are a table-of-contents entry at the top and
 * cross-references inside neighbouring sections. Picking the FIRST match
 * returns a heading with nothing under it; picking the LAST returns whatever
 * fragment follows a cross-reference. Both were tried and both produced
 * confident, tiny, wrong answers — Oregon 140 characters, Nevada 39, each
 * looking like a real result.
 *
 * The body is simply the candidate with the most text before the next section
 * begins, which is true regardless of where the page puts its contents list.
 *
 * @param heading matches the start of the wanted section (global flag required)
 * @param next    matches the start of ANY section, to bound the slice
 */
function sliceSection(text: string, heading: RegExp, next: RegExp): string | null {
  // Record where each candidate starts AND how long its heading is. Skipping
  // only one character past the start lets the  pattern re-match the very
  // heading we just found, which yields an empty body — that bug returned
  // section_not_found for a section plainly present on the page.
  const found: Array<{ at: number; len: number }> = [];
  const re = new RegExp(heading.source, heading.flags.includes('g') ? heading.flags : heading.flags + 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found.push({ at: m.index, len: m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;   // guard zero-width matches
  }
  if (!found.length) return null;

  let best: string | null = null;
  for (const { at, len } of found) {
    const from = at + len;
    const nre = new RegExp(next.source, next.flags.includes('g') ? next.flags : next.flags + 'g');
    const m = nre.exec(text.slice(from));
    const body = (m ? text.slice(at, from + m.index) : text.slice(at)).trim();
    if (body.length > (best?.length ?? 0)) best = body;
  }
  return best && best.length > 0 ? best : null;
}
/**
 * Indiana Code — state statutes by citation, plus topic search and
 * historical (per-year) versions. Fleet #2724.
 *
 * SOURCE: the Indiana General Assembly's own code viewer (iga.in.gov) is a
 * React SPA whose "api" (its env var is literally REACT_APP_API_URL) is a
 * plain JSON/HTML object store behind CloudFront + S3, not a hand-built
 * backend — found by downloading the SPA's own JS bundle and grepping it for
 * the base URL and the fetch it issues for a title page:
 *
 *   https://iga.in.gov/ic/<year>/Title_<N>.html
 *
 * ONE DOCUMENT PER TITLE PER YEAR, not per section — e.g. Title_9.html (Motor
 * Vehicles) is ~5.9 MB and contains all ~2,600 sections of Title 9 for that
 * year. <year> is the field the SPA itself calls `in_code_year`
 * (https://iga.in.gov/api/getSessionYears lists it); AN EXPLICIT YEAR IS THE
 * "historical version" capability the task asked for — no separate archive
 * API exists or is needed, the current-year URL and a 2017 URL are the same
 * shape with a different path segment. Measured live: 2017-2026 return real
 * content for Title 9; 2015-2016 return the SPA's own 404 shell (691 bytes)
 * for that specific title, so "2015 onward" is per-title, not universal —
 * every lookup here checks for actual section markers rather than trusting a
 * hardcoded year floor.
 *
 * THE UPSTREAM NEEDS A BROWSER-SHAPED USER-AGENT, which is why this is not a
 * one-line fetch. A bare curl/Node UA (and even a bare "Mozilla/5.0") gets
 * the SAME 691-byte SPA shell back with HTTP 200 — no error, just silent
 * emptiness, the California-code trap wearing a CDN's hat instead of a Java
 * app server's. `Mozilla/5.0 (compatible; pipeworx-mcp-indiana-code/1.0;
 * +https://pipeworx.io)` — the honest bot-UA convention this repo already
 * uses for 19hz/fed-comms/etc — passes; no Referer needed. No postback, no
 * JS challenge, no session cookie: once the UA string is shaped right this
 * is a plain keyless GET, confirmed with curl outside any browser.
 *
 * STRUCTURE: every title/article/chapter/section in the document is wrapped
 * in the SAME marker shape —
 *
 *   <div class="section" id="9-21-5-5" ...>
 *     <span id="ic_number">IC 9-21-5-5</span>
 *     <span id="shortdescription">Oversized vehicles; violation</span>
 *     <div style="clear: both;"></div></div>
 *   [...section body...]
 *
 * — so a single regex finds every boundary (of all four levels) in one
 * pass, and a section's body is just the text between its own marker and
 * the next one, of ANY level. The citation's title segment (before the
 * first dash — "9", or "7.1" for the one title whose number itself carries
 * a decimal) is exactly the document to fetch; no lookup table needed.
 *
 * ONE DOCUMENT PER TITLE (not per chapter, unlike mcps/north-carolina-code's
 * 396 R2 objects) is a deliberate size/count trade-off, not an oversight:
 * Indiana's live path is NOT throttled (NC's is, which is why NC pre-fetches
 * at all), so this pack hits iga.in.gov directly on every citation lookup
 * and only pre-fetches, into R2 + a search shard, for the one thing a live
 * call cannot do — full-text search across all 37 titles. 37 R2 objects
 * (one per title, ~37 `wrangler r2 object put` calls) ingests in minutes;
 * 2,000+ chapter-level objects would not have, with no API token configured
 * for this run. The read-time cost is bounded: the largest title (36, Local
 * Government, ~6,200 sections) is ~15 MB of source HTML and ~9 MB once
 * parsed to JSON — one allocation, well inside a Worker's 128 MB ceiling,
 * and only paid by a search-index rebuild, not by every citation lookup.
 *
 * AMENDMENT HISTORY: each section's trailing paragraph(s) — "As added by
 * P.L.2-1991, SEC.9. Amended by P.L.188-2015, SEC.64." and/or a
 * "[Pre-1991 Recodification Citation: ...]" note — are peeled off the body
 * into their own `history` field rather than left in `text`, the same shape
 * mcps/california-code uses for its own trailing enactment note.
 */

const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp-indiana-code/1.0; +https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Indiana General Assembly (iga.in.gov)');
}

const TITLE_URL = (year: string, title: string) => `https://iga.in.gov/ic/${year}/Title_${title}.html`;
const R2_PREFIX = 'statutes/in';

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface LocalSection {
  section: string;
  heading: string | null;
  text: string;
  history: string | null;
  url: string;
}

interface LocalBundle {
  title: string;
  title_name: string | null;
  in_code_year: string;
  sections: LocalSection[];
  ingested_at: string;
  source: string;
}

interface IndexEntry {
  id: number;
  title: string;
  section: string;
  heading: string | null;
  text_chars: number;
}

interface StatuteIndex {
  jurisdiction: string;
  in_code_year: string;
  ingested_at: string;
  entries: IndexEntry[];
}

function r2FromArgs(args: Record<string, unknown>): R2Like | undefined {
  return args._r2 as R2Like | undefined;
}

async function readJson<T>(r2: R2Like, key: string): Promise<T | null> {
  try {
    const obj = await r2.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

const tools: McpToolExport['tools'] = [
  {
    name: 'in_code_section',
    description:
      'Get the FULL TEXT of a section of the Indiana Code — Indiana state law — by citation, plus when it was added or amended. "IC 9-21-5-5" is an oversized-vehicle speed limit (traffic, Title 9); "IC 32-31-3-6" defines "rent" in the landlord-tenant chapter (Title 32). An ARTICLE ("IC 24-16") or CHAPTER ("IC 24-16-4") reference also works — it returns that group\'s own section list (citation + heading for each) instead of failing, so you can pick the right one and call this again for its full text. Pass `year` (e.g. 2020) to retrieve a historical annual edition instead of the current code — Indiana publishes a separate archived edition per year. Keyless. Use for "what does Indiana Code 9-21-5-5 say" or to check an Indiana statute a lease, ticket, or case relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section, chapter, or article as cited — "9-21-5-5" (section), "24-16-4" (chapter), "24-16" (article). The title is the part before the first dash (title "7.1" is the one exception that itself contains a dot).' },
        year: { type: 'string', description: 'Optional 4-digit year for a historical annual edition, e.g. "2020". Omit for the current Indiana Code.' },
      },
      required: ['section'],
    },
  },
  {
    name: 'in_code_search',
    description:
      'Search the Indiana Code BY TOPIC or keyword rather than citation — "traffic oversized vehicle permit", "landlord retaliatory eviction", "concealed handgun license". Returns ranked sections with their citations across all 37 Indiana Code titles; use in_code_section afterward for the full text of one. Full-text search, so it answers questions no citation lookup can. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord retaliatory eviction".' },
        limit: { type: 'number', description: 'Max results, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

// Boundary marker shared by title/article/chapter/section headers — see the
// file header comment. Captures: level, id (citation-shaped for sections),
// the "IC N" number span, and the short description/heading span.
const BOUND_RE = /<div class="(title|article|chapter|section)" id="([^"]+)"[^>]*>\s*<span id="ic_number"[^>]*>([^<]*)<\/span><span id="shortdescription"[^>]*>([^<]*)<\/span>\s*<div style="clear: both;"><\/div>\s*<\/div>/g;

interface Boundary { level: string; id: string; icNumber: string; shortDesc: string; start: number; end: number }

function findBoundaries(html: string): Boundary[] {
  const out: Boundary[] = [];
  const re = new RegExp(BOUND_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ level: m[1], id: m[2], icNumber: m[3], shortDesc: m[4], start: m.index, end: re.lastIndex });
  }
  return out;
}

/** Peel trailing "As added by..."/"Amended by..."/recodification-citation
 *  paragraphs off the end of a section's text into a separate history
 *  string, the same split mcps/california-code does for its own trailing
 *  enactment parenthetical. */
const HISTORY_PARA = /^(\[Pre-[^\]]*Recodification Citation[^\]]*\]|(?:As added|Added|Amended|Repealed|Renumbered)\b)/i;

function splitHistory(text: string): { text: string; history: string | null } {
  const paras = text.split(/\n{2,}/);
  const history: string[] = [];
  while (paras.length && HISTORY_PARA.test(paras[paras.length - 1])) {
    history.unshift(paras.pop()!.replace(/\s+/g, ' ').trim());
  }
  return { text: paras.join('\n\n').trim(), history: history.length ? history.join(' ') : null };
}

/** Extract one section's body from a full Title document, given its
 *  boundary list. Body runs from the end of this boundary's own header div
 *  to the start of the NEXT boundary of any level, or end of document. */
function sectionFromBoundaries(html: string, boundaries: Boundary[], index: number, url: string): LocalSection {
  const b = boundaries[index];
  const bodyEnd = index + 1 < boundaries.length ? boundaries[index + 1].start : html.length;
  const raw = html.slice(b.end, bodyEnd);
  const { text, history } = splitHistory(statuteText(raw));
  return { section: b.id, heading: b.shortDesc || null, text, history, url };
}

function parseSections(html: string, year: string, title: string): LocalSection[] {
  const boundaries = findBoundaries(html);
  const sections: LocalSection[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i].level !== 'section') continue;
    sections.push(sectionFromBoundaries(html, boundaries, i, TITLE_URL(year, title)));
  }
  return sections;
}

/** Indiana citations nest hierarchically — "24-16" is article 16 of Title
 *  24, "24-16-4" is chapter 4 of that article, "24-16-4-1" is a section —
 *  and every real section id starts with its own article's and chapter's
 *  id plus a dash. `groupLevel` reads that off the id's own segment count
 *  rather than needing the live HTML's article/chapter boundary markers. */
function groupLevel(id: string): string {
  const n = id.split('-').length;
  if (n === 2) return 'article';
  if (n === 3) return 'chapter';
  return 'group';
}

async function localLookup(
  r2: R2Like, title: string, section: string,
): Promise<{ record: Record<string, unknown> } | { group: Record<string, unknown> } | { titleKnown: true } | { titleKnown: false }> {
  const bundle = await readJson<LocalBundle>(r2, `${R2_PREFIX}/${title}.json`);
  if (!bundle) return { titleKnown: false };
  const hit = bundle.sections.find((s) => s.section === section);
  if (hit) {
    return {
      record: {
        citation: `IC ${section}`, section, title, title_name: bundle.title_name,
        heading: hit.heading, text: hit.text, text_chars: hit.text.length,
        history: hit.history, in_code_year: bundle.in_code_year, url: hit.url,
        source: 'Indiana General Assembly (iga.in.gov), pre-fetched current-year text, keyless',
        attribution: 'Indiana statutes are public record.',
        data_as_of: bundle.ingested_at,
      },
    };
  }
  // Not an exact section. An ARTICLE ("24-16") or CHAPTER ("24-16-4")
  // reference is not a section and never will be — a caller asking for one
  // deserves the group it names, not "no section 24-16" (the bug this
  // fixes: an article number was being probed as if it were a section id).
  // Any real section whose id starts with "<this>-" is this reference's own
  // child, so the prefix test alone tells article/chapter apart from a
  // genuinely bad citation with no fallback.
  const prefix = `${section}-`;
  const children = bundle.sections.filter((s) => s.section.startsWith(prefix));
  if (children.length) {
    return {
      group: {
        found: true, level: groupLevel(section),
        citation: `IC ${section}`, section, title, title_name: bundle.title_name,
        section_count: children.length,
        sections: children.slice(0, 60).map((s) => ({ citation: `IC ${s.section}`, heading: s.heading })),
        message: `IC ${section} is ${groupLevel(section) === 'article' ? 'an article' : groupLevel(section) === 'chapter' ? 'a chapter' : 'a group'}, not a single section — it has ${children.length} section(s). Pass one of the citations below to in_code_section for its full text.`,
        in_code_year: bundle.in_code_year,
        source: 'Indiana General Assembly (iga.in.gov), pre-fetched current-year text, keyless',
        attribution: 'Indiana statutes are public record.',
        data_as_of: bundle.ingested_at,
      },
    };
  }
  return { titleKnown: true };
}

async function liveLookup(raw: string, title: string, year: string) {
  const url = TITLE_URL(year, title);
  const res = await pwFetch(url);
  if (!res.ok) throw new Error(`Indiana General Assembly returned HTTP ${res.status} for Title ${title} (${year})`);
  const html = await res.text();
  const boundaries = findBoundaries(html);
  if (!boundaries.length) {
    return { found: false, reason: 'year_or_title_not_found', title, year,
      message: `No Indiana Code content found for Title ${title}, ${year}. Either ${year} has no published archive for this title, or Title ${title} does not exist.`,
      hint: 'Indiana publishes per-year archives from roughly 2017 onward (varies by title) — try omitting `year` for the current code.',
      data_as_of: new Date().toISOString() };
  }
  const idx = boundaries.findIndex((b) => b.level === 'section' && b.id === raw);
  if (idx === -1) {
    // Not a section — check whether `raw` is itself an article/chapter
    // boundary (or simply the common prefix of a run of real sections, same
    // test as localLookup's). The live document carries the article's and
    // chapter's own heading spans, so this path can show it where the
    // pre-fetched bundle (sections only) cannot.
    const children = boundaries.filter((b) => b.level === 'section' && b.id.startsWith(`${raw}-`));
    if (children.length) {
      const own = boundaries.find((b) => b.level !== 'section' && b.id === raw);
      const level = own?.level ?? groupLevel(raw);
      return {
        found: true, level,
        citation: `IC ${raw}`, section: raw, title, year,
        heading: own?.shortDesc || null,
        section_count: children.length,
        sections: children.slice(0, 60).map((b) => ({ citation: `IC ${b.id}`, heading: b.shortDesc || null })),
        message: `IC ${raw} is ${level === 'article' ? 'an article' : level === 'chapter' ? 'a chapter' : 'a group'}, not a single section — it has ${children.length} section(s). Pass one of the citations below to in_code_section for its full text.`,
        source: 'Indiana General Assembly (iga.in.gov), live fetch, keyless',
        data_as_of: new Date().toISOString(),
      };
    }
    return { found: false, reason: 'section_not_found', section: raw, title, year,
      message: `No section ${raw} in the Indiana Code, Title ${title} (${year}).`,
      hint: 'Section numbers are not contiguous — repealed/renumbered sections are normal. Check the citation, or use in_code_search.',
      data_as_of: new Date().toISOString() };
  }
  const sec = sectionFromBoundaries(html, boundaries, idx, url);
  if (sec.text.length < 10) {
    return { found: false, reason: 'empty_section', section: raw, title, year,
      message: `Section ${raw} resolved but returned no usable text — it may be repealed or reserved.`,
      data_as_of: new Date().toISOString() };
  }
  const titleHead = boundaries.find((b) => b.level === 'title');
  return {
    citation: `IC ${raw}`, section: raw, title,
    title_name: titleHead ? titleHead.shortDesc.replace(/^TITLE\s+[0-9.]+\.\s*/i, '').trim() || null : null,
    heading: sec.heading, text: sec.text, text_chars: sec.text.length, history: sec.history,
    in_code_year: year, url,
    source: 'Indiana General Assembly (iga.in.gov), live fetch, keyless',
    attribution: 'Indiana statutes are public record.',
    data_as_of: new Date().toISOString(),
  };
}

async function inCodeSection(args: Record<string, unknown>) {
  const raw = String(args.section ?? '').trim()
    .replace(/^(IC|I\.C\.)\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/§/g, '');
  const m = /^(\d+(?:\.\d+)?)-(.+)$/.exec(raw);
  if (!m) {
    return { found: false, reason: 'unparsed_section',
      message: `"${args.section}" is not an Indiana Code citation.`,
      hint: 'Indiana sections are title-article-chapter-section, e.g. "9-21-5-5" (oversized vehicle speed limit) or "32-31-3-6" (landlord-tenant: "rent" defined).' };
  }
  const title = m[1];

  const yearArg = args.year !== undefined && args.year !== null && args.year !== '' ? String(args.year).trim() : null;
  if (yearArg && !/^\d{4}$/.test(yearArg)) {
    return { found: false, reason: 'invalid_year', message: `"${args.year}" is not a 4-digit year.` };
  }

  const r2 = r2FromArgs(args);
  if (r2) {
    // A requested year that is not the bundle's own ingested year always
    // goes live — the R2 bundle only ever holds the current code, the same
    // "local-first for the common case, live for everything else" split
    // mcps/north-carolina-code uses, here split by YEAR rather than by
    // whether the chapter was crawled at all.
    const bundle = await readJson<LocalBundle>(r2, `${R2_PREFIX}/${title}.json`);
    if (bundle && (!yearArg || yearArg === bundle.in_code_year)) {
      const local = await localLookup(r2, title, raw);
      if ('record' in local) return local.record;
      if ('group' in local) return local.group;
      if (local.titleKnown) {
        return {
          found: false, reason: 'section_not_found', section: raw, title,
          message: `No section ${raw} in the Indiana Code, Title ${title} (checked against pre-fetched ${bundle.in_code_year} text).`,
          hint: 'Section numbers are not contiguous — repealed/renumbered sections are normal.',
          data_as_of: new Date().toISOString(),
        };
      }
    }
  }
  return liveLookup(raw, title, yearArg ?? '2026');
}

async function inCodeSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return { found: false, reason: 'empty_query',
      message: 'in_code_search needs a query — search by topic, e.g. "landlord retaliatory eviction".',
      hint: 'To look up a known citation use in_code_section instead.' };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const ns = args._searchShards as DurableObjectNamespace | undefined;
  const r2 = r2FromArgs(args);
  if (!ns || !r2) {
    return { found: false, reason: 'search_unavailable',
      message: 'Topic search runs through Pipeworx\'s full-text index and is not available in a standalone install of this pack.',
      hint: 'in_code_section (citation lookup) still works standalone.' };
  }

  // Over-fetch past `limit`, same reasoning as mcps/illinois-code's
  // ilStatuteSearch / mcps/north-carolina-code's ncStatuteSearch: the shard
  // ranks text matches, not resolved citations, so some hits may fail to
  // resolve against the index below and this keeps enough margin to still
  // fill `limit` after that filter.
  const fetchLimit = Math.min(100, Math.max(limit * 3, 30));
  const stub = ns.get(ns.idFromName('in-statutes'));

  // ftsQuery/shardSearch (shared, fleet #3070) quote the caller's text into a
  // safe FTS5 MATCH expression and retry ALL->ANY before giving up — a comma
  // or '?' in the question used to throw a SQLite syntax error read as
  // index_unreachable, and a whole-sentence AND-only search used to return a
  // silent zero because no statute section contains stopwords like "what".
  const sr = await shardSearch(stub, q, fetchLimit);
  if (!sr.ok) {
    return { found: false, reason: 'index_unreachable',
      message: 'The Indiana Code search index did not answer. This is an infrastructure failure, not an absence of matching sections.' };
  }
  const hits = sr.hits;
  if (!hits.length) {
    return { found: false, query: q,
      message: `No section matched "${q}" in the Indiana Code index.`,
      hint: 'Try fewer or more general words — this is a full-text match, not semantic search.' };
  }

  const index = await readJson<StatuteIndex>(r2, `${R2_PREFIX}/_index.json`);
  const byId = new Map((index?.entries ?? []).map((e) => [e.id, e]));
  const results = hits
    .map((h) => {
      const e = byId.get(h.opinion_id);
      if (!e) return null;
      return {
        citation: `IC ${e.section}`,
        title: e.title,
        section: e.section,
        heading: e.heading,
        score: h.score,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, limit);

  return {
    found: results.length > 0,
    query: q,
    match: sr.mode === 'any' ? 'any_word' : 'all_words',
    count: results.length,
    results,
    in_code_year: index?.in_code_year ?? null,
    data_as_of: index?.ingested_at ?? null,
    source: 'Indiana Code full-text search (Indiana General Assembly)',
    hint: 'Call in_code_section with the section from a result to get its full text.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'in_code_section') return inCodeSection(args);
  if (name === 'in_code_search') return inCodeSearch(args);
  throw new Error(`Unknown tool: ${name}`);
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
