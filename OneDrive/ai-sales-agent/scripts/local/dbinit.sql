-- Create (or re-password) the login role the services use. Run by the `dbinit`
-- container of docker-compose.local.yml after the migrations (same as
-- scripts/db/create_app_login.sh, but inside the compose network).
--
-- The password arrives through the environment (SALES_APP_DB_PASSWORD) and \getenv,
-- so it is never on a command line or in this file.
SET client_min_messages = warning;
\getenv pw SALES_APP_DB_PASSWORD
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'login') AS missing \gset
\if :missing
  CREATE ROLE :"login" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE sales_app PASSWORD :'pw';
\else
  ALTER ROLE :"login" WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'pw';
  GRANT sales_app TO :"login";
\endif
