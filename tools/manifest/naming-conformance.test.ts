/**
 * Phase 3B.N0 — the public naming surface is an executable contract.
 *
 * These gates hold the vocabulary still while 3B.N1–N8 migrate it: the committed baseline must
 * match the live surface, the generator must be deterministic, the unresolved queue may only
 * shrink, and every curated exemption must name something that actually exists and actually needs
 * it. `unresolved` reaching zero is the 3B.N9 exit condition.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  flaggedTokens,
  generatePublicNamingManifest,
  readPublicNamingManifest,
  tokenize,
  type NamingIdentity,
} from './naming-inventory.js';
import {
  BARE_ONLY_TOKENS,
  CANONICAL_NAMES,
  CANONICAL_NAME_TOKENS,
  CANONICAL_TOKENS,
  CODE_NAMESPACES,
  CODE_SUFFIXES,
  COMPILE_FAIL_FIXTURES,
  FORBIDDEN_TOKENS,
  OPAQUE_STATE_ENVELOPES,
  ORDINARY_TOKENS,
  PACKAGE_IDENTITIES,
  SCOPED_SYMBOLS,
} from './naming-policy.js';

const live = generatePublicNamingManifest();
const liveNames = new Set(live.identities.map((identity) => identity.name));
const liveIds = live.identities.map((identity) => identity.id);
const DISPOSITIONS = new Set([
  'explicit',
  'canonical-term',
  'scoped-symbol',
  'opaque-state',
  'unresolved',
]);

/** A scope is live when some identity is that type, or is a member declared inside it. */
function scopeIsLive(scope: string): boolean {
  return liveIds.some((id) => id.endsWith(`|${scope}`) || id.includes(`|${scope}.`));
}

function label(identity: NamingIdentity): string {
  return `${identity.id} (${identity.disposition})`;
}

describe('public naming conformance (Phase 3B.N)', () => {
  it('the committed baseline matches the live public surface exactly', () => {
    const committed = readPublicNamingManifest();
    expect(
      committed,
      'missing tools/manifest/public-naming.json — run pnpm naming:update',
    ).toBeTruthy();
    expect(committed).toEqual(live);
  }, 180_000);

  it('the generator is deterministic', () => {
    expect(generatePublicNamingManifest()).toEqual(live);
  }, 180_000);

  it('never publishes TypeScript process-local unique-symbol ids as caller-facing names', () => {
    expect(live.identities.filter((identity) => identity.name.startsWith('__@'))).toEqual([]);
  });

  it('the unresolved migration queue never grows', () => {
    const committed = readPublicNamingManifest();
    expect(live.summary.unresolved).toBeLessThanOrEqual(committed!.summary.unresolved);
  });

  it('every identity carries a known disposition', () => {
    const bad = live.identities.filter((identity) => !DISPOSITIONS.has(identity.disposition));
    expect(bad.map(label), 'identities with no valid disposition').toEqual([]);
  });

  /**
   * A canonical term is a CLAIM that a name is the one the literature prints. An entry with an empty
   * rationale is that claim with nothing behind it — indistinguishable, from the outside, from the
   * silence this gate was reopened for.
   */
  it('every canonical-term and scoped-symbol carries a written rationale', () => {
    const blank = live.identities
      .filter((i) => i.disposition === 'canonical-term' || i.disposition === 'scoped-symbol')
      .filter((i) => (i.policy ?? '').trim().length === 0);
    expect(blank.map(label), 'allowlisted with no recorded reason').toEqual([]);
  });

  /**
   * EVERY SHORT TOKEN IS DISPOSITIONED — the rule that closes the `explicit` blind spot.
   *
   * `explicit` was the default for any name carrying no denylisted token, so "no rule recognized
   * this" and "this was reviewed" produced the same verdict. 203 one-to-three-character tokens sat
   * in that gap: ordinary words like `bar` and `day` beside genuine truncations like `ma` + `Type`,
   * `v` + `rp`, `ad` + `v`, `d` + `k`, `pi` + `v`, `zcb` + `Option` and `volume` + `OiRatio`.
   *
   * Those seven are written split for a reason. This sentence names the RETIRED forms, and a
   * previous bulk rename rewrote every one of them into its replacement — leaving a paragraph that
   * called `movingAverageType` and `varianceRiskPremium` "genuine truncations", which is the exact
   * opposite of what it exists to say. It shipped that way and no gate could see it, because the
   * text was still perfectly grammatical. Split spellings are the same defence the removal fixtures
   * use, and for the same reason.
   *
   * A short token in an `explicit` name must now be one of four things — an ordinary word, an
   * approved canonical term with a written reason, an approved scoped symbol, or unresolved. There
   * is no fifth bucket, and silence is not one of the four.
   *
   * Only names that resolve to `explicit` are scanned: a token appearing solely inside an allowlisted
   * NAME (`c` from CVaR, `va` from VaR, `p` from pValue) is already accounted for by that name's own
   * declared pardon, and asking for it twice would be theatre.
   */
  it('every short token in an explicit name has a recorded disposition', () => {
    const ordinary = new Set(ORDINARY_TOKENS);
    const canonical = new Set(Object.keys(CANONICAL_TOKENS));
    const forbidden = new Set(Object.keys(FORBIDDEN_TOKENS));
    const scoped = new Set(
      Object.values(SCOPED_SYMBOLS).flatMap((rule) => rule.symbols.map((s) => s.toLowerCase())),
    );
    const undispositioned = new Map<string, string>();
    for (const identity of live.identities) {
      if (identity.disposition !== 'explicit') continue;
      for (const token of tokenize(identity.name)) {
        if (!/^[a-z]{1,3}$/.test(token)) continue;
        if (
          ordinary.has(token) ||
          canonical.has(token) ||
          forbidden.has(token) ||
          scoped.has(token)
        )
          continue;
        if (!undispositioned.has(token)) undispositioned.set(token, identity.name);
      }
    }
    const offenders = [...undispositioned.entries()].map(
      ([token, example]) =>
        `'${token}' (e.g. ${example}) — classify it: ORDINARY_TOKENS, CANONICAL_TOKENS with a ` +
        `reason, SCOPED_SYMBOLS, or FORBIDDEN_TOKENS with a rename direction`,
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no identity is called explicit while carrying a forbidden token', () => {
    const leaks = live.identities
      .filter((identity) => identity.disposition === 'explicit')
      .filter((identity) => flaggedTokens(identity.name).length > 0);
    expect(leaks.map(label), 'forbidden tokens classified as explicit').toEqual([]);
  });

  /**
   * 3B.N IS REOPENED, and this is the number that reopened it.
   *
   * This gate read "the migration queue is EMPTY" and passed for the whole of 3B.N. It was measuring
   * "no token the denylist recognized", which is not the same claim and was mistaken for it — by me,
   * in the closeout, in writing. Three tokenizer blind spots hid real names:
   *
   *   a digit ended scrutiny   `vol1`, `vol2`, `iv10Put`, `rr10`, `bf25`, `rangeAverage5` — `avg` had
   *                            been on the denylist since N0 and `rangeAverage5` still passed
   *   embedding hid a letter   `v` + `ShortUpper` / `ShortLower` — only a WHOLE single-letter name
   *                            was checked (written as a concatenation: a sweep rewrote this line
   *                            into the replacement name and inverted its meaning)
   *   short ≠ reviewed         `lo`, `hi`, `mult`, `bb`, `kc`, `rr`, `bf` were never on the list
   *
   * With those closed the queue is 199, not 0. The bound is a RATCHET on the corrected measurement,
   * not an exit condition: it may only fall. Each entry needs a rename or a recorded canonical/scoped
   * rationale, and roughly a quarter (`mult` 18, `bb` 17, `kc` 13, `hi`/`lo` 6 each, `vol` 4, `iv` 4)
   * are true truncations the reviewer named; most of the rest are mathematical symbols (`r` 53,
   * `k` 20, `d` 13, `z` 11) that need a scoped rationale rather than a rename.
   *
   * Leaving this at `toEqual([])` would be a knowingly-red gate, which this repo does not ship;
   * quoting 0 again would be the original defect. A falling bound is the honest third option.
   *
   * ============================ 86 -> 0. THIS IS THE THIRD ZERO. ============================
   *
   * The first two were wrong, and the difference is the only thing that makes this one worth
   * anything:
   *
   *   ZERO #1 (3B.N closeout) measured "no token the DENYLIST RECOGNIZED". Names carrying a trailing
   *           digit, an embedded single letter, or an unlisted short truncation were never presented
   *           to it. Silence, reported as review.
   *   ZERO #2 (RV8) measured a corrected tokenizer, but `explicit` was still the DEFAULT for any
   *           short token no rule had an opinion about. 203 one-to-three-character tokens had never
   *           been looked at; they were merely unrecognized. Correcting that raised the queue to 86.
   *   ZERO #3 (this one) measures: every short token in an `explicit` name is an ordinary word, an
   *           approved canonical term WITH a written reason, an approved scoped symbol, or in this
   *           queue. There is no fifth bucket and no default.
   *
   * Seven batches: `oi` 7, `vrp` 10, `zcb` 3, `lw`+`adv` 8, `ma`+`agg` 38, the parameter families
   * (`def`/`scn`/`acc`/`src`/`val`) 7, and the last thirteen bare tokens on math, volatility and TA.
   *
   * WHAT WOULD MAKE THIS ZERO FALSE AGAIN, and what now stops each:
   *   - a canonical pardon added without declaring which tokens it excuses -> the two key-set gates
   *     below (an absent excuse list now pardons NOTHING; the fallback that pardoned everything is
   *     gone)
   *   - an excuse naming a token the name does not contain -> "every excused token actually occurs"
   *   - a rule whose stated reason was swept into comparing a term with itself -> "no policy
   *     rationale compares a term with itself"
   *   - a tracker quietly drifting from the artifact -> "every stated disposition count matches"
   *   - a pardon written for one meaning landing on another -> not gated. `ar` and `tc` were each
   *     pardoned for a quantity that does not occur anywhere in the surface, while excusing exactly
   *     one field that the reason misdescribed. Both were deleted. A rule that pardons only things
   *     its own rationale does not describe is still findable only by reading.
   *   - a public spelling this inventory cannot see -> the KNOWN HOLE recorded below: string-LITERAL
   *     union members are not walked. `RankByKey` moved only because the compiler forced it.
   *
   * The bound stays a ratchet rather than becoming `toEqual([])`, because the number is what carries
   * the history: a future reader can see it fall, and a future regression has to explain a rise.
   *
   * 86 -> 79: the `oi` family, spelled out to `openInterest` on `GexSplit`, `Levels`, `FlowGroup`
   * and `RankOptions`. First batch of the RV9 renames; `oi` leaves the token list entirely.
   *
   * GATE GAP THIS FAMILY EXPOSED, recorded because it is not yet closed. The retired
   * `FlowGroup.volumeOiRatio` was ALSO a member of the `RankByKey` string union — a value a caller
   * passes as DATA, not merely a declared field. This inventory walks declared identifiers and TS
   * `enum` members; it does NOT walk string-LITERAL union members, so that public spelling was
   * invisible to every gate in this file. It moved only because `rank` sorts with `b[by]`, which
   * makes the union members structurally equal to `FlowGroup` keys and forced the compiler to
   * object. A union whose members are NOT keys of some walked type would have gone unnoticed.
   * Widening the inventory to string-literal unions is its own batch — it will surface identities
   * no one has reviewed — so this note exists to make the hole a KNOWN hole rather than a silent
   * one. `tools/naming-removals.test.ts` carries the executable evidence that this particular value
   * moved, since the baseline could not testify to it.
   *
   * 0 -> 86 (RV9). The queue GREW because the denylist finally reaches the tokens it was missing.
   *
   * `explicit` was the default for any name carrying no denylisted token, so 203 one-to-three
   * character tokens had never been reviewed — they were merely unrecognized. Classifying all of
   * them (77 ordinary words, 111 published identities each with a written reason, 15 truncations)
   * put 86 identities into the queue that were previously invisible: the `ma`/`vrp`/`oi`/`lw`/`adv`/
   * `zcb`/`dk` families the review named.
   *
   * A number that rises when a rule starts working is the rule working. The renames were the
   * remaining half and were deliberately NOT bundled into that commit — see the note below on why a
   * bare-token sweep is unsafe. They landed across the seven batches recorded above.
   *
   * 135 -> 0 (RV8). THIS ZERO WAS NOT THE OLD ZERO, and the difference was the whole point.
   *
   * The old zero meant "no token the denylist recognized" — silence, reported as review. This one
   * means every public identity either passes the corrected checks (which now see through numeric
   * suffixes, embedded single letters and short truncations) or carries a WRITTEN rationale naming
   * the literature it comes from. 1,469 canonical-term entries, and a sibling assertion holds that
   * none of them is blank.
   *
   * The last 131 were notation, not truncation: VaR/CVaR, R², p-value, stochastic %K/%D, Ichimoku
   * Senkou spans, Bollinger %B, greeks partials (`dSpot`), Gatheral's `g`, SSVI's `w`, G2++,
   * z-score/Z-spread, k-fold. Each got its own NAME entry — 66 of them — because a `r`/`k`/`d`/`z`
   * TOKEN entry would exempt every compound containing that letter, which is exactly the blanket
   * exemption that produced this queue.
   *
   * 181 -> 135: the Bollinger/Keltner/multiplier families. Every remaining entry is now a single
   * mathematical letter (`r` 53, `k` 20, `d` 13, `z` 11, …) plus two `avg`, which want individual
   * scoped rationales rather than renames — and individually, since one widened rule is what hid
   * this whole queue.
   *
   * 191 -> 181: the skew desk vocabulary (`iv10Put`/`rr25`/`bf25` -> `put10DeltaImpliedVolatility`,
   * `riskReversal25Delta`, `butterfly25Delta`) and the candle body fields. `GannHiLo` keeps its
   * spelling by EXACT allowlist — the published indicator name — which is the shape every remaining
   * symbol should take rather than a widened rule.
   *
   * 199 -> 191: the volatility-bracket and two-asset-spread forms are renamed
   * (`lowerVolatilityBound`/`upperVolatilityBound`, `volatility1`/`volatility2`), with removal
   * evidence recorded — 35 retired forms became 39. The bound moves with every batch; a batch that
   * does not move it did not land.
   */
  it('the reopened short-token queue only shrinks', () => {
    const unresolved = live.identities.filter((i) => i.disposition === 'unresolved');
    expect(
      unresolved.length,
      `the queue grew — expand the name, or record its exemption in naming-policy.ts with a reason:\n${unresolved.map(label).join('\n')}`,
    ).toBeLessThanOrEqual(0);
  });

  /**
   * Law N4 has a blind spot the token check cannot see. `timeToExpiry` contains no forbidden token
   * — it tokenizes to `['time','to','expiry']` — so the inventory calls it `explicit` even while
   * `timeToExpiryYears` names the SAME quantity elsewhere in the same file. Zero unresolved
   * identities therefore does NOT prove the vocabulary is unit-complete.
   *
   * The mechanically checkable half of that law: if the surface publishes `X` and `XYears`, one of
   * them is hiding its unit. Same for the other unit suffixes the library uses. No judgment call —
   * either both spellings are public or they are not.
   */
  it('no public name is the unit-suffixed twin of another (law N4)', () => {
    // TIME units only. `Fraction`/`Percent`/`Bps` CHANGE the quantity rather than annotate it —
    // `basis` (future − spot, in currency) and `basisFraction` (future/spot − 1) are two different
    // numbers that both deserve a name, so pairing them would be a false alarm.
    const UNIT_SUFFIXES = ['Years', 'Ms', 'Seconds', 'Days'];
    // Data positions only. An EXPORT may legitimately be a verb phrase whose object happens to be a
    // unit (`addDays` is "add days", not "add, in days"); a field or parameter never is.
    const DATA_KINDS = new Set(['field', 'parameter', 'method']);
    // A bare name that denotes an INSTANT or a LABEL is not the unit-stripped form of a duration:
    // `expiry` is a date ('2026-01-01' or an epoch), `expiryYears` is a time remaining. Both are
    // needed and neither hides anything. Each entry states which is which.
    const DIFFERENT_QUANTITY: Readonly<Record<string, string>> = {
      expiry: 'a date/instant label; `expiryYears` is the time remaining to it',
      maturity: 'a maturity DATE string; `maturityYears` is the year fraction to it',
      interval: 'a resample interval token (e.g. `5m`); `intervalMs` is its length in ms',
      time: 'a tick/bar timestamp — an instant; `timeYears` is a span measured in years',
      period: 'a lookback/window COUNT of bars or rows; `periodDays` is a calendar-day span',
    };
    const names = new Set(
      live.identities.filter((i) => DATA_KINDS.has(i.kind)).map((identity) => identity.name),
    );
    const twins: string[] = [];
    for (const name of names) {
      for (const suffix of UNIT_SUFFIXES) {
        if (!name.endsWith(suffix)) continue;
        const bare = name.slice(0, -suffix.length);
        if (bare.length <= 2 || !names.has(bare)) continue;
        if (bare in DIFFERENT_QUANTITY) continue;
        twins.push(`${bare} vs ${name}`);
      }
    }
    expect(
      [...new Set(twins)].sort(),
      `both spellings are public — the bare one hides its unit:\n${[...new Set(twins)].join('\n')}`,
    ).toEqual([]);
  });

  it('any unresolved identity still names the token that flagged it and a canonical direction', () => {
    const unresolved = live.identities.filter((i) => i.disposition === 'unresolved');
    const broken = unresolved.filter(
      (identity) =>
        !identity.forbidden?.length ||
        identity.forbidden.some((token) => !live.summary.directions[token]),
    );
    expect(broken.map(label), 'unresolved identities missing a token or direction').toEqual([]);
  });

  // ---- The curated policy may not go stale (law N7: every exception is reviewed and real) ----

  it('every canonical-name exemption is live AND actually needs the exemption', () => {
    const problems: string[] = [];
    for (const name of Object.keys(CANONICAL_NAMES)) {
      if (!liveNames.has(name)) {
        problems.push(`${name}: not a live public name`);
        continue;
      }
      if (flaggedTokens(name).length === 0)
        problems.push(`${name}: needs no exemption — delete it rather than imply one`);
    }
    expect(problems, `stale canonical-name policy:\n${problems.join('\n')}`).toEqual([]);
  });

  it('every scoped-symbol and opaque-state scope is live', () => {
    const stale = [...Object.keys(SCOPED_SYMBOLS), ...Object.keys(OPAQUE_STATE_ENVELOPES)]
      .filter((scope) => !scope.includes(':'))
      .filter((scope) => !scopeIsLive(scope));
    expect(stale, `policy scopes that name nothing live:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every settled package identity still names a live package or subpath', () => {
    const ids = new Set(liveIds);
    /** `@totalfinance/volatility` → its package id; `@totalfinance/volatility/local-volatility` → that package's subpath id. */
    const isLive = (identity: string): boolean => {
      const parts = identity.split('/');
      const owner = identity.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      const rest = parts.slice(identity.startsWith('@') ? 2 : 1);
      return rest.length === 0
        ? ids.has(`${owner}|package|${owner}`)
        : ids.has(`${owner}|subpath|./${rest.join('/')}`);
    };
    const stale = Object.keys(PACKAGE_IDENTITIES).filter((identity) => !isLive(identity));
    expect(stale, `settled renames whose source identity is gone:\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  it('every recorded compile-fail fixture has a unique id and a landing phase', () => {
    const ids = COMPILE_FAIL_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size, 'duplicate compile-fail fixture ids').toBe(ids.length);
    // A landing phase is a 3B.N migration batch, a Stage 4.x slice, or a pre-publish repairs item
    // (`repairs.B7`, `repairs.B6`, `repairs.C` — the last free renames before the surface freezes).
    const unphased = COMPILE_FAIL_FIXTURES.filter(
      (f) => !/^(3B\.N[1-9]|4\.[0-9]|repairs\.(B[1-7]|C))$/.test(f.landsIn),
    );
    expect(
      unphased.map((f) => f.id),
      'fixtures with no migration phase',
    ).toEqual([]);
  });

  /**
   * A removal fixture is EVIDENCE: `before` records the retired form, `after` the replacement. A
   * repo-wide rename that rewrites the `before` side collapses the pair into `X → X`, which proves
   * nothing while still counting as a fixture. Six of nineteen were in that state before this gate
   * existed — the reason the surviving entries build their `before` by string concatenation.
   */
  it('no removal fixture is tautological (before !== after)', () => {
    const tautological = COMPILE_FAIL_FIXTURES.filter((f) => f.before === f.after).map(
      (f) => `${f.id}: ${f.before} → ${f.after}`,
    );
    expect(
      tautological,
      `these fixtures prove nothing — a rename sweep rewrote the retired form into its replacement:\n${tautological.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The same corruption, one level up: a settled-namespace or settled-suffix map whose KEY equals
   * its own value is a retired rule wearing a live one's clothes (`volatility: 'volatility'`).
   */
  it('no settled code-namespace or suffix maps a name to itself', () => {
    const selfMapped = [
      ...Object.entries(CODE_NAMESPACES),
      ...Object.entries(CODE_SUFFIXES),
    ].filter(([from, to]) => from === to);
    expect(
      selfMapped.map(([from]) => from),
      `settled code mappings that changed nothing — the key was rewritten into its replacement:\n${selfMapped
        .map(([from, to]) => `${from} → ${to}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  // ---- The settled renames must stay visible until they are actually performed ----

  it('the settled package, umbrella, and flagship renames are still queued', () => {
    const byId = new Map(live.identities.map((identity) => [identity.id, identity]));
    // Each family left this list in the commit that landed it, exactly as the failure message
    // instructs: the package / umbrella-subpath / umbrella-namespace / MCP-domain identities in
    // 3B.N1, then `spec`, `rng`, `fn`, `var`/`cvar`, the `local-vol` and `stats` subpaths, the
    // generic `rate` and the whole statistics tail in 3B.N6. The list is EMPTY because every
    // settled rename has now been performed — which is what 3B.N9 asked for. It is kept (rather
    // than deleted) so a future settled-but-unperformed rename has a home that already has teeth.
    const mustBeUnresolved: string[] = [];
    const wrong = mustBeUnresolved.filter((id) => byId.get(id)?.disposition !== 'unresolved');
    expect(
      wrong,
      `settled rename targets that are no longer queued — if the rename landed, remove the entry here in the SAME commit:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });
});

describe('naming tokenizer', () => {
  it('splits camel, Pascal, acronym runs, separators, and digits', () => {
    expect(tokenize('atm' + 'Vol')).toEqual(['atm', 'vol']);
    expect(tokenize('timeToExpiryYears')).toEqual(['time', 'to', 'expiry', 'years']);
    expect(tokenize('RSIValue')).toEqual(['rsi', 'value']);
    expect(tokenize('toJSON')).toEqual(['to', 'json']);
    expect(tokenize('volatility.surface_extrapolated')).toEqual([
      'volatility',
      'surface',
      'extrapolated',
    ]);
    expect(tokenize('totalfinance.technical_analysis.calculate')).toEqual([
      'totalfinance',
      'technical',
      'analysis',
      'calculate',
    ]);
  });

  it('keeps a name whose identity includes a number in one token', () => {
    expect(tokenize('T3Parameters')).toEqual(['t3', 'parameters']);
    expect(tokenize('PV01')).toEqual(['pv01']);
    // Built by concatenation: a bulk `ci95` → `confidenceInterval95` sweep would otherwise rewrite
    // the INPUT of the test that proves `ci95` tokenizes as one token, and the test would still
    // pass while asserting nothing. (This happened.)
    expect(tokenize('ci' + '95')).toEqual(['ci95']);
    expect(tokenize('v0')).toEqual(['v0']);
  });

  it('never splits a full word into a forbidden fragment', () => {
    // The whole reason matching is per-token: `volatility` must not be caught by `vol`, and
    // `beta`/`delta`/`theta` must not be caught by `ta`.
    for (const word of ['volatility', 'beta', 'delta', 'theta', 'metadata', 'statistics']) {
      expect(tokenize(word)).toEqual([word]);
    }
  });

  it('an abbreviation SPELLED OUT inside a name is a different token, by design', () => {
    // The module doc used to claim `atmVolatility` tokenizes to ['atm','vol'] "and is" flagged. It
    // does not and it is not: the forbidden-token rule governs names that USE an abbreviation, not
    // names that merely contain its letters. Pinning both spellings keeps the doc honest.
    expect(tokenize('atm' + 'Vol')).toEqual(['atm', 'vol']); // uses the abbreviation ⇒ flagged
    expect(tokenize('atmVolatility')).toEqual(['atm', 'volatility']); // spells it out ⇒ not flagged
    expect(tokenize('atmVolatility')).not.toContain('vol');
    expect(flaggedTokens('atmVolatility')).toEqual([]);
    expect(flaggedTokens('atm' + 'Vol')).toContain('vol');
  });
});

describe('the policy protects itself', () => {
  /**
   * A repo-wide specifier rewrite is how this phase migrates code, and `naming-policy.ts` is a
   * normal `.ts` file — so a sweep for `opts` → `options` will happily rewrite the forbidden-token
   * KEY `opts:` into `options:`, silently inverting the rule and marking 600+ correct names as
   * unresolved. This has happened; the gate exists so it cannot happen quietly again.
   */
  /**
   * The list-free version of the same guard, and the one that actually generalizes: a token can
   * never be its own replacement. `rng: { direction: 'randomNumberGenerator' }` rewritten to
   * `randomNumberGenerator: { direction: 'randomNumberGenerator' }` passed the hand-list check
   * below (nobody had thought to list `randomNumberGenerator`) while silently retiring the rule.
   */
  it('no forbidden token appears in its own replacement direction', () => {
    const bareOnly = new Set(BARE_ONLY_TOKENS);
    /** Prose words of a direction, NOT camel-split: `riskFreeRate` is one word, not three. */
    const words = (direction: string): string[] =>
      direction
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const selfReferential = Object.entries(FORBIDDEN_TOKENS)
      .filter(([token, rule]) =>
        // A bare-only token IS legal inside a role-qualified compound — `rate` → `riskFreeRate` is
        // the fix, not a corruption — so it is judged on whole words: the direction may not offer
        // the bare token back. Every other token may not appear in its replacement at all.
        bareOnly.has(token)
          ? words(rule.direction).includes(token)
          : tokenize(rule.direction).includes(token),
      )
      .map(([token, rule]) => `${token} → ${rule.direction}`);
    expect(
      selfReferential,
      `a token cannot be its own replacement — a bulk rename probably rewrote the policy's own keys:\n${selfReferential.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * A forbidden token is matched per TOKEN (see `flaggedTokens`), so a multi-token key can never
   * match anything: it is a dead rule that reads as a live one. Expanding a key in place — the exact
   * shape a bulk rename produces — is therefore silent, not loud, without this check.
   */
  it('every forbidden-token key is a single token', () => {
    const compound = Object.keys(FORBIDDEN_TOKENS).filter((token) => tokenize(token).length !== 1);
    expect(
      compound,
      `these keys can never match, so the rules are dead:\n${compound.join('\n')}`,
    ).toEqual([]);
  });

  it('no canonical replacement is itself registered as a forbidden token', () => {
    const canonical = [
      'options',
      'context',
      'parameters',
      'parameter',
      'volatility',
      'impliedVolatility',
      'realizedVolatility',
      'timestampMs',
      'riskFreeRate',
      'blackScholes',
      'monteCarlo',
      'technicalAnalysis',
      'statistics',
      'metadata',
      'standardDeviation',
      'arguments',
      'argument',
      'request',
      'result',
      'specification',
    ];
    const inverted = canonical.filter((name) => name in FORBIDDEN_TOKENS);
    expect(
      inverted,
      `these are canonical REPLACEMENTS, not forbidden tokens — a bulk rename probably rewrote the policy's own keys:\n${inverted.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * A hand-typed count in prose is a claim about the fixture list, and prose does not recompute.
   *
   * Two documents quoted this number and they disagreed: the naming spec's closeout table said
   * `35 of 35` while `docs/implementation-order.md` said "All 36 retired forms" — one sentence apart
   * from naming the very test file that proves the number. The fixture list and the removal test both
   * carry 35, so the spec was right and the prose had drifted; but nothing in CI could tell which,
   * which is why an external reviewer reasonably concluded the opposite. Neither number was checked
   * against the list it described.
   *
   * This binds every stated count to `COMPILE_FAIL_FIXTURES.length`. Retire a thirty-sixth form and
   * both documents fail until they say 36.
   */
  it('every stated retired-form count matches the fixture list', () => {
    const docs = [
      '../../docs/implementation-order.md',
      '../../docs/specs/phase-3b-public-naming-normalization.md',
    ];
    const expected = COMPILE_FAIL_FIXTURES.length;
    const wrong: string[] = [];
    for (const relative of docs) {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      const text = readFileSync(path, 'utf8');
      // "All 35 retired forms" and "| Retired forms ... | 35 of 35 |" are the two shapes in use.
      const prose = [...text.matchAll(/All (\d+) retired forms/g)].map((m) => Number(m[1]));
      const table = [...text.matchAll(/Retired forms[^|]*\|\s*(\d+) of (\d+)/g)].flatMap((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      for (const stated of [...prose, ...table]) {
        if (stated !== expected)
          wrong.push(`${relative}: states ${stated}, fixtures hold ${expected}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /**
   * The retired-form count above was bound to the fixture list, but the DISPOSITION counts in the
   * same paragraph were not bound to anything — and they rotted. At RV9 the tracker still read
   * "86 unresolved; 18,124 explicit; 1,469 canonical" against a live baseline of 79 / 17,532 /
   * 1,982: three numbers wrong in one sentence, in the document that tells a reader where the phase
   * stands, with every gate green. Being next to a gated number is not the same as being gated.
   */
  /**
   * RV9 — a canonical pardon must be DECLARED, not inferred.
   *
   * `classify` used to read `CANONICAL_NAME_TOKENS[name] ?? tokenize(name)`: with no companion
   * entry, the fallback excused every token in the name. That is the whole-identifier pardon the
   * split was introduced to kill, reachable again by simply forgetting half of it — and the longer
   * the name, the more it forgave. The fallback is gone, so an undeclared entry now excuses nothing
   * and the name flags its own tokens.
   *
   * These two assertions are what stop that from being a merely theoretical improvement. Without
   * them a future author could satisfy the generator with an empty array (excuse nothing, but also
   * claim nothing) or with tokens that do not appear in the name at all — a rationale about a
   * different word.
   */
  /**
   * A RATIONALE THAT QUOTES THE SAME IDENTIFIER TWICE HAS USUALLY LOST A CONTRAST.
   *
   * Every rule in this policy is written as "the retired form reads badly where the canonical form
   * reads as itself" — two DIFFERENT backticked terms. A bulk rename rewrites both sides, and the
   * sentence collapses into one term compared with itself. It has happened twice on this branch and
   * shipped both times, because the result is still grammatical and nothing in CI reads prose:
   *
   *   FORBIDDEN_TOKENS.ma.why   "`movingAverageType` reads as a two-letter riddle where
   *                              `movingAverageType` reads as itself"
   *   the short-token gate      "genuine truncations like `movingAverageType`, `varianceRiskPremium`,
   *                              `averageDailyVolume` …" — the REPLACEMENTS, called truncations
   *
   * This is a heuristic, not a proof, so it carries an explicit allowlist rather than pretending to
   * be exact: a term may legitimately repeat (Gatheral's `g` appears twice in three SVI rationales
   * because the sentence is genuinely about `g` twice). What the gate buys is that a NEW repeat has
   * to be looked at by a person — which is all that was missing both times.
   *
   * The fix at each site is a split spelling (`'ma' + 'Type'`), the same defence the removal
   * fixtures use, so the next sweep cannot reach it.
   */
  /**
   * EVERY KEY IN A TOKEN MAP MUST ACTUALLY BE A TOKEN.
   *
   * RV10 — a rename sweep rewrote `'abs'` in ORDINARY_TOKENS into `'absolute'` and the
   * `tif:` key of CANONICAL_TOKENS into `timeInForce:`. Both are the trap this phase keeps hitting:
   * the policy names the abbreviation it governs, so the abbreviation appears as a literal string in
   * this file, and a sweep of that abbreviation rewrites the RULE along with the code. The result is
   * a rule that can never fire — `tokenize` never produces `timeInForce` or `absolute` as a
   * one-to-three-character token — sitting in the file reading exactly like a live one.
   *
   * The sibling gate ("no policy rationale compares a term with itself") catches the same sweep when
   * it lands in a RATIONALE. This catches it when it lands in a KEY, which is the more dangerous
   * half: a dead rationale merely misinforms, a dead key silently stops governing.
   *
   * The test is that a key round-trips through the real tokenizer to itself. `pv01` and `t3` pass —
   * they are what `tokenize` emits. `timeInForce` and `absolute` do not.
   */
  it('every token-map key is a token the tokenizer can actually produce', () => {
    const bad: string[] = [];
    const check = (map: string, key: string) => {
      const tokens = tokenize(key);
      if (tokens.length !== 1 || tokens[0] !== key) {
        bad.push(`${map}: '${key}' is not a token (tokenize -> [${tokens.join(', ')}])`);
      }
    };
    for (const key of ORDINARY_TOKENS) check('ORDINARY_TOKENS', key);
    for (const key of Object.keys(CANONICAL_TOKENS)) check('CANONICAL_TOKENS', key);
    for (const key of Object.keys(FORBIDDEN_TOKENS)) check('FORBIDDEN_TOKENS', key);
    for (const key of BARE_ONLY_TOKENS) check('BARE_ONLY_TOKENS', key);
    expect(
      bad,
      `a token map is keyed by something the tokenizer never emits, so the rule can never fire —\nusually a rename sweep that rewrote the rule along with the code:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('no policy rationale compares a term with itself', () => {
    const ALLOWED_REPEATS = new Set(['minButterflyG', 'sviG', 'sviMinG']);
    const repeated = (text: string): string[] => {
      const counts = new Map<string, number>();
      for (const match of text.matchAll(/`([^`]+)`/g)) {
        const term = match[1]!;
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      return [...counts.entries()].filter(([, n]) => n > 1).map(([term, n]) => `${term} x${n}`);
    };
    const offenders: string[] = [];
    const check = (kind: string, key: string, text: string) => {
      if (ALLOWED_REPEATS.has(key)) return;
      const dupes = repeated(text);
      if (dupes.length > 0) offenders.push(`${kind} ${key}: repeats ${dupes.join(', ')}`);
    };
    for (const [token, rule] of Object.entries(FORBIDDEN_TOKENS))
      check('FORBIDDEN_TOKENS', token, rule.why);
    for (const [token, why] of Object.entries(CANONICAL_TOKENS))
      check('CANONICAL_TOKENS', token, why);
    for (const [name, why] of Object.entries(CANONICAL_NAMES)) check('CANONICAL_NAMES', name, why);
    for (const [scope, rule] of Object.entries(SCOPED_SYMBOLS))
      check('SCOPED_SYMBOLS', scope, rule.rationale);
    expect(
      offenders,
      `a rule whose reason names one term twice has probably had its contrast swept away — read it,\nand if it is correct, write the retired side as a split spelling and add the key to ALLOWED_REPEATS:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every canonical NAME declares exactly the tokens its rationale excuses', () => {
    const named = Object.keys(CANONICAL_NAMES).sort();
    const declared = Object.keys(CANONICAL_NAME_TOKENS).sort();
    const withoutTokens = named.filter((name) => !(name in CANONICAL_NAME_TOKENS));
    expect(
      withoutTokens,
      `allowlisted names with no declared excuse list — they now pardon NOTHING, which is correct but\nalmost certainly not what was intended; write the tokens the rationale is about:\n${withoutTokens.join('\n')}`,
    ).toEqual([]);
    const orphaned = declared.filter((name) => !(name in CANONICAL_NAMES));
    expect(
      orphaned,
      `excuse lists for names that are no longer allowlisted — dead entries that read like live ones:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });

  it('every excused token is EXACTLY the set the name would otherwise be flagged for', () => {
    /**
     * RV10 — the test said "exactly" and checked containment.
     *
     * Requiring each excused token merely to OCCUR in the name lets an entry list tokens that occur
     * but are not flagged: an excuse that pardons nothing while reading like it pardons something.
     * That is the `['r', 'c']` VaR defect in miniature — nineteen entries excusing a `c` that no VaR
     * name has — and containment is exactly the check that missed it.
     *
     * The excuse set must EQUAL `flaggedTokens(name)`. Too few and the name lands in the queue
     * anyway, which the queue already reports; too many and the entry is claiming a pardon it does
     * not need, which nothing reported until now.
     */
    const wrong: string[] = [];
    for (const [name, tokens] of Object.entries(CANONICAL_NAME_TOKENS)) {
      const flagged = [...new Set(flaggedTokens(name))].sort();
      const excused = [...new Set(tokens)].sort();
      if (flagged.length === 0) {
        wrong.push(
          `${name}: carries no flagged token, so its excuse list [${excused.join(', ')}] pardons nothing`,
        );
        continue;
      }
      if (excused.join(',') === flagged.join(',')) continue;
      const absent = excused.filter((t) => !flagged.includes(t));
      const unexcused = flagged.filter((t) => !excused.includes(t));
      wrong.push(
        `${name}: excuses [${excused.join(', ')}] but is flagged for [${flagged.join(', ')}]` +
          (absent.length > 0 ? ` — excuses nothing for [${absent.join(', ')}]` : '') +
          (unexcused.length > 0 ? ` — leaves [${unexcused.join(', ')}] unexcused` : ''),
      );
    }
    expect(
      wrong,
      `an excuse list must be exactly the tokens the name is flagged for:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  it('every stated disposition count matches the generated baseline', () => {
    const path = fileURLToPath(new URL('../../docs/implementation-order.md', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const number = (raw: string | undefined): number | null =>
      raw === undefined ? null : Number(raw.replace(/,/g, ''));
    const claims: Array<[string, number | null, number]> = [
      [
        'identities walked',
        number(/([\d,]+) public naming identities are walked/.exec(text)?.[1]),
        live.summary.identities,
      ],
      [
        'unresolved',
        number(/are walked and ([\d,]+) are unresolved/.exec(text)?.[1]),
        live.summary.unresolved,
      ],
      [
        'explicit',
        number(/([\d,]+) are `explicit`/.exec(text)?.[1]),
        live.summary.byDisposition['explicit'] ?? -1,
      ],
      [
        'canonical-term',
        number(/([\d,]+) allowlisted canonical terms/.exec(text)?.[1]),
        live.summary.byDisposition['canonical-term'] ?? -1,
      ],
      [
        'scoped-symbol',
        number(/([\d,]+) are scoped notation/.exec(text)?.[1]),
        live.summary.byDisposition['scoped-symbol'] ?? -1,
      ],
      [
        'opaque-state',
        number(/([\d,]+) are opaque payload interiors/.exec(text)?.[1]),
        live.summary.byDisposition['opaque-state'] ?? -1,
      ],
    ];
    // A claim that no longer parses is a claim that stopped being checked — the exact shape of the
    // defect this test exists for. Rewording the sentence must update the pattern, not silence it.
    const unparsed = claims.filter(([, stated]) => stated === null).map(([label]) => label);
    expect(
      unparsed,
      `implementation-order.md no longer states these — restore the sentence or update the patterns:\n${unparsed.join('\n')}`,
    ).toEqual([]);
    const wrong = claims
      .filter(([, stated, actual]) => stated !== actual)
      .map(([label, stated, actual]) => `${label}: states ${stated}, baseline says ${actual}`);
    expect(
      wrong,
      `docs/implementation-order.md is stale — run \`pnpm naming:update\` and update the prose:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  /** The count is only meaningful if each fixture is actually proven by the removal test. */
  it('every fixture id appears in the executable removal evidence', () => {
    const path = fileURLToPath(new URL('../naming-removals.test.ts', import.meta.url));
    const evidence = readFileSync(path, 'utf8');
    const unproven = COMPILE_FAIL_FIXTURES.filter((f) => !evidence.includes(f.id)).map((f) => f.id);
    expect(
      unproven,
      `fixtures counted as evidence but never asserted:\n${unproven.join('\n')}`,
    ).toEqual([]);
  });
});
