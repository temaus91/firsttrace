export type Classification = "bug" | "feature_request" | "support_question" | "unknown";

export type EvidenceType = "file" | "commit" | "doc" | "issue";

export type Citation = {
  commit?: string;
  label: string;
  line?: number;
  path?: string;
  repo: string;
};

export type EvidenceItem = {
  citations: Citation[];
  metadata?: Record<string, string | number | boolean | null>;
  owner?: string;
  path?: string;
  repo: string;
  score: number;
  summary: string;
  title: string;
  type: EvidenceType;
};

export type InvestigationResult = {
  ai?: AiInvestigationResult;
  classification: Classification;
  likelyComponent: string;
  likelyOwners: string[];
  relatedCommits: EvidenceItem[];
  relatedDocs: EvidenceItem[];
  report: string;
  searchTerms: string[];
  suggestedNextSteps: string[];
  suspiciousFiles: EvidenceItem[];
  warnings: string[];
};

export type AiEvidenceKind = "suspicious_file" | "related_commit" | "related_doc" | "warning";

export type AiEvidenceItem = {
  citations: string[];
  id: string;
  kind: AiEvidenceKind;
  metadata?: Record<string, string | number | boolean | null>;
  owner?: string;
  path?: string;
  repo?: string;
  score?: number;
  summary: string;
  title: string;
  type?: EvidenceType;
};

export type AiReasonerRequest = {
  classification: Classification;
  evidence: AiEvidenceItem[];
  likelyComponent: string;
  likelyOwners: string[];
  report: string;
  searchTerms: string[];
  warnings: string[];
};

export type AiFileFinding = {
  citations: string[];
  confidence: number;
  path: string;
  reason: string;
  repo: string;
};

export type AiImplementerHint = {
  citations: string[];
  commit: string | null;
  email: string | null;
  name: string | null;
  reason: string;
};

export type AiInvestigationResult = {
  confidence: number;
  explanation: string;
  implementerHints: AiImplementerHint[];
  likelyComponent: string;
  likelyFiles: AiFileFinding[];
  likelyOwners: string[];
  missingInfoQuestions: string[];
  provider: string;
  warnings: string[];
};

export type AiProvider = {
  name: string;
  reason(request: AiReasonerRequest): Promise<AiInvestigationResult>;
};

export type RepoConfig = {
  name: string;
  path: string;
};

export type OwnerRule = {
  owner: string;
  path: string;
};

export type SearchConfig = {
  maxCommits: number;
  maxEvidencePerFile: number;
  maxFiles: number;
};

export type FirstTraceConfig = {
  configPath: string;
  docs: string[];
  issueExports: string[];
  owners: OwnerRule[];
  repos: RepoConfig[];
  search: SearchConfig;
};
