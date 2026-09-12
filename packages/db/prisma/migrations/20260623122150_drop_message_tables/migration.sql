-- Pi sessions are the source of truth for chat history. Remove the legacy
-- PostgreSQL message/event tables from fresh databases as well as upgrades.
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "stream_events";
