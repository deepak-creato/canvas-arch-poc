.PHONY: bootstrap teardown preflight health smoke-sfn up down reset logs ps verify-s3 verify-events verify verify-schema migrate psql test verify-m2

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

# M2 exit demo: 5 images + 1 video become usable, no final-tier work
verify-m2:
	@./infra/scripts/verify-m2.sh
