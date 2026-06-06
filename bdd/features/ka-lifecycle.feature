@devnet
Feature: Knowledge Asset publish lifecycle (Working Memory -> Shared WM -> Verified)
  # The canonical V10 flow a DKG agent performs: take a draft assertion through
  # create -> write -> finalize -> promote -> publish, ending as a verifiable
  # on-chain Knowledge Asset. Mirrors devnet/v10-core-flows fullPublish(), but
  # expressed as behaviour anyone can read.
  #
  # Tagged @devnet: skipped automatically unless a local devnet is running
  #   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
  #   node devnet/_bootstrap/bootstrap.cjs

  Background:
    Given a reachable devnet node with an authenticated agent
    And the "devnet-test" context graph

  # Tag is repeated on the scenario (not only the feature): @amiceli/vitest-cucumber
  # filters per-scenario, so the gate that skips this without a devnet lives here.
  @devnet
  Scenario: A signed assertion becomes a confirmed on-chain Knowledge Asset
    Given a fresh draft assertion in the context graph
    When I write 2 entity quads to the assertion
    And I finalize the assertion
    Then the assertion has a merkle root and an EIP-712 digest

    When I promote the assertion to shared working memory
    Then at least 1 share is created

    When I publish the assertion to the chain
    Then a knowledge asset id is returned
    And the knowledge asset status is one of "confirmed,tentative,finalized"
