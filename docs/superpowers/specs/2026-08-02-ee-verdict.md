# Verdict: the exploration/exploitation redesign

Judgment, 2026-08-02. Four contenders: `decision-theory`, `conversation`, `minimalist`, and the incumbent as it stands in the working tree (uncommitted fixes included). Every judgment below is grounded in a mechanism read in the source document or in `src/`, not in a document's summary of itself. Where a design's walkthrough contradicts its own rules, that is called out and weighted heavily, because a walkthrough is where a designer is most likely to assume away the thing they built.

Three verifications done against the running code, cited throughout:

- `grep -rn "\.kind" src/ontology src/prompts` returns **nothing**. The incumbent stores `node_facts.kind` and never reads it. Its only closure rule is `shouldDeplete`, whose entire body is `avgYieldChars < depletionRatio * personMedianChars`.
- `ALL_DOMAINS` in `src/ontology/types.ts` has **10** entries. There is no `tastes-preferences`.
- I ran the incumbent's new fuzzy topic guard. `nearestPrior("childhood food", ["food memories"])` returns similarity **0.333** against a `NEAR_DUPLICATE_THRESHOLD` of **0.5**. The uncommitted fix does not fire on the example its own code comment cites as the motivation. `"area of growth"` vs `"new skills"` scores 0.0, and `"reading progress"` vs `"self improvement"` scores 0.0.

---

## 1. Scorecard

| | Incumbent | Decision-theory | Conversation | Minimalist |
|---|---|---|---|---|
| S1 settled preference, no length heuristic | **fail** | **pass** | **pass** | **partial** |
| S2 vada pav not re-asked for two days | **partial** | **pass** | **pass** | **pass** |
| S3 event follow-up fires next day | **fail** | **pass** | **partial** | **fail** |
| S4 no same-day twins | **partial** | **pass** | **partial** | **pass** |
| S5 semantic family structurally blocked | **fail** | **pass** | **partial** | **partial** |
| S6 all-explore drift impossible | **partial** | **pass** | **pass** | **pass** |
| S7 cold start | **partial** | **pass** | **pass** | **pass** |
| S9 implementability | **free / capped** | **heaviest** | **largest surface** | **cheapest** |
| S10a semantic closure, mechanism verified | **fail** | **pass** | **pass** | **pass** |
| S10b tastes-preferences domain | **fail** | **pass** | **pass** | **pass** |
| S10c multi-homed facts | **fail** | **pass (facts + subjects)** | **pass (facts)** | **pass (facts)** |

### S1. "I've liked paneer since childhood"

**Incumbent, fail.** There is no semantic closure mechanism in the codebase at all. `kind` is unread, and the one closure rule that exists is literally a length heuristic, which is the thing the scenario forbids by name. Worse, `shouldDeplete` also requires `timesAsked >= depletionMinAskings (2)`, and the ontology doc itself established that most nodes are asked zero or one times ever, so the rule is dead code guarding nothing. Paneer is protected for exactly two days by `isSettling`, then reappears as a `lastAsked === null` node at `rank()` 1 or 2, which is the head of the exploit list. Compounding it: with no `tastes-preferences` domain, paneer files under `childhood` or `hobbies-interests` and corrupts the domain counts that drive explore.

**Decision-theory, pass.** `interest` plus `fact` with no thread computes continuation class `standing`. `FOLLOW_UP` requires `pending`, `DEEPEN` requires `open`, so neither emits a candidate. Only `REVISIT` can reach it, and its Timeliness is 0 until `g >= 21`. Length appears in no term of `V`.

**Conversation, pass.** `openness = open threads + pending hooks = 0`, so the subject settles and then finishes. `return_not_before` is `asked + 45`. No length input anywhere.

**Minimalist, partial, on an internal contradiction.** The budget table says `kind='fact'` grants budget **0**, and the algorithm's exploit predicate is `budget > 0`. That means a settled fact subject can never be asked **at all**. But invariant 7 is titled "a settled fact is asked at most once, ever" and its body says budget 0 "can produce exactly one question in its lifetime". The document contradicts itself, and the arithmetic reading is the stricter one. Either reading blocks the re-ask, so the scenario's letter is satisfied, but under the code as written paneer produces zero good questions rather than one, and every `fact`-only subject is born permanently invisible. This is a defect, not a rounding error, and it is fixable in one line (see Synthesis).

### S2. Vada pav, rich and warm, asked once

**Incumbent, partial.** There are two independent guards and both are correct in shape: the 14-day `exploitCooldownDays` and the 2-day `settlingDays`. The uncommitted patch is genuinely right here, and the important part is the sign flip: fresh facts now **extend** the exclusion instead of promoting the node, which is exactly the correction the failure demanded. But both guards depend on attribution. `recordAsked` fires only when `validA && targetNodeId !== null`. It does not fire on explore-stance days, and `adaptive.ts` explicitly ships an unattributed question on a final-attempt target miss with `targetNodeId: null`. In either case vada pav is a `lastAsked === null` rich node on day 3, which `rank()` puts first. The guard is real but its input is model-supplied.

**Decision-theory, pass.** G1 blocks the node for 21 days and reads `moves_log`, which is written at dispatch and therefore never depends on late extraction. G2 blocks it for 2 days on fresh facts. The single exception is gated on the `event_date` column, which a food preference does not have. Double coverage, and the design says so.

**Conversation, pass.** The first row of the P2 table sets `return_not_before = max(current, d + 3)` on every fact arrival, which freezes the subject for exactly the days it repeated on. The only bypass requires a dated event.

**Minimalist, pass.** Invariants 2 and 3, both derived from `asks` (written at dispatch), both audited nightly as SQL over live history. This is the strongest form of the same guarantee because it is checked in production rather than only in fixtures.

### S3. Psychic party. The one everyone loves.

This is where the field separates, and two contenders fail on their own mechanisms.

**Incumbent, fail, and this is the finding that sinks its "the architecture is right" claim.** Two blockers, neither touched by this week's patches.

First: `decideStance` returns `"explore"` whenever either of the last two days contained an exploit. Nothing in the LIVE path can override a day stance. So a follow-up due tomorrow is simply not asked if yesterday happened to be an exploit day. The 3-day `liveEventWindowDays` buys two more chances at declining quality, and the same rule can eat those too.

Second, even on an exploit day, LIVE only sets `rank()` to 0, which puts the node first in a five-item menu handed to the model. The system prompt says a LIVE marker "usually deserves the pick". Nothing in code enforces it. The single behavior the owner calls non-negotiable rests on a prompt adverb, in a project whose entire failure record is model judgment going the other way.

These two are not independent bugs. They are the same one: a single day-level explore/exploit scalar cannot simultaneously guarantee exploit variety (S6) and let a dated follow-up fire (S3). Every patch to that scalar trades one for the other. There is no place inside this architecture to put the follow-up, which is why all three challengers, independently, gave it a dedicated non-competing lane.

**Decision-theory, pass, and it is the design's global maximum.** `100` base plus `60` timeliness at `d = 1` plus `5` infogain equals `165`, against `DEEPEN` at `55` and `OPEN` capped at `80`. G1 and G2 have exactly one exception in the whole design and it fires precisely here, gated on a column rather than on freshness. The claim "the best question the system ever produced is the design's global maximum" is verified arithmetic, not rhetoric. One real gap the design missed: `Timeliness` defines an anticipation branch for `d` in `[-3, -1]` worth 20, but the G1/G2 exception window is `[today - 5, today]`, which does not cover negative `d`. A dated event arriving as a fresh fact is therefore gated out before the party happens, making the anticipation branch nearly unreachable. It does not affect S3 but it is dead code in a design that prides itself on having none.

**Conversation, partial, blocked by its own P6.** Tier A is the highest-precedence tier and a hook is a row with a due date, which is exactly right. But the Tier A query carries the filter `NOT (heat > 0 AND subject.weight != 'light')`. The static weight map in P6 puts `beliefs-values` in **heavy**, and the walkthrough files the party under `psychic-readings`, a `beliefs-values` subject. `heat` is set to 2 by any `mood_signal` in the last 3 days, about anything. So an unrelated mood signal blocks the best question in the system for up to two days out of a seven-day hook window. The walkthrough survives only by asserting "heat is 0 (nothing heavy recently)" without noticing the hook's own subject is the heavy one. Second, smaller contradiction in the same walkthrough: P5 claims the two people never share a domain the same day, but the Tier A query in the pseudocode does not consult `blockedDom` at all, so hook days can collide. The design violates its own stated principle in its own algorithm listing.

**Minimalist, fail, on arithmetic.** Lane 0's guard is `event_date < today <= event_date + 4, domain not in E.domain, domain not taken today by partner`. `E.domain` is the invariant-4 domain cooldown, **5 days**. Invariant 8 is explicit that the token bypasses `SUBJECT_COOLDOWN` and `SETTLE` only. The party subject is created by an answer, and the question that produced that answer was very likely in the same domain (ask about Cora, get the party). That puts the domain on a 5-day cooldown covering the token's entire 4-day window, and the token expires unfired. The walkthrough asserts "lane 0 preempts whatever the rotation said" while its own lane-0 predicate says otherwise two pages earlier. This is the sharpest self-contradiction in the four documents and it kills the one behavior the owner named as non-negotiable. It is also a one-line fix, which is why the design still ranks second.

### S4. No same-day twins

**Incumbent, partial.** The new check fires only when both people declared the **same explore domain**. It does not cover A exploring `childhood` while B exploits a `childhood` node, nor two exploits in one domain, nor near-identical wording. `nearestPrior` runs each person against their own history only, never against the partner's question today. `stemA === stemB` is caught, which is real but is grammar, not subject. And the system prompt mandates a shared theme, which actively pushes the two questions toward each other.

**Decision-theory, pass, and it is the only design that formulates this correctly.** Step 4 enumerates all 64 pairs with a `-1000` coupling penalty for a shared facet and a defined, logged relaxation. Every other design selects sequentially, which structurally means the second person always eats the leftovers. Joint enumeration can move either person, which is both fairer and strictly more likely to find a disjoint pair.

**Conversation, partial.** Sequential exclusion with parity-alternating order, conditional on the second person having candidates in two or more domains, and not applied to Tier A per its own pseudocode.

**Minimalist, pass.** Invariant 5, enforced sequentially and, crucially, audited nightly as `GROUP BY date, domain HAVING count(*) > 1` over the live table. Weaker selection than joint enumeration, stronger verification than anyone.

### S5. Four self-improvement questions, structurally blocked

**Incumbent, fail, verified by execution.** The mechanism is a model-declared `topic` tag compared by Jaccard over content words at 0.5. I ran it: the very case the new comment cites, `childhood-food` versus `food-memories`, scores 0.33 and passes. `area-of-growth` versus `new-skills` scores 0.0. `reading-progress` versus `self-improvement` scores 0.0. Content-word overlap cannot see a register, which is the finding the ontology doc opened with, and hyphen-splitting does not change that. On top of the mechanism failing, the tag is written by the model being policed, so evasion costs nothing. The remaining defense is a system-prompt paragraph, which is discouragement by definition.

**Decision-theory, pass, and it is the only design with a mechanism aimed at this exact failure.** The `family` column on `seeds` is a static hand-written taxonomy where "growth", "a skill you'd like to build" and "an area of development" all resolve to `family = self-improvement`, paying satiation plus a 14-day cooldown. The document is admirably honest that mechanisms 1 and 2 would not have caught four questions spread across four domains and that "the static family table is the load-bearing part, and it is load-bearing precisely because it is hand-written rather than derived". That is correct and it is the single most valuable idea in the field. Caveat, unstated: it covers `OPEN` moves only, so two exploit-side subjects can still both read as self-improvement.

**Conversation, partial, and its argument here is the weakest reasoning in any of the four documents.** It claims the 4-day domain cooldown caps a domain at 2 in 6 days, so four self-improvement questions "would need four distinct domains, which by definition is not four self-improvement questions". That is false. Self-improvement is a register, not a domain. Guitar practice (`hobbies-interests`), a job search (`career-academics`), a reading goal (`daily-life`) and a values question (`beliefs-values`) are four domains and four self-improvement questions, and that is approximately what actually shipped. The real protection here is validation rule 2 forcing a named subject, which blocks the abstract shape but not the repeated register.

**Minimalist, partial, honestly labelled.** The seed bank plus the anchor check make the abstract shape impossible on explore days. The weaknesses section states plainly that exploit-day cross-domain register repeats survive and that killing it "needs a register tag, which needs a judgment, which is what this design refuses". Correct diagnosis, deliberate refusal, no mechanism. Decision-theory's `family` column is the proof that the refusal was unnecessary: a static hand-written table is not a judgment.

### S6. All-explore drift

**Incumbent, partial.** `decideStance` caps the day stance at two consecutive explores when either person has an exploit candidate, which is a real improvement over the model deciding. But `stanceForPerson` downgrades any person with an empty exploit list to explore indefinitely, and that list is emptied by the 14-day cooldown plus settling while material genuinely exists. And, as established in S3, the mechanism that fixes this is the mechanism that breaks the follow-up.

**Decision-theory, pass.** There is no mode to drift into. Six explore days requires six days with no `pending` and no `open` subject, which is the case where exploring is correct.

**Conversation, pass structurally, with a caveat it names itself.** Explore is Tier E, reachable only when A through D are empty. But the co-mention dampener freezes every subject sharing a fact with the asked one for 7 days, and with multi-homing common, month one can starve B through D and push everything to explore. The design identifies this as "failure 1 arriving through a different door", which is exactly right.

**Minimalist, pass, and it is the only design that guards both directions.** Invariant 9 caps explore drift at 4. Invariant 10 catches the opposite failure, a chronically starved exploit lane producing the same symptom for a different reason, with an ordered relaxation that never touches subject cooldown or settling. The observation that "today, no threads silently means explore forever" is a precise diagnosis of the incumbent's `stanceForPerson`, and the two-sided quota is the best idea in the minimalist document.

### S7. Cold start

**Incumbent, partial.** Empty graph gives no exploit candidates, so `hasThreads` is false and both explore. Both people get an identical explore list, because all domain counts are zero and the tie-break is the `ALL_DOMAINS` index. The new collision check then rejects and retries, burning attempts to fix a collision that was created by construction. Day-one quality rests entirely on a prompt paragraph telling the model to open a domain "through a concrete everyday subject", which is the same instruction shape that produced the four self-improvement questions.

**Decision-theory, pass.** Fixed 10-day opening schedule, A from index 0 and B from index 5, disjoint by construction, seeds supply the nouns. It also handles the case that matters on migration day: a newly added domain cold-starts itself because coverage 0 yields `InfoGain = 30`, with no backfill and no special rule.

**Conversation, pass, with the best-judged ordering of the four.** The rotation is ordered by conversational warmth rather than information gain, heavy domains deliberately last, on the reasoning that "a friend does not open with your health". That is a genuinely good product judgment and it is free, being a static array.

**Minimalist, pass and cheapest.** Day 1 the exploit lane is empty, the rotation is irrelevant, invariant 5 separates the two seeds, and no cold-start code path exists at all. Weakest ordering, zero machinery.

### S8. New failure surface, and whether the weaknesses sections are honest

**Incumbent.** Creates no new failure mode; it perpetuates the existing one. The honest characterization of this week's work is that two of the patches (event-date-only LIVE, settling as a veto) are structurally correct and should survive into whatever comes next, one (explore domain cooldown) is a reasonable stopgap, and one (fuzzy topic matching) does not fire on its own cited example. The architectural claim fails in one specific, unpatchable place: the day-level stance scalar.

**Decision-theory.** Honest. It names deadline dominance (a busy fortnight starving exploration, the mirror image of failure 1) and admits its governor is undesigned. It admits twelve invented constants that will never be fit. It calls `REVISIT` "a guess wearing the costume of a curve", which is exactly what it is. **Missed:** (a) the anticipation branch of `Timeliness` is unreachable because the gate exception window excludes negative `d`; (b) cross-move-type ties have no defined break, and its own section 7.2 walkthrough produces a 55-versus-55 tie and calls it a win; (c) taking the top 8 per person **before** joint enumeration can hand both people facet-homogeneous shortlists, silently triggering the `-1000` relaxation that the design treats as a first-days-only event.

**Conversation.** Honest about the one-subject-no-escape-hatch trade, hook date ambiguity ("next week is not a date"), the blunt co-mention dampener, and static impersonal weights. **Missed:** the `heat` gate blocking Tier A on heavy-domain hooks (the S3 contradiction), and P5 not being applied to Tier A. It also does not acknowledge that nine principles, four hook kinds, six forms with an interrogative-word map, three weights, two derived counters, five tiers and a nightly sweep is by a wide margin the largest surface in the field.

**Minimalist.** The most disciplined weaknesses section: it names the peak-question sacrifice, legible rhythm, the surviving `kind` judgment, cross-domain register, settling freezing a wide slice, lexical anchors as a proxy, seed bank aging, and wrong domain assignment. **Missed, and these are its three worst:** (a) the domain cooldown eating the follow-up token, which is fatal; (b) permanent budget-0 accumulation, since a subject whose facts are all `kind='fact'` is unaskable forever and the graph fills with dead nodes, permanently biasing the system toward explore; (c) the exploit `argmin` sorts on `oldest_linked_fact_date`, so it systematically asks about the stalest available subject first, which is the opposite of what a friend does and is a quality cost nowhere acknowledged.

### S9. Implementability

| | migration | moving parts | hand-tuned constants | testable without an LLM |
|---|---|---|---|---|
| Incumbent | zero | ~8 | ~12, two of which provably never fire | **partially, and this is the deep problem** |
| Decision-theory | heaviest: 2 create-copy-swaps, `node_facets`, `fact_subjects`, `moves_log` + backfill, `resolved_on`, ~150 hand-tagged seeds | ~14 | ~12, all invented | excellent |
| Conversation | heavy: new `subjects`/`facts`/`fact_subjects`/`hooks`, extractor rework, full replay (hooks cannot be backfilled by SQL) | ~20 | 20+ | good |
| Minimalist | lightest: one create-copy-swap, one join table, `asks` backfill, `seeds` TSV | **10, counted by the author** | **6, counted by the author** | best, and the only one verified in production |

Two things dominate this row.

**The incumbent's testability gap is architectural, not incidental.** Because selection produces a *menu* that the model picks from, no test can assert what will be asked, only what will be offered. `tests/ontology/candidates.test.ts` can prove the candidate list is right and still tell you nothing about the question that ships. Every challenger makes selection a pure function ending in a single target, which converts the entire selection layer into ordinary unit tests. That alone justifies the migration.

**Constants that can never be fit.** At two people and one question each, the system produces 14 answers a week with no counterfactual and no repeated measurement per subject. Decision-theory says this out loud and defends itself by making the constants ordinal and asserting orderings rather than values, which is the right defense but does not change that twelve numbers were guessed. Conversation has over twenty and does not raise the issue. Minimalist has six and its numbers are window lengths, which are the one kind of constant a human can reason about directly ("21 days feels like the right gap"). Six reasonable-on-their-face windows beat twelve ordinal weights, and both beat twenty.

Two acceptance artifacts deserve to be lifted regardless of who wins. Decision-theory's **counterfactual replay gate** over the 24 live person-days, with five named mechanical assertions and the stated rule that "if replay does not reproduce all five, the design is wrong, not the thresholds", is the best falsifiable gate anyone proposed. Minimalist's **nightly `audit-invariants.ts` over live history, exiting non-zero on any violating row**, is the only proposal that verifies anything in production rather than in fixtures. They are complementary and both should ship.

### S10. The owner's three requirements

**Semantic closure, not length.** All four claim it. Three have it.

- Incumbent: **no**. `kind` is never read. The only closure rule in the repository is a length comparison. This is not a gap in the claim, it is the claim's opposite.
- Decision-theory: continuation class from fact kinds, **plus the resolution rule**, which is the only self-correcting mechanism in the field: if a targeted subject's answer produces no new `thread` fact, its existing threads are marked resolved in code, so a mislabel costs exactly one question.
- Conversation: `openness` from open threads plus pending hooks, with three code guards on the extractor's `resolves` pointer and a lexical future-marker demotion. Strong, though the demotion list will misfire on "I still make it the same way", which the design admits.
- Minimalist: budget from `kind`, capped at 3, incremented only by human evidence. The most robust to model error, because a wrong label costs a bounded integer rather than a state. Undermined by the invariant-7 contradiction and by having no way for a wrong `thread` label to self-correct.

**A tastes-preferences domain.** Incumbent does not have it. All three challengers add it and all three correctly identify it as a create-copy-swap because SQLite cannot alter a CHECK in place. No differentiation.

**Multi-homed facts.** Incumbent does not have it; `node_facts.node_id` is a single FK, and the ontology doc's own `UNIQUE (person, subdomain)` decision was itself a partial workaround for the same problem.

The costs differ and this is where it gets interesting. Minimalist takes `fact_subjects` and nothing else, so multi-homing is free. Conversation adds a `role` column and then makes multi-homing **expensive**: the co-mention dampener freezes every co-homed subject for 7 days, so a fact on three subjects costs three subjects, and the design correctly names this as a path to explore starvation. Decision-theory is the only one that multi-homes the **subject** as well, via `node_facets`, which is what the psychic party actually needed: it is genuinely a `relationships-friends` event, a `beliefs-values` event, and a `plans-future` event at once. It pays for that by having to decide which facet a question counts against, which it handles by carrying `facet` on every `moves_log` row. That is the right answer and the extra table is worth it, but the fact-level join is the requirement and the subject-level one is a bonus.

---

## 2. Ranked verdict

**1. Decision-theory.** It is the only contender that passes S1 through S7 with no self-contradiction, and the only one that understands S3 and S6 as the same problem rather than opposing ones. Three of its ideas are best-in-field and none of the others have equivalents: typed moves replacing a mode flag, `InfoGain` decaying with coverage so exploration is self-limiting with no cooldown counter to tune, and the seed `family` taxonomy, which is the sole mechanism anywhere that would have caught the four self-improvement questions. Its costs are exactly what it says they are: twelve invented constants and the heaviest migration.

**2. Minimalist.** The best design per unit of complexity in the field, and the only one whose guarantees are verified in production. Ten moving parts and six constants, counted honestly by its own author. Its two-sided quota (invariants 9 and 10) is the cleanest solution to explore drift anyone proposed. It ranks second and not first only because its follow-up token is unspendable under its own domain cooldown, which fails the owner's non-negotiable behavior. That is a one-line fix, and the fact that a one-line fix is all it needs is itself an argument for the architecture.

**3. Conversation.** The best human instincts in the field: the warmth-ordered cold start, the heavy-light alternation, and the `hooks` table as the cleanest expression of scheduled follow-up anyone wrote. It ranks third because it has the largest surface by a wide margin, because its S5 argument is plainly false (a register is not a domain), and because two of its own principles are violated by its own algorithm listing (P5 not applied to Tier A, and P6's `heat` blocking Tier A on the very hook it exists to protect). A design with nine principles will have a principle that its pseudocode forgets, and this one has two.

**4. Incumbent.** Not because this week's work was bad. Two of the four patches (event-date-only LIVE, settling as a veto) are structurally correct and belong in the successor. The claim "the architecture is right, this week's patches close the holes" fails on three grounds, in increasing order of severity: one patch does not fire on its own cited example (verified: 0.33 against a 0.5 threshold); the architecture cannot satisfy any of the owner's three requirements from today without becoming one of the other three designs; and the day-level explore/exploit scalar is a single variable being asked to guarantee two things that trade against each other, so S3 and S6 cannot both be fixed inside it. That last one is not a hole a patch closes. It is the shape of the thing.

---

## 3. The synthesis: what to build

The three designs were written independently and converged on four mechanisms. Convergence under independence is the strongest evidence available here, so these four are settled and go in unconditionally, with no further debate:

1. **Freshness is a veto, never a promotion.** A subject with a fact observed inside 2 days is excluded. This is already correct in the working tree and is the one thing the incumbent got right this week.
2. **Kind-typing drives closure, and length is deleted rather than tuned.** `avg_yield_chars` stops being written and `shouldDeplete` is deleted.
3. **Explore carries a concrete noun from a checked-in seed bank.** Code picks the seed; the model wraps it.
4. **Event follow-up is a scheduled row with a due date, not a ranking outcome.** It lives in its own lane that does not compete on the same scale as anything else.

### Recommendation: the minimalist spine, with four grafts and two corrections

Build **minimalist's exclusion-window architecture**, with the single `asks` table as the sole exclusion source, `budget` from `kind` as the closure model, and the thirteen invariants as the test suite. Reasons, in order:

- The failure record is unanimously a record of rankings without floors. The minimalist position ("a ranking has no floor") is the correct reading of the history, and it is the only design whose central claim is derived from what actually went wrong rather than from a lens.
- Six window-shaped constants beat twelve ordinal weights at n = 14 answers per week. A human can reason directly about "21 days is the right gap before a subject returns". Nobody can reason about whether `FOLLOW_UP` base should be 100 and `DEEPEN` 55, and no data this system will ever collect can settle it.
- It is the only design that verifies itself in production. `audit-invariants.ts` running nightly over live history, exiting non-zero on a violating row, is worth more than any amount of fixture coverage in a system that has now shipped four bugs past its own tests.
- Its migration is the cheapest by a wide margin, and migration cost is real: the schema is three commits old and the team has already spent a week on patches that did not work.

Then graft in the following, each named to its source and each justified by a defect in the spine.

**Graft 1, from decision-theory (G1/G2's single-exception structure): the follow-up token outranks the domain cooldown.** Lane 0 bypasses subject cooldown, settling, **and** the 5-day domain cooldown. It yields only to invariant 5, and when it collides with the partner's domain, the **partner** is re-selected, not the follow-up. Why: a 4-day token window under a 5-day domain cooldown is arithmetically unsatisfiable, and the domain cooldown exists to stop four food questions, not to outrank a dated event. Decision-theory's discipline of having exactly one exception in the entire design, gated on a column rather than on freshness, is the right structure; minimalist had the structure and misdrew the boundary. This is the fix that turns minimalist's S3 fail into a pass.

**Graft 2, from decision-theory (section 4.1): the `family` column on `seeds`, plus a 14-day per-person family cooldown.** Why: it is the only mechanism in the entire field that would have caught four self-improvement questions spread across four domains, and it is the cheapest thing in any of the three documents, being one TEXT column and about fifteen hand-written family labels. Minimalist declined this on the grounds that a register tag "needs a judgment"; decision-theory demonstrated that a static hand-authored table is not a judgment, it is data. Extend the same family cooldown to exploit-lane subjects by tagging subjects with a family at creation from the same static map, which closes the exploit-side gap that decision-theory itself left open.

**Graft 3, from decision-theory (Step 4): joint pair selection instead of sequential.** Not the scoring, only the enumeration. Take each person's top few eligible targets, enumerate the pairs, and take the first pair with disjoint domains, preferring pairs with at most one explore. Why: sequential selection structurally means the second person always eats the leftovers, and both minimalist and conversation had to add "provided the second person has candidates in at least two domains" escape clauses to cover it. With windows instead of scores there is nothing to sum, so this degrades to a dozen comparisons and introduces **zero new constants**. It is the cheapest graft and it removes an unfairness that would otherwise be invisible until someone noticed one person always gets the odd question.

**Graft 4, from decision-theory (section 3.2): the resolution rule, on top of the budget.** When a question targets subject N and the answer produces no new `thread` fact on N, mark N's open threads resolved in code. Why: minimalist's budget is more robust to a wrong `kind` than any other closure model in the field, but it is write-once and never self-corrects, which is what produces permanent budget-0 dead nodes and unbounded nagging on a wrong `thread` label. The resolution rule gives the budget a second, human-evidenced path to zero and bounds a wrong `thread` to one question instead of three. It is arithmetic over rows, not a second judgment call, which is the property that makes it safe to add.

**Graft 5, from conversation (cold start): the warmth-ordered opening rotation.** `tastes-preferences`, `daily-life`, `childhood`, `hobbies-interests`, `relationships-friends`, `career-academics`, `plans-future`, `family`, `health-body`, `beliefs-values`, with person B offset by one. Why: it is a static array, it costs nothing, and "a friend does not open with your health" is the best product judgment in any of the four documents. Minimalist's cold start orders by lowest domain index, which is arbitrary; this makes it deliberate for free.

**Correction 1 to the spine: fix the budget contradiction.** Grant budget **1** for `fact`, **2** for `interest`, **3** for `thread`, keeping the `min(budget + grant, 3)` cap and the `budget > 0` predicate. Why: as written, a `fact`-only subject is born unaskable, invariant 7's own text says it should be askable exactly once, and the paneer node deserves the one good question it can produce. Without this, every settled subject is permanent dead weight and the graph biases toward explore forever.

**Correction 2 to the spine: change the exploit tie-break.** Replace `argmin(event_date is null, oldest_linked_fact_date, id)` with a preference for the subject holding the most recently updated **unresolved thread**, falling back to oldest-linked-fact and then id. Why: asking about the stalest available subject first is the opposite of what a friend does. This does not reintroduce the recency-LIVE bug, because settling and subject cooldown remain absolute vetoes that are never relaxed, and the minimalist position permits it explicitly: "ordering exists only to break ties inside the surviving set". The bug was recency as a promotion past a veto; this is recency as a tie-break underneath two vetoes, which is a different thing.

**Emotional safety, resolved against conversation.** Take decision-theory's **G5** (a subject carrying a distress mood signal within 7 days is dropped, per subject) and reject conversation's **`heat`** (a person-level day mode that gates entire weight classes). Why: a per-subject exclusion protects the person processing something alone without ever being able to block an unrelated dated follow-up, which is precisely the failure `heat` introduces.

### What the hybrid costs, from the incumbent

Schema, one commit: create-copy-swap `nodes` into `subjects` (add `tastes-preferences` to the CHECK, add `budget`, `anchors`, `family`; drop `status` and `avg_yield_chars`); new `fact_subjects` backfilled one-to-one from `node_facts.node_id`; new `asks` backfilled from `generation_log` joined to `person_days`, reusing the argmax attribution already implemented; new `followup_tokens` seeded from subjects with a non-null `event_date`; new `seeds` table loaded from a checked-in TSV.

Code, three commits: a pure selector module returning one target per person (this is the whole design, roughly 250 lines, fully unit-testable); the generation handoff, which replaces the candidate-menu block in `generationPrompt.ts` with a single assigned target and adds the anchor check to `adaptive.ts`'s existing retry loop; and `audit-invariants.ts` plus decision-theory's counterfactual replay gate over the 24 live person-days.

Deleted: `src/prompts/stance.ts` entirely, `isRich` and `shouldDeplete` from `status.ts`, the exploit/explore candidate list building in `ledgerOntology.ts`, and the stance paragraphs from `ADAPTIVE_SYSTEM_PROMPT`. The retry loop, the near-duplicate wording guard, the opening-stem guard and the cross-person leakage rule all survive unchanged.

The long pole is not code. It is writing roughly 130 seeds with domain, family and anchor tokens. That is content, it is a couple of hours, and it is deliberately manual for the reason decision-theory gives: a hand-written taxonomy is the guard that a learned similarity metric already failed to be.

Constant count for the hybrid: 21 (subject cooldown), 5 (domain cooldown), 2 (settling), 4 (follow-up window), 14 (family cooldown), 90 and 30 (seed cooldowns), 1-in-3 (explore rotation), 5 (exploit deficit). Nine, all window-shaped, all directly reasonable-about. Against the incumbent's twelve, decision-theory's twelve ordinal weights and conversation's twenty-plus.

---

## 4. What to reject, explicitly

**From decision-theory**

- **Reject the twelve-constant scored index.** Ordinal weights that can never be fit at 14 answers a week are a ranking without a floor wearing a derivation, and the failure record is a record of exactly that.
- **Reject `REVISIT`'s 21-day linear ramp**, which the design itself calls "a guess wearing the costume of a curve"; a subject returns when new material touches it or not at all.
- **Reject `node_facets`** (subject-level multi-homing) for now, because the fact-level join is the owner's actual requirement and facets force every domain rule to first decide which facet a question counts against.

**From conversation**

- **Reject the `heat` day-mode gate on Tier A**, because a mood signal about anything at all must never be able to block a dated event follow-up, and the design's own walkthrough survives only by assuming `heat` is zero on a heavy-domain hook.
- **Reject the six-form rotation with its interrogative-word map**, which is the incumbent's `openingStem` check reimplemented at ten times the size to police grammar rather than subject.
- **Reject the co-mention dampener's 7-day freeze on every co-homed subject**, because it makes multi-homing (an owner requirement) actively expensive and the design itself identifies it as a path back to all-explore.

**From minimalist**

- **Reject the domain cooldown's authority over the follow-up token**, because a 4-day token window under a 5-day domain cooldown is arithmetically unsatisfiable and it silently kills the one behavior the owner named as non-negotiable.
- **Reject `budget = 0` for `kind='fact'`**, which contradicts invariant 7's own text and makes every settled subject permanently unaskable dead weight.
- **Reject `oldest_linked_fact_date` as the exploit tie-break**, because always digging the stalest subject first is the opposite of what a friend does.

**From the incumbent**

- **Reject the day-level explore/exploit scalar**, because one flag cannot both guarantee exploit variety and let a dated follow-up fire, and every patch to it trades one for the other.
- **Reject the model-declared `topic` tag as a repeat guard**, since I ran it and it scores 0.33 on the exact example its own code comment cites, against a 0.5 threshold.
- **Reject the five-candidate menu handed to the model**, because a menu is a decision, no test can assert what will be asked from one, and this project has now watched the model make that decision badly four times.
- **Keep, unchanged:** event-date-only `isLive`, settling as a veto rather than a promotion, the retry-with-reason loop, the near-duplicate wording guard, the opening-stem guard, and the cross-person leakage rule. Those are the parts of this week's work that survive.
