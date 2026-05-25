import type { AiFileFinding, AiImplementerHint, EvidenceItem, InvestigationResult } from "../../types.js";

const empty = "_None found._";

const textList = (items: string[]) => items.join(", ") || empty;

const classificationLabel = (classification: InvestigationResult["classification"]) => {
  switch (classification) {
    case "bug":
      return "likely bug";
    case "feature_request":
      return "feature request";
    case "support_question":
      return "support question";
    case "unknown":
      return "needs clarification";
  }
};

const isTeamAlias = (value: string | null | undefined) => Boolean(value?.trim().startsWith("@"));

const unique = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const sentenceLimit = (text: string, limit: number) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [normalized];
  return sentences.slice(0, limit).join(" ");
};

const compactReason = (text: string) => sentenceLimit(text, 1);

const primaryFiles = (result: InvestigationResult) => {
  const aiFiles = result.ai?.likelyFiles.map((item) => item.path) ?? [];
  const deterministicFiles = result.suspiciousFiles.map((item) => item.path ?? item.title);
  return unique([...aiFiles, ...deterministicFiles]).slice(0, 3);
};

const commitDateFor = (result: InvestigationResult, commit: string | null) => {
  if (!commit) return undefined;
  const match = result.relatedCommits.find((item) =>
    item.citations.some(
      (citation) => citation.commit && (commit.startsWith(citation.commit) || citation.commit.startsWith(commit)),
    ),
  );
  return typeof match?.metadata?.date === "string" ? match.metadata.date : undefined;
};

const humanImplementerName = (item: AiImplementerHint) => {
  const candidate = item.name ?? item.email;
  return isTeamAlias(candidate) ? undefined : candidate ?? undefined;
};

const likelyOwners = (result: InvestigationResult) => {
  const humanOwners = unique(result.ai?.implementerHints.map(humanImplementerName).filter((name): name is string => Boolean(name)) ?? []);
  if (humanOwners.length) return humanOwners.slice(0, 2);

  return unique([
    ...(result.ai?.likelyOwners ?? []),
    ...result.likelyOwners,
    ...(result.suspiciousFiles.map((item) => item.owner).filter((owner): owner is string => Boolean(owner)) ?? []),
  ]).slice(0, 2);
};

const nextChecks = (result: InvestigationResult) => {
  const questions = result.ai?.missingInfoQuestions.map((question) => `Confirm: ${question}`) ?? [];
  if (result.ai) {
    const topFile = result.ai.likelyFiles[0];
    const topOwner = likelyOwners(result)[0];
    return [
      topFile ? `Inspect \`${topFile.path}\` first.` : undefined,
      topOwner ? `Route the first pass to ${topOwner}.` : undefined,
      ...questions,
    ]
      .filter((step): step is string => Boolean(step))
      .slice(0, 3)
      .map((step, index) => `${index + 1}. ${step}`)
      .join("\n");
  }

  return [...result.suggestedNextSteps, ...questions].slice(0, 3).map((step, index) => `${index + 1}. ${step}`).join("\n");
};

const commitSignalText = (result: InvestigationResult, item: AiImplementerHint) => {
  const name = humanImplementerName(item) ?? item.email ?? item.name ?? "Unknown";
  const date = commitDateFor(result, item.commit);
  const commit = [item.commit ? `commit ${item.commit}` : undefined, date].filter(Boolean).join(", ");
  return `${name}${commit ? ` - ${commit}` : ""}: ${compactReason(item.reason)}`;
};

const relatedCommitSignalText = (item: EvidenceItem) => {
  const author = typeof item.metadata?.author === "string" ? item.metadata.author : undefined;
  const date = typeof item.metadata?.date === "string" ? item.metadata.date : undefined;
  const commit = item.citations[0]?.commit ?? item.title;
  const attribution = [author, `commit ${commit}`, date].filter(Boolean).join(", ");
  return `${attribution}: ${compactReason(item.summary)}`;
};

const fileSignalText = (item: AiFileFinding) =>
  `${item.path}: ${compactReason(item.reason) || `confidence ${item.confidence.toFixed(2)}`}`;

const suspiciousFileSignalText = (item: EvidenceItem) =>
  `${item.path ?? item.title}: ${compactReason(item.summary) || "matched the report"}`;

const evidenceSignals = (result: InvestigationResult) => {
  const signals = [
    ...(result.ai?.implementerHints ?? [])
      .filter((item) => Boolean(humanImplementerName(item) || item.commit))
      .slice(0, 2)
      .map((item) => commitSignalText(result, item)),
    ...(result.relatedCommits.length ? result.relatedCommits.slice(0, 1).map(relatedCommitSignalText) : []),
    ...(result.ai?.likelyFiles ?? []).slice(0, 2).map(fileSignalText),
    ...result.suspiciousFiles.slice(0, 2).map(suspiciousFileSignalText),
  ];

  return unique(signals)
    .slice(0, 3)
    .map((signal, index) => `${index + 1}. ${signal}`)
    .join("\n");
};

export const renderSlackInvestigationReply = (result: InvestigationResult) =>
  [
    "*FirstTrace investigation*",
    `Classification: \`${classificationLabel(result.classification)}\``,
    `Likely owner: \`${textList(likelyOwners(result))}\``,
    `Primary files: \`${textList(primaryFiles(result))}\``,
    result.ai ? `AI confidence: \`${result.ai.confidence.toFixed(2)}\`` : "",
    "",
    "*Likely cause*",
    result.ai?.explanation ? sentenceLimit(result.ai.explanation, 2) : sentenceLimit(result.likelyComponent, 2) || empty,
    "",
    "*Next checks*",
    nextChecks(result) || empty,
    "",
    "*Evidence*",
    evidenceSignals(result) || empty,
    result.warnings.length ? `\n*Warnings*\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
