# Nodal AI Roadmap

Welcome to the Nodal AI roadmap! This document provides visibility into our planned features, current engineering priorities, and opportunities for open-source contributors to get involved and earn [Stellar Wave Drips points](./CONTRIBUTING.md#stellar-wave--drips-points).

To view all active milestones and track issue progress directly on GitHub, visit our [GitHub Milestones](https://github.com/Nodal-stellar/Nodal-AI/milestones).

---

## Current Sprint

*Milestone:* [Sprint 1: Core Primitives, DX & Test Reliability](https://github.com/Nodal-stellar/Nodal-AI/milestones)  
*Target Date:* Q3 2026

The current sprint focuses on five core themes from our issue backlog:

### 1. Developer Experience (DX) & Documentation
*Target Date:* Q3 2026
- Add public roadmap and contribution documentation to align community contributors ([#485](https://github.com/Nodal-stellar/Nodal-AI/issues/485))
- Establish pull request templates with security and test coverage checklists ([#483](https://github.com/Nodal-stellar/Nodal-AI/issues/483))
- Configure automated pre-commit type checking and formatting hooks ([#475](https://github.com/Nodal-stellar/Nodal-AI/issues/475))
- Provide test-only Docker profiles and devcontainer configurations ([#481](https://github.com/Nodal-stellar/Nodal-AI/issues/481))

### 2. Autonomous PayFi & Tool Integrations
*Target Date:* Q3 2026
- Wire `ClaimableBalanceTool` into `PayFiAgent` task execution ([#546](https://github.com/Nodal-stellar/Nodal-AI/issues/546))
- Build `SponsoredAccountTool` for managing sponsored reserve accounts ([#398](https://github.com/Nodal-stellar/Nodal-AI/issues/398))
- Implement `AnchorQuoteTool` for SEP-0038 firm quote requests ([#399](https://github.com/Nodal-stellar/Nodal-AI/issues/399))
- Add `SequenceNumberTool` to fetch and bump account sequence numbers ([#400](https://github.com/Nodal-stellar/Nodal-AI/issues/400))

### 3. Testing, Reliability & Network Simulation
*Target Date:* Q3 2026
- Build `MockNetworkConditions` utility for injecting latency and failures in tests ([#443](https://github.com/Nodal-stellar/Nodal-AI/issues/443))
- Add snapshot tests for `AgentResult` serialisation shapes across tools ([#442](https://github.com/Nodal-stellar/Nodal-AI/issues/442))
- Implement shared `MockSorobanServer` fixture for offline Soroban testing ([#438](https://github.com/Nodal-stellar/Nodal-AI/issues/438))
- Introduce network partition simulation tests for RPC client retry logic ([#439](https://github.com/Nodal-stellar/Nodal-AI/issues/439))

### 4. Smart Contracts & Soroban Escrow
*Target Date:* Q3 2026
- Expand milestone-based PayFi escrow contract capabilities with release conditions
- Implement authorization signer guards for contract invocations
- Ensure pre-flight simulation validation on all smart contract transactions
- Pin dependency versions and build caches for reproducible Soroban builds

### 5. Security & Spending Controls
*Target Date:* Q3 2026
- Implement rolling-window spending limit tracker and status checks ([#447](https://github.com/Nodal-stellar/Nodal-AI/issues/447))
- Add HMAC webhook signature verification and payload tamper detection ([#448](https://github.com/Nodal-stellar/Nodal-AI/issues/448))
- Strict zero-leak secret hygiene and validation error sanitization
- Fuzz testing for payment amounts and x402 challenge schemas ([#445](https://github.com/Nodal-stellar/Nodal-AI/issues/445), [#440](https://github.com/Nodal-stellar/Nodal-AI/issues/440))

---

## Next Up

*Milestone:* [Sprint 2: Multi-Party Orchestration & Advanced Flow](https://github.com/Nodal-stellar/Nodal-AI/milestones)  
*Target Date:* Q4 2026

Planned work includes:
- Multi-agent coordination protocols and state synchronisation
- Streaming micropayments leveraging SEP-0010 and x402 challenge cycles
- Dynamic transaction fee estimation and network congestion mitigation
- Interactive CLI agent debugger for inspecting tool execution graphs
- Automated test coverage reporting in CI with thresholds

---

## Future

*Milestone:* [Sprint 3: Enterprise PayFi & Cross-Chain Interoperability](https://github.com/Nodal-stellar/Nodal-AI/milestones)  
*Target Date:* Q1 2027

Planned work includes:
- Cross-chain liquidity routing and bridge connectors
- Hardware Security Module (HSM) and cloud KMS key management integrations
- Decentralised agent identity and on-chain reputation scoring
- Zero-knowledge compliance and proof-of-payment verifiers
- Automated liquidity rebalancing across Stellar DEX order books and AMM pools

---

## Completed

*Milestone:* [Sprint 0: Core Architecture & Initial Tooling](https://github.com/Nodal-stellar/Nodal-AI/milestones)  
*Target Date:* Q2 2026

Completed milestones and capabilities:
- Modular `PayFiAgent` orchestration core with extensible `TaskType` dispatch
- Base `StellarPaymentTool` with native XLM and trustline asset transfer support
- Standardised `x402_respond` payment challenge and proof generation flow
- Soroban RPC client with simulation verification before broadcast
- Multi-stage Docker development and testing environment
