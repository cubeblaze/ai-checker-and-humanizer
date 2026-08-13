# AI writing detector — architecture, signals, and honest limitations

This document explains how the detector actually works, what each signal
does and doesn't prove, and what would be needed to make stronger claims
than are made here. Read it before trusting or defending a specific score.

## Two-tier design

**Primary path (`analyzeLocal()` in index.html):** two ONNX transformer
classifiers run client-side in a Web Worker —
[`tmr-ai-text-detector-ONNX`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX)
(RAID-trained across 11 LLM architectures, weight 0.65) and
[`answerdotai-ModernBERT-base-ai-detector-ONNX`](https://huggingface.co/onnx-community/answerdotai-ModernBERT-base-ai-detector-ONNX)
(DAIGT V2-trained on ChatGPT/Claude/DeepSeek output, weight 0.35). These are
the only components in the system actually trained on labeled AI/human
text. Everything else is a statistical or stylometric heuristic layered
around it.

**This pair has changed three times, each time for a specific, tested
reason — not guessed at:**

1. `chatgpt-detector-roberta` + `e5-small-lora` — rejected. Testing against
   text written fresh (Claude, unedited — a model this pair was never
   trained on) showed roberta is trained on ChatGPT output ONLY: it scored
   every genuine Claude sample under 5% AI regardless of truth. 1/6 correct
   on that fresh set.
2. `tmr-ai-text-detector` + `e5-small-lora`, 75/25 — better, but e5 caught
   only 1 of 4 AI samples solo against tmr's 3 of 4 while carrying a
   quarter of the weight. Simplified to tmr alone for a while — see "The
   one miss" below for the specific case that decision made worse, not
   better, and which the user directly flagged in production ("its just
   giving a lot of things 94% ai").
3. `tmr-ai-text-detector` + `answerdotai-ModernBERT-base-ai-detector`,
   65/35 (current) — went looking for an actual replacement instead of just
   reverting. Evaluated three real ONNX-ready candidates against this
   project's full 37-item labeled set, live in a browser, not from
   model-card claims:
   - `modernbert-ai-detection-raid-mage-ONNX` (ModernBERT, RAID+MAGE):
     REJECTED — 65% solo accuracy, only 48% human specificity (13 of 25
     human samples confidently flagged 80-89% AI). Would have made false
     positives *more* common, not less.
   - `answerdotai-ModernBERT-base-ai-detector`: 86% solo accuracy, 100% AI
     recall, 80% human specificity — and scores the exact known
     false-positive case (below) at 9% instead of tmr's 94%. Adopted.
   - `GabeuxDev/ai-text-detector-v1.01-onnx` (desklib DeBERTa-v3-large):
     not usable — 1.7GB fp32-only (author found int8 quantization shifted
     probabilities by up to 0.5), needs WebGPU rather than the CPU/WASM q8
     pipeline this project runs.

   Honest caveat on the winner: its training data covers 3 generator
   families (ChatGPT, Claude, DeepSeek), not tmr's 11 — weighted below tmr
   in the blend specifically because of that narrower diversity, despite
   scoring better on this project's own eval set. The eval set can't prove
   generalization to generators neither it nor the model has seen.

`MODELS` in index.html is an array; the worker and `scoreMany()` loop over
it generically — swapping a model in or out is a one/two-line change, not
a rewrite, which is exactly how this has been iterated three times now.

**Offline fallback (`analyze()`):** used only when the transformer models
can't be downloaded (no internet on first run). Weaker by construction and
labeled as such in the UI.

## The multi-signal pipeline (`detector-core.js`)

As of this rebuild, the document-level score is no longer the transformer
average alone. It's a weighted combination of three independent layers:

| Layer | What it measures | Weight in final logit | Trained on labeled data? |
|---|---|---|---|
| Transformer (tmr-ai-text-detector) | Learned AI/human token patterns | ~65% | Yes (upstream, RAID + others) |
| Statistical | Burstiness, vocabulary diversity, self-repetition, perplexity-proxy register | ~25% | No — hand-set thresholds |
| Stylometric | Function-word evenness, discourse-marker density, sentence-opener repetition, Markdown listicle density | ~10% | No — hand-set thresholds |

Combination is a **weighted average in logit space**
(`DetectorCore.combineSignals`), not `average(scores)` — see the function's
own doc comment for why that distinction matters (naive averaging lets a
single confident wrong signal drag the result, logit averaging is closer to
how independent evidence should combine).

**What is deliberately NOT in the statistical/stylometric layers:** a list
of "AI-sounding" words or phrases. The offline fallback's per-sentence
highlighting still uses one (`AI_WORDS`/`AI_PHRASES`, pre-existing code) for
localization, but it does not drive the document-level headline number
computed by `combineSignals` in either path.

## Confidence, not just a percentage

Every result now carries a **category** (`insufficient` / `likely_human` /
`probably_human` / `uncertain` / `probably_ai` / `likely_ai`) and a separate
**confidence score (5–95%, never 0 or 100)**. Confidence is reduced by:
short documents, disagreement between the two transformer models,
disagreement between the transformer and statistical layers, and a high
fraction of chunks too short to score independently. See
`combineSignals()` in `detector-core.js` for the exact arithmetic.

## Word-count gating

Three tiers (`wordCountTier()`): under 120 words is `insufficient` (no
confident call is made at all); 120–259 is `limited` (result shown, but
confidence is capped lower and the extreme categories are unreachable);
260+ is `standard`. These thresholds come from an in-project measurement
already documented in the code: one identical human passage scored 90% AI
at 70 words and 11% AI at 134 words on the same source text — the boundary
is set just above where that measured instability showed up, not from the
round numbers in an external spec.

## Paragraph-level / mixed-authorship report

The detector already chunked text paragraph-aware (merging short paragraphs
forward until a chunk clears 120 words, to avoid the false-positive-on-short-
windows failure mode documented at `chunkForAnalysis()`). This rebuild adds
an explicit **per-paragraph report** (`computeParagraphReport()`) that maps
every real paragraph back to the chunk that scored it, and reports
`low` / `uncertain` / `high` AI signal per paragraph — with an honest
`merged` / `too short to score alone` flag when a paragraph wasn't long
enough to be judged independently, rather than silently inheriting a
neighbor's score.

## Markdown-formatted text — a real false negative, found and fixed

A user reported a 1,234-word, clearly AI-generated essay (Markdown headers,
bold "**Term:**"-style lead-ins organizing bullet after bullet, numbered
lists) scoring only ~24% — "probably human." Traced live in-browser against
the actual text, not guessed at. Three real, compounding bugs, all now fixed:

1. **Paragraph splitting collapsed the whole document to one paragraph.**
   `text.split(/\n\s*\n/)` only recognizes blank-line-separated blocks, but
   this text (like a lot of real pasted content — chat-UI output, Word/Docs
   copy-paste, raw Markdown) used single newlines between sections. Result:
   `numParagraphs === 1`, which silently disables `discourseMarkerDensity`
   and `paragraphConsistency` (both require ≥2 paragraphs to run at all) —
   exactly the signals meant to catch this kind of heavily-sectioned text.
   Fixed with `splitParagraphs()`/`splitParagraphSpans()` in index.html
   (mirrored in `tests/detector-eval.js`): try the blank-line split first,
   fall back to single-newline splitting only when that collapses to ~1
   paragraph on a long document.

2. **No signal could see Markdown structure at all.** `words()` strips every
   non-letter character before any signal ever looks at the text, so a
   document that's "**Term:**" bullet after bullet, header after header, was
   completely invisible to detection — not scored low, just never examined.
   Added `markdownListicleDensity()`: counts bold-lead-in-then-colon
   patterns and heading density directly on the raw text, folded into the
   stylometric layer at a modest weight (0.15).

3. **The transformer itself was being fed raw Markdown syntax.** This was
   the dominant one — confirmed by actually downloading the models and
   running the real pipeline, not just reasoning about it. Before fixing
   this, `chunkTexts` (what gets tokenized and scored by the ONNX models)
   was a straight slice of the original text, `**`/`#`/`|` and all. Those
   models are trained on plain prose (RAID etc.), never on Markdown source —
   feeding them decoration syntax is out-of-distribution input, not just
   "unusual." Added `stripMarkdownForScoring()`: strips headers, bold/italic
   markers, bullet/numbered-list markers, table pipes, and horizontal rules
   before the transformer sees the text — never touches the words
   themselves, and the untouched original is still what every other signal
   (including `markdownListicleDensity`, which needs the raw syntax) reads.

**Measured effect, live, same document, real models — measured while the
project still ran two transformer models (see "Two-tier design" above for
why it's since down to one; the figures below predate that change and are
left as originally recorded rather than restated):** the transformer's own
document score (`docP`) went from confused/low to **68%**, with the primary
model (`tmr-ai-text-detector`) alone reading **86%**. Combined score went
from the reported 24% to **52%** — correctly landing on `uncertain` rather
than a false `probably_human`, because the two transformer models
disagreed (86% vs. 19%) on this text rather than both reading it through a
Markdown-shaped blind spot.

**What this doesn't fix:** `markdownListicleDensity`'s thresholds are
hand-set from one real example, not fitted against a labeled corpus of
Markdown-formatted AI text (none exists in this project) — expect it to
need recalibration as more real cases are seen.

### A follow-on bug this fix didn't catch: fenced code blocks crashed the worker

The same essay, resubmitted with its actual fenced code blocks (\`\`\`...\`\`\`
wrapping ASCII-art diagrams) intact, still scored ~21% — the fix above
never ran. `stripMarkdownForScoring()` didn't touch fenced blocks, so the
tokenizer was fed dozens of repeated `+---+` box-drawing lines. That didn't
just score wrong, it threw inside the ONNX worker (an opaque numeric
error message, no readable text). `runScan()`'s try/catch silently falls
back to the much weaker offline heuristic engine on any `analyzeLocal()`
failure — so the crash was invisible in the UI; a bad score looked
identical to a crash. Fixed by having `stripMarkdownForScoring()` also drop
box-drawing lines inside fenced blocks (keeping lines that are mostly real
words — diagram labels like "Whale Locates Dense Krill Swarm" survive as
legitimate short prose). Verified on the exact real essay, real models: no
crash, `analyzeLocal()` completes, docP 81%, primary model 98%, combined
66% ("Probably AI-generated").

## What was evaluated, and what wasn't

`tests/detector-core.test.js` — 25 unit tests on the pure functions in
`detector-core.js` (burstiness direction, vocab diversity bounds, category
thresholds, confidence floor/ceiling, monotonicity). Run: `node
tests/detector-core.test.js`.

`tests/detector-eval.js` + `tests/detector-testset.json` — a **12-document,
hand-written illustrative set** (not scraped, not crowd-sourced) covering
generic AI prose, an ESL student sample, a strong essay, a weak essay,
technical notes, creative writing, and dense encyclopedic human prose. Run:
`node tests/detector-eval.js`.

**This evaluation only exercises the statistical/stylometric layer**, because
the transformer models require a browser (WASM + Web Worker) and don't run
in Node. Running it today shows the statistical/stylometric layer *alone*
correctly avoids flagging any of the 6 resolved human samples (0%
false-positive rate) but misses most of the AI samples on its own (near-0%
recall) — which is expected and by design: this layer exists to add
robustness and explainability *alongside* the transformer signal, not to
replace it. If it ever scored highly *on its own*, that would actually be a
red flag that it had drifted toward keying on something spurious.

**Full-pipeline (transformer + statistical + stylometric) manual evaluation,
2026-08-09 — NOTE: recorded under the original tmr+e5-small-lora setup
(see "Two-tier design" above for what's changed since — tmr paired with
`answerdotai-ModernBERT-base-ai-detector` at 65/35, not e5 at 75/25).
`fullPipelineDocP` below reflects that original blend, not the current
pair's `docP`. Not re-run in full against the current pipeline — the one
case that mattered most (the false positive below) was individually
re-verified live with real models; the other 24 have not been.**
`tests/detector-testset.json` now holds 37 items — the original
12, plus 25 more (10 AI, 15 human, including 5 written specifically to stress
casual/informal register: text-speak, forum posts, rant-y first-person). The
25 new items carry a `fullPipelineDocP` field recorded from a real run of
`analyzeLocal()` — the actual client-side pipeline a user gets — in a live
browser with both transformer models loaded, not the statistical layer alone.

Result on those 25: **24/25 correct.** 10/10 AI samples caught (100%
recall), spanning formal business prose, history/science essays, a casual
blog voice, a professional email, and a Q&A explainer — all scored
97-98%. 14/15 human samples scored correctly low, across dense encyclopedic
prose, ESL writing, technical notes, creative fiction, strong and weak
student essays, forum posts, and five separate casual/informal samples
written specifically to try to break it (all scored 9-31%, comfortably
below the AI threshold).

**The one miss, kept in the set rather than quietly dropped:**
`human-09-casual-opinion-2`, a casual first-person opinion piece, scored 71%
AI (`tmr-ai-text-detector` alone said 94%; `e5-small-lora` correctly said
~0%, but it only carries 25% of the blend weight — see `scoreMany()` in
index.html for the exact 75/25 linear combination). Investigated rather than
patched: five more casual/informal samples covering the same register were
added and all scored correctly, so this reads as an isolated model error on
this specific passage, not a systematic weakness of informal writing that a
weight change would reliably fix. Changing the 75/25 blend to chase a single
failing example risks degrading the 24 cases that are currently correct —
that tradeoff was not made without more evidence than one document.

**Update — this is now the specific case that motivated adopting
`answerdotai-ModernBERT-base-ai-detector`.** After `e5-small-lora` was
dropped (tmr alone), this passage predictably got worse, not better: close
to tmr's raw 94% instead of the blended 71%, and the user hit this directly
in production and reported it. Verified live with the real model, this
exact text, current 65/35 blend: tmr still says 94% (unchanged — it's the
same model, same known weakness), but `answerdotai-ModernBERT-base-ai-detector`
says 9%, and the two disagreeing by 85 points is reported honestly rather
than averaged away — combined result **51%, "Uncertain"**, down from 71%
and far down from tmr's raw 94%. Not perfect (a genuinely human casual post
landing on "uncertain" rather than confidently "human" is still a
real cost), but a clear improvement over both prior states on the one
concrete failure case this project has actually measured.

**What this project has still not done, and cannot honestly claim:** a
large-scale ROC-AUC/precision-recall study across thousands of documents,
multiple genres, and multiple AI models; adversarial testing against
several live AI systems' outputs; a direct head-to-head comparison against
commercial detectors (Turnitin, GPTZero, etc.) — those companies don't
publish comparable methodology or give free bulk API access, so any claim
of parity with them would be unverifiable marketing, not a measurement;
or cross-session authorship-consistency comparison (would require accounts
and a stored corpus of prior writing, which this project has neither). If
you need those numbers, they require a labeled corpus this project doesn't
have — the honest thing to do here was build the infrastructure (the eval
harness, the test set format, and now a real 37-item labeled set with
recorded full-pipeline results) rather than fabricate the results.

## Never claim 100%

`combineSignals()` clamps confidence to `[5, 95]` unconditionally. No code
path in this project should ever render "100% confident" or "certain" —
if you find one, it's a bug, file it as such.
