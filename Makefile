.PHONY: up down reset logs ps verify-s3 verify-events verify verify-schema migrate psql

up:
	@test -f .env || cp .env.example .env
	docker compose up -d --build --wait

down:
	docker compose down

reset:
	docker compose down -v

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

verify-s3:
	@./infra/scripts/verify-s3.sh

verify-events:
	@./infra/scripts/verify-events.sh

verify: verify-s3 verify-events verify-schema

migrate:
	docker compose run --rm migrate

psql:
	docker compose exec postgres psql -U canvas -d canvas

verify-schema:
	@./infra/scripts/verify-schema.sh
