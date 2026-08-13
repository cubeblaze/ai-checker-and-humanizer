# Humanizer research notes — what the industry actually recommends, and what's already built

This file exists so the reasoning behind the Humanizer's design isn't lost
between sessions. It records what four outside sources claim about
"humanizing" AI text, checks each claim against `humanize()` in `index.html`,
and calls out honestly where the sources add nothing new versus where they
motivated a real change.

Sources read (2026-08):
- [justdone.com — How AI Humanizer Works](https://justdone.com/blog/ai/how-ai-humanizer-works)
- [surferseo.com — Make AI Sound Human](https://surferseo.com/blog/make-ai-sound-human/)
- [quillbot.com — Burstiness and Perplexity](https://quillbot.com/blog/ai-writing-tools/burstiness-and-perplexity/)
- [Medium — AI Humanizer: The Complete 2026 Guide](https://medium.com/illumination/ai-humanizer-the-complete-2026-guide-aa570c97dcef)

## Definitions the sources agree on

**Perplexity** — how predictable the next word is, given what came before.
AI models are trained to pick likely-next-tokens, so AI text tends to sit at
lower perplexity than human writing, which takes more "surprising" paths.

**Burstiness** — variation in sentence length/structure *across* a passage,
not within one sentence. AI text tends toward uniform sentence length; human
writing swings between short and long.

Neither term is defined with a formula in any of the four sources — all four
describe them qualitatively only. `detector-core.js` in this repo already
computes real statistical proxies for both (`burst`, `perp` in the stylometric
layer — see [DETECTION.md](DETECTION.md)), which is more rigor than any of
these sources provide.

## Claim-by-claim check against `humanize()`

| Technique claimed | Source(s) | Already in `humanize()`? |
|---|---|---|
| Swap AI buzzwords (delve, leverage, streamline, multifaceted, "in today's digital age"...) | all four | **Yes** — `VOCAB` (150+ pairs) and `FILLER` already cover every specific example these articles name, word-for-word |
| Vary sentence length (burstiness) | all four | **Yes** — `trySplit`/merge pass under `opt.burst` |
| Convert passive → active voice | surferseo | **Yes** — added `tryActive()`, two guarded patterns (simple-past regular verbs, any-verb perfect tense), see prior commit |
| Diversify repeated transition words (Furthermore/Moreover/However...) | Medium, justdone | **Yes** — `TRANSITIONS` array, picks a random alternative per occurrence |
| Break up repeated sentence openers ("The X... The Y...") | Medium (implied via "paragraph rhythm") | **Yes** — `OPENER_VARY` + `GENERIC_OPENERS` diversifier |
| Add contractions | surferseo (tone/voice) | **Yes** — `CONTRACT` |
| "Read your sentences aloud" | surferseo | Not automatable — a human QA step, not a rewrite rule |
| Add first-person language ("I", "we", "my") to signal lived experience | surferseo | **Deliberately not implemented** — inventing first-person claims of experience the user didn't have would be fabrication, not rewriting |
| Define a persona / feed writing samples | surferseo | Not applicable — that's prompt-engineering advice for a *generative* rewriter; this engine is rule-based and has no model to prompt |
| Add original data, expert quotes, fact-checking | surferseo | Out of scope on purpose — this is a style tool, not a research assistant; inventing sources/quotes would be fabrication |
| Break into short paragraphs, bullets, bold text | surferseo | Not implemented — reformatting into bullets changes the document's structure/meaning, which conflicts with the tool's actual promise ("keeps your wording and voice") |
| Reorder paragraphs for better flow | Medium | Not implemented — safe sentence-level rewriting has clear guardrails (see `trySplit`'s doc comment); safely reordering paragraphs without changing meaning is a much harder, riskier problem and wasn't worth the risk for the payoff |

## The one real gap these sources motivated a fix for

Every source that discusses vocabulary specifically frames it as picking
options that are "less statistically safe" — i.e., *varied*, not just
different-from-the-original. Before this pass, `VOCAB` and `TRANSITIONS` both
picked a replacement independently at each occurrence
(`opts[Math.floor(rand()*opts.length)]`), so the same source phrase could by
chance get the same synonym twice in a row in one document — itself a small
predictability tell. Fixed by tracking the last pick per source phrase and
excluding it from the next draw (mirrors the `usedMark`/`openerUsed` pattern
`CASUAL` and `OPENER_VARY` already used) — see the `vocabLastPick` /
`transLastPick` maps in `humanize()`.

## Bottom line

Three of the four sources are marketing content for competing "humanizer"
products and are light on real mechanism — the Quillbot piece is the most
honest, and even it admits it gives "no detailed methodology." The net result
of this research pass: confirms the existing engine already implements
essentially everything concrete and safe that's out there, adds one small
real improvement (anti-repeat synonym/transition picking), and documents
*why* several commonly-suggested techniques (fake first-person experience,
invented sources, paragraph reordering, bullet-reformatting) are deliberately
left out rather than missing by oversight.
