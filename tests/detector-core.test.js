/**
 * Unit tests for detector-core.js. Run with:
 *   node tests/detector-core.test.js
 *
 * Plain Node `assert` — no test framework dependency, consistent with the
 * rest of this project (a single static HTML file with no build step).
 */
var assert = require('assert');
var DetectorCore = require('../detector-core.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + name);
    console.log('    ' + e.message);
  }
}

console.log('burstiness()');
test('uniform sentence lengths score high uniformity (AI-leaning)', function () {
  var lens = [15, 15, 16, 15, 14, 15, 16, 15]; // steady, low variation
  var r = DetectorCore.burstiness(lens);
  assert.ok(r.uniformity > 0.6, 'expected high uniformity, got ' + r.uniformity);
});
test('highly variable sentence lengths score low uniformity (human-leaning)', function () {
  var lens = [4, 22, 7, 31, 3, 18, 9, 27];
  var r = DetectorCore.burstiness(lens);
  assert.ok(r.uniformity < 0.4, 'expected low uniformity, got ' + r.uniformity);
});
test('fewer than 2 sentences returns an unreliable, neutral result', function () {
  var r = DetectorCore.burstiness([10]);
  assert.strictEqual(r.reliable, false);
  assert.strictEqual(r.uniformity, 0.5);
});

console.log('vocabDiversity()');
test('short input is marked unreliable rather than scored', function () {
  var r = DetectorCore.vocabDiversity(['a', 'b', 'c']);
  assert.strictEqual(r.reliable, false);
});
test('highly repetitive vocabulary scores a high diversity deficit', function () {
  var words = [];
  for (var i = 0; i < 60; i++) words.push('the', 'cat', 'sat');
  var r = DetectorCore.vocabDiversity(words);
  assert.ok(r.diversityDeficit > 0.5, 'expected high deficit, got ' + r.diversityDeficit);
});
test('varied vocabulary scores a low diversity deficit', function () {
  var words = [];
  for (var i = 0; i < 60; i++) words.push('word' + i);
  var r = DetectorCore.vocabDiversity(words);
  assert.ok(r.diversityDeficit < 0.3, 'expected low deficit, got ' + r.diversityDeficit);
});

console.log('selfRepetition()');
test('repeated trigrams raise the repetition score', function () {
  var repeated = 'we tried this and it worked we tried this and it worked we tried this and it worked'.split(' ');
  var r = DetectorCore.selfRepetition(repeated);
  assert.ok(r.score > 0.3, 'expected elevated repetition score, got ' + r.score);
});
test('no repeated trigrams scores zero', function () {
  var unique = 'every single word here appears exactly once in this sentence today'.split(' ');
  var r = DetectorCore.selfRepetition(unique);
  assert.strictEqual(r.score, 0);
});

console.log('wordCountTier()');
test('under 120 words is insufficient', function () { assert.strictEqual(DetectorCore.wordCountTier(50), 'insufficient'); });
test('120-259 words is limited', function () { assert.strictEqual(DetectorCore.wordCountTier(200), 'limited'); });
test('260+ words is standard', function () { assert.strictEqual(DetectorCore.wordCountTier(400), 'standard'); });
test('boundary at exactly 120 is limited, not insufficient', function () { assert.strictEqual(DetectorCore.wordCountTier(120), 'limited'); });

console.log('combineSignals()');
test('never returns 100% confidence, even with perfect agreement', function () {
  var r = DetectorCore.combineSignals(0.99, 0.99, 0.99, { wordCount: 500, modelsAgree: 1, chunkReliableFraction: 1 });
  assert.ok(r.confidence <= 95, 'confidence must be capped below 100, got ' + r.confidence);
});
test('never returns 0% confidence, even with worst-case inputs', function () {
  var r = DetectorCore.combineSignals(0.5, 0.5, 0.5, { wordCount: 10, modelsAgree: 0, chunkReliableFraction: 0 });
  assert.ok(r.confidence >= 5, 'confidence must be floored above 0, got ' + r.confidence);
});
test('insufficient word count forces the insufficient category', function () {
  var r = DetectorCore.combineSignals(0.9, 0.9, 0.9, { wordCount: 40, modelsAgree: 1, chunkReliableFraction: 1 });
  assert.strictEqual(r.category, 'insufficient');
});
test('high transformer probability with strong agreement yields likely_ai', function () {
  var r = DetectorCore.combineSignals(0.95, 0.85, 0.7, { wordCount: 500, modelsAgree: 0.95, chunkReliableFraction: 1 });
  assert.strictEqual(r.category, 'likely_ai');
});
test('low transformer probability with strong agreement yields likely_human', function () {
  var r = DetectorCore.combineSignals(0.05, 0.10, 0.2, { wordCount: 500, modelsAgree: 0.95, chunkReliableFraction: 1 });
  assert.strictEqual(r.category, 'likely_human');
});
test('strong disagreement between transformer and statistical layers lowers confidence', function () {
  var agree = DetectorCore.combineSignals(0.8, 0.8, 0.8, { wordCount: 500, modelsAgree: 0.9, chunkReliableFraction: 1 });
  var disagree = DetectorCore.combineSignals(0.8, 0.1, 0.8, { wordCount: 500, modelsAgree: 0.9, chunkReliableFraction: 1 });
  assert.ok(disagree.confidence < agree.confidence, 'disagreement should reduce confidence');
});
test('combination is monotonic in the transformer probability, all else equal', function () {
  var low = DetectorCore.combineSignals(0.2, 0.5, 0.5, { wordCount: 500, modelsAgree: 0.8, chunkReliableFraction: 1 });
  var high = DetectorCore.combineSignals(0.8, 0.5, 0.5, { wordCount: 500, modelsAgree: 0.8, chunkReliableFraction: 1 });
  assert.ok(high.probability > low.probability);
});
test('missing transformer score (offline fallback) still produces a result', function () {
  var r = DetectorCore.combineSignals(null, 0.7, 0.6, { wordCount: 500, modelsAgree: null, chunkReliableFraction: 1 });
  assert.ok(typeof r.probability === 'number' && !isNaN(r.probability));
});

console.log('paragraphConsistency()');
test('near-identical paragraph stats are reported consistent', function () {
  var r = DetectorCore.paragraphConsistency([{ ttr: 0.6, meanSentLen: 18 }, { ttr: 0.61, meanSentLen: 19 }, { ttr: 0.59, meanSentLen: 17 }]);
  assert.strictEqual(r.consistent, true);
});
test('wildly different paragraph stats are reported inconsistent', function () {
  var r = DetectorCore.paragraphConsistency([{ ttr: 0.9, meanSentLen: 8 }, { ttr: 0.2, meanSentLen: 40 }]);
  assert.strictEqual(r.consistent, false);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
