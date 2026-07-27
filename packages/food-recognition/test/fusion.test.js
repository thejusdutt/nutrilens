import { describe, it, expect } from 'vitest';
import { FusionScorer } from '../src/fusion.js';
import { ZeroShotFoodClassifier } from '../src/zero-shot.js';
import { softmax } from '../src/swin-classifier.js';

const vocab = [
  { id: 'pizza', name: 'Pizza', f101: 0 },
  { id: 'hamburger', name: 'Hamburger', f101: 1 },
  { id: 'biryani', name: 'Biryani', f101: null },      // OOV: zero-shot only
  { id: 'nf-person', name: 'a person', f101: null, nonFood: true },
];

function probs(arr) { return Float32Array.from(arr); }

describe('softmax', () => {
  it('sums to 1 and is monotone', () => {
    const p = softmax(probs([1, 2, 3]));
    expect(p[0] + p[1] + p[2]).toBeCloseTo(1, 5);
    expect(p[2]).toBeGreaterThan(p[1]);
  });
  it('temperature flattens the distribution', () => {
    const sharp = softmax(probs([1, 5]), 1);
    const flat = softmax(probs([1, 5]), 4);
    expect(flat[1]).toBeLessThan(sharp[1]);
  });
});

describe('FusionScorer', () => {
  it('closed-set winner dominates when both heads agree', () => {
    const scorer = new FusionScorer(vocab);
    const swin = probs([0.97, 0.02, 0.01]); // over 101-space; here 3 for the test — index 2 unused
    const zs = probs([0.6, 0.1, 0.2, 0.1]);
    const r = scorer.fuse(swin, zs);
    expect(r.top[0].id).toBe('pizza');
    expect(r.isFood).toBe(true);
    expect(r.top[0].sources.swin).toBeCloseTo(0.97, 3);
  });

  it('zero-shot rescues out-of-set foods when the closed-set head is unsure', () => {
    const scorer = new FusionScorer(vocab);
    const swin = probs([0.3, 0.35, 0.35]); // Swin confused (max 0.35)
    const zs = probs([0.05, 0.05, 0.85, 0.05]); // zero-shot certain: biryani
    const r = scorer.fuse(swin, zs);
    expect(r.top[0].id).toBe('biryani');
  });

  it('flags non-food when probe mass is high', () => {
    const scorer = new FusionScorer(vocab);
    const swin = probs([0.4, 0.3, 0.3]);
    const zs = probs([0.1, 0.1, 0.1, 0.7]); // person probe wins
    const r = scorer.fuse(swin, zs);
    expect(r.isFood).toBe(false);
    expect(r.uncertain).toBe(true);
    expect(r.nonFoodMass).toBeCloseTo(0.7, 5);
  });

  it('fused probabilities sum to ~1 over food labels', () => {
    const scorer = new FusionScorer(vocab);
    const r = scorer.fuse(probs([0.5, 0.4, 0.1]), probs([0.25, 0.25, 0.25, 0.25]));
    const sum = r.top.reduce((s, t) => s + t.prob, 0);
    expect(sum).toBeGreaterThan(0.99); // only 3 food labels, all in top
  });
});

describe('ZeroShotFoodClassifier probe blend', () => {
  // Two labels. The zero-shot head slightly prefers `zero-shot-fave`; the probe
  // is certain of `probe-fave`. Whether the probe gets to flip the answer is
  // exactly the trusted/whole decision under test.
  const labels = ['zero-shot-fave', 'probe-fave'];
  const dim = 2;
  // Text embeddings: label 0 aligns with the (fixed) image embedding, label 1 does not.
  const matrix = Float32Array.from([1, 0, 0, 1]);
  // Probe: strong weight on label 1, so it argmaxes to `probe-fave`.
  const probe = {
    classes: ['zero-shot-fave', 'probe-fave'],
    weights: Float32Array.from([0, 0, 0, 10]),
    bias: Float32Array.from([0, 0]),
    index: new Map([['zero-shot-fave', 0], ['probe-fave', 1]]),
  };

  /** Build a classifier with a stubbed embed() — no ONNX session needed. */
  function make(probeExtra) {
    const zs = new ZeroShotFoodClassifier(
      null, null, { labels, matrix, dim, logitScale: 10 }, { probe: { ...probe, ...probeExtra }, probeAlpha: 0.8 },
    );
    // Image embedding leans slightly toward label 0 — a near-tie the confident
    // probe can flip, which is the only case where trusting it changes anything
    // (the blend lifts a trusted label, it does not suppress the rest).
    zs.embed = async () => Float32Array.from([0.72, 0.70]);
    return zs;
  }

  it('does not let a whole-only class override zero-shot on a region crop', async () => {
    const zs = make({ trusted: new Set(), trustedWhole: new Set(['probe-fave']) });
    const r = await zs.classify({}, { whole: false });
    expect(r.top[0].label).toBe('zero-shot-fave');
  });

  it('lets a whole-trusted class win on a whole photo', async () => {
    const zs = make({ trusted: new Set(), trustedWhole: new Set(['probe-fave']) });
    const r = await zs.classify({}, { whole: true });
    expect(r.top[0].label).toBe('probe-fave');
  });

  it('a crop-trusted class wins in both contexts', async () => {
    const zs = make({ trusted: new Set(['probe-fave']), trustedWhole: new Set(['probe-fave']) });
    expect((await zs.classify({}, { whole: false })).top[0].label).toBe('probe-fave');
    expect((await zs.classify({}, { whole: true })).top[0].label).toBe('probe-fave');
  });

  it('falls back to trusted when no whole list is present', async () => {
    // Older probe.json without trustedWhole must behave exactly as before.
    const zs = make({ trusted: new Set(['probe-fave']), trustedWhole: null });
    expect((await zs.classify({}, { whole: true })).top[0].label).toBe('probe-fave');
  });
});
