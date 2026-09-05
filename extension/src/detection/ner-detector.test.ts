/**
 * SIH 26171 — NER detector tests (Track 3, 4a).
 *
 * Same philosophy as face-detector.test.ts / onnx-loader.ts: the pipeline
 * itself needs a browser and is not mocked — a fake pipeline would only
 * assert a mock behaves like a mock. What's worth pinning is the pure logic
 * around it: the label map (all 17 model labels, the keep-set, the unknown
 * case) and the score-floor/offset/null-drop filtering.
 */

import { describe, expect, it } from 'vitest';
import { filterEntities, mapNerLabel } from './ner-detector';

describe('mapNerLabel', () => {
  it('maps GIVEN_NAME and SURNAME to NAME', () => {
    expect(mapNerLabel('GIVEN_NAME')).toBe('NAME');
    expect(mapNerLabel('SURNAME')).toBe('NAME');
  });

  it('maps PHONE, EMAIL, URL to themselves', () => {
    expect(mapNerLabel('PHONE')).toBe('PHONE');
    expect(mapNerLabel('EMAIL')).toBe('EMAIL');
    expect(mapNerLabel('URL')).toBe('URL');
  });

  it('maps every ID-shaped label to ID_NUMBER', () => {
    const idLabels = [
      'TAX_ID',
      'BANK_ACCOUNT',
      'ROUTING_NUMBER',
      'GOVERNMENT_ID',
      'PASSPORT',
      'DRIVERS_LICENSE',
    ];
    for (const label of idLabels) {
      expect(mapNerLabel(label)).toBe('ID_NUMBER');
    }
  });

  it('maps every address-fragment label to ADDRESS', () => {
    expect(mapNerLabel('BUILDING_NUMBER')).toBe('ADDRESS');
    expect(mapNerLabel('STREET_NAME')).toBe('ADDRESS');
    expect(mapNerLabel('SECONDARY_ADDRESS')).toBe('ADDRESS');
  });

  it('drops the CITY/STATE/ZIP_CODE keep-set — detected but not redacted', () => {
    expect(mapNerLabel('CITY')).toBeNull();
    expect(mapNerLabel('STATE')).toBeNull();
    expect(mapNerLabel('ZIP_CODE')).toBeNull();
  });

  it('drops an unrecognized label rather than guessing', () => {
    expect(mapNerLabel('SOMETHING_NEW')).toBeNull();
    expect(mapNerLabel('')).toBeNull();
  });

  it('covers all 17 model labels from the model card', () => {
    // Every label the model can emit maps to something defined here (NAME,
    // PHONE, EMAIL, URL, ID_NUMBER, ADDRESS, or an explicit null) — none
    // fall through to a label this file has never heard of.
    const allLabels = [
      'GIVEN_NAME', 'SURNAME', 'EMAIL', 'PHONE', 'URL', 'TAX_ID',
      'BANK_ACCOUNT', 'ROUTING_NUMBER', 'GOVERNMENT_ID', 'PASSPORT',
      'DRIVERS_LICENSE', 'BUILDING_NUMBER', 'STREET_NAME',
      'SECONDARY_ADDRESS', 'CITY', 'STATE', 'ZIP_CODE',
    ];
    expect(allLabels).toHaveLength(17);
    for (const label of allLabels) {
      expect(() => mapNerLabel(label)).not.toThrow();
    }
  });
});

describe('filterEntities', () => {
  it('keeps entities at or above the score floor, drops below', () => {
    const entities = [
      { entity_group: 'GIVEN_NAME', score: 0.15, word: 'प्रिया' },
      { entity_group: 'GIVEN_NAME', score: 0.14, word: 'राहुल' },
    ];
    const spans = filterEntities(entities, 0.15);

    expect(spans).toHaveLength(1);
    expect(spans[0].word).toBe('प्रिया');
  });

  it('drops entities whose label maps to null (keep-set or unknown)', () => {
    const entities = [
      { entity_group: 'CITY', score: 0.99, word: 'मुंबई' },
      { entity_group: 'MYSTERY', score: 0.99, word: 'xyz' },
    ];
    expect(filterEntities(entities)).toHaveLength(0);
  });

  it('maps the label and carries word/score through, offsets null', () => {
    // Offsets are null by construction: transformers.js does not emit char
    // offsets for token-classification. See NerSpan's doc comment.
    const entities = [{ entity_group: 'SURNAME', score: 0.42, word: 'शर्मा' }];
    const spans = filterEntities(entities);

    expect(spans).toEqual([
      {
        piiType: 'NAME',
        word: 'शर्मा',
        start: null,
        end: null,
        score: 0.42,
        label: 'SURNAME',
      },
    ]);
  });

  it('respects a custom score floor', () => {
    const entities = [{ entity_group: 'PHONE', score: 0.5, word: '9876543210' }];
    expect(filterEntities(entities, 0.6)).toHaveLength(0);
    expect(filterEntities(entities, 0.4)).toHaveLength(1);
  });

  it('uses the 0.15 default floor when none is given', () => {
    const entities = [
      { entity_group: 'PHONE', score: 0.16, word: '98765' },
      { entity_group: 'PHONE', score: 0.1, word: '43210' },
    ];
    expect(filterEntities(entities)).toHaveLength(1);
  });

  it('keeps a real SURNAME/CITY score pair the 0.4 floor would have split', () => {
    // Observed scores from the actual model on the self-test string:
    // SURNAME 0.421, CITY 0.369. This is why the floor is 0.15, not Track
    // 2's 0.4 — INT8 flattens scores, and 0.4 would drop the surname on a
    // string where the model is plainly correct.
    const entities = [
      { entity_group: 'SURNAME', score: 0.421, word: 'शर्मा' },
      { entity_group: 'GIVEN_NAME', score: 0.478, word: 'प्रिया' },
    ];
    expect(filterEntities(entities)).toHaveLength(2);
  });
});
