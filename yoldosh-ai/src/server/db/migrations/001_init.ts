/**
 * Yagona biznes ma'lumot modeli (Unified Business Data Model).
 * Barcha manbalar (Meta Ads, CRM, to'lovlar, Excel...) shu jadvallarga normallashtiriladi.
 * Markaziy obyekt — `customers` (universal Customer ID) va `customer_identities`.
 */
export const migration001 = /* sql */ `
-- ============ Biznes ============
CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  vertical    TEXT NOT NULL DEFAULT 'education',
  currency    TEXT NOT NULL DEFAULT 'UZS',
  timezone    TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  strategy    TEXT,
  priorities  JSONB NOT NULL DEFAULT '[]',
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 2-qavat: Connector Layer ============
CREATE TABLE connectors (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  config        JSONB NOT NULL DEFAULT '{}',
  cursor        JSONB NOT NULL DEFAULT '{}',
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connector_id  TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL DEFAULT 'schedule',
  status        TEXT NOT NULL DEFAULT 'running',
  stats         JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX sync_runs_connector ON sync_runs(connector_id, started_at DESC);

-- Webhook "inbox": har bir kelgan hodisa avval shu yerda saqlanadi (idempotentlik + audit)
CREATE TABLE raw_events (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connector_id  TEXT REFERENCES connectors(id) ON DELETE SET NULL,
  source        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (business_id, source, external_id)
);

-- ============ 3-qavat: Data Layer ============
CREATE TABLE branches (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  city         TEXT
);

CREATE TABLE employees (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'sales_manager',
  branch_id         TEXT REFERENCES branches(id) ON DELETE SET NULL,
  telegram_chat_id  TEXT,
  source            TEXT NOT NULL DEFAULT 'internal',
  external_id       TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, external_id)
);

CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  segment      TEXT NOT NULL,
  price        BIGINT NOT NULL DEFAULT 0,
  billing      TEXT NOT NULL DEFAULT 'monthly',
  keywords     TEXT[] NOT NULL DEFAULT '{}',
  active       BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'internal',
  external_id  TEXT
);

-- Sig'im birligi (ta'limda — guruh; boshqa vertikalda — slot/xona/stol)
CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id   TEXT REFERENCES products(id) ON DELETE SET NULL,
  branch_id    TEXT REFERENCES branches(id) ON DELETE SET NULL,
  teacher_id   TEXT REFERENCES employees(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  capacity     INT NOT NULL DEFAULT 25,
  schedule     TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE campaigns (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  segment       TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  daily_budget  BIGINT,
  started_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, external_id)
);

CREATE TABLE ad_metrics_daily (
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  spend         BIGINT NOT NULL DEFAULT 0,
  impressions   INT NOT NULL DEFAULT 0,
  clicks        INT NOT NULL DEFAULT 0,
  leads         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX ad_metrics_business_date ON ad_metrics_daily(business_id, date);

-- Universal Customer ID
CREATE TABLE customers (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  full_name          TEXT,
  phone              TEXT,
  email              TEXT,
  telegram           TEXT,
  telegram_chat_id   TEXT,
  source             TEXT,
  first_campaign_id  TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attributes         JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_business ON customers(business_id);
CREATE INDEX customers_phone ON customers(business_id, phone);

-- Identity resolution: bir odamning turli tizimlardagi identifikatorlari
CREATE TABLE customer_identities (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind, value)
);
CREATE INDEX customer_identities_customer ON customer_identities(customer_id);

CREATE TABLE leads (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id        TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  campaign_id        TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  product_id         TEXT REFERENCES products(id) ON DELETE SET NULL,
  segment            TEXT,
  source             TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'new',
  assigned_to        TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  first_response_at  TIMESTAMPTZ,
  trial_at           TIMESTAMPTZ,
  won_at             TIMESTAMPTZ,
  lost_at            TIMESTAMPTZ,
  lost_reason        TEXT,
  value              BIGINT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, external_id)
);
CREATE INDEX leads_business_created ON leads(business_id, created_at);
CREATE INDEX leads_business_won ON leads(business_id, won_at);
CREATE INDEX leads_customer ON leads(customer_id);
CREATE INDEX leads_open ON leads(business_id, status) WHERE first_response_at IS NULL;

CREATE TABLE interactions (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lead_id      TEXT REFERENCES leads(id) ON DELETE SET NULL,
  employee_id  TEXT REFERENCES employees(id) ON DELETE SET NULL,
  channel      TEXT NOT NULL,
  direction    TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  summary      TEXT,
  source       TEXT NOT NULL DEFAULT 'internal',
  external_id  TEXT
);
CREATE INDEX interactions_customer ON interactions(customer_id, occurred_at DESC);
CREATE UNIQUE INDEX interactions_external ON interactions(business_id, source, external_id) WHERE external_id IS NOT NULL;

-- Sotuv = obuna/kursga yozilish (ta'limda — talaba guruhga qo'shiladi)
CREATE TABLE subscriptions (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id   TEXT REFERENCES products(id) ON DELETE SET NULL,
  group_id     TEXT REFERENCES groups(id) ON DELETE SET NULL,
  lead_id      TEXT REFERENCES leads(id) ON DELETE SET NULL,
  sold_by      TEXT REFERENCES employees(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  price        BIGINT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT
);
CREATE INDEX subscriptions_business ON subscriptions(business_id, status);
CREATE INDEX subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE payments (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id      TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id  TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount           BIGINT NOT NULL,
  method           TEXT,
  status           TEXT NOT NULL DEFAULT 'paid',
  kind             TEXT NOT NULL DEFAULT 'renewal',
  due_date         DATE,
  paid_at          TIMESTAMPTZ,
  source           TEXT NOT NULL DEFAULT 'internal',
  external_id      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, external_id)
);
CREATE INDEX payments_business_paid ON payments(business_id, paid_at);
CREATE INDEX payments_customer ON payments(customer_id);

CREATE TABLE attendance (
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  present      BOOLEAN NOT NULL,
  PRIMARY KEY (customer_id, group_id, date)
);
CREATE INDEX attendance_business_date ON attendance(business_id, date);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  assignee_id   TEXT REFERENCES employees(id) ON DELETE SET NULL,
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_ids      TEXT[] NOT NULL DEFAULT '{}',
  due_at        TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'open',
  priority      TEXT NOT NULL DEFAULT 'normal',
  created_by    TEXT NOT NULL DEFAULT 'ai',
  action_id     TEXT,
  external_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX tasks_business ON tasks(business_id, status);

-- Chiquvchi xabarlar jurnali (Telegram, ichki bildirishnomalar)
CREATE TABLE notifications (
  id                     TEXT PRIMARY KEY,
  business_id            TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel                TEXT NOT NULL,
  recipient_employee_id  TEXT REFERENCES employees(id) ON DELETE SET NULL,
  recipient_customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
  recipient              TEXT,
  text                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  error                  TEXT,
  action_id              TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 4-qavat: Business Context Layer ============
CREATE TABLE targets (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'kpi',
  metric       TEXT NOT NULL,
  label        TEXT NOT NULL,
  target       DOUBLE PRECISION NOT NULL,
  comparator   TEXT NOT NULL DEFAULT 'gte',
  segment      TEXT,
  priority     INT NOT NULL DEFAULT 2,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_rules (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  detector       TEXT NOT NULL,
  params         JSONB NOT NULL DEFAULT '{}',
  action_type    TEXT NOT NULL,
  action_params  JSONB NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_run_at    TIMESTAMPTZ,
  last_result    JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 5-qavat: AI Business Brain ============
CREATE TABLE findings (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  detector           TEXT NOT NULL,
  severity           TEXT NOT NULL DEFAULT 'warning',
  title              TEXT NOT NULL,
  summary            TEXT,
  metrics            JSONB NOT NULL DEFAULT '{}',
  entity_type        TEXT,
  entity_ids         TEXT[] NOT NULL DEFAULT '{}',
  impact             DOUBLE PRECISION NOT NULL DEFAULT 0,
  dedupe_key         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  first_detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  UNIQUE (business_id, dedupe_key)
);

CREATE TABLE diagnoses (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'daily',
  window_days      INT NOT NULL,
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  kpis             JSONB NOT NULL,
  tree             JSONB NOT NULL,
  root_cause       JSONB,
  priorities       JSONB NOT NULL DEFAULT '[]',
  recommendations  JSONB NOT NULL DEFAULT '[]',
  narrative        TEXT,
  generated_by     TEXT NOT NULL DEFAULT 'engine',
  model            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX diagnoses_business ON diagnoses(business_id, created_at DESC);

-- ============ 6-qavat: Action Layer ============
CREATE TABLE actions (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  params           JSONB NOT NULL DEFAULT '{}',
  risk             TEXT NOT NULL,
  status           TEXT NOT NULL,
  source           TEXT NOT NULL,
  rationale        TEXT,
  expected_impact  TEXT,
  confidence       DOUBLE PRECISION,
  finding_id       TEXT,
  diagnosis_id     TEXT,
  rule_id          TEXT,
  dedupe_key       TEXT,
  context          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  decided_by       TEXT,
  decision_note    TEXT,
  executed_at      TIMESTAMPTZ,
  result           JSONB,
  error            TEXT
);
CREATE INDEX actions_business ON actions(business_id, status, created_at DESC);
CREATE UNIQUE INDEX actions_dedupe ON actions(business_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'failed';

-- ============ Feedback Loop ============
CREATE TABLE outcomes (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  action_id     TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,
  label         TEXT NOT NULL,
  direction     TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'ratio',
  baseline      DOUBLE PRECISION,
  observed      DOUBLE PRECISION,
  evaluate_at   TIMESTAMPTZ NOT NULL,
  evaluated_at  TIMESTAMPTZ,
  verdict       TEXT NOT NULL DEFAULT 'pending',
  details       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX outcomes_due ON outcomes(verdict, evaluate_at);

-- ============ AI suhbatlari (CEO Agent) ============
CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT 'Yangi suhbat',
  channel      TEXT NOT NULL DEFAULT 'web',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- content: API'ga aynan qayta yuboriladigan JSON matn (TEXT — kalitlar tartibi o'zgarmasligi uchun)
CREATE TABLE messages (
  seq              BIGSERIAL PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  display          TEXT,
  meta             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages(conversation_id, seq);
`;
