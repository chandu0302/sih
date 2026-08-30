/**
 * SIH 26171 — model registry tests.
 *
 * The registry is data plus one lookup. The lookup is worth pinning because
 * its failure mode is the quiet kind: returning undefined for a typo'd id
 * would surface three frames later as `undefined.inputName`, or worse, as a
 * model that appears to have simply found nothing.
 */

import { describe, expect, it } from 'vitest';
import { MODELS, getModel, modelIds, type ModelSpec } from './model-registry';

const SPEC: ModelSpec = {
  id: 'test-model',
  url: 'chrome-extension://abc/models/test.onnx',
  inputName: 'images',
  inputSize: 640,
  runtime: 'onnx',
};

describe('getModel', () => {
  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => getModel('does-not-exist')).toThrow(/Unknown model id/);
  });

  it('names the missing id and lists what IS registered', () => {
    // The error is read by whoever typo'd the id; it should say what to use.
    expect(() => getModel('yolo-fase')).toThrow(/yolo-fase/);
    expect(() => getModel('yolo-fase')).toThrow(/Registered:/);
  });

  it('reports an empty registry legibly instead of an empty string', () => {
    // Track 2/3 have not landed yet, so this is the current state; the message
    // must still be readable rather than trailing off after "Registered:".
    if (modelIds().length === 0) {
      expect(() => getModel('anything')).toThrow(/<registry is empty>/);
    }
  });

  it('returns a registered spec', () => {
    // Registered through the same Record the production entries will use, then
    // removed — so this exercises the real lookup rather than a parallel one.
    MODELS[SPEC.id] = SPEC;
    try {
      expect(getModel(SPEC.id)).toEqual(SPEC);
      expect(modelIds()).toContain(SPEC.id);
    } finally {
      delete MODELS[SPEC.id];
    }
  });
});

describe('modelIds', () => {
  it('returns an array, empty until the tracks register their models', () => {
    expect(Array.isArray(modelIds())).toBe(true);
  });
});
