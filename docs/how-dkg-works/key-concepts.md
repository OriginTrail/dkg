---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Key Concepts

DKG V10 is easiest to understand as a memory system with increasing scope and trust. Agents start with private working notes, share selected knowledge with peers, and publish durable records when the knowledge is worth anchoring.

![DKG key concepts](../assets/legacy-gitbook/dkg-key-concepts.png)

```mermaid
flowchart LR
  WM["Working Memory<br/>private drafts"] --> SWM["Shared Working Memory<br/>peer-visible collaboration"]
  SWM --> VM["Verified Memory<br/>on-chain Knowledge Assets"]
```

## DKG Network

The DKG network combines local nodes, peer-to-peer exchange, and on-chain commitments. It lets agents write knowledge as graph data, replicate selected data to peers, and finalize selected records as verifiable Knowledge Assets.

## DKG Node

A DKG node is the local gateway into the network. It owns local graph storage, API routes, auth, wallets, peer networking, Context Graph subscriptions, the Node UI, and integrations such as MCP, Hermes, and OpenClaw.

## Context Graph

A Context Graph is a scoped knowledge domain. A team, application, research effort, customer workspace, or agent swarm can each use a separate Context Graph so memory, membership, access policy, and publication policy stay bounded.

## Knowledge Asset

A Knowledge Asset is published graph data with provenance and integrity commitments. It is the durable unit that survives beyond local memory and can be independently verified.

## Knowledge Collection

A Knowledge Collection groups one or more Knowledge Assets into a publish operation. The collection is the on-chain batch boundary for finalization.

## UAL

A UAL is a Universal Asset Locator. It is the durable identifier used to address a published Knowledge Asset after it is anchored.

## Agent

An agent is a software actor that reads, writes, shares, queries, or publishes through a node. The node maps agents to credentials and permissions instead of letting every tool invent its own persistence or trust rules.

## Curator

A Curator controls a curated Context Graph. Curators define who can write, who can publish, and which authority is needed for SHARE or PUBLISH flows.

## Integration

An integration connects an outside workflow to a DKG node through a public interface: HTTP API, CLI, MCP, or another supported surface. Good integrations use public node contracts and do not import private monorepo internals.

## Publisher

A Publisher triggers PUBLISH, UPDATE, or VERIFY operations. In V10, publisher identity matters because published graph data carries provenance and because publishing can be tied to a Publishing Conviction Account.

## Staker

A Staker locks TRAC to support network infrastructure. V10 staking conviction represents these commitments as NFT-backed positions with lock tiers and reward multipliers.

## Core Node and Edge Node

Core Nodes provide resilient network infrastructure. Edge Nodes are local gateways for users, teams, applications, and agents. Both participate in the DKG model, but most agent workflows start from an Edge Node.

## SHARE and PUBLISH

SHARE moves selected local knowledge into Shared Working Memory so peers can see it. PUBLISH finalizes selected shared knowledge into Verified Memory and creates durable on-chain commitments.

Use SHARE for collaboration. Use PUBLISH for finality.
