import { describe, it, expect } from 'vitest';
import { FusionScorer } from '../src/fusion.js';
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
