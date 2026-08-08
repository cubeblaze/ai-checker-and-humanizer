# AI writing detector — architecture, signals, and honest limitations

This document explains how the detector actually works, what each signal
does and doesn't prove, and what would be needed to make stronger claims
than are made here. Read it before trusting or defending a specific score.

## Two-tier design

**Primary path (`analyzeLocal()` in index.html):** two ONNX transformer
classifiers run client-side in a Web Worker —
[`tmr-ai-text-detector-ONNX`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX)
(RAID-trained across 11 LLM architectures, weight 0.75) and `e5-small-lora`
(weight 0.25, recentered onto its own observed decision point — see the code
comment at `recentre()`). This is the only component in the system actually
trained on labeled AI/human text. Everything else is a statistical or
stylometric heuristic layered around it.

**Offline fallback (`analyze()`):** used only when the transformer models
can't be downloaded (no internet on first run). Weaker by construction and
labeled as such in the UI.

## The multi-signal pipeline (`detector-core.js`)

As of this rebuild, the document-level score is no longer the transformer
average alone. It's a weighted combination of three independent layers:

| Layer | What it measures | Weight in final logit | Trained on labeled data? |
|---|---|---|---|
| Transformer ensemble | Learned AI/human token patterns | ~65% | Yes (upstream, RAID + others) |
| Statistical | Burstiness, vocabulary diversity, self-repetition, perplexity-proxy register | ~25% | No — hand-set thresholds |
| Stylometric | Function-word evenness, discourse-marker density, sentence-opener repetition | ~10% | No — hand-set thresholds |

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

## What was evaluated, and what wasn't

`tests/detector-core.test.js` — 22 unit tests on the pure functions in
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

**What this project has not done, and cannot honestly claim:** a
large-scale ROC-AUC/precision-recall study across thousands of documents,
multiple genres, and multiple AI models; adversarial testing against
several live AI systems' outputs; or cross-session authorship-consistency
comparison (would require accounts and a stored corpus of prior writing,
which this project has neither). If you need those numbers, they require a
labeled corpus this project doesn't have — the honest thing to do here was
build the infrastructure (the eval harness, the test set format) rather
than fabricate the results.

## Never claim 100%

`combineSignals()` clamps confidence to `[5, 95]` unconditionally. No code
path in this project should ever render "100% confident" or "certain" —
if you find one, it's a bug, file it as such.
