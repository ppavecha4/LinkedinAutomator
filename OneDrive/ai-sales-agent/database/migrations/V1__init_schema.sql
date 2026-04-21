-- V1__init_schema.sql
-- Shared extensions and enum types used across the schema.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE channel_type AS ENUM ('email', 'linkedin', 'whatsapp');
CREATE TYPE direction_type AS ENUM ('outbound', 'inbound');
