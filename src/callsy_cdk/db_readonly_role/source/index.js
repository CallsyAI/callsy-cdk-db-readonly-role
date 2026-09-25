const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager")
const { Client } = require("pg")
const crypto = require("node:crypto")

// Iterations Postgres itself uses when it hashes a password.
const SCRAM_ITERATIONS = 4096

// Length in bytes of the random salt Postgres uses.
const SCRAM_SALT_BYTES = 16

// Length in bytes of a SHA-256 digest.
const SCRAM_KEY_BYTES = 32

// SQLSTATE Postgres returns when it refuses a grant.
const INSUFFICIENT_PRIVILEGE = "42501"

// Applied when the resource properties leave a limit out.
const DEFAULT_LIMITS = {
  statementTimeout: "30s",
  idleTransactionTimeout: "60s",
  lockTimeout: "5s",
  connectionLimit: 5
}

// Limits this handler's own session. It runs against a production writer during a deploy,
// so it must give up rather than block an application statement.
const SESSION_OPTIONS = "-c statement_timeout=20s -c lock_timeout=5s"

// How long to wait for the connection itself. Long enough for a Serverless v2 writer to
// resume from pause, which takes roughly fifteen seconds on the first connection.
const CONNECTION_TIMEOUT_MILLISECONDS = 30000

const secrets = new SecretsManagerClient({})

/**
 * Reads one secret and parses its JSON value.
 *
 * @param {string} arn - The secret ARN.
 * @returns {Promise<object>} The parsed secret value.
 */
async function readSecret(arn) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }))
  return JSON.parse(response.SecretString)
}

/**
 * Reads the role limits out of the resource properties and falls back to the defaults.
 * The connection limit lands in a statement as a bare number, so it is parsed and checked
 * rather than trusted.
 *
 * @param {object} properties - The resource properties.
 * @returns {object} The limits to apply to the role.
 */
function readLimits(properties) {
  const connectionLimit = Number.parseInt(properties.ConnectionLimit ?? DEFAULT_LIMITS.connectionLimit, 10)

  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
    throw new Error(`Invalid connection limit: ${properties.ConnectionLimit}`)
  }

  return {
    statementTimeout: properties.StatementTimeout || DEFAULT_LIMITS.statementTimeout,
    idleTransactionTimeout: properties.IdleTransactionTimeout || DEFAULT_LIMITS.idleTransactionTimeout,
    lockTimeout: properties.LockTimeout || DEFAULT_LIMITS.lockTimeout,
    connectionLimit: connectionLimit
  }
}

/**
 * Builds the SCRAM-SHA-256 verifier Postgres stores for a password.
 * Postgres accepts an already-encrypted string and stores it unchanged.
 * The plaintext therefore never appears in a statement.
 *
 * @param {string} password - The plaintext password.
 * @returns {string} The verifier.
 */
function buildVerifier(password) {
  const salt = crypto.randomBytes(SCRAM_SALT_BYTES)
  // The generated password is alphanumeric, so SASLprep normalises it to itself.
  const salted = crypto.pbkdf2Sync(password, salt, SCRAM_ITERATIONS, SCRAM_KEY_BYTES, "sha256")
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest()
  const storedKey = crypto.createHash("sha256").update(clientKey).digest()
  const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest()

  return [
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}`,
    `${salt.toString("base64")}$${storedKey.toString("base64")}`,
    serverKey.toString("base64")
  ].join(":")
}

/**
 * Opens one Postgres connection under this handler's own limits.
 *
 * @param {object} params - Where to connect and who to connect as.
 * @returns {Promise<Client>} The connected client.
 */
async function connect(params) {
  const client = new Client({
    host: params.host,
    port: Number(params.port),
    database: params.database,
    user: params.user,
    password: params.password,
    // rds.force_ssl is on, so the connection is encrypted. The certificate is not verified,
    // which is the same stance the containers take with sslmode=require.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    options: SESSION_OPTIONS
  })

  await client.connect()

  return client
}

/**
 * Grants the role read access to every table.
 * Falls back to the public schema when the engine refuses the predefined role.
 *
 * @param {object} params - The connected master client and the quoted role.
 * @returns {Promise<string>} The grant path that was taken.
 */
async function grantRead(params) {
  await params.client.query("SAVEPOINT read_all_data")

  try {
    // Covers every table that exists now and every table a migration adds later.
    // pg_read_all_data does not set BYPASSRLS, so row-level security still applies.
    await params.client.query(`GRANT pg_read_all_data TO ${params.role}`)
    return "pg_read_all_data"
  } catch (error) {
    if (error.code !== INSUFFICIENT_PRIVILEGE) throw error

    // rds_superuser does not hold pg_read_all_data with admin option on this engine.
    // This reaches only the public schema, and only objects that postgres creates.
    await params.client.query("ROLLBACK TO SAVEPOINT read_all_data")
    await params.client.query(`GRANT USAGE ON SCHEMA public TO ${params.role}`)
    await params.client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${params.role}`)
    await params.client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO ${params.role}`
    )
    return "public schema fallback"
  }
}

/**
 * Creates the role when it is absent, then applies everything that is safe to repeat.
 *
 * @param {object} params - The connected master client, the names, the verifier and the limits.
 * @returns {Promise<string>} The grant path that was taken.
 */
async function ensureRole(params) {
  const client = params.client
  const limits = params.limits
  const role = client.escapeIdentifier(params.roleName)
  const database = client.escapeIdentifier(params.database)
  const verifier = client.escapeLiteral(params.verifier)

  await client.query("BEGIN")

  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [params.roleName])

  // NOSUPERUSER, NOCREATEDB and NOCREATEROLE are the CREATE ROLE defaults. Postgres 15
  // also removed CREATE on schema public from PUBLIC, so the role cannot create objects.
  if (existing.rowCount === 0) await client.query(`CREATE ROLE ${role}`)

  // Connections the role may hold at once, so one client cannot eat the cluster's budget.
  await client.query(
    `ALTER ROLE ${role} WITH LOGIN PASSWORD ${verifier} CONNECTION LIMIT ${limits.connectionLimit}`
  )

  // Aurora 14.7 and 15.2 revoked CONNECT from PUBLIC, so it is granted explicitly.
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)

  const grantPath = await grantRead({ client: client, role: role })

  // Read-only even when the client never asks for it. A session can turn this off, so the
  // missing write grants are the boundary and this is the second layer.
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`)

  // The cluster leaves statement_timeout unset and idle_in_transaction_session_timeout at
  // a day. A generated query must not be able to sit on a production connection.
  // The values arrive from the resource properties, so they are escaped rather than inlined.
  await client.query(
    `ALTER ROLE ${role} SET statement_timeout = ${client.escapeLiteral(limits.statementTimeout)}`
  )
  await client.query(
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ${client.escapeLiteral(limits.idleTransactionTimeout)}`
  )
  await client.query(
    `ALTER ROLE ${role} SET lock_timeout = ${client.escapeLiteral(limits.lockTimeout)}`
  )

  await client.query("COMMIT")

  return grantPath
}

/**
 * Connects as the role itself and checks what the role actually got.
 * This is what catches a wrong verifier or a missing CONNECT grant at deploy time.
 *
 * @param {object} params - Where to connect and the expected role name.
 * @returns {Promise<void>} Nothing.
 */
async function verifyRole(params) {
  const client = await connect(params)

  try {
    const result = await client.query(
      "SELECT current_user, current_setting('transaction_read_only') AS read_only"
    )
    const row = result.rows[0]

    if (row.current_user !== params.user) throw new Error(`Connected as ${row.current_user}`)
    if (row.read_only !== "on") throw new Error("Role is not read only by default")
  } finally {
    await client.end()
  }
}

/**
 * Drops the role and the privileges it holds.
 * A role that is already gone is not an error, so a hand-made change cannot wedge the stack.
 *
 * @param {object} params - The connected master client and the role name.
 * @returns {Promise<void>} Nothing.
 */
async function dropRole(params) {
  const client = params.client
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [params.roleName])

  if (existing.rowCount === 0) return

  const role = client.escapeIdentifier(params.roleName)

  // DROP OWNED BY is what revokes the database CONNECT grant. Without it DROP ROLE fails
  // with "role cannot be dropped because some objects depend on it".
  await client.query(`DROP OWNED BY ${role}`)
  await client.query(`DROP ROLE ${role}`)
}

/**
 * Creates, updates or drops the read-only role.
 * The event carries only names and ARNs, so logging it whole is safe.
 * The secret value and the statement text are never logged.
 *
 * @param {object} event - The CloudFormation custom resource event.
 * @returns {Promise<object>} The physical resource id.
 */
exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event))

  const properties = event.ResourceProperties
  const master = await readSecret(properties.MasterSecretArn)

  // Echoed back unchanged on an update. A new id would make CloudFormation send a delete
  // for the old one and drop the role that was just configured.
  const physicalResourceId = `${properties.Database}/${properties.RoleName}`

  const connection = {
    host: properties.Host,
    port: properties.Port,
    database: properties.Database,
    user: master.username,
    password: master.password
  }

  const client = await connect(connection)

  try {
    if (event.RequestType === "Delete") {
      await dropRole({ client: client, roleName: properties.RoleName })
      console.log(`Dropped role ${properties.RoleName}`)
      return { PhysicalResourceId: event.PhysicalResourceId }
    }

    const role = await readSecret(properties.RoleSecretArn)
    const grantPath = await ensureRole({
      client: client,
      roleName: properties.RoleName,
      database: properties.Database,
      verifier: buildVerifier(role.password),
      limits: readLimits(properties)
    })

    console.log(`Granted read access through ${grantPath}`)

    await verifyRole({
      host: properties.Host,
      port: properties.Port,
      database: properties.Database,
      user: properties.RoleName,
      password: role.password
    })

    console.log(`Verified role ${properties.RoleName}`)

    return { PhysicalResourceId: physicalResourceId }
  } finally {
    await client.end()
  }
}
