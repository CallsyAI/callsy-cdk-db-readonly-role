# callsy-cdk-db-readonly-role

An AWS CDK construct that creates a Postgres role which can read every table and write nothing. The password is generated into a Secrets Manager secret, applied to the cluster by a Lambda, and never appears in your code, your template, or a SQL statement.

## Features

- **Read-only by construction** — the role holds `SELECT` and nothing else. No `INSERT`, no `UPDATE`, no `DELETE`, no DDL.
- **Read-only by default too** — `default_transaction_read_only` is set on the role, so a client that never asks for a read-only transaction still gets one. The missing write grants are the boundary; this is the second layer.
- **The plaintext password never reaches the database** — the handler computes the SCRAM-SHA-256 verifier itself and sends that. The password appears in no statement and in no log.
- **Covers tables that do not exist yet** — `GRANT pg_read_all_data` picks up every table a later migration adds, with an automatic fallback to the public schema on engines that refuse the predefined role.
- **Guarded against runaway queries** — a statement timeout, an idle-in-transaction timeout, a lock timeout and a connection limit are all set on the role, so one client cannot sit on a production connection or eat the cluster's connection budget.
- **Verified at deploy time** — before reporting success, the handler reconnects *as the role* and asserts that it is who it says it is and that it is read-only. A wrong verifier or a missing `CONNECT` grant fails the deploy, not your application.
- **Idempotent** — create and update run the same convergent statements, so a repeated deploy is safe. Delete drops the role, and a role already dropped by hand does not wedge the stack.
- **Writer for DDL, reader for clients** — the handler connects to the writer endpoint, because `CREATE ROLE` is a write; the secret it hands out points at the reader endpoint.
- **Typed** — ships a `py.typed` marker, so mypy and your IDE see the full signature.

## Installation

```bash
pip install callsy-cdk-db-readonly-role
```

**Requirements:** Python >= 3.10, `aws-cdk-lib` >= 2.180.0, and **Docker running at synthesis** — the handler's dependencies (`pg`, `@aws-sdk/client-secrets-manager`) are installed in a container when the asset is bundled.

## Quick start

```python
from aws_cdk import Stack
from aws_cdk.aws_rds import DatabaseCluster
from callsy_cdk.db_readonly_role import DatabaseReadonlyRole

class DatabaseStack(Stack):
    def __init__(self, scope):
        super().__init__(scope, "DatabaseStack")

        cluster = DatabaseCluster(self, "Cluster", ...)

        role = DatabaseReadonlyRole(
            scope=self,
            cluster=cluster,
            database_name="app"
        )

        # The credentials, for whatever needs to read.
        role.secret.grant_read(some_function)
```

Deploy, and the cluster has a `readonly` Postgres role whose credentials live in `role.secret`.

## What the secret holds

The generated secret carries the same five keys as the cluster's own master secret, so it speaks the database's vocabulary rather than any one consumer's:

```json
{
  "host": "my-cluster.cluster-ro-abc123.eu-west-1.rds.amazonaws.com",
  "port": 5432,
  "dbname": "app",
  "username": "readonly",
  "password": "<generated, 32 alphanumeric characters>"
}
```

`host` is the cluster **reader** endpoint. Every consumer of this secret only reads, and on a cluster that later gains a replica the endpoint starts routing to it with no change here.

This is a routing choice and not a safety one. On a single-instance cluster the reader endpoint is fully writable — the role is what stops a write, not the endpoint.

The password excludes punctuation, so it drops into a connection string without escaping.

## What happens on each CloudFormation event

| Event | What the handler does |
|---|---|
| **Create** / **Update** | Connects to the **writer** as the master user. Creates the role if absent, then applies every convergent statement: the verifier, the connection limit, `CONNECT` on the database, the read grant, and the four read-only and timeout settings. Then reconnects as the role and verifies it. |
| **Delete** | `DROP OWNED BY` followed by `DROP ROLE`. A role that is already gone is not an error. |

Create and update run exactly the same path, so a repeated deploy converges rather than drifting. The physical resource id is `<database>/<role_name>` and is echoed back unchanged on an update — a new id would make CloudFormation send a delete for the old one and drop the role that was just configured.

## How the password reaches Postgres

```
Secrets Manager generates the password
        |
        v
handler reads it  ──>  PBKDF2-HMAC-SHA256, 4096 iterations, random 16-byte salt
                                |
                                v
                       SCRAM-SHA-256 verifier
                                |
                                v
              ALTER ROLE ... PASSWORD '<verifier>'    <-- Postgres stores this unchanged
```

Postgres accepts an already-encrypted password string and stores it as-is. So the plaintext is never part of a statement, never reaches the query log, and never reaches CloudTrail. The generated password is alphanumeric, so SASLprep normalises it to itself and the verifier matches.

## The read grant, and its fallback

The handler first tries the predefined role:

```sql
GRANT pg_read_all_data TO readonly
```

This covers every table that exists now **and every table a later migration adds** — there is nothing to re-run after a schema change. It does not set `BYPASSRLS`, so row-level security still applies.

Some managed engines do not hold `pg_read_all_data` with admin option, and refuse the grant with SQLSTATE `42501`. The handler catches exactly that code, rolls back to a savepoint, and falls back to:

```sql
GRANT USAGE ON SCHEMA public TO readonly
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO readonly
```

The fallback reaches only the `public` schema, and only objects that `postgres` creates. Which path was taken is logged. Any other error is re-raised rather than swallowed.

## Limits set on the role

Every one of these is set on the role itself, so they apply to every session it opens.

| Setting | Default | Why |
|---|---|---|
| `default_transaction_read_only` | `on` | A client that never asks for read-only still gets it. |
| `statement_timeout` | `30s` | A generated query cannot sit on a production connection. |
| `idle_in_transaction_session_timeout` | `60s` | The cluster default is a day. An abandoned transaction cannot hold its snapshot. |
| `lock_timeout` | `5s` | A reader cannot queue behind a lock it will never get. |
| `CONNECTION LIMIT` | `5` | One client cannot eat the cluster's connection budget. |

The handler's own session is separately capped (`statement_timeout=20s`, `lock_timeout=5s`) because it runs against a production writer during a deploy, and must give up rather than block an application statement.

## Networking

The Lambda is created **outside any VPC** by default. That is deliberate: a function placed in a VPC with no NAT gateway and no interface endpoints can reach neither Secrets Manager nor the pre-signed URL CloudFormation expects its response on — the deploy then hangs until the custom resource times out.

If your cluster is not reachable from outside the VPC, pass `vpc`, `vpc_subnets` and `security_groups`, and make sure that subnet has a route to Secrets Manager (a NAT gateway or an interface endpoint) as well as to the cluster.

Connections are made with TLS (`sslmode=require` semantics: encrypted, certificate not verified).

## API

### `DatabaseReadonlyRole(scope, cluster, database_name, *, ...)`

| Argument | Type | Default | Description |
|---|---|---|---|
| `scope` | `Stack` | — | The stack the role belongs to. |
| `cluster` | `IDatabaseCluster` | — | The cluster the role is created on. Its writer endpoint is used for DDL, its reader endpoint goes into the secret. |
| `database_name` | `str` | — | The database the role is granted `CONNECT` on. |
| `id` | `str` | `"DatabaseReadonlyRole"` | Construct id, and the stem of every child. Change it to build more than one role in a stack. |
| `role_name` | `str` | `"readonly"` | The Postgres role name, and the `username` in the secret. |
| `master_secret` | `ISecret \| None` | `cluster.secret` | Credentials the handler connects with. Required for an imported cluster that carries no secret. |
| `secret_name` | `str \| None` | `None` | A fixed name for the generated secret. Set it when another project looks the secret up by name rather than by ARN. |
| `secret_description` | `str` | *(see source)* | Description of the generated secret. |
| `password_length` | `int` | `32` | Length of the generated password. |
| `connection_limit` | `int` | `5` | Connections the role may hold at once. |
| `statement_timeout` | `str` | `"30s"` | Postgres interval, set on the role. |
| `idle_transaction_timeout` | `str` | `"60s"` | Postgres interval, set on the role. |
| `lock_timeout` | `str` | `"5s"` | Postgres interval, set on the role. |
| `function_name` | `str \| None` | `None` | A fixed name for the handler function. |
| `runtime` | `Runtime \| None` | `NODEJS_22_X` | Lambda runtime for the handler. |
| `memory_size` | `int \| None` | `256` | Handler memory, in MiB. |
| `timeout` | `Duration \| None` | `2 minutes` | Handler timeout. |
| `docker_image` | `str \| None` | `"node:22-alpine"` | Image the handler dependencies are installed with. |
| `vpc` | `IVpc \| None` | `None` | See **Networking**. |
| `vpc_subnets` | `SubnetSelection \| None` | `None` | See **Networking**. |
| `security_groups` | `Sequence[ISecurityGroup] \| None` | `None` | See **Networking**. |

**Attributes**

| Attribute | Type | Description |
|---|---|---|
| `secret` | `Secret` | The role's credentials. |
| `role_name` | `str` | The Postgres role name. |
| `function` | `DatabaseReadonlyRoleFunction` | The handler, if you need to grant it something extra. |

`DatabaseReadonlyRole` extends `CustomResource`, so the whole construct API is available as usual.

### Children it builds

With the default `id`, the construct adds four resources to the stack:

| Construct id | What it is |
|---|---|
| `DatabaseReadonlyRoleSecret` | The generated credentials. |
| `DatabaseReadonlyRoleFunction` | The handler. |
| `DatabaseReadonlyRoleProvider` | The custom resource provider (synchronous, no waiter). |
| `DatabaseReadonlyRole` | The custom resource itself. |

To build a second role in the same stack, pass a different `id`.

## Examples

**An imported cluster, with credentials handed over explicitly**

```python
cluster = DatabaseCluster.from_database_cluster_attributes(self, "Cluster", cluster_identifier="my-cluster", ...)
master = Secret.from_secret_name_v2(self, "Master", "my-cluster-master")

DatabaseReadonlyRole(
    scope=self,
    cluster=cluster,
    database_name="app",
    master_secret=master,
    secret_name="my-project/readonly"
)
```

**A looser role for a long-running analytics client**

```python
DatabaseReadonlyRole(
    scope=self,
    cluster=cluster,
    database_name="app",
    id="AnalyticsReadonlyRole",
    role_name="analytics",
    connection_limit=20,
    statement_timeout="5min"
)
```

## License

ISC
