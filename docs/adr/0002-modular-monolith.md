# ADR 0002: Start as a modular monolith

- Status: Accepted
- Date: 2026-07-20

## Context

CodeM may eventually need remote sandboxes, job queues, artifact storage, authentication, indexing, and multiple transports. Splitting these concerns into services before a working coding-tool loop exists would add deployment and debugging cost without proving product value.

## Decision

Build the MVP as one deployable MCP server with strongly separated packages and ports. Keep process execution, filesystem access, Git, policy, and host-specific metadata behind interfaces.

Extract a service only when operational requirements justify it, especially isolation, scaling, independent deployment, or different trust boundaries.

## Consequences

- local development and debugging remain simple
- contracts can be tested without network boundaries
- future extraction remains possible through existing ports
- package boundaries require discipline because the compiler alone cannot prevent every architectural violation

## Enforcement

- core cannot import MCP, Bun, or host-specific packages
- tool handlers cannot call concrete operating-system APIs
- adapters implement ports defined by core
- architecture rules are documented and later enforced with dependency tests
