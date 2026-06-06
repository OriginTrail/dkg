/**
 * Smoke spec — proves the Gherkin -> Vitest binding runs end to end against
 * real product code, with no devnet and no network.
 *
 * Binds bdd/features/entity-predicate.feature to the pure helpers in
 * packages/core/src/entity-predicate.ts (the OT-RFC-43/44 dual-read invariant).
 */
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAssertionEntityPredicate,
  isEntityPredicate,
} from '../../packages/core/src/entity-predicate.js';

const here = dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(resolve(here, '../features/entity-predicate.feature'));

describeFeature(feature, ({ Background, ScenarioOutline }) => {
  Background(({ Given }) => {
    Given('the entity-predicate migration helpers', () => {
      expect(typeof isEntityPredicate).toBe('function');
      expect(typeof isAssertionEntityPredicate).toBe('function');
    });
  });

  ScenarioOutline(
    'A KA entity-member predicate is recognised across the rename',
    ({ When, Then }, variables) => {
      let result = false;
      When('I check whether "<iri>" is a KA entity predicate', () => {
        result = isEntityPredicate(String(variables.iri));
      });
      Then('the recognition result is "<expected>"', () => {
        expect(String(result)).toBe(String(variables.expected));
      });
    },
  );

  ScenarioOutline(
    'An assertion-seal entity predicate is recognised across the rename',
    ({ When, Then }, variables) => {
      let result = false;
      When('I check whether "<iri>" is an assertion-seal entity predicate', () => {
        result = isAssertionEntityPredicate(String(variables.iri));
      });
      Then('the recognition result is "<expected>"', () => {
        expect(String(result)).toBe(String(variables.expected));
      });
    },
  );
});
