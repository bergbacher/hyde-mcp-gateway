-- Local fixture for test/query.integration.test.ts. Run as root against a
-- local MySQL; idempotent. A base table with a "personal" column, database
-- `redacted` with one view that leaves it out, and the reader that may read
-- `redacted` only, as hyde-db sets it up.

CREATE DATABASE IF NOT EXISTS hyde_test_app;
CREATE TABLE IF NOT EXISTS hyde_test_app.users (
  id INT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL
);
DELETE FROM hyde_test_app.users;
INSERT INTO hyde_test_app.users (id, email, status) VALUES
  (1, 'a@example.com', 'active'), (2, 'b@example.com', 'active'), (3, 'c@example.com', 'blocked'),
  (4, 'd@example.com', 'active'), (5, 'e@example.com', 'active'), (6, 'f@example.com', 'pending'),
  (7, 'g@example.com', 'active'), (8, 'h@example.com', 'active'), (9, 'i@example.com', 'blocked'),
  (10, 'j@example.com', 'active');

CREATE DATABASE IF NOT EXISTS redacted;
CREATE OR REPLACE SQL SECURITY DEFINER VIEW redacted.users AS SELECT id, status FROM hyde_test_app.users;

CREATE USER IF NOT EXISTS 'redacted_reader'@'%' IDENTIFIED BY 'local-reader-password';
ALTER USER 'redacted_reader'@'%' IDENTIFIED BY 'local-reader-password';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'redacted_reader'@'%';
GRANT SELECT ON redacted.* TO 'redacted_reader'@'%';
