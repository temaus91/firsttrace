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
