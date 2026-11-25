.PHONY: dev test lint deploy migrate setup typecheck synth build

setup:
	cp .env.example .env
	cd infrastructure/cdk && npm install
	cd services/api && npm install
	cd dashboard && npm install
	pip install -r services/orchestrator/requirements.txt
	pip install -r services/outreach-worker/requirements.txt
	pip install -r services/reply-processor/requirements.txt
	@echo "Setup complete. Edit .env with your API keys then run: make dev"

dev:
	docker compose up --build

migrate:
	docker compose run --rm flyway migrate

# Run every test suite the project ships. Vitest tests live under
# services/api/tests; pytest tests live under services/orchestrator/tests
# and pick up the orchestrator + reply-processor + outreach-worker
# imports via the orchestrator's tests/conftest.py sys.path manipulation.
test:
	cd services/api && npm test
	cd services/orchestrator && python -m pytest tests/ -v

# Lint = type-checks across all TS surfaces + Python compile check.
# `flake8` was the original lint target but isn't in any requirements.txt
# and would just fail loudly on a fresh clone; we use `python -m compileall`
# instead — runs the byte-compiler over every .py file and exits non-zero
# on any SyntaxError. Type-checks (`tsc --noEmit`) cover the TS side.
lint:
	cd services/api && npx tsc --noEmit
	cd dashboard && npx tsc --noEmit
	cd infrastructure/cdk && npx tsc --noEmit
	python -m compileall -q services/orchestrator/src services/outreach-worker/src services/reply-processor/src
	@echo "lint OK"

typecheck: lint

# `cdk synth` compiles all 6 stacks to CloudFormation templates without
# touching AWS. Useful as a CI gate.
synth:
	cd infrastructure/cdk && npx cdk synth > /dev/null
	@echo "cdk synth OK"

# Build every Docker image the docker-compose stack references.
build:
	docker compose build

deploy:
	cd infrastructure/cdk && npx cdk deploy --all --require-approval never
