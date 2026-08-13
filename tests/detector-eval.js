/**
 * Evaluation harness for the statistical/stylometric detection layer.
 *
 * HONEST SCOPE LIMIT — read this before trusting any number this script
 * prints: the transformer classifiers (the two ONNX models in index.html)
 * only run in a browser (they're loaded via a Web Worker + WASM). This
 * script runs in Node, so it can only evaluate the statistical +
 * stylometric layer and the combination/category logic in detector-core.js
 * — NOT the full pipeline end-to-end, and NOT with the transformer signal
 * included. Treat every metric below as "how good is the offline layer
 * alone," not "how good is the shipped detector."
 *
 * The labeled set below is a SMALL, HAND-WRITTEN illustrative set (not a
 * scraped or crowd-sourced corpus) — nowhere near large enough for a
 * statistically meaningful ROC-AUC. It exists to catch regressions
 * (a change that makes a previously-correct case wrong) across model
 * versions, per the spec's feedback-loop requirement — not to certify
 * accuracy. A real accuracy claim would need thousands of documents across
 * genres, proficiency levels, and generator models, which this project has
 * no access to.
 *
 * Run with: node tests/detector-eval.js
 */
var DetectorCore = require('../detector-core.js');

// ---- minimal tokenizers, mirroring index.html's words()/splitSentences() ----
function words(s) {
  var m = s.toLowerCase().match(/[a-zà-öø-ÿ]+(?:['’][a-zà-öø-ÿ]+)?/g);
  return m || [];
}
function splitSentences(text) {
  // simplified: split on sentence-ending punctuation followed by whitespace
  return text.split(/(?<=[.!?])\s+/).filter(function (s) { return s.trim(); });
}
// mirrors index.html's splitParagraphs(): blank-line paragraphs first, but
// fall back to single-newline splitting when that collapses a long document
// to ~1 paragraph (common with pasted chat/Markdown output using single
// newlines between blocks) — otherwise discourseMarkerDensity silently goes
// dark on exactly the heading/bullet-heavy text it exists to catch.
function splitParagraphs(text) {
  var byBlank = text.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (byBlank.length <= 1 && words(text).length > 150) {
    var byLine = text.split(/\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (byLine.length > 1) return byLine;
  }
  return byBlank;
}

function runStatStyloOnly(text) {
  var allWords = words(text);
  var sentences = splitSentences(text);
  var sentenceLens = sentences.map(function (s) { return words(s).length; }).filter(function (n) { return n > 0; });
  var paragraphs = splitParagraphs(text);
  var openers = {};
  sentences.forEach(function (s) { var w = words(s)[0]; if (w) openers[w] = (openers[w] || 0) + 1; });

  var burst = DetectorCore.burstiness(sentenceLens);
  var vocab = DetectorCore.vocabDiversity(allWords);
  var rep = DetectorCore.selfRepetition(allWords);
  var fw = DetectorCore.functionWordProfile(allWords);
  var openerStat = DetectorCore.openerRepetition(openers);
  var discourse = DetectorCore.discourseMarkerDensity(paragraphs);
  var md = DetectorCore.markdownListicleDensity(text, allWords.length);

  var statisticalP = DetectorCore.clamp(0.34 * burst.uniformity + 0.24 * vocab.diversityDeficit + 0.22 * rep.score + 0.20 * 0.3, 0, 1);
  var stylometricP = DetectorCore.clamp(0.42 * fw.score + 0.25 * openerStat.score + 0.18 * discourse.score + 0.15 * md.score, 0, 1);

  return DetectorCore.combineSignals(null, statisticalP, stylometricP, {
    wordCount: allWords.length, modelsAgree: null, chunkReliableFraction: paragraphs.length ? 1 : 0
  });
}

// ---- tiny labeled set. label: 1 = AI-generated, 0 = human-written ----
var DATASET = require('./detector-testset.json');

var results = [];
DATASET.forEach(function (item) {
  var r = runStatStyloOnly(item.text);
  var predictedAi = (r.category === 'likely_ai' || r.category === 'probably_ai') ? 1 :
    (r.category === 'uncertain' || r.category === 'insufficient') ? 0.5 : 0;
  results.push({ id: item.id, label: item.label, genre: item.genre || 'unspecified', predictedAi: predictedAi, probability: r.probability, confidence: r.confidence, category: r.category });
});

// ---- metrics (treating "uncertain"/0.5 as a miss for both counts, since
// this is the offline layer alone and shouldn't be forced into a binary call) ----
var tp = 0, tn = 0, fp = 0, fn = 0, unresolved = 0;
results.forEach(function (r) {
  if (r.predictedAi === 0.5) { unresolved++; return; }
  if (r.label === 1 && r.predictedAi === 1) tp++;
  else if (r.label === 0 && r.predictedAi === 0) tn++;
  else if (r.label === 0 && r.predictedAi === 1) fp++;
  else if (r.label === 1 && r.predictedAi === 0) fn++;
});
var resolved = tp + tn + fp + fn;
var accuracy = resolved ? (tp + tn) / resolved : 0;
var precision = (tp + fp) ? tp / (tp + fp) : 0;
var recall = (tp + fn) ? tp / (tp + fn) : 0;
var f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
var falsePositiveRate = (fp + tn) ? fp / (fp + tn) : 0;
var falseNegativeRate = (fn + tp) ? fn / (fn + tp) : 0;

console.log('=== Statistical/stylometric layer evaluation (offline, no transformer signal) ===');
console.log('Dataset size:', DATASET.length, '| resolved (non-uncertain):', resolved, '| left uncertain:', unresolved);
console.log('');
console.log('Accuracy (of resolved cases): ' + (accuracy * 100).toFixed(1) + '%');
console.log('Precision: ' + (precision * 100).toFixed(1) + '%');
console.log('Recall: ' + (recall * 100).toFixed(1) + '%');
console.log('F1: ' + f1.toFixed(3));
console.log('False positive rate (human flagged as AI): ' + (falsePositiveRate * 100).toFixed(1) + '% <-- watch this one most closely');
console.log('False negative rate (AI missed): ' + (falseNegativeRate * 100).toFixed(1) + '%');
console.log('');
console.log('Per-item detail:');
results.forEach(function (r) {
  var mark = r.predictedAi === 0.5 ? '?' : (r.predictedAi === r.label ? 'ok' : 'MISS');
  console.log('  [' + mark + '] ' + r.id + ' (' + r.genre + ') label=' + r.label + ' -> ' + r.category + ' (p=' + r.probability.toFixed(2) + ', conf=' + r.confidence + '%)');
});

// A regression gate: fail the run if the false-positive rate on this small
// set exceeds a threshold, so a future change that starts flagging human
// writing gets caught before it ships. This is NOT a claim that the
// threshold below is the "correct" real-world FPR — it's a tripwire against
// this specific set getting worse.
var FPR_REGRESSION_GATE = 0.34;
if (falsePositiveRate > FPR_REGRESSION_GATE) {
  console.log('\nFAIL: false-positive rate exceeds the regression gate (' + (FPR_REGRESSION_GATE * 100) + '%). Do not ship this change without investigating which human samples got flagged.');
  process.exit(1);
}
console.log('\nOK: within the regression gate.');
