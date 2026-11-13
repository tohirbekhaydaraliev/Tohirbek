/**
 * Server va web o'rtasida umumiy tiplar.
 */

export type RiskLevel = 'low' | 'medium' | 'high';
export type AutonomyMode = 'auto' | 'approval';

export interface BusinessSettings {
  /** Diagnostika solishtirish oynasi (kun) */
  diagnosisWindowDays: number;
  /** Leadga birinchi javob SLA (daqiqa) */
  responseSlaMinutes: number;
  /** Necha soatdan keyin lead "javobsiz" hisoblanadi */
  unansweredHours: number;
  /** Churn ehtimoli chegarasi (0..1) */
  churnThreshold: number;
  /** Xavf darajasi bo'yicha avtonomiya */
  autonomy: { low: AutonomyMode; medium: AutonomyMode; high: 'approval' };
  /** AI chatda taklif qilgan past xavfli harakatlarni avtomatik bajarish */
  agentLowRiskAuto: boolean;
  /** Kunlik diagnostika soati (biznes vaqt mintaqasida) */
  dailyDigestHour: number;
  /** Byudjet o'zgarishi shu foizdan oshsa — yuqori xavf */
  maxBudgetChangePct: number;
  /** Segment -> afzal guruh (lead routing) */
  leadRouting: Record<string, string>;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  diagnosisWindowDays: 30,
  responseSlaMinutes: 15,
  unansweredHours: 2,
  churnThreshold: 0.6,
  autonomy: { low: 'auto', medium: 'approval', high: 'approval' },
  agentLowRiskAuto: true,
  dailyDigestHour: 8,
  maxBudgetChangePct: 30,
  leadRouting: {},
};

export interface Business {
  id: string;
  name: string;
  vertical: string;
  currency: string;
  timezone: string;
  strategy: string | null;
  priorities: string[];
  settings: BusinessSettings;
}

export type Unit = 'money' | 'count' | 'percent' | 'minutes' | 'ratio' | 'months';

export interface Kpi {
  key: string;
  label: string;
  unit: Unit;
  current: number | null;
  previous: number | null;
  change: number | null;
  goodDirection: 'up' | 'down';
  status: 'good' | 'bad' | 'neutral';
  target?: number | null;
  targetComparator?: 'gte' | 'lte';
  /** Kunlik qiymatlar (sparkline uchun) */
  series?: number[];
}

export interface TreeNode {
  key: string;
  label: string;
  unit: Unit;
  current: number;
  previous: number;
  change: number | null;
  /** Ota tugun o'zgarishining shu tugun tushuntirgan qismi (ota birligida) */
  contribution: number | null;
  /** Ota o'zgarishidagi ulush (0..1) */
  share: number | null;
  relation: 'root' | 'sum' | 'product' | 'driver' | 'evidence';
  status: 'ok' | 'warning' | 'critical' | 'improved';
  note?: string;
  onPath?: boolean;
  children: TreeNode[];
}

export interface RootCause {
  headline: string;
  mainFactor: string;
  explanation: string;
  path: string[];
  segment?: string | null;
  evidence: string[];
  confidence: number;
}

export interface Priority {
  rank: number;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  detector: string;
  findingId?: string;
  impact: number;
}

export interface Recommendation {
  title: string;
  actionType: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  rationale: string;
  expectedImpact: string;
  confidence: number;
  actionId?: string;
  actionStatus?: ActionStatus;
}

export interface Diagnosis {
  id: string;
  kind: string;
  windowDays: number;
  periodStart: string;
  periodEnd: string;
  kpis: Kpi[];
  tree: TreeNode;
  rootCause: RootCause | null;
  priorities: Priority[];
  recommendations: Recommendation[];
  narrative: string | null;
  generatedBy: 'engine' | 'ai';
  model: string | null;
  createdAt: string;
}

export type ActionStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'rejected'
  | 'ignored'
  | 'failed';

export interface ActionView {
  id: string;
  type: string;
  typeLabel: string;
  title: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  status: ActionStatus;
  source: string;
  rationale: string | null;
  expectedImpact: string | null;
  confidence: number | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  outcome?: OutcomeView | null;
}

export interface OutcomeView {
  id: string;
  actionId: string;
  metric: string;
  label: string;
  direction: 'increase' | 'decrease';
  unit: Unit;
  baseline: number | null;
  observed: number | null;
  evaluateAt: string;
  evaluatedAt: string | null;
  verdict: 'pending' | 'improved' | 'no_change' | 'worsened' | 'unknown';
}

export interface Finding {
  id: string;
  detector: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string | null;
  metrics: Record<string, unknown>;
  entityType: string | null;
  entityIds: string[];
  impact: number;
  status: 'open' | 'resolved';
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'number' | 'select';
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  default?: string;
}

export interface ConnectorTypeInfo {
  type: string;
  label: string;
  category: 'marketing' | 'sales' | 'finance' | 'messaging' | 'files' | 'demo';
  description: string;
  configFields: ConfigField[];
  capabilities: { sync: boolean; webhook: boolean; actions: string[] };
}

export interface ConnectorView {
  id: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
  lastSyncAt: string | null;
  lastError: string | null;
  webhookUrl: string | null;
  createdAt: string;
  lastRun?: { status: string; stats: Record<string, unknown>; startedAt: string; finishedAt: string | null } | null;
}

export interface AgentStep {
  agent: string;
  kind: 'start' | 'tool' | 'done' | 'error';
  label: string;
  at: string;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps: AgentStep[];
  actions: ActionView[];
  createdAt: string;
}

export interface Customer360 {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  source: string | null;
  campaign: string | null;
  firstContactAt: string | null;
  salesManager: string | null;
  product: string | null;
  segment: string | null;
  group: string | null;
  trialAt: string | null;
  purchaseAt: string | null;
  revenue: number;
  attendanceRate: number | null;
  lastActivityAt: string | null;
  churnProbability: number | null;
  churnLevel: 'low' | 'medium' | 'high' | null;
  churnReasons: string[];
  subscriptionStatus: string | null;
  identities: Array<{ kind: string; value: string; source: string | null }>;
  timeline: Array<{ at: string; kind: string; title: string; detail?: string }>;
  openTasks: Array<{ id: string; title: string; dueAt: string | null }>;
}
