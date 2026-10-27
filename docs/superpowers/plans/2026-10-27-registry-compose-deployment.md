# Standalone Compose deployment implementation plan

**Goal:** The server needs only docker-compose.yaml and runs docker compose up -d to pull and start an already published image.

**Architecture:** Remove source-build and image archive requirements from server deployment. Use ghcr.io/amazingz-sys/printer-logcat-sever:latest, inline credentials and a named volume. A GitHub workflow tests and builds multi-platform images before publication. Creating configuration is distinct from publishing an actual remote image.

- [x] Inspect repository ownership, existing image and available publication tooling.
- [x] Replace compose.yaml with independent docker-compose.yaml without build or env_file; retain persistent storage, health checks from image and graceful shutdown.
- [x] Remove obsolete package script and generated archive; rewrite README for the one-file server flow.
- [x] Add GitHub Actions for test/typecheck and main/tag/manual GHCR publication, never publishing from PRs.
- [x] Validate the standalone file in an empty directory and run an isolated Compose deployment against the existing local image, including log ingestion and volume persistence across recreation.
- [x] Review workflow permissions, triggers, tags and target architectures; run relevant repository checks.
- [x] Explain the remaining first publication step and package visibility. Actual remote publication requires authorization to push the current source and workflow to the public repository.

Verification: docker-compose.yaml validated alone in an empty directory. Isolated local-image Compose deployment accepted logs, then retained them across down/up. All 14 application tests, typecheck, build and git diff --check passed. Remote anonymous GHCR inspection currently returns denied; publication and public package availability have not been completed.
