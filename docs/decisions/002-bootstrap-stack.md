# ADR 002: Offline bootstrap stack

Status: accepted for the Task 2 prototype  
Date: 2026-09-24

## Context

The first implementation slice needs strict, versioned contracts and a deterministic fake runtime. Nate requested compatibility with Node 24 and newer; Node 24 and 26 are installed on the development Mac.

## Decision

Use ESM TypeScript 5.9.3 with `NodeNext` resolution and strict checking. Declare Node `>=24`, lock project development dependencies with npm, and use Node's built-in test runner. Keep the fake adapter and contract validation dependency-free at runtime. Build and run the focused offline suite on both installed Node majors.

## Consequences

- The package is reproducible with `npm ci`; no provider dependency or credential is required for offline tests.
- Runtime parsing rejects unknown fields and validates versioned job, event, result and configuration shapes. This is a contract prototype, not an authorization or sandbox boundary.
- SQLite packaging, daemon transport, release packaging, and a real OpenCode adapter remain separate decisions. A working fake adapter does not establish real-runtime behavior.
