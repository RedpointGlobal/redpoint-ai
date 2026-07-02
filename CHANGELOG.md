# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `rpi-domain-expert` — a dispatched, grounded domain-knowledge expert for building RPI campaigns (attributes, selection rules (segments), audiences, interactions, and the design strategy behind them). Tool-less; its knowledge loads into a sub-agent only on a knowledge-intent hit.

### Changed

- Skill router now supports **dispatched experts** (`dispatch: true` on an `expert` skill): such an expert is surfaced in the catalog and reached via `execute_skill` instead of being inlined into the router prompt, so its body costs the parent prompt nothing until invoked.

### Fixed

---

<!-- Compare link — update <<ORG>>/<<REPO>> once the canonical slug is locked -->
[Unreleased]: https://github.com/<<ORG>>/<<REPO>>/compare/HEAD...HEAD
