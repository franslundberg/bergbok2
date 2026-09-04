import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appConfig } from "./config.ts";

const MIGRATION = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT,verified_at INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS email_challenges (id TEXT PRIMARY KEY,email TEXT NOT NULL,remote_hash TEXT NOT NULL,code_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed_at INTEGER,verified_at INTEGER,user_id TEXT REFERENCES users(id),signup_token_digest TEXT,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS email_challenges_email_created ON email_challenges(email,created_at);
CREATE INDEX IF NOT EXISTS email_challenges_remote_created ON email_challenges(remote_hash,created_at);
CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY,token_digest TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS auth_sessions_token_digest ON auth_sessions(token_digest);
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY,name TEXT NOT NULL,language TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS company_memberships (company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner')),can_approve INTEGER NOT NULL CHECK(can_approve IN (0,1)),PRIMARY KEY(company_id,user_id)) STRICT;
CREATE TABLE IF NOT EXISTS company_periods (company_id TEXT NOT NULL REFERENCES companies(id),id TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,start_date TEXT,end_date TEXT NOT NULL,PRIMARY KEY(company_id,id),UNIQUE(company_id,sequence)) STRICT;
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS conversation_events (id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,company_id TEXT NOT NULL REFERENCES companies(id),type TEXT NOT NULL,actor_id TEXT,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS conversation_events_sequence ON conversation_events(conversation_id,id);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),log_item_id TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('unassigned','assigned','ignored')),period_id TEXT,document_id TEXT,duplicate_of TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,origin TEXT NOT NULL DEFAULT 'upload',parent_document_id TEXT,replaces_document_id TEXT,target_period_id TEXT) STRICT;
CREATE INDEX IF NOT EXISTS uploads_company_sha ON uploads(company_id,sha256);
CREATE TABLE IF NOT EXISTS docset_entries (company_id TEXT NOT NULL REFERENCES companies(id),period_id TEXT NOT NULL,document_id TEXT NOT NULL,upload_id TEXT NOT NULL REFERENCES uploads(id),status TEXT NOT NULL CHECK(status IN ('active','removed','replaced')),parent_document_id TEXT,replaces_document_id TEXT,created_at INTEGER NOT NULL,ended_at INTEGER,PRIMARY KEY(company_id,period_id,document_id)) STRICT;
CREATE INDEX IF NOT EXISTS docset_entries_period_status ON docset_entries(company_id,period_id,status);
CREATE TABLE IF NOT EXISTS bookkeeping_jobs (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),period_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','proposal','needs_input','out_of_scope','failed')),created_by TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,heartbeat_at INTEGER,finished_at INTEGER,error_message TEXT,run_id TEXT,phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','preparing','analyzing','recording')),phase_changed_at INTEGER) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_bookkeeping_job ON bookkeeping_jobs(company_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS bookkeeping_runs (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),period_id TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES bookkeeping_jobs(id),outcome_kind TEXT NOT NULL,run_ref_json TEXT NOT NULL,run_sha256 TEXT NOT NULL,review_markdown TEXT,outcome_json TEXT NOT NULL,decision TEXT CHECK(decision IN ('approved','rejected')),decided_at INTEGER,superseded_at INTEGER,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS bookkeeping_runs_period ON bookkeeping_runs(company_id,period_id,created_at);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),run_id TEXT NOT NULL,profile TEXT NOT NULL,filename TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,relative_path TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,profile,filename)) STRICT;
`;

export type BergbokDatabase = DatabaseSync;

export const createDatabase = (databasePath: string) => {
  if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  database.exec(MIGRATION);
  migrateApplication(database);
  seedApplication(database);
  return database;
};

const migrateApplication = (database: BergbokDatabase) => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT",
  );
  const columns = new Set(
    (database.prepare("PRAGMA table_info(uploads)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions = [
    ["origin", "TEXT NOT NULL DEFAULT 'upload'"],
    ["parent_document_id", "TEXT"],
    ["replaces_document_id", "TEXT"],
    ["target_period_id", "TEXT"],
  ] as const;
  for (const [name, declaration] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE uploads ADD COLUMN ${name} ${declaration}`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS docset_entries (company_id TEXT NOT NULL REFERENCES companies(id),period_id TEXT NOT NULL,document_id TEXT NOT NULL,upload_id TEXT NOT NULL REFERENCES uploads(id),status TEXT NOT NULL CHECK(status IN ('active','removed','replaced')),parent_document_id TEXT,replaces_document_id TEXT,created_at INTEGER NOT NULL,ended_at INTEGER,PRIMARY KEY(company_id,period_id,document_id)) STRICT;
    CREATE INDEX IF NOT EXISTS docset_entries_period_status ON docset_entries(company_id,period_id,status);
  `);
  const jobColumns = new Set(
    (database.prepare("PRAGMA table_info(bookkeeping_jobs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!jobColumns.has("phase"))
    database.exec(
      "ALTER TABLE bookkeeping_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','preparing','analyzing','recording'))",
    );
  if (!jobColumns.has("phase_changed_at"))
    database.exec("ALTER TABLE bookkeeping_jobs ADD COLUMN phase_changed_at INTEGER");
  database.exec(
    "UPDATE bookkeeping_jobs SET phase='analyzing',phase_changed_at=COALESCE(started_at,created_at) WHERE status='running' AND phase='queued'",
  );
  database.exec(
    "UPDATE bookkeeping_jobs SET phase_changed_at=COALESCE(phase_changed_at,created_at)",
  );
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get()) {
    database
      .prepare("INSERT INTO schema_migrations (version,applied_at) VALUES (2,?)")
      .run(Date.now());
  }
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=1").get()) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        INSERT OR IGNORE INTO docset_entries (company_id,period_id,document_id,upload_id,status,parent_document_id,replaces_document_id,created_at)
        SELECT company_id,period_id,document_id,id,'active',parent_document_id,replaces_document_id,created_at
        FROM uploads
        WHERE status='assigned' AND period_id IS NOT NULL AND document_id IS NOT NULL;
      `);
      database
        .prepare("INSERT INTO schema_migrations (version,applied_at) VALUES (1,?)")
        .run(Date.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const seedApplication = (database: BergbokDatabase) => {
  const now = Date.now();
  database
    .prepare(
      "INSERT OR IGNORE INTO companies (id,name,language,created_at) VALUES ('fiktiv-ab','Fiktiv AB','sv',?)",
    )
    .run(now);
  const insert = database.prepare(
    "INSERT OR IGNORE INTO company_periods (company_id,id,sequence,kind,start_date,end_date) VALUES ('fiktiv-ab',?,?,?,?,?)",
  );
  insert.run("Start", 1, "start", null, "2026-05-11");
  insert.run("2026-05", 2, "ordinary", "2026-05-12", "2026-05-31");
  insert.run("2026-06", 3, "ordinary", "2026-06-01", "2026-06-30");
  database
    .prepare(
      "INSERT OR IGNORE INTO conversations (id,company_id,created_at,updated_at) VALUES ('fiktiv-ab-main','fiktiv-ab',?,?)",
    )
    .run(now, now);
};

let singleton: BergbokDatabase | undefined;
export const getDatabase = () => (singleton ??= createDatabase(appConfig().databasePath));
