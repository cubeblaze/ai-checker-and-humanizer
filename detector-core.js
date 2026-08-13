/**
 * detector-core.js — pure, dependency-free statistical/stylometric signal
 * functions for the AI-writing detector, plus the ensemble combination and
 * category-mapping logic.
 *
 * WHY THIS FILE EXISTS SEPARATELY: everything here is a pure function (no
 * DOM, no fetch, no globals) so it can be loaded two ways with zero
 * duplication:
 *   1. In the browser: <script src="detector-core.js"></script> attaches
 *      window.DetectorCore.
 *   2. In Node, for the unit tests and evaluation harness:
 *      const DetectorCore = require('./detector-core.js');
 *
 * SCOPE AND HONEST LIMITATIONS (read before trusting a number from this file):
 *  - The transformer classifiers (the two ONNX models in index.html) are the
 *    only component here that was actually trained on labeled AI/human text.
 *    Everything in this file is a statistical or stylometric heuristic —
 *    principled, but hand-weighted, not fit on a validation set, because no
 *    labeled corpus of meaningful size exists in this project. Comments below
 *    say "heuristic, not fitted" wherever that applies — that phrase means
 *    exactly what it says.
 *  - There is no semantic-coherence signal. An early draft considered
 *    adjacent-sentence word-overlap as a coherence proxy, but it was dropped:
 *    good human writing avoids repeating words between sentences, which
 *    would make the proxy fire on strong writing. Rather than ship a signal
 *    that can't be defended, it's simply not here. If a validated
 *    replacement is found later, add it as its own signal — don't fold a
 *    weak proxy into an existing one where it can't be audited.
 *  - Cross-document authorship-consistency (comparing this submission
 *    against a student's past writing) is not implemented — it needs a
 *    stored corpus of prior samples, which requires accounts/a database
 *    this project doesn't have. `paragraphConsistency()` below is a
 *    *within-document* check only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DetectorCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mean(a) { if (!a.length) return 0; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sd(a) { if (a.length < 2) return 0; var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / (a.length - 1)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sig(z) { return 1 / (1 + Math.exp(-z)); }
  /** Safe logit: real p=0/1 never happens with a calibrated classifier, but
   * clamp anyway so a stray exact 0 or 1 can't produce +/-Infinity and NaN
   * its way through the weighted sum below. */
  function logit(p) { var q = clamp(p, 0.02, 0.98); return Math.log(q / (1 - q)); }

  // ---------------------------------------------------------------
  // Signal 1: burstiness (sentence-length rhythm)
  // ---------------------------------------------------------------
  /**
   * Three burstiness measures from a list of sentence word-counts:
   *   msd  — mean absolute change between successive sentence lengths,
   *          normalized by mean length. This is the sharpest of the three;
   *          measured on samples in this project: AI ~0.14, formal human
   *          ~0.32, casual human ~0.68 (small sample, not a population
   *          statistic — treat as indicative).
   *   cv   — coefficient of variation of sentence length (classic burstiness).
   *   shortRate — fraction of sentences under 11 words. Human writers use
   *          short sentences far more often than LLM prose does.
   * Returns a 0..1 "uniformity" score where 1 = maximally AI-like (steady,
   * unchanging sentence length) — NOT a probability by itself.
   */
  function burstiness(sentenceLens) {
    if (sentenceLens.length < 2) {
      return { msd: 0, cv: 0, shortRate: 0, uniformity: 0.5, reliable: false };
    }
    var mLen = mean(sentenceLens), sLen = sd(sentenceLens);
    var cv = mLen > 0 ? sLen / mLen : 0;
    var msdSum = 0;
    for (var i = 1; i < sentenceLens.length; i++) msdSum += Math.abs(sentenceLens[i] - sentenceLens[i - 1]);
    var msd = mLen > 0 ? (msdSum / (sentenceLens.length - 1)) / mLen : 0;
    var shortRate = sentenceLens.filter(function (l) { return l < 11; }).length / sentenceLens.length;

    var uMsd = clamp((0.42 - msd) / 0.36, 0, 1);
    var uCv = clamp((0.42 - cv) / 0.34, 0, 1);
    var uShort = clamp((0.22 - shortRate) / 0.22, 0, 1);
    var uniformity = clamp(0.42 * uMsd + 0.33 * uCv + 0.25 * uShort, 0, 1);
    return { msd: msd, cv: cv, shortRate: shortRate, uniformity: uniformity, reliable: true };
  }

  // ---------------------------------------------------------------
  // Signal 2: vocabulary diversity (chunked type-token ratio)
  // ---------------------------------------------------------------
  /**
   * Average TTR over rolling 50-word windows — length-stabilized, unlike raw
   * TTR which shrinks as documents get longer regardless of authorship.
   * Returns { avgTtr, diversityDeficit } where diversityDeficit is 0..1,
   * 1 = maximally repetitive vocabulary (weak AI-ish signal on its own).
   */
  function vocabDiversity(wordsArr) {
    if (wordsArr.length < 20) return { avgTtr: 0.5, diversityDeficit: 0.5, reliable: false };
    var chunk = 50, ttrs = [];
    for (var i = 0; i < wordsArr.length; i += chunk) {
      var slice = wordsArr.slice(i, i + chunk);
      if (slice.length < 10) continue;
      var uniq = {};
      slice.forEach(function (w) { uniq[w] = true; });
      ttrs.push(Object.keys(uniq).length / slice.length);
    }
    var avgTtr = ttrs.length ? mean(ttrs) : 0.5;
    var diversityDeficit = clamp((0.55 - avgTtr) / 0.30, 0, 1);
    return { avgTtr: avgTtr, diversityDeficit: diversityDeficit, reliable: true };
  }

  // ---------------------------------------------------------------
  // Signal 3: self-repetition (reused 3-grams, templated construction)
  // ---------------------------------------------------------------
  function selfRepetition(wordsArr) {
    if (wordsArr.length < 6) return { rep3: 0, score: 0 };
    var tri = {}, rep3 = 0;
    for (var i = 0; i + 2 < wordsArr.length; i++) {
      var tk = wordsArr[i] + ' ' + wordsArr[i + 1] + ' ' + wordsArr[i + 2];
      if (tri[tk]) rep3++;
      tri[tk] = 1;
    }
    var rate = rep3 / wordsArr.length;
    return { rep3: rate, score: clamp(rate / 0.012, 0, 1) };
  }

  // ---------------------------------------------------------------
  // Signal 4: stylometric — function-word profile
  // ---------------------------------------------------------------
  // Closed-class function words. Unlike content-word "AI phrase" lists, this
  // set doesn't change with topic or register — it's the standard stylometry
  // feature set (going back to Mosteller & Wallace's Federalist Papers work).
  // The signal is REGULARITY of the function-word distribution, not the
  // presence/absence of any individual word.
  var FUNCTION_WORDS = ('the of and a to in is you that it he was for on are as with his they i at be '
    + 'this have from or one had by word but not what all were we when your can said there use an each '
    + 'which she do how their if will up other about out many then them these so some her would make like '
    + 'him into time has look two more write go see number no way could people my than first water been '
    + 'call who oil its now find long down day did get come made may part').split(' ');

  /**
   * Returns { entropy, evenness, score } where score is 0..1, 1 = unusually
   * even/predictable function-word usage. HEURISTIC, NOT FITTED: the
   * intuition (LLM output leans on a narrower, more evenly-used function-word
   * set than most individual human writers) is drawn from general stylometry
   * literature, not validated on an in-project labeled set — so this signal
   * is deliberately given a light weight in the final combination.
   */
  function functionWordProfile(wordsArr) {
    if (wordsArr.length < 40) return { entropy: 0, evenness: 0.5, score: 0.5, reliable: false };
    var counts = {}, total = 0;
    for (var i = 0; i < wordsArr.length; i++) {
      if (FUNCTION_WORDS.indexOf(wordsArr[i]) > -1) { counts[wordsArr[i]] = (counts[wordsArr[i]] || 0) + 1; total++; }
    }
    if (total < 15) return { entropy: 0, evenness: 0.5, score: 0.5, reliable: false };
    var keys = Object.keys(counts), ent = 0;
    keys.forEach(function (k) {
      var p = counts[k] / total;
      ent -= p * Math.log2(p);
    });
    var maxEnt = Math.log2(keys.length || 1);
    var evenness = maxEnt > 0 ? ent / maxEnt : 0.5;
    // Evenness close to 1 (near-uniform use of function words) is the
    // mildly-AI-leaning end; treat only the upper tail as signal.
    var score = clamp((evenness - 0.78) / 0.16, 0, 1);
    return { entropy: ent, evenness: evenness, score: score, reliable: true };
  }

  // ---------------------------------------------------------------
  // Signal 5: sentence-opener repetition
  // ---------------------------------------------------------------
  function openerRepetition(openers) {
    var keys = Object.keys(openers), total = 0, ent = 0;
    keys.forEach(function (k) { total += openers[k]; });
    if (!total) return { evenness: 1, score: 0 };
    keys.forEach(function (k) {
      var p = openers[k] / total;
      ent -= p * Math.log2(p);
    });
    var maxEnt = Math.log2(Math.max(2, total));
    var evenness = maxEnt > 0 ? ent / maxEnt : 1; // 1 = every sentence opens differently
    return { evenness: evenness, score: clamp((0.95 - evenness) / 0.45, 0, 1) };
  }

  // ---------------------------------------------------------------
  // Signal 6: discourse-marker density (legitimate transition-word rate,
  // distinct from an "AI phrase" list — measures structural signposting
  // density, not any specific vocabulary choice being inherently suspicious)
  // ---------------------------------------------------------------
  var TRANSITION_WORDS = ['however', 'moreover', 'furthermore', 'therefore', 'consequently', 'additionally',
    'in addition', 'similarly', 'in contrast', 'on the other hand', 'for example', 'for instance', 'as a result',
    'in conclusion', 'in summary', 'finally', 'meanwhile', 'nevertheless', 'nonetheless', 'thus',
    'hence', 'accordingly', 'likewise', 'indeed', 'specifically', 'overall'];

  function discourseMarkerDensity(paragraphs) {
    if (paragraphs.length < 2) return { rate: 0, score: 0, reliable: false };
    var withMarker = 0;
    for (var i = 1; i < paragraphs.length; i++) {
      var opening = paragraphs[i].slice(0, 60).toLowerCase();
      if (TRANSITION_WORDS.some(function (t) { return opening.indexOf(t) > -1; })) withMarker++;
    }
    var rate = withMarker / (paragraphs.length - 1);
    // Very high, very mechanical use of leading transition words at nearly
    // every paragraph boundary is the AI-leaning end; occasional use is
    // just good writing and scores near 0.
    return { rate: rate, score: clamp((rate - 0.55) / 0.35, 0, 1), reliable: true };
  }

  // ---------------------------------------------------------------
  // Signal 7: Markdown "listicle" structure density
  // ---------------------------------------------------------------
  /**
   * Counts a specific, very mechanical formatting pattern: a bolded lead-in
   * term immediately followed by a colon ("**Cardiac Architecture:** A blue
   * whale's heart..."), used as the organizing device for section after
   * section, plus heading density (#, ##, ###...). Found this gap directly:
   * a real 1,234-word AI-generated essay (headers, bullet lists, this exact
   * bold-lead-in pattern used 11 times) scored only ~24% AI overall despite
   * every other signal being neutral-to-low, because NOTHING in this file
   * looks at raw formatting — words() strips all markdown punctuation before
   * any other signal ever sees it, so a document could be "**Term:**"
   * structured throughout and every existing signal would be blind to it.
   * A human writing a genuine glossary or definition list might use this
   * pattern once or twice; using it as the load-bearing structure for most
   * of a document is a distinctly LLM "comprehensive breakdown" habit.
   * HEURISTIC, NOT FITTED — same caveat as every hand-set threshold in this
   * file; this one is newer than the others and correspondingly more likely
   * to need recalibration once more real examples are seen.
   *
   * @param {string} text       the raw, unstripped document text
   * @param {number} wordCount  precomputed word count (this file has no
   *                            tokenizer of its own for markdown-bearing text)
   */
  function markdownListicleDensity(text, wordCountN) {
    var boldLeadIns = (text.match(/\*\*[^*\n]{2,60}:\*\*/g) || []).length;
    var headers = (text.match(/^#{1,6}\s/gm) || []).length;
    var n = wordCountN > 0 ? wordCountN : 1;
    var perFiveHundred = (boldLeadIns + headers * 0.5) / n * 500;
    return {
      boldLeadIns: boldLeadIns, headers: headers, perFiveHundred: perFiveHundred,
      score: clamp(perFiveHundred / 4, 0, 1)
    };
  }

  // ---------------------------------------------------------------
  // Signal 8: within-document paragraph consistency (style-shift check)
  // ---------------------------------------------------------------
  /**
   * Takes an array of per-paragraph stat objects ({ ttr, meanSentLen }) and
   * reports how much they vary — NOT proof of anything, just an
   * authorship-consistency signal per the spec: large shifts are reported
   * as "style varies across the document," not "part of this is AI."
   */
  function paragraphConsistency(paragraphStats) {
    if (paragraphStats.length < 2) return { ttrCv: 0, lenCv: 0, consistent: true, reliable: false };
    var ttrs = paragraphStats.map(function (p) { return p.ttr; });
    var lens = paragraphStats.map(function (p) { return p.meanSentLen; });
    var ttrCv = mean(ttrs) > 0 ? sd(ttrs) / mean(ttrs) : 0;
    var lenCv = mean(lens) > 0 ? sd(lens) / mean(lens) : 0;
    return { ttrCv: ttrCv, lenCv: lenCv, consistent: (ttrCv < 0.35 && lenCv < 0.45), reliable: true };
  }

  // ---------------------------------------------------------------
  // Word-count gating (point 7 of the spec)
  // ---------------------------------------------------------------
  /**
   * Three tiers. Thresholds are carried over from empirical notes already in
   * this project (one human passage measured 90% AI at 70 words, 11% AI at
   * 134 words on the same source text) rather than the example numbers in
   * the spec verbatim — that in-project measurement is the actual evidence
   * available, so the tier boundary is set just above where that measured
   * instability was observed.
   */
  function wordCountTier(n) {
    if (n < 120) return 'insufficient';
    if (n < 260) return 'limited';
    return 'standard';
  }

  // ---------------------------------------------------------------
  // Ensemble combination (point 8 / point 2 of the spec)
  // ---------------------------------------------------------------
  /**
   * Combines the transformer-ensemble probability with the statistical and
   * stylometric layers via a WEIGHTED LOGIT AVERAGE, not
   * AI_score = average(all_scores). The transformer signal is the only
   * component actually trained on labeled data, so its weight is not fixed —
   * it SCALES with how decisive the transformer signal itself is (distance
   * from 0.5). Rationale, backed by this project's own eval harness
   * (tests/detector-eval.js): the statistical+stylometric layers alone show
   * near-zero recall on AI text (they essentially never confidently call
   * something AI on their own) while showing zero false positives on human
   * text in the same run. That asymmetry means they are weak, mostly-
   * one-directional evidence — they should be able to pull a WEAK or
   * borderline transformer read down (protecting against false accusations),
   * but should not be allowed to meaningfully drag down a transformer read
   * that is already highly confident, since there's no evidence they can
   * distinguish AI text reliably enough to overrule that. Confidence-scaling
   * the transformer weight (2.0 at transformerP=0.5, up to 5.0 at the
   * extremes) implements that without hand-coding a one-off exception.
   *
   * WEIGHTS ARE HAND-SET, NOT FITTED. There is no labeled validation set of
   * meaningful size in this project to fit them against (see file header).
   * If one is ever built, refit these numbers against it rather than
   * trusting the ratios chosen here.
   *
   * @param {number} transformerP  0..1, from the ONNX model ensemble (or null if unavailable)
   * @param {number} statisticalP  0..1, from burstiness+TTR+repetition+perplexity
   * @param {number} stylometricP  0..1, from function-word+discourse+opener signals
   * @param {object} reliability   { wordCount, modelsAgree (0..1), chunkReliableFraction (0..1) }
   */
  function combineSignals(transformerP, statisticalP, stylometricP, reliability) {
    var haveTransformer = typeof transformerP === 'number';
    var wT = haveTransformer ? (2.0 + 3.0 * Math.abs(transformerP - 0.5) * 2) : 0;
    var wS = 1.0;
    var wY = 0.55;
    var totalW = wT + wS + wY;

    var z = (wT * (haveTransformer ? logit(transformerP) : 0)
      + wS * logit(statisticalP)
      + wY * logit(stylometricP)) / totalW;
    var probability = sig(z);

    // ---- confidence (0..100), never allowed to reach 100 (point 14) ----
    var confidence = 68;
    var tier = wordCountTier(reliability.wordCount || 0);
    if (tier === 'insufficient') confidence -= 35;
    else if (tier === 'limited') confidence -= 15;
    else confidence += 8;

    if (haveTransformer && typeof reliability.modelsAgree === 'number') {
      // modelsAgree: 1 = perfect agreement between the two transformer models, 0 = total disagreement
      confidence += (reliability.modelsAgree - 0.5) * 40;
    }
    var statVsTransformerGap = haveTransformer ? Math.abs(transformerP - statisticalP) : 0;
    confidence -= clamp(statVsTransformerGap - 0.25, 0, 0.6) * 45;

    if (typeof reliability.chunkReliableFraction === 'number') {
      confidence += (reliability.chunkReliableFraction - 0.5) * 20;
    }
    confidence = clamp(Math.round(confidence), 5, 95);

    // ---- 5-category verdict (point 3) ----
    var category;
    if (tier === 'insufficient') {
      category = 'insufficient';
    } else if (confidence < 38) {
      category = 'uncertain';
    } else if (probability >= 0.80) {
      category = 'likely_ai';
    } else if (probability >= 0.58) {
      category = 'probably_ai';
    } else if (probability >= 0.38) {
      category = 'uncertain';
    } else if (probability >= 0.18) {
      category = 'probably_human';
    } else {
      category = 'likely_human';
    }

    return {
      probability: probability,
      confidence: confidence,
      category: category,
      wordCountTier: tier,
      componentScores: { transformer: transformerP, statistical: statisticalP, stylometric: stylometricP }
    };
  }

  var CATEGORY_LABELS = {
    insufficient: 'Insufficient text',
    likely_human: 'Likely human-written',
    probably_human: 'Probably human-written',
    uncertain: 'Uncertain',
    probably_ai: 'Probably AI-generated',
    likely_ai: 'Likely AI-generated'
  };

  return {
    mean: mean, sd: sd, clamp: clamp, sig: sig, logit: logit,
    burstiness: burstiness,
    vocabDiversity: vocabDiversity,
    selfRepetition: selfRepetition,
    functionWordProfile: functionWordProfile,
    openerRepetition: openerRepetition,
    discourseMarkerDensity: discourseMarkerDensity,
    markdownListicleDensity: markdownListicleDensity,
    paragraphConsistency: paragraphConsistency,
    wordCountTier: wordCountTier,
    combineSignals: combineSignals,
    CATEGORY_LABELS: CATEGORY_LABELS,
    FUNCTION_WORDS: FUNCTION_WORDS,
    TRANSITION_WORDS: TRANSITION_WORDS
  };
});
