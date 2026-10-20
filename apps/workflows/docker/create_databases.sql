-- One local Postgres server: n8n's own state, the app (local mode), and the test database.
CREATE DATABASE n8n;
CREATE DATABASE loan_engine;
CREATE DATABASE loan_engine_test;  -- pytest wipes and recreates its schema
