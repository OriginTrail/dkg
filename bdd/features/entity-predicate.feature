Feature: Knowledge Asset entity-member predicate recognition
  # Behaviour spec for the OT-RFC-43 §10.1 / OT-RFC-44 §4 predicate rename:
  #   dkg:rootEntity          -> dkg:entity
  #   dkg:assertionRootEntity -> dkg:assertionEntity
  # During the dual-write migration window a mixed-fleet node MUST recognise
  # BOTH the new and the legacy predicate, or entity members get silently
  # dropped. This spec pins that behaviour in human-readable terms.
  #
  # This is the "smoke" spec: pure, deterministic, no devnet required.

  Background:
    Given the entity-predicate migration helpers

  Scenario Outline: A KA entity-member predicate is recognised across the rename
    When I check whether "<iri>" is a KA entity predicate
    Then the recognition result is "<expected>"

    Examples:
      | iri                                    | expected |
      | http://dkg.io/ontology/entity          | true     |
      | http://dkg.io/ontology/rootEntity      | true     |
      | http://dkg.io/ontology/assertionEntity | false    |
      | http://dkg.io/ontology/unrelated       | false    |
      | http://schema.org/name                 | false    |

  Scenario Outline: An assertion-seal entity predicate is recognised across the rename
    When I check whether "<iri>" is an assertion-seal entity predicate
    Then the recognition result is "<expected>"

    Examples:
      | iri                                        | expected |
      | http://dkg.io/ontology/assertionEntity     | true     |
      | http://dkg.io/ontology/assertionRootEntity | true     |
      | http://dkg.io/ontology/entity              | false    |
      | http://dkg.io/ontology/rootEntity          | false    |
