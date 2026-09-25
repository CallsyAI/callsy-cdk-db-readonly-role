# Changelog

All notable changes to this project are documented here.
This project adheres to [semantic versioning](https://semver.org/).

## 1.0.0

Initial release. Extracted from the Callsy infrastructure repositories, where the construct
had already been running in production.

- `DatabaseReadonlyRole` — a Postgres role that reads every table and writes nothing, with
  its password generated into a Secrets Manager secret.
- SCRAM-SHA-256 verifier built in the handler, so the plaintext password never reaches a
  SQL statement.
- `GRANT pg_read_all_data` with an automatic fallback to the public schema on engines that
  refuse it.
- Deploy-time verification: the handler reconnects as the role and asserts it is read-only.
- New over the in-repo version: `IDatabaseCluster` instead of the concrete cluster type, an
  optional `master_secret` for imported clusters, an `id` that renames every child, and the
  role limits (`connection_limit`, `statement_timeout`, `idle_transaction_timeout`,
  `lock_timeout`) exposed as arguments rather than constants.
- The limits now travel in the resource properties and are escaped by the handler rather
  than inlined into the statement.
- Node 22 is the default Lambda runtime and bundling image, up from Node 20.
