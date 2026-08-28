# Build the offline bundle.
#
# Run on a machine WITH internet. Produces a single directory that can be copied
# to an isolated server and installed with no network access whatsoever.
#
#   make -C infra/bundle assets     fetch + verify model weights
#   make -C infra/bundle images     build all container images
#   make -C infra/bundle bundle     assemble the transferable directory
#   make -C infra/bundle verify     prove the images run with no network
#
SHELL := /bin/bash
ROOT := $(shell cd ../.. && pwd)
VERSION ?= 0.1.0
PLATFORM ?= linux/amd64
OUT := $(ROOT)/infra/bundle/out/pixelsmith-$(VERSION)
COMPOSE := $(ROOT)/docker-compose.yml

IMAGES := pixelsmith/api:$(VERSION) pixelsmith/runner:$(VERSION) pixelsmith/inference:$(VERSION) redis:7.4-alpine

.PHONY: all assets images bundle verify clean

all: assets images bundle

assets:
	@echo "==> Fetching and verifying vendored assets"
	@$(ROOT)/infra/bundle/fetch-assets.sh

images: assets
	@echo "==> Building images for $(PLATFORM)"
	cd $(ROOT) && \
	  PIXELSMITH_VERSION=$(VERSION) COOKIE_SECRET=build-time-placeholder \
	  docker compose -f $(COMPOSE) build
	@echo "==> Pulling Redis so it ships with the bundle too"
	docker pull --platform $(PLATFORM) redis:7.4-alpine

bundle: images
	@echo "==> Assembling $(OUT)"
	@rm -rf $(OUT) && mkdir -p $(OUT)
	@echo "    saving images (this is the slow part)"
	docker save $(IMAGES) | gzip -9 > $(OUT)/images.tar.gz
	@cp $(COMPOSE) $(OUT)/docker-compose.yml
	@cp $(ROOT)/infra/bundle/install.sh $(OUT)/install.sh
	@cp $(ROOT)/infra/bundle/env.example $(OUT)/env.example
	@cp $(ROOT)/docs/RUNBOOK.md $(OUT)/RUNBOOK.md
	@cp $(ROOT)/infra/bundle/assets.manifest $(OUT)/assets.manifest
	@chmod +x $(OUT)/install.sh
	@echo "$(VERSION)" > $(OUT)/VERSION
	@cd $(OUT) && (command -v sha256sum >/dev/null && sha256sum * > SHA256SUMS || shasum -a 256 * > SHA256SUMS) 2>/dev/null || true
	@echo ""
	@echo "Bundle ready: $(OUT)"
	@du -sh $(OUT)
	@echo "Copy that directory to the isolated server and run ./install.sh"

# Proves the stack runs and that the processing tier has no route out. The
# check itself lives in egress-check.sh, so an operator can run it on the
# isolated server without make, and so its logic is readable rather than
# escaped three times over.
PORT ?= 8080
TARGET ?= 1.1.1.1

verify:
	@echo "==> Starting the stack"
	cd $(ROOT) && \
	  PIXELSMITH_VERSION=$(VERSION) COOKIE_SECRET=$$(openssl rand -hex 32) PUBLISH_PORT=$(PORT) \
	  docker compose -f $(COMPOSE) up -d
	@echo "==> Waiting for health"
	@for i in $$(seq 40); do \
	  if curl -fsS http://127.0.0.1:$(PORT)/healthz >/dev/null 2>&1; then break; fi; \
	  sleep 3; \
	done
	@curl -fsS http://127.0.0.1:$(PORT)/healthz && echo ""
	cd $(ROOT) && ./infra/bundle/egress-check.sh $(TARGET)
	cd $(ROOT) && docker compose -f $(COMPOSE) down

clean:
	rm -rf $(ROOT)/infra/bundle/out
