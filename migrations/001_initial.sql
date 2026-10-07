-- ═══════════════════════════════════════════════════════════════════════════
-- Railway PostgreSQL schema — mirrors the Cloudflare D1 schema
-- but uses PostgreSQL syntax and types.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Session store (for express-session / connect-pg-simple) ──────────────────
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR    NOT NULL COLLATE "default",
  sess   JSON       NOT NULL,
  expire TIMESTAMP  NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- ── Guilds ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guilds (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  icon          TEXT,
  monitoring    INTEGER NOT NULL DEFAULT 0,
  last_event_at BIGINT,
  created_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_guilds_monitoring ON guilds(monitoring);

-- ── Categories ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id            TEXT    PRIMARY KEY,
  guild_id      TEXT    NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  monitoring    INTEGER NOT NULL DEFAULT 0,
  last_event_at BIGINT,
  created_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_categories_guild_id   ON categories(guild_id);
CREATE INDEX IF NOT EXISTS idx_categories_monitoring ON categories(monitoring);

-- ── Channels ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id              TEXT    PRIMARY KEY,
  guild_id        TEXT    NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  guild_name      TEXT    NOT NULL,
  category_id     TEXT    REFERENCES categories(id) ON DELETE SET NULL,
  category_name   TEXT,
  name            TEXT    NOT NULL,
  channel_type    INTEGER NOT NULL DEFAULT 0,
  parsed          INTEGER NOT NULL DEFAULT 0,
  boost_type      TEXT,
  boost_count     INTEGER,
  boost_level     INTEGER,
  customer        TEXT,
  parse_status    TEXT    NOT NULL DEFAULT 'UNPARSED',
  active          INTEGER NOT NULL DEFAULT 1,
  monitoring      INTEGER NOT NULL DEFAULT 0,
  in_level_range  INTEGER NOT NULL DEFAULT 0,
  last_event_at   BIGINT,
  created_at      BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at      BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_channels_guild_id    ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_channels_category_id ON channels(category_id);
CREATE INDEX IF NOT EXISTS idx_channels_active      ON channels(active);
CREATE INDEX IF NOT EXISTS idx_channels_monitoring  ON channels(monitoring);
CREATE INDEX IF NOT EXISTS idx_channels_parsed      ON channels(parsed);
CREATE INDEX IF NOT EXISTS idx_channels_boost_level ON channels(boost_level);

-- ── Boosts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boosts (
  id                       TEXT    PRIMARY KEY,
  guild_id                 TEXT    NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  guild_name               TEXT    NOT NULL,
  category_id              TEXT,
  category_name            TEXT,
  channel_id               TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  channel_name             TEXT    NOT NULL,
  customer                 TEXT    NOT NULL,
  level                    INTEGER NOT NULL,
  count                    INTEGER NOT NULL,
  boost_type               TEXT    NOT NULL,
  fingerprint              TEXT    NOT NULL UNIQUE,
  outgoing_message_id      TEXT,
  outgoing_message_content TEXT,
  status                   TEXT    NOT NULL DEFAULT 'ACTIVE',
  created_at               BIGINT  NOT NULL,
  sent_at                  BIGINT,
  accepted_at              BIGINT,
  acceptance_method        TEXT,
  accepted_by_user_id      TEXT,
  accepted_by_username     TEXT,
  accepted_reaction        TEXT,
  acceptance_message_id    TEXT,
  notif_sent               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_boosts_guild_id        ON boosts(guild_id);
CREATE INDEX IF NOT EXISTS idx_boosts_channel_id      ON boosts(channel_id);
CREATE INDEX IF NOT EXISTS idx_boosts_status          ON boosts(status);
CREATE INDEX IF NOT EXISTS idx_boosts_fingerprint     ON boosts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_boosts_outgoing_msg_id ON boosts(outgoing_message_id);
CREATE INDEX IF NOT EXISTS idx_boosts_created_at      ON boosts(created_at);

-- ── Messages ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT   PRIMARY KEY,
  boost_id    TEXT   NOT NULL REFERENCES boosts(id) ON DELETE CASCADE,
  guild_id    TEXT   NOT NULL,
  category_id TEXT,
  channel_id  TEXT   NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content     TEXT   NOT NULL,
  sent_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_boost_id   ON messages(boost_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);

-- ── Acceptances ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acceptances (
  id                   TEXT   PRIMARY KEY,
  boost_id             TEXT   NOT NULL REFERENCES boosts(id) ON DELETE CASCADE,
  outgoing_message_id  TEXT   NOT NULL,
  channel_id           TEXT   NOT NULL,
  method               TEXT   NOT NULL,
  accepted_by_user_id  TEXT   NOT NULL,
  accepted_by_username TEXT,
  reaction_emoji       TEXT,
  mention_message_id   TEXT,
  mention_content      TEXT,
  accepted_at          BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptances_boost_method
  ON acceptances(boost_id, method);
CREATE INDEX IF NOT EXISTS idx_acceptances_boost_id        ON acceptances(boost_id);
CREATE INDEX IF NOT EXISTS idx_acceptances_outgoing_msg_id ON acceptances(outgoing_message_id);
CREATE INDEX IF NOT EXISTS idx_acceptances_accepted_at     ON acceptances(accepted_at);

-- ── Monitoring config (singleton) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitoring_config (
  id                       INTEGER PRIMARY KEY DEFAULT 1,
  enabled                  INTEGER NOT NULL DEFAULT 0,
  min_level                INTEGER NOT NULL DEFAULT 10,
  max_level                INTEGER NOT NULL DEFAULT 12,
  message_template         TEXT    NOT NULL DEFAULT 'Interested in +{level} for {customer}',
  acceptance_mode          TEXT    NOT NULL DEFAULT 'ANY',
  accepted_reactions       TEXT    NOT NULL DEFAULT '✅',
  mention_target_id        TEXT,
  accept_reaction          INTEGER NOT NULL DEFAULT 1,
  accept_mention           INTEGER NOT NULL DEFAULT 1,
  any_reaction_accepted    INTEGER NOT NULL DEFAULT 1,
  paused_after_accept      INTEGER NOT NULL DEFAULT 1,
  paused                   INTEGER NOT NULL DEFAULT 0,
  paused_for_confirmation  INTEGER NOT NULL DEFAULT 0,
  last_accepted_boost_id   TEXT,
  notification_channel_id  TEXT,
  discovery_interval_sec   INTEGER NOT NULL DEFAULT 5,
  sign_delay_sec           INTEGER NOT NULL DEFAULT 3,
  queue_delay_sec          INTEGER NOT NULL DEFAULT 2,
  updated_at               BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
INSERT INTO monitoring_config (id) VALUES (1) ON CONFLICT(id) DO NOTHING;

-- ── Telegram config (singleton) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_config (
  id                   INTEGER PRIMARY KEY DEFAULT 1,
  chat_id              TEXT,
  alert_boost_accepted INTEGER NOT NULL DEFAULT 1,
  alert_new_boost      INTEGER NOT NULL DEFAULT 1,
  alert_new_channel    INTEGER NOT NULL DEFAULT 1,
  alert_errors         INTEGER NOT NULL DEFAULT 1,
  updated_at           BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
INSERT INTO telegram_config (id) VALUES (1) ON CONFLICT(id) DO NOTHING;

-- ── M+ Logs ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mplus_logs (
  id          TEXT   PRIMARY KEY,
  level       TEXT   NOT NULL,
  event_type  TEXT   NOT NULL,
  guild_id    TEXT,
  channel_id  TEXT,
  boost_id    TEXT,
  message     TEXT   NOT NULL,
  context     TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlogs_level      ON mplus_logs(level);
CREATE INDEX IF NOT EXISTS idx_mlogs_event_type ON mplus_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_mlogs_guild_id   ON mplus_logs(guild_id);
CREATE INDEX IF NOT EXISTS idx_mlogs_channel_id ON mplus_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_mlogs_boost_id   ON mplus_logs(boost_id);
CREATE INDEX IF NOT EXISTS idx_mlogs_created_at ON mplus_logs(created_at);

-- ── Resource failures (cooldown) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_failures (
  resource_key    TEXT    NOT NULL PRIMARY KEY,
  failure_type    TEXT    NOT NULL,
  http_status     INTEGER NOT NULL,
  first_failed_at BIGINT  NOT NULL,
  last_failed_at  BIGINT  NOT NULL,
  failure_count   INTEGER NOT NULL DEFAULT 1,
  cooldown_until  BIGINT  NOT NULL,
  resolved_at     BIGINT
);
CREATE INDEX IF NOT EXISTS idx_rf_cooldown_until ON resource_failures(cooldown_until);

-- ── KV store (replaces Cloudflare KV for original bot state) ──────────────────
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT   PRIMARY KEY,
  value      TEXT   NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

-- ── Guild character types ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guild_character_types (
  guild_id      TEXT    PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled_types TEXT    NOT NULL DEFAULT 'nostack,plate,cloth,mail,leather',
  allow_all     INTEGER NOT NULL DEFAULT 1,
  updated_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
