.PHONY: bootstrap teardown preflight health smoke-sfn up down reset logs ps verify-s3 verify-events verify verify-schema migrate psql test verify-m2 gc-run gc-jobs gc-dlq gc-redrive gc-reconcile demo demo-run ui-install ui ui-test ui-build

# One command from a fresh clone to a verified stack (M1 exit demo)
bootstrap:
	@test -f .env || cp .env.example .env
	@./infra/scripts/preflight.sh
	docker compose up -d --build --wait
	@./infra/scripts/health.sh
	@$(MAKE) --no-print-directory verify
	@echo
	@echo "Stack ready: API http://localhost:3000  LocalStack http://localhost:4566  Postgres 127.0.0.1:5433  Redis 127.0.0.1:6380"

preflight:
	@./infra/scripts/preflight.sh

health:
	@./infra/scripts/health.sh

smoke-sfn:
	@./infra/scripts/smoke-sfn.sh

up:
	@test -f .env || cp .env.example .env
	docker compose up -d --build --wait

down:
	docker compose down

reset: teardown

teardown:
	docker compose down -v --remove-orphans

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

verify-s3:
	@./infra/scripts/verify-s3.sh

verify-events:
	@./infra/scripts/verify-events.sh

verify: verify-s3 verify-events verify-schema smoke-sfn

migrate:
	docker compose run --rm migrate

psql:
	docker compose exec postgres psql -U canvas -d canvas

verify-schema:
	@./infra/scripts/verify-schema.sh

# Integration tests for canvas-api; need the stack running (make up)
test:
	cd services/canvas-api && npm test
	cd services/light-worker && npm test -- --forceExit
	cd services/ai-worker && npm test -- --forceExit
	cd services/mock-transcoder && npm test -- --forceExit
	cd services/gc-worker && npm test -- --forceExit

# M2 exit demo: 5 images + 1 video become usable, no final-tier work
verify-m2:
	@./infra/scripts/verify-m2.sh

# One GC cycle now (optionally STEP=sweep). Prints the per-step summary.
gc-run:
	@curl -fsS -X POST "http://127.0.0.1:$${HOST_PORT_GC:-3104}/run$(if $(STEP),?step=$(STEP),)"; echo

# Diagnose and recover (POC-035): failed or stuck jobs, DLQ contents, move DLQ messages back
gc-jobs:
	@curl -fsS "http://127.0.0.1:$${HOST_PORT_GC:-3104}/ops/jobs"; echo

gc-dlq:
	@curl -fsS "http://127.0.0.1:$${HOST_PORT_GC:-3104}/ops/dlq"; echo

gc-redrive:
	@curl -fsS -X POST "http://127.0.0.1:$${HOST_PORT_GC:-3104}/ops/redrive"; echo

# Missed events and storage drift (POC-036); strays are deleted only with GC_DELETE_STRAYS=true
gc-reconcile:
	@$(MAKE) --no-print-directory gc-run STEP=reconcileUploads,reconcileDrift,reconcileStrays

# POC-039: the whole story from a clean environment. WIPES the stack's volumes first (teardown).
demo:
	@$(MAKE) --no-print-directory teardown
	@$(MAKE) --no-print-directory bootstrap
	@./infra/scripts/demo.sh

# Same demonstration against the running stack, no wipe
demo-run:
	@./infra/scripts/demo.sh

# POC-041: browser test UI (Vite + React in web/), runs on the host at http://127.0.0.1:5173; needs the stack (make up)
ui-install:
	cd web && npm ci

ui:
	cd web && npm run dev

ui-test:
	cd web && npm test

ui-build:
	cd web && npm run build
